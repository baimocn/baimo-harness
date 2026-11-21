/*** 阶段 2 · 模块 4：权限模式与分级审批 —— agent-host E2E *****
 * 机制实证（非假拦截）：审批门是跑在 Pi 进程内的扩展（--extension），
 * 在 tool_call 事件上裁决；编辑/构建模式的审批经 ctx.ui.select 的
 * RPC 往返（extension_ui_request → 宿主 respondExtensionUi）阻塞等待，
 * 拒绝时扩展 return { block: true, reason }，工具根本不执行。
 * 逐模式断言：文件系统状态 + 事件流（tool_execution_end 成败——Pi 在门
 * 裁决前就发 start，被拦的调用以 isError 收尾；拦截理由是否作为工具
 * 结果回到 agent）+ 审批请求次数。
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
import { AgentHost, approvalGateExtensionPath } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
  STUB_WRITE_CONTENT,
  STUB_WRITE_PATH,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 180_000;
const GATE = approvalGateExtensionPath();

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeStubModels(dataDir, url) {
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(url), "utf8");
}

/** 开一个带审批门的会话；policy 文件由测试控制（模拟壳层改模式）。 */
async function openGatedSession(t, mode) {
  const stub = await createStubModelServer();
  const dataDir = makeTmp("baimo-appr-data-");
  const workDir = makeTmp("baimo-appr-work-");
  writeStubModels(dataDir, stub.url);
  const policyFile = join(dataDir, "approval-policy.json");
  const writePolicy = (m, grants = []) =>
    writeFileSync(policyFile, JSON.stringify({ mode: m, grants }), "utf8");
  writePolicy(mode);
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  const session = await host.openSession({
    title: `审批会话-${mode}`,
    workspaceDir: workDir,
    piArgs: ["--provider", "stub", "--model", "stub-model", "--extension", GATE],
    env: { BAIMO_APPROVAL_POLICY: policyFile },
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
  return { stub, host, session, events, workDir, policyFile, writePolicy };
}

/**
 * 发一轮 prompt；decide(req) 给出裁决（选项原文）则立即回复审批请求，
 * 返回 null 表示不裁决（用于断言「根本没弹卡」的场景）。
 */
async function promptWithApprovals(session, message, decide) {
  const requests = [];
  const listener = (rec) => {
    if (rec?.type === "extension_ui_request" && rec.method === "select") {
      requests.push(rec);
      const value = decide?.(rec);
      if (value) session.respondExtensionUi(rec.id, { value });
    }
  };
  session.on("event", listener);
  try {
    const outcome = await session.prompt(message, { timeoutMs: 90_000 });
    return { outcome, requests };
  } finally {
    session.removeListener("event", listener);
  }
}

/**
 * 成功执行过的工具调用数。注意：Pi 在扩展门裁决前就发 tool_execution_start，
 * 被拦的调用也会有 start；判据看 tool_execution_end——被拦时 isError=true
 * 且结果是拦截理由，文件系统状态由各用例另外断言。
 */
function toolSuccesses(events, toolName) {
  return events.filter(
    (e) =>
      e.type === "tool_execution_end" &&
      e.toolName === toolName &&
      e.isError !== true,
  );
}

test(
  "计划模式：write 与危险 bash 一律拦截，文件未变，理由回到 agent 且有显形通知",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openGatedSession(t, "plan");
    const r1 = await promptWithApprovals(session, "[[stub:write]] 请写文件", null);
    assert.equal(r1.outcome.disposition, "started");
    assert.equal(r1.requests.length, 0, "计划模式不弹卡、直接拦截");
    assert.ok(!existsSync(join(workDir, STUB_WRITE_PATH)), "文件不得被创建");

    const r2 = await promptWithApprovals(session, "[[stub:bash-danger]] 请清理", null);
    assert.equal(r2.outcome.disposition, "started");
    assert.equal(toolSuccesses(events, "write").length, 0);
    assert.equal(toolSuccesses(events, "bash").length, 0, "危险 bash 不得执行成功");
    const all = JSON.stringify(events);
    assert.ok(all.includes("计划模式"), "拦截理由应作为工具结果回到 agent");
    assert.ok(
      events.some(
        (e) =>
          e.type === "extension_ui_request" &&
          e.method === "notify" &&
          String(e.message).includes("已拦截"),
      ),
      "拦截应有 notify 显形",
    );
  },
);

test(
  "编辑模式：审批卡拒绝 → 不执行；允许一次 → 执行落盘",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openGatedSession(t, "edit");
    const denied = await promptWithApprovals(
      session,
      "[[stub:write]] 请写文件",
      (req) => {
        const payload = JSON.parse(req.title);
        assert.equal(payload.baimoApproval, 1);
        assert.equal(payload.tool, "write");
        assert.equal(payload.args.path, STUB_WRITE_PATH);
        assert.deepEqual(req.options, ["允许一次", "本会话始终允许", "拒绝"]);
        return "拒绝";
      },
    );
    assert.equal(denied.requests.length, 1);
    assert.ok(!existsSync(join(workDir, STUB_WRITE_PATH)), "拒绝后文件不得创建");
    assert.ok(
      JSON.stringify(events).includes("审批未通过"),
      "拒绝理由应回到 agent",
    );

    const allowed = await promptWithApprovals(
      session,
      "[[stub:write]] 请写文件",
      () => "允许一次",
    );
    assert.equal(allowed.requests.length, 1);
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );
  },
);

test(
  "编辑模式：本会话始终允许 → 同工具第二次免问，且授权落盘",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, workDir, policyFile } = await openGatedSession(t, "edit");
    const first = await promptWithApprovals(
      session,
      "[[stub:write]] 请写文件",
      () => "本会话始终允许",
    );
    assert.equal(first.requests.length, 1);
    assert.ok(existsSync(join(workDir, STUB_WRITE_PATH)));
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.ok(policy.grants.includes("write"), "授权应落盘进策略文件");

    rmSync(join(workDir, STUB_WRITE_PATH));
    const second = await promptWithApprovals(
      session,
      "[[stub:write]] 再写一次",
      null,
    );
    assert.equal(second.requests.length, 0, "已授权工具不得再弹卡");
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );
  },
);

test(
  "构建模式：普通写自动过；危险 bash 弹卡，拒绝后不执行",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openGatedSession(t, "build");
    const before = events.length;
    const write = await promptWithApprovals(
      session,
      "[[stub:write]] 请写文件",
      null,
    );
    assert.equal(write.requests.length, 0, "构建模式普通写不弹卡");
    assert.equal(
      readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
      STUB_WRITE_CONTENT,
    );

    const danger = await promptWithApprovals(
      session,
      "[[stub:bash-danger]] 请清理",
      (req) => {
        const payload = JSON.parse(req.title);
        assert.equal(payload.danger, true);
        assert.ok(payload.reason.includes("危险命令"));
        return "拒绝";
      },
    );
    assert.equal(danger.requests.length, 1, "危险命令必须弹卡");
    const runEvents = events.slice(before);
    assert.equal(
      toolSuccesses(runEvents, "bash").length,
      0,
      "被拒绝的危险 bash 不得执行成功",
    );
  },
);

test(
  "YOLO 模式：write 与危险 bash 全自动，无任何审批请求",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, events, workDir } = await openGatedSession(t, "yolo");
    const r1 = await promptWithApprovals(session, "[[stub:write]] 请写文件", null);
    assert.equal(r1.requests.length, 0);
    assert.ok(existsSync(join(workDir, STUB_WRITE_PATH)));
    const r2 = await promptWithApprovals(session, "[[stub:bash-danger]] 请清理", null);
    assert.equal(r2.requests.length, 0);
    assert.ok(
      toolSuccesses(events, "bash").length >= 1,
      "YOLO 下危险 bash 应真实执行成功（tool_execution_end 非错误）",
    );
  },
);
