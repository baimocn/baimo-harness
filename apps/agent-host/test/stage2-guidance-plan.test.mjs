/*** 阶段 2 · 引导簇模块 1：计划面板（M-03）—— agent-host E2E *****
 * 机制实证（非假计划）：计划门是跑在 Pi 进程内的扩展（--extension），
 * 注册 submit_plan / plan_progress 两个真实工具：
 * - submit_plan 在 execute 内先落盘计划状态（awaiting_approval），再经
 *   ctx.ui.select/editor 的 RPC 阻塞往返等用户裁决，批准后才返回定稿；
 * - 步骤进度只由 plan_progress 的真实调用驱动（断言状态文件逐步变化）；
 * - 「先审后行」是 tool_call 层硬拦：required 且本轮未获批准时写类工具
 *   以 isError 收尾、文件不变，不是靠提示词自觉；
 * - 暂停（策略文件 paused）同样在 tool_call 层拦截，状态转 paused。
 * 桩模型按 [[stub:plan]] 剧本扮演守流程的模型（提交→逐步执行→回报）。
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
} from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
  STUB_PLAN_STEPS,
  STUB_WRITE_CONTENT,
  STUB_WRITE_PATH,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;
const GATE_ARGS = [
  "--extension",
  approvalGateExtensionPath(),
  "--extension",
  planGateExtensionPath(),
];

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function openPlanSession(t, { required = true, chunkDelayMs = 5 } = {}) {
  const stub = await createStubModelServer({ chunkDelayMs });
  const dataDir = makeTmp("baimo-plan-data-");
  const workDir = makeTmp("baimo-plan-work-");
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
  const planStateFile = join(dataDir, "plan-state.json");
  const planPolicyFile = join(dataDir, "plan-policy.json");
  const apprPolicyFile = join(dataDir, "appr-policy.json");
  const writePlanPolicy = (p) =>
    writeFileSync(planPolicyFile, JSON.stringify(p), "utf8");
  writePlanPolicy({ required, paused: false });
  // 审批门用 build 模式与计划流程隔离（普通写自动过、危险命令仍拦）
  writeFileSync(
    apprPolicyFile,
    JSON.stringify({ mode: "build", grants: [] }),
    "utf8",
  );
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  const session = await host.openSession({
    title: "计划会话",
    workspaceDir: workDir,
    piArgs: ["--provider", "stub", "--model", "stub-model", ...GATE_ARGS],
    env: {
      BAIMO_PLAN_STATE: planStateFile,
      BAIMO_PLAN_POLICY: planPolicyFile,
      BAIMO_APPROVAL_POLICY: apprPolicyFile,
    },
    modelRef: { provider: "stub", modelId: "stub-model" },
  });
  const events = [];
  session.on("event", (rec) => events.push(rec));
  t.after(async () => {
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const readPlan = () =>
    existsSync(planStateFile)
      ? JSON.parse(readFileSync(planStateFile, "utf8"))
      : null;
  return { stub, host, session, events, workDir, readPlan, writePlanPolicy };
}

/**
 * 发一轮 prompt 并自动裁决计划请求：
 * decide({selects, editors, payload}) → 返回 select 选项原文或 editor 文本；
 * 返回 null 表示不裁决该请求。
 */
async function promptWithPlan(session, message, decide) {
  const seen = { selects: [], editors: [] };
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
      seen.selects.push(payload);
      const v = decide?.({ kind: "select", seen, payload });
      if (v) session.respondExtensionUi(rec.id, { value: v });
    } else if (rec.method === "editor") {
      seen.editors.push(rec);
      const v = decide?.({ kind: "editor", seen, payload, prefill: rec.prefill });
      if (typeof v === "string") {
        session.respondExtensionUi(rec.id, { value: v });
      } else if (v === null) {
        session.respondExtensionUi(rec.id, { cancelled: true });
      }
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
  "批准路径：计划先落盘待批准，批准后逐步执行，进度由 plan_progress 真实驱动至 completed",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir, readPlan } = await openPlanSession(t);
    let planAtSelect = null;
    const { outcome, seen } = await promptWithPlan(
      session,
      "[[stub:plan]] 完成一件事",
      ({ kind }) => {
        if (kind === "select") {
          planAtSelect = readPlan();
          return "批准执行";
        }
        return undefined;
      },
    );
    assert.equal(outcome.disposition, "started");
    assert.equal(seen.selects.length, 1);
    // 裁决发生时计划已落盘为待批准（事前计划，不是事后总结）
    assert.equal(planAtSelect.status, "awaiting_approval");
    assert.deepEqual(
      planAtSelect.steps.map((s) => s.title),
      STUB_PLAN_STEPS.map((s) => s.title),
    );
    assert.ok(planAtSelect.task.includes("[[stub:plan]]"));
    // 执行真实发生且顺序正确：submit_plan 先于 write
    const names = events
      .filter((e) => e.type === "tool_execution_start")
      .map((e) => e.toolName);
    assert.ok(names.indexOf("submit_plan") >= 0);
    assert.ok(names.indexOf("submit_plan") < names.indexOf("write"));
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );
    // 最终状态：全部步 done、计划 completed
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
  "编辑路径：editor 逐行改计划（删步+改名），定稿按编辑后的步骤执行",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, workDir, readPlan } = await openPlanSession(t);
    const editedText = "第一步：查看现状\n第二步：写入文件（改名）";
    const { seen } = await promptWithPlan(
      session,
      "[[stub:plan]] 编辑计划",
      ({ kind, seen: s }) => {
        if (kind === "select") {
          return s.selects.length === 1 ? "编辑计划" : "批准执行";
        }
        if (kind === "editor") return editedText;
        return undefined;
      },
    );
    assert.equal(seen.selects.length, 2, "编辑后应回到 select 再裁决");
    assert.equal(seen.editors.length, 1);
    assert.ok(
      String(seen.editors[0].prefill).includes("第三步：收尾检查"),
      "editor 应以原计划逐行预填",
    );
    const plan = readPlan();
    assert.deepEqual(
      plan.steps.map((s) => s.title),
      ["第一步：查看现状", "第二步：写入文件（改名）"],
      "定稿计划必须是编辑后的两步",
    );
    assert.equal(plan.status, "completed");
    assert.ok(existsSync(join(workDir, STUB_WRITE_PATH)));
  },
);

test(
  "拒绝路径：状态 rejected、写操作零执行、未获批准理由回到 agent",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir, readPlan } = await openPlanSession(t);
    const { outcome } = await promptWithPlan(
      session,
      "[[stub:plan]] 不要执行",
      ({ kind }) => (kind === "select" ? "拒绝计划" : undefined),
    );
    assert.equal(outcome.disposition, "started");
    const plan = readPlan();
    assert.equal(plan.status, "rejected");
    assert.ok(!existsSync(join(workDir, STUB_WRITE_PATH)), "拒绝后不得写文件");
    assert.equal(
      toolEnds(events, "write").filter((e) => e.isError !== true).length,
      0,
      "write 不得成功执行",
    );
    assert.ok(
      JSON.stringify(events).includes("未获批准"),
      "未获批准应作为 submit_plan 结果回到 agent",
    );
  },
);

test(
  "先审后行硬拦：required 下不提交计划直接写，tool_call 层拦截且文件不变",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openPlanSession(t);
    const outcome = await session.prompt("[[stub:write]] 直接写", {
      timeoutMs: 120_000,
    });
    assert.equal(outcome.disposition, "started");
    const ends = toolEnds(events, "write");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].isError, true, "被拦的 write 应以错误收尾");
    assert.ok(JSON.stringify(events).includes("计划先行"));
    assert.ok(!existsSync(join(workDir, STUB_WRITE_PATH)));
  },
);

test(
  "失败路径：某步回报 failed → 计划 completed_with_failures 且该步标 failed",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, readPlan } = await openPlanSession(t);
    await promptWithPlan(session, "[[stub:plan-fail]] 会失败的计划", ({ kind }) =>
      kind === "select" ? "批准执行" : undefined,
    );
    const plan = readPlan();
    assert.equal(plan.status, "completed_with_failures");
    assert.deepEqual(
      plan.steps.map((s) => s.status),
      ["done", "failed", "pending"],
    );
  },
);

test(
  "暂停：执行中置 paused → 后续工具被拦、状态转 paused、文件未写；解除后新一轮可走完",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir, readPlan, writePlanPolicy } =
      await openPlanSession(t, { chunkDelayMs: 150 });
    const runPromise = promptWithPlan(
      session,
      "[[stub:plan]] 暂停测试",
      ({ kind }) => (kind === "select" ? "批准执行" : undefined),
    );
    // 等计划进入 executing 后置暂停（轮询状态文件，不靠固定睡眠猜时序）
    const deadline = Date.now() + 30_000;
    for (;;) {
      const p = readPlan();
      if (p?.status === "executing") break;
      if (Date.now() > deadline) throw new Error("计划未进入 executing");
      await new Promise((r) => setTimeout(r, 50));
    }
    writePlanPolicy({ required: true, paused: true });
    const { outcome } = await runPromise;
    assert.equal(outcome.disposition, "started");
    const plan = readPlan();
    assert.equal(plan.status, "paused", "计划应停在 paused，不得冒充完成");
    assert.ok(
      plan.steps.some((s) => s.status === "pending"),
      "应有未执行的步骤留待恢复",
    );
    assert.ok(!existsSync(join(workDir, STUB_WRITE_PATH)), "暂停后不得写文件");
    assert.ok(
      JSON.stringify(events).includes("计划已被用户暂停"),
      "暂停拦截理由应回到 agent",
    );

    // 解除暂停 → 新一轮重新提交计划并走完（真实模型亦可重新规划续跑）
    writePlanPolicy({ required: true, paused: false });
    await promptWithPlan(session, "[[stub:plan]] 继续完成", ({ kind }) =>
      kind === "select" ? "批准执行" : undefined,
    );
    const plan2 = readPlan();
    assert.equal(plan2.status, "completed");
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );
  },
);

test(
  "未开启 required：计划门不介入，普通写直接执行、无任何计划请求",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir, readPlan } = await openPlanSession(t, {
      required: false,
    });
    const outcome = await session.prompt("[[stub:write]] 直接写", {
      timeoutMs: 120_000,
    });
    assert.equal(outcome.disposition, "started");
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );
    assert.equal(
      events.filter((e) => e.type === "extension_ui_request").length,
      0,
      "未开启计划先行时不得出现计划/审批请求",
    );
    assert.equal(readPlan(), null, "不得生成计划状态");
  },
);
