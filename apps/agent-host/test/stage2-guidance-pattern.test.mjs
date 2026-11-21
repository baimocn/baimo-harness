/*** 阶段 2 · 引导簇模块 4 宿主 E2E：D-01 第三级授权（按命令模式持久允许） *****
 * 编辑模式下，非危险 bash 的审批多一档「按命令模式始终允许」：裁决后
 * 审批门把命令头前缀规则（如 `touch *`）落盘进策略 patternGrants；
 * 后续同命令头命令免问、不同命令头照常问；危险命令永不豁免——已授
 * `rm *` 时 `rm -rf` 仍必须弹卡。全部以文件系统状态 + 策略文件 + 审批
 * 请求次数为断言依据。
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
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;
const GATE = approvalGateExtensionPath();
const OPT_PATTERN = "按命令模式始终允许";
const OPT_DENY = "拒绝";

async function openGatedSession(t) {
  const stub = await createStubModelServer();
  const dataDir = mkdtempSync(join(tmpdir(), "baimo-pat-data-"));
  const workDir = mkdtempSync(join(tmpdir(), "baimo-pat-work-"));
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
  const policyFile = join(dataDir, "approval-policy.json");
  writeFileSync(policyFile, JSON.stringify({ mode: "edit", grants: [] }), "utf8");
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  const session = await host.openSession({
    title: "模式授权会话",
    workspaceDir: workDir,
    piArgs: ["--provider", "stub", "--model", "stub-model", "--extension", GATE],
    env: { BAIMO_APPROVAL_POLICY: policyFile },
    modelRef: { provider: "stub", modelId: "stub-model" },
  });
  t.after(async () => {
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  return { session, workDir, policyFile };
}

/** 发一轮 prompt；decide(rec) 返回裁决选项原文（不返回则不裁决）。 */
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

test(
  "模式授权：授 `touch *` 后同头免问、异头照常问、规则落盘可查",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, workDir, policyFile } = await openGatedSession(t);

    // A：首次 touch → 弹卡且选项含模式档 → 按模式允许 → 执行 + 落盘
    const a = await promptWithApprovals(
      session,
      "执行 [[stub:bash:touch stub-p-a]]",
      (rec) => {
        assert.ok(
          (rec.options ?? []).includes(OPT_PATTERN),
          "非危险 bash 的审批必须提供「按命令模式始终允许」档",
        );
        return OPT_PATTERN;
      },
    );
    assert.equal(a.requests.length, 1);
    assert.ok(existsSync(join(workDir, "stub-p-a")), "获准的命令应已执行");
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.deepEqual(policy.patternGrants, [
      { tool: "bash", pattern: "touch *" },
    ]);

    // B：同命令头 touch → 免问直接执行
    const b = await promptWithApprovals(
      session,
      "执行 [[stub:bash:touch stub-p-b]]",
      null,
    );
    assert.equal(b.requests.length, 0, "命中模式的命令不得再弹卡");
    assert.ok(existsSync(join(workDir, "stub-p-b")));

    // C：不同命令头 mkdir → 照常弹卡 → 拒绝 → 不执行
    const c = await promptWithApprovals(
      session,
      "执行 [[stub:bash:mkdir stub-dir-c]]",
      () => OPT_DENY,
    );
    assert.equal(c.requests.length, 1, "未命中模式的命令必须照常审批");
    assert.ok(!existsSync(join(workDir, "stub-dir-c")), "被拒绝的命令不得执行");
  },
);

test(
  "危险永不豁免：已授 `rm *` 后 `rm -rf` 仍弹卡，拒绝后目标完好",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session, workDir } = await openGatedSession(t);
    writeFileSync(join(workDir, "stub-d1"), "x", "utf8");
    mkdirSync(join(workDir, "stub-d2"));
    writeFileSync(join(workDir, "stub-d2", "keep.txt"), "x", "utf8");

    // 先授 rm *（普通 rm 非危险，可按模式授权）
    const a = await promptWithApprovals(
      session,
      "执行 [[stub:bash:rm stub-d1]]",
      () => OPT_PATTERN,
    );
    assert.equal(a.requests.length, 1);
    assert.ok(!existsSync(join(workDir, "stub-d1")), "普通 rm 应已执行");

    // rm -rf 命中危险清单：即便有 rm * 模式授权也必须弹卡
    const b = await promptWithApprovals(
      session,
      "执行 [[stub:bash:rm -rf stub-d2]]",
      (rec) => {
        assert.ok(
          !(rec.options ?? []).includes(OPT_PATTERN),
          "危险命令的审批不得提供模式授权档",
        );
        return OPT_DENY;
      },
    );
    assert.equal(b.requests.length, 1, "危险命令永不豁免，必须弹卡");
    assert.ok(
      existsSync(join(workDir, "stub-d2", "keep.txt")),
      "被拒绝的危险命令不得执行",
    );
  },
);
