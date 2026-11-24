/*** 第九块：宽容工具调用解析 —— 解析器 / 代理 / 安全通路 E2E *****
 * 背景：小模型（qwen2.5-coder 类）把工具调用写成 JSON 纯文本 / ```json 块，
 * Pi 只认原生 tool_calls。本块三层防线逐层实证：
 * A. parseLenientToolCalls 纯函数：只转「确信是调用」的段（工具名在清单内、
 *    schema 基本校验过、模式回声能确信解包），其余一律原文保留、不抛错；
 * B. startLenientToolCallProxy 直测：文本调用被转成原生 tool_calls 并以
 *    x-baimo-lenient-converted 响应头显形，原生调用零介入透传；
 * C. 安全通路 E2E：转换出的调用在 Pi 内与原生调用走同一通路——计划门
 *    （tool_call 硬拦 + submit_plan 裁决）与审批门（危险命令弹卡）都钩得住，
 *    宽容解析不构成绕过门的后门。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHost,
  approvalGateExtensionPath,
  planGateExtensionPath,
  parseLenientToolCalls,
  startLenientToolCallProxy,
} from "../dist/index.js";
import {
  createLenientModelServer,
  lenientModelsJson,
  LENIENT_DANGER_COMMAND,
  LENIENT_DEFAULT_COMMAND,
  LENIENT_ECHO_BAD_TEXT,
  LENIENT_FINAL_TEXT,
  LENIENT_NATIVE_COMMAND,
  LENIENT_NATIVE_TEXT,
  LENIENT_PLAN_CONTENT,
  LENIENT_PLAN_PATH,
  LENIENT_PLAN_STEPS,
  LENIENT_WRITE_FIRST_PATH,
} from "./fixtures/lenient-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;

/* ================= A. 解析器单测 ================= */

/** 解析器单测工具清单：参数 schema 与真实工具同口径（必填 + 基本类型）。 */
const PARSER_TOOLS = [
  {
    name: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "bash",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "submit_plan",
    parameters: {
      type: "object",
      properties: { steps: { type: "array" } },
      required: ["steps"],
    },
  },
  {
    name: "plan_progress",
    parameters: {
      type: "object",
      properties: {
        stepIndex: { type: "integer" },
        status: { type: "string" },
      },
      required: ["stepIndex", "status"],
    },
  },
];

test("A1 解析器：裸 JSON 全文转换成功，remainingText 为空", () => {
  const text = JSON.stringify({
    name: "bash",
    arguments: { command: "echo bare" },
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.deepEqual(r.calls[0].arguments, { command: "echo bare" });
  assert.equal(r.remainingText, "");
});

test("A2 解析器：```json 围栏块转换成功，前后说明文字保留", () => {
  const text =
    "我先说明一下。\n```json\n" +
    JSON.stringify({ name: "bash", arguments: { command: "echo fenced" } }) +
    "\n```\n执行完毕后汇报。";
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.deepEqual(r.calls[0].arguments, { command: "echo fenced" });
  assert.ok(r.remainingText.includes("我先说明一下。"));
  assert.ok(r.remainingText.includes("执行完毕后汇报。"));
  assert.ok(!r.remainingText.includes("echo fenced"), "已转段落应从文本中移除");
});

test("A3 解析器：<tool_call> 段转换成功", () => {
  const text =
    "<tool_call>" +
    JSON.stringify({ name: "bash", arguments: { command: "echo tc" } }) +
    "</tool_call>";
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.deepEqual(r.calls[0].arguments, { command: "echo tc" });
  assert.equal(r.remainingText, "");
});

test("A4 解析器：arguments 为 JSON 字符串时转换成功", () => {
  const text = JSON.stringify({
    name: "bash",
    arguments: JSON.stringify({ command: "echo str-args" }),
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.deepEqual(r.calls[0].arguments, { command: "echo str-args" });
});

test("A5 解析器：模式回声带 value 解包成功，参数还原为字符串", () => {
  const text = JSON.stringify({
    name: "write",
    arguments: {
      path: { type: "string", description: "文件路径", value: "echo.txt" },
      content: { type: "string", description: "文件内容", value: "hello\n" },
    },
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "write");
  assert.deepEqual(r.calls[0].arguments, { path: "echo.txt", content: "hello\n" });
});

test("A6 解析器：模式回声无 value（只有 type/description）→ 不转换、原文保留", () => {
  const text = JSON.stringify({
    name: "write",
    arguments: {
      path: { type: "string", description: "文件路径" },
      content: "hello\n",
    },
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 0);
  assert.equal(r.calls.length, 0);
  assert.equal(r.remainingText, text);
});

test("A7 解析器：畸形 JSON（围栏里少个括号）→ 不转换、不抛错、原文保留", () => {
  const text =
    '```json\n{"name":"bash","arguments":{"command":"echo hi"}\n```';
  let r;
  assert.doesNotThrow(() => {
    r = parseLenientToolCalls(text, PARSER_TOOLS);
  });
  assert.equal(r.convertedCount, 0);
  assert.equal(r.remainingText, text);
});

test("A8 解析器：未知工具名 → 不转换、原文保留", () => {
  const text = JSON.stringify({
    name: "teleport",
    arguments: { target: "mars" },
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 0);
  assert.equal(r.remainingText, text);
});

test("A9 解析器：一段文本里两个围栏块（bash + write）→ 两个都转、顺序对", () => {
  const text =
    "```json\n" +
    JSON.stringify({ name: "bash", arguments: { command: "echo one" } }) +
    "\n```\n中间说明。\n```json\n" +
    JSON.stringify({
      name: "write",
      arguments: { path: "two.txt", content: "two\n" },
    }) +
    "\n```";
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 2);
  assert.deepEqual(
    r.calls.map((c) => c.name),
    ["bash", "write"],
  );
  assert.deepEqual(r.calls[1].arguments, { path: "two.txt", content: "two\n" });
  assert.ok(r.remainingText.includes("中间说明。"));
});

test("A10 解析器：混合合法块 + 未知工具块 → 只转合法的，未知块留在 remainingText", () => {
  const unknownBlock =
    "```json\n" +
    JSON.stringify({ name: "teleport", arguments: { target: "mars" } }) +
    "\n```";
  const text =
    "```json\n" +
    JSON.stringify({ name: "bash", arguments: { command: "echo ok" } }) +
    "\n```\n" +
    unknownBlock;
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.ok(r.remainingText.includes("teleport"), "未知块应原样留在文本里");
  assert.ok(!r.remainingText.includes("echo ok"), "合法块应被移除");
});

test("A11 解析器：带前后说明文字的裸 JSON（非全文）→ 不转换", () => {
  const text =
    "好的，我调用：" +
    JSON.stringify({ name: "bash", arguments: { command: "echo hi" } }) +
    " 请看结果。";
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 0);
  assert.equal(r.remainingText, text);
});

test("A12 解析器：required 缺失 / 类型不符 → 均不转换", () => {
  // write 少 content（required 缺失）
  const missing = JSON.stringify({
    name: "write",
    arguments: { path: "only-path.txt" },
  });
  const r1 = parseLenientToolCalls(missing, PARSER_TOOLS);
  assert.equal(r1.convertedCount, 0);
  assert.equal(r1.remainingText, missing);
  // bash 的 command 给数字（类型不符）
  const wrongType = JSON.stringify({
    name: "bash",
    arguments: { command: 123 },
  });
  const r2 = parseLenientToolCalls(wrongType, PARSER_TOOLS);
  assert.equal(r2.convertedCount, 0);
  assert.equal(r2.remainingText, wrongType);
});

test("A13 解析器：多个裸 JSON 对象首尾相接（3B 验收实证形态）→ 逐个转、顺序对", () => {
  // 2026-11-24 3B 真跑原始输出：计划获批后 plan_progress 与 write 以
  // 每行一个裸对象、无围栏的形式连发——旧「全文单对象」口径转不了。
  const text =
    '{"name": "plan_progress", "arguments": {"stepIndex": 0, "status": "done"}}\n' +
    '{"name": "write", "arguments": {"path": "greeting.txt", "content": "hello baimo\\nversion: 1\\nstatus: draft\\n"}}';
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 2);
  assert.equal(r.calls[0].name, "plan_progress");
  assert.equal(r.calls[1].name, "write");
  assert.equal(r.calls[1].arguments.content, "hello baimo\nversion: 1\nstatus: draft\n");
  assert.equal(r.remainingText, "");
});

test("A14 解析器：首尾相接裸对象中一个未知工具 → 只转已知的，未知对象原文保留", () => {
  const unknown = '{"name": "teleport", "arguments": {"to": "mars"}}';
  const text =
    '{"name": "bash", "arguments": {"command": "echo hi"}}\n' + unknown;
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].name, "bash");
  assert.equal(r.remainingText, unknown);
});

test("A15 解析器：裸对象之间夹说明文字 → 不转换（确定性口径不变）", () => {
  const text =
    '{"name": "bash", "arguments": {"command": "echo hi"}}\n' +
    "接下来写文件：\n" +
    '{"name": "write", "arguments": {"path": "a.txt", "content": "x"}}';
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 0);
  assert.equal(r.remainingText, text);
});

test("A16 解析器：顶层 JSON 数组 → 全部可转才转；含未知工具则全不转", () => {
  const good = JSON.stringify([
    { name: "bash", arguments: { command: "echo hi" } },
    { name: "write", arguments: { path: "a.txt", content: "x" } },
  ]);
  const r1 = parseLenientToolCalls(good, PARSER_TOOLS);
  assert.equal(r1.convertedCount, 2);
  assert.equal(r1.remainingText, "");
  const bad = JSON.stringify([
    { name: "bash", arguments: { command: "echo hi" } },
    { name: "teleport", arguments: { to: "mars" } },
  ]);
  const r2 = parseLenientToolCalls(bad, PARSER_TOOLS);
  assert.equal(r2.convertedCount, 0);
  assert.equal(r2.remainingText, bad);
});

test("A17 解析器：围栏块内首尾相接两个对象 → 整段转两个调用", () => {
  const text =
    "```json\n" +
    '{"name": "bash", "arguments": {"command": "echo one"}}\n' +
    '{"name": "bash", "arguments": {"command": "echo two"}}\n' +
    "```";
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 2);
  assert.equal(r.calls[0].arguments.command, "echo one");
  assert.equal(r.calls[1].arguments.command, "echo two");
  assert.equal(r.remainingText, "");
});

test("A18 解析器：字符串值内含大括号/转义 → 平衡扫描不被骗、内容逐字保真", () => {
  const content = 'if (a) { b("}"); }\nprint("{x}")\n';
  const text = JSON.stringify({
    name: "write",
    arguments: { path: "code.txt", content },
  });
  const r = parseLenientToolCalls(text, PARSER_TOOLS);
  assert.equal(r.convertedCount, 1);
  assert.equal(r.calls[0].arguments.content, content);
});

/* ================= B. 代理直测 ================= */

/** 发给代理的 tools（OpenAI 形态）：代理从中提取工具清单与 schema 做解析。 */
function openAiTools() {
  return PARSER_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, parameters: t.parameters },
  }));
}

/** 起 fixture 作上游 + 宽容代理，t.after 关干净。 */
async function openProxy(t) {
  const upstream = await createLenientModelServer();
  const proxy = await startLenientToolCallProxy({
    upstreamBaseUrl: upstream.url,
  });
  t.after(async () => {
    await proxy.close().catch(() => undefined);
    await upstream.close();
  });
  return { upstream, proxy };
}

async function postChat(proxy, body) {
  const res = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

test("B1 代理：非流式缺省剧本 → 文本调用转成原生 tool_calls 并带转换头", async (t) => {
  const { proxy } = await openProxy(t);
  const res = await postChat(proxy, {
    model: "lenient-model",
    messages: [{ role: "user", content: "请执行命令" }],
    tools: openAiTools(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-baimo-lenient-converted"), "1");
  const json = await res.json();
  const choice = json.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, "我来执行命令。");
  assert.equal(choice.message.tool_calls.length, 1);
  const tc = choice.message.tool_calls[0];
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "bash");
  assert.deepEqual(JSON.parse(tc.function.arguments), {
    command: LENIENT_DEFAULT_COMMAND,
  });
});

test("B2 代理：流式请求 → SSE 拼合能还原 content 与 tool_calls", async (t) => {
  const { proxy } = await openProxy(t);
  const res = await postChat(proxy, {
    model: "lenient-model",
    stream: true,
    messages: [{ role: "user", content: "请执行命令" }],
    tools: openAiTools(),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(res.headers.get("x-baimo-lenient-converted"), "1");
  const text = await res.text();
  // 小收集器：按 SSE data 行拼合 delta 的 content 与 tool_calls 分片。
  const acc = { content: "", name: "", arguments: "", finishReason: null };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length).trim();
    if (data === "[DONE]") continue;
    const chunk = JSON.parse(data);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") acc.content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      if (typeof tc.function?.name === "string") acc.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") {
        acc.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  }
  assert.equal(acc.content, "我来执行命令。");
  assert.equal(acc.name, "bash");
  assert.deepEqual(JSON.parse(acc.arguments), {
    command: LENIENT_DEFAULT_COMMAND,
  });
  assert.equal(acc.finishReason, "tool_calls");
});

test("B3 代理：原生 tool_calls 零介入透传，无转换头", async (t) => {
  const { proxy } = await openProxy(t);
  const res = await postChat(proxy, {
    model: "lenient-model",
    messages: [{ role: "user", content: "[[lenient:native]] 原生调用" }],
    tools: openAiTools(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-baimo-lenient-converted"), null);
  const json = await res.json();
  const choice = json.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, LENIENT_NATIVE_TEXT);
  assert.deepEqual(choice.message.tool_calls, [
    {
      id: "call_lenient_native_1",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: LENIENT_NATIVE_COMMAND }),
      },
    },
  ]);
});

test("B4 代理：模式回声缺 value → 无 tool_calls、无转换头、content 原样", async (t) => {
  const { proxy } = await openProxy(t);
  const res = await postChat(proxy, {
    model: "lenient-model",
    messages: [{ role: "user", content: "[[lenient:echo-bad]] 回声坏例" }],
    tools: openAiTools(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-baimo-lenient-converted"), null);
  const json = await res.json();
  const choice = json.choices[0];
  assert.equal(choice.message.tool_calls, undefined);
  assert.equal(choice.message.content, LENIENT_ECHO_BAD_TEXT);
  assert.equal(choice.finish_reason, "stop");
});

/* ================= C. 安全通路 E2E ================= */

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 开一个经宽容代理的会话：models.json 写 fixture 地址，宿主以
 * lenientProxy:true 启动——start 时应把回环 provider 的 baseUrl 改写为
 * 宿主代理地址（fixture 只作代理上游，会话流量全程过代理）。
 * gates 决定挂哪道门 extension；策略文件写法照 stage2 两份测试。
 */
async function openLenientSession(t, { gates, approvalMode = "build", planRequired = true }) {
  const fixture = await createLenientModelServer();
  const dataDir = makeTmp("baimo-lenient-data-");
  const workDir = makeTmp("baimo-lenient-work-");
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), lenientModelsJson(fixture.url), "utf8");
  const planStateFile = join(dataDir, "plan-state.json");
  const planPolicyFile = join(dataDir, "plan-policy.json");
  const apprPolicyFile = join(dataDir, "appr-policy.json");
  writeFileSync(
    planPolicyFile,
    JSON.stringify({ required: planRequired, paused: false }),
    "utf8",
  );
  writeFileSync(
    apprPolicyFile,
    JSON.stringify({ mode: approvalMode, grants: [] }),
    "utf8",
  );
  const host = new AgentHost({
    dataDir,
    env: { HOME: workDir },
    lenientProxy: true,
  });
  await host.start();
  const session = await host.openSession({
    title: "宽容解析会话",
    workspaceDir: workDir,
    piArgs: ["--provider", "lenient", "--model", "lenient-model", ...gates],
    env: {
      BAIMO_PLAN_STATE: planStateFile,
      BAIMO_PLAN_POLICY: planPolicyFile,
      BAIMO_APPROVAL_POLICY: apprPolicyFile,
    },
    modelRef: { provider: "lenient", modelId: "lenient-model" },
  });
  const events = [];
  session.on("event", (rec) => events.push(rec));
  t.after(async () => {
    await host.close().catch(() => undefined);
    await fixture.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const readPlan = () =>
    existsSync(planStateFile)
      ? JSON.parse(readFileSync(planStateFile, "utf8"))
      : null;
  return { fixture, host, session, events, workDir, readPlan };
}

/**
 * 发一轮 prompt 并自动批准计划（promptApprovePlan 式，照本地模型验收）：
 * 计划 select 一律回「批准执行」，记录首次裁决时的计划状态（事前落盘证据）；
 * editor 一律取消（本剧本不走编辑路径）。
 */
async function promptApprovePlan(session, message, readPlan) {
  const seen = { selects: 0, planAtSelect: null };
  const listener = (rec) => {
    if (rec?.type !== "extension_ui_request") return;
    let payload = null;
    try {
      payload = JSON.parse(rec.title ?? "");
    } catch {
      /* 非计划请求 */
    }
    if (payload?.baimoPlan !== 1) return;
    if (rec.method === "select") {
      seen.selects += 1;
      if (!seen.planAtSelect) seen.planAtSelect = readPlan();
      session.respondExtensionUi(rec.id, { value: "批准执行" });
    } else if (rec.method === "editor") {
      session.respondExtensionUi(rec.id, { cancelled: true });
    }
  };
  session.on("event", listener);
  try {
    const outcome = await session.prompt(message, { timeoutMs: 120_000 });
    return { outcome, seen };
  } finally {
    session.removeListener("event", listener);
  }
}

function toolEnds(events, toolName) {
  return events.filter(
    (e) => e.type === "tool_execution_end" && e.toolName === toolName,
  );
}

test(
  "C1 安全通路：文本 submit_plan 经代理转换后走计划裁决，批准后逐步落盘至 completed",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { host, session, events, workDir, readPlan } = await openLenientSession(t, {
      gates: [
        "--extension",
        approvalGateExtensionPath(),
        "--extension",
        planGateExtensionPath(),
      ],
    });
    // 宿主应已为回环 provider 建好代理路由（改写真实发生，不是直连 fixture）
    assert.ok(Array.isArray(host.lenientProxyRoutes));
    assert.ok(host.lenientProxyRoutes.length >= 1, "应有一条宽容代理路由");

    const { outcome, seen } = await promptApprovePlan(
      session,
      "[[lenient:plan]] 完成一件事",
      readPlan,
    );
    assert.equal(outcome.disposition, "started");
    assert.equal(seen.selects, 1, "转换出的 submit_plan 应触发一次计划裁决");
    // 裁决发生时计划已落盘为待批准（事前计划，与原生调用同口径）
    assert.equal(seen.planAtSelect?.status, "awaiting_approval");
    assert.deepEqual(
      seen.planAtSelect.steps.map((s) => s.title),
      LENIENT_PLAN_STEPS.map((s) => s.title),
    );
    // 执行真实发生且顺序正确：submit_plan 先于 write
    const names = events
      .filter((e) => e.type === "tool_execution_start")
      .map((e) => e.toolName);
    assert.ok(names.indexOf("submit_plan") >= 0);
    assert.ok(names.indexOf("submit_plan") < names.indexOf("write"));
    assert.equal(
      readFileSync(join(workDir, LENIENT_PLAN_PATH), "utf8"),
      LENIENT_PLAN_CONTENT,
    );
    const plan = readPlan();
    assert.equal(plan.status, "completed");
    assert.deepEqual(
      plan.steps.map((s) => s.status),
      ["done", "done", "done"],
    );
    assert.equal(toolEnds(events, "plan_progress").length, 3);
  },
);

test(
  "C2 安全通路：计划门硬拦——不交计划的文本 write 被 tool_call 层拦截，文件不存在",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openLenientSession(t, {
      gates: [
        "--extension",
        approvalGateExtensionPath(),
        "--extension",
        planGateExtensionPath(),
      ],
    });
    // 不裁决任何东西：write-first 剧本根本不提交计划，直接 prompt 等结算。
    const outcome = await session.prompt("[[lenient:write-first]] 直接写", {
      timeoutMs: 120_000,
    });
    assert.equal(outcome.disposition, "started");
    assert.ok(
      !existsSync(join(workDir, LENIENT_WRITE_FIRST_PATH)),
      "被计划门拦下的 write 不得落盘",
    );
    // 拦截痕迹（照 stage2 计划门测试口径）：write 以 isError 收尾且理由含「计划先行」
    const ends = toolEnds(events, "write");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].isError, true, "被拦的 write 应以错误收尾");
    assert.ok(
      JSON.stringify(events).includes("计划先行"),
      "计划门拦截理由应作为工具结果回到 agent",
    );
    // 会话最终以文本收尾（模型收到拦截理由后回了收尾文本）
    assert.ok(JSON.stringify(events).includes(LENIENT_FINAL_TEXT));
  },
);

test(
  "C3 安全通路：审批门拦截危险命令——文本 bash 经转换后弹卡，拒绝后不执行",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openLenientSession(t, {
      gates: ["--extension", approvalGateExtensionPath()],
      approvalMode: "build",
    });
    // 预建危险命令的目标目录：命令若真执行，目录会被 rm -rf 删掉。
    const target = join(workDir, "lenient-danger-target");
    mkdirSync(target, { recursive: true });

    // 照 stage2-approval 的应答法：监听 select 审批请求并回「拒绝」。
    const requests = [];
    const listener = (rec) => {
      if (rec?.type === "extension_ui_request" && rec.method === "select") {
        requests.push(rec);
        session.respondExtensionUi(rec.id, { value: "拒绝" });
      }
    };
    session.on("event", listener);
    let outcome;
    try {
      outcome = await session.prompt("[[lenient:danger]] 请清理", {
        timeoutMs: 120_000,
      });
    } finally {
      session.removeListener("event", listener);
    }
    assert.equal(outcome.disposition, "started");
    assert.equal(requests.length, 1, "转换出的危险 bash 应进审批门弹卡一次");
    const payload = JSON.parse(requests[0].title);
    assert.equal(payload.tool, "bash");
    assert.equal(payload.danger, true);
    assert.equal(payload.args.command, LENIENT_DANGER_COMMAND);
    assert.ok(existsSync(target), "被拒绝的危险命令不得执行，目标目录应仍在");
    assert.equal(
      toolEnds(events, "bash").filter((e) => e.isError !== true).length,
      0,
      "被拒绝的 bash 不得执行成功",
    );
    assert.ok(
      JSON.stringify(events).includes("审批未通过"),
      "拒绝理由应作为工具结果回到 agent",
    );
  },
);
