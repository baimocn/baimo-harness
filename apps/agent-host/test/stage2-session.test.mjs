/*** 阶段 2 · 模块 1：会话续接（resume）+ 停止（abort）—— agent-host E2E *****
 * 续接：会话落盘后换一个全新的 AgentHost 实例（模拟应用重启）resume 同一会话，
 * 再发一轮 prompt；断言桩模型收到的请求带着第一轮的 prompt 与工具结果
 * （上下文真的续上，不是新会话冒充）。
 * 停止：hang 桩让运行挂住，abort() 后运行以 disposition=aborted 结算，
 * 落盘是 run_stopped 而非 run_settled，会话保持 live 且可继续用（get_state 正常）。
 * 无 Pi 会话文件的会话 resume 必须大声失败（SESSION_NOT_RESUMABLE）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 180_000;

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

async function waitFor(cond, timeoutMs = 30_000, label = "条件") {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function writeStubModels(dataDir, url) {
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(url), "utf8");
}

const STUB_ARGS = ["--provider", "stub", "--model", "stub-model"];
const STUB_REF = { provider: "stub", modelId: "stub-model" };

test(
  "续接：重启宿主后 resume 同一会话，第二轮请求带第一轮上下文",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-resume-data-");
    const workDir = makeTmp("baimo-resume-work-");
    writeStubModels(dataDir, stub.url);
    let sessionId;
    let piSessionId;

    const host1 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host1.start();
      const s1 = await host1.openSession({
        title: "续接会话",
        workspaceDir: workDir,
        piArgs: STUB_ARGS,
        modelRef: STUB_REF,
      });
      sessionId = s1.id;
      piSessionId = s1.meta.piSessionId;
      assert.ok(s1.meta.piSessionFile, "新会话应记录 Pi 会话文件（可续接前提）");
      const out1 = await s1.prompt("第一轮：请执行工具", { timeoutMs: 90_000 });
      assert.equal(out1.disposition, "started");
      assert.equal(stub.requests.length, 2);
      await s1.close();
      assert.equal(s1.meta.status, "closed");
    } finally {
      await host1.close();
    }

    // 全新宿主实例（模拟应用重启）：会话只剩落盘记录
    const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host2.start();
      assert.equal(host2.getLiveSession(sessionId), undefined);
      const s2 = await host2.resumeSession(sessionId, { piArgs: STUB_ARGS });
      assert.equal(s2.meta.status, "live");
      assert.equal(s2.meta.piSessionId, piSessionId, "续接后应是同一个 Pi 会话");

      const before = stub.requests.length;
      const out2 = await s2.prompt("第二轮：继续", { timeoutMs: 90_000 });
      assert.equal(out2.disposition, "started");
      assert.ok(stub.requests.length > before, "第二轮应产生新的模型请求");
      const firstReqOfRun2 = JSON.stringify(stub.requests[before].messages ?? []);
      assert.ok(
        firstReqOfRun2.includes("第一轮：请执行工具"),
        "续接后的首个请求必须带第一轮 prompt（上下文真续上）",
      );
      assert.ok(
        firstReqOfRun2.includes("stub-tool-ok"),
        "续接后的首个请求必须带第一轮工具结果",
      );

      const loaded = host2.loadSession(sessionId);
      const lifecycle = loaded.events
        .filter((e) => e.kind === "lifecycle")
        .map((e) => e.event);
      assert.ok(lifecycle.includes("session_resumed"));
      assert.equal(
        lifecycle.filter((e) => e === "run_settled").length,
        2,
        "两轮都应正常结算",
      );
      await s2.close();
    } finally {
      await host2.close();
      await stub.close();
      cleanup(dataDir, workDir);
    }
  },
);

test(
  "停止：hang 中 abort → 已停止结算（run_stopped 落盘），会话保持可用",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const stub = await createStubModelServer({ hang: true });
    const dataDir = makeTmp("baimo-abort-data-");
    const workDir = makeTmp("baimo-abort-work-");
    writeStubModels(dataDir, stub.url);
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const session = await host.openSession({
        title: "停止会话",
        workspaceDir: workDir,
        piArgs: STUB_ARGS,
        modelRef: STUB_REF,
      });

      // 无运行时 abort 返回 false，不假装
      assert.equal(await session.abort(), false);

      const outcome = session
        .prompt("会挂住的问题")
        .then((o) => ({ ok: true, o }), (err) => ({ ok: false, err }));
      await waitFor(() => session.busy, 30_000, "运行进入 busy");
      await waitFor(() => stub.requests.length >= 1, 30_000, "桩模型收到请求");

      assert.equal(await session.abort(), true);
      const res = await outcome;
      assert.ok(res.ok, `停止后 prompt 应正常结算而非报错: ${res.err ?? ""}`);
      assert.equal(res.o.disposition, "aborted");
      assert.equal(session.busy, false);

      // 落盘口径：run_stopped 有、run_settled 无，会话仍 live
      const loaded = host.loadSession(session.id);
      const lifecycle = loaded.events
        .filter((e) => e.kind === "lifecycle")
        .map((e) => e.event);
      assert.ok(lifecycle.includes("run_stop_requested"));
      assert.ok(lifecycle.includes("run_stopped"));
      assert.ok(!lifecycle.includes("run_settled"), "已停止的运行不许记为完成");
      assert.equal(session.meta.status, "live");

      // 会话仍可用：get_state 正常且不在流式中
      const state = await session.getState();
      assert.equal(state.success, true);
      assert.equal(state.data.isStreaming, false);

      await session.close();
      assert.equal(session.meta.status, "closed");
    } finally {
      await host.close();
      await stub.close();
      cleanup(dataDir, workDir);
    }
  },
);

test(
  "续接拒绝：没有 Pi 会话文件的会话 resume 大声失败",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const dataDir = makeTmp("baimo-noresume-data-");
    const workDir = makeTmp("baimo-noresume-work-");
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const session = await host.openSession({
        title: "待伪造会话",
        workspaceDir: workDir,
      });
      await session.close();
      // 模拟旧版（--no-session 时代）落盘：抹掉 Pi 会话文件记录
      const { SessionStore } = await import("../dist/index.js");
      const store = new SessionStore(dataDir);
      store.init();
      store.updateMeta(session.id, { piSessionFile: null });

      const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
      try {
        await host2.start();
        await assert.rejects(
          host2.resumeSession(session.id),
          (err) => err.code === "SESSION_NOT_RESUMABLE",
        );
      } finally {
        await host2.close();
      }
    } finally {
      await host.close();
      cleanup(dataDir, workDir);
    }
  },
);
