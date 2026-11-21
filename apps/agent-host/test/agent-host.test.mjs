/*** agent-host 端到端测试 *****
 * 覆盖：宿主启动+握手、RPC 协议容错、会话落盘+重启重载+尾部损坏恢复、
 * 坏配置拒绝启动（K-03）、命令错误显形（K-01）、运行中杀进程的异常终止
 * 显形（K-02）、桩模型完整轮次（流式文本+工具调用+落盘可查）。
 * 模型一律走本地桩服务器（fixtures/stub-model-server.mjs），不碰真实账号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  appendFileSync,
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
  RpcClient,
} from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 120_000;

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

/** 在 dataDir 的 Pi 配置目录里写好指向桩服务器的 models.json。 */
function writeStubModels(dataDir, url) {
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(url), "utf8");
}

test(
  "宿主启动+握手：get_state 成功、遥测三重关闭落地、命令错误显形（K-01）",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const dataDir = makeTmp("baimo-host-data-");
    const workDir = makeTmp("baimo-host-work-");
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const session = await host.openSession({
        title: "握手会话",
        workspaceDir: workDir,
      });
      assert.equal(typeof session.meta.piSessionId, "string");
      assert.ok(session.meta.piSessionId.length > 0);

      // 遥测三重关闭：env 强制变量 + settings 写死
      assert.equal(session.process.spawnedEnv.PI_TELEMETRY, "0");
      assert.equal(session.process.spawnedEnv.PI_SKIP_VERSION_CHECK, "1");
      assert.equal(
        session.process.spawnedEnv.PI_CODING_AGENT_DIR,
        join(dataDir, "pi-agent"),
      );
      const settings = JSON.parse(
        readFileSync(join(dataDir, "pi-agent", "settings.json"), "utf8"),
      );
      assert.equal(settings.enableInstallTelemetry, false);

      const state = await session.getState();
      assert.equal(state.success, true);

      // K-01：未知命令的 success:false 必须以类型化错误显形，不许吞
      await assert.rejects(
        session.command({ type: "definitely_not_a_command" }),
        (err) => err.code === "RPC_COMMAND_FAILED" && /Unknown command/.test(err.piError),
      );

      await session.close();
      assert.equal(session.meta.status, "closed");
    } finally {
      await host.close();
      cleanup(dataDir, workDir);
    }
  },
);

test("RPC 客户端：坏行记录不吞、无主响应上报、未知事件透传、超时与命令错误显形", async () => {
  const toPi = new PassThrough();
  const fromPi = new PassThrough();
  const client = new RpcClient({ requestTimeoutMs: 5_000 });
  client.attach(toPi, fromPi);
  const events = [];
  client.on("event", (r) => events.push(r));

  // 坏行：记录进 protocolErrors，连接不断
  fromPi.write("{not json\n");
  assert.equal(client.protocolErrors.length, 1);
  assert.match(client.protocolErrors[0].line, /not json/);

  // 无 id 的 response（Pi 的 parse 回执形态）：进 unmatchedResponses，不吞
  fromPi.write(
    JSON.stringify({
      type: "response",
      command: "parse",
      success: false,
      error: "Failed to parse command: x",
    }) + "\n",
  );
  assert.equal(client.unmatchedResponses.length, 1);

  // 未知事件类型：原样透传给订阅者
  fromPi.write(JSON.stringify({ type: "some_future_event", data: 1 }) + "\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "some_future_event");

  // 正常请求/响应按 id 关联
  const okPromise = client.request({ id: "t-ok", type: "get_state" });
  fromPi.write(
    JSON.stringify({
      id: "t-ok",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "abc" },
    }) + "\n",
  );
  const ok = await okPromise;
  assert.equal(ok.data.sessionId, "abc");

  // success:false → RpcCommandError
  const errPromise = client.request({ id: "t-err", type: "get_state" });
  fromPi.write(
    JSON.stringify({
      id: "t-err",
      type: "response",
      command: "get_state",
      success: false,
      error: "boom",
    }) + "\n",
  );
  await assert.rejects(
    errPromise,
    (err) => err.code === "RPC_COMMAND_FAILED" && err.piError === "boom",
  );

  // 超时 → RpcTimeoutError；迟到的响应进 unmatchedResponses，不吞
  const slowClient = new RpcClient({ requestTimeoutMs: 120 });
  const toPi2 = new PassThrough();
  const fromPi2 = new PassThrough();
  slowClient.attach(toPi2, fromPi2);
  await assert.rejects(
    slowClient.request({ id: "t-slow", type: "get_state" }),
    (err) => err.code === "RPC_TIMEOUT",
  );
  fromPi2.write(
    JSON.stringify({
      id: "t-slow",
      type: "response",
      command: "get_state",
      success: true,
      data: {},
    }) + "\n",
  );
  assert.equal(slowClient.unmatchedResponses.length, 1);
});

test(
  "会话落盘：宿主重启后可列出并加载历史会话",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const dataDir = makeTmp("baimo-host-data-");
    const workDir = makeTmp("baimo-host-work-");
    let sessionId;
    const host1 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host1.start();
      const session = await host1.openSession({
        title: "持久化会话",
        workspaceDir: workDir,
      });
      sessionId = session.id;
      await session.getState();
      await session.close();
    } finally {
      await host1.close();
    }

    const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host2.start();
      const list = host2.listSessions();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, sessionId);
      assert.equal(list[0].title, "持久化会话");
      assert.equal(list[0].status, "closed");

      const loaded = host2.loadSession(sessionId);
      assert.equal(loaded.recovery, null);
      const kinds = loaded.events.map((e) => e.kind);
      assert.ok(kinds.includes("lifecycle"));
      const lifecycleEvents = loaded.events
        .filter((e) => e.kind === "lifecycle")
        .map((e) => e.event);
      assert.ok(lifecycleEvents.includes("session_opened"));
      assert.ok(lifecycleEvents.includes("handshake"));
      assert.ok(lifecycleEvents.includes("session_closed"));
      assert.equal(loaded.meta.eventCount, loaded.events.length);
    } finally {
      await host2.close();
      cleanup(dataDir, workDir);
    }
  },
);

test(
  "会话落盘：事件日志尾部损坏可检测并恢复到最后一个完整记录",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const dataDir = makeTmp("baimo-host-data-");
    const workDir = makeTmp("baimo-host-work-");
    let sessionId;
    let goodCount;
    const host1 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host1.start();
      const session = await host1.openSession({
        title: "损坏恢复会话",
        workspaceDir: workDir,
      });
      sessionId = session.id;
      await session.close();
      goodCount = host1.loadSession(sessionId).events.length;
      assert.ok(goodCount > 0);
    } finally {
      await host1.close();
    }

    // 模拟强杀写一半：往日志尾部追加半行坏 JSON（无结尾、无换行）
    appendFileSync(
      join(dataDir, "sessions", sessionId, "events.jsonl"),
      '{"seq":999,"ts":"2026-01-01T00:00:00.000Z","kind":"rpc_eve',
      "utf8",
    );

    const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host2.start();
      const loaded = host2.loadSession(sessionId);
      assert.ok(loaded.recovery, "应报告恢复信息而非静默");
      assert.equal(loaded.recovery.droppedLines, 1);
      assert.equal(loaded.recovery.recoveredEvents, goodCount);
      assert.equal(loaded.events.length, goodCount);
      // 修复后再次加载应干净
      const again = host2.loadSession(sessionId);
      assert.equal(again.recovery, null);
      assert.equal(again.events.length, goodCount);
    } finally {
      await host2.close();
      cleanup(dataDir, workDir);
    }
  },
);

test("坏配置拒绝启动（K-03）：宿主未知键/非法值、Pi 设置未知键/非法值", async () => {
  const dataDir = makeTmp("baimo-host-data-");
  try {
    assert.throws(
      () => new AgentHost({ dataDir, nope: 1 }),
      (err) => err.code === "CONFIG_INVALID" && /nope/.test(err.message),
    );
    assert.throws(
      () => new AgentHost({ dataDir, requestTimeoutMs: -5 }),
      (err) => err.code === "CONFIG_INVALID",
    );
    assert.throws(
      () => new AgentHost({ dataDir, extraPiArgs: "--model" }),
      (err) => err.code === "CONFIG_INVALID",
    );

    // Pi 设置未知键：start() 阶段就拒绝，不许等 Pi 自己静默忽略
    const agentDir1 = join(dataDir, "pi-agent-badkey");
    mkdirSync(agentDir1, { recursive: true });
    writeFileSync(
      join(agentDir1, "settings.json"),
      JSON.stringify({ bogusKey: true }),
      "utf8",
    );
    const hostBadKey = new AgentHost({ dataDir, piAgentDir: agentDir1 });
    await assert.rejects(
      hostBadKey.start(),
      (err) => err.code === "CONFIG_INVALID" && /bogusKey/.test(err.message),
    );

    // Pi 设置类型错误：同样拒绝
    const agentDir2 = join(dataDir, "pi-agent-badtype");
    mkdirSync(agentDir2, { recursive: true });
    writeFileSync(
      join(agentDir2, "settings.json"),
      JSON.stringify({ enableInstallTelemetry: "yes" }),
      "utf8",
    );
    const hostBadType = new AgentHost({ dataDir, piAgentDir: agentDir2 });
    await assert.rejects(
      hostBadType.start(),
      (err) => err.code === "CONFIG_INVALID",
    );
  } finally {
    cleanup(dataDir);
  }
});

test(
  "K-02：运行中杀进程 → 异常终止显形（带事件计数），后续请求以进程错误结算",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const stub = await createStubModelServer({ hang: true });
    const dataDir = makeTmp("baimo-host-data-");
    const workDir = makeTmp("baimo-host-work-");
    writeStubModels(dataDir, stub.url);
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const session = await host.openSession({
        title: "异常终止会话",
        workspaceDir: workDir,
        piArgs: ["--provider", "stub", "--model", "stub-model"],
        modelRef: { provider: "stub", modelId: "stub-model" },
      });

      let abnormalEvent = null;
      session.on("abnormalTermination", (err) => (abnormalEvent = err));
      const outcome = session
        .prompt("hello")
        .then(() => null, (err) => err);

      // 等运行真正进入状态（模型请求已发出、运行对账已武装）再杀
      await waitFor(() => session.busy, 30_000, "运行进入 busy");
      await waitFor(() => stub.requests.length >= 1, 30_000, "桩模型收到请求");
      session.kill("SIGKILL");

      const err = await outcome;
      assert.ok(err, "prompt 必须以错误结算，不许假装完成");
      assert.equal(err.code, "RUN_ABNORMALLY_TERMINATED");
      assert.equal(typeof err.eventsReceived, "number");
      assert.ok(abnormalEvent, "应发出 abnormalTermination 显形事件");
      assert.equal(abnormalEvent.code, "RUN_ABNORMALLY_TERMINATED");
      // stdout 关闭可能先于 exit 事件到达，等进程退出记录落定再断言
      const exitInfo = await session.process.waitExit();
      assert.equal(exitInfo.signal, "SIGKILL");

      // 进程已死：后续请求以带退出上下文的进程错误结算，不静默
      await assert.rejects(
        session.getState(),
        (e) => e.code === "PI_PROCESS_FAILED",
      );

      // 落盘里应有 run_aborted 记录
      const loaded = host.loadSession(session.id);
      const lifecycle = loaded.events
        .filter((e) => e.kind === "lifecycle")
        .map((e) => e.event);
      assert.ok(lifecycle.includes("run_aborted"));
    } finally {
      await host.close();
      await stub.close();
      cleanup(dataDir, workDir);
    }
  },
);

test(
  "桩模型完整轮次：流式文本 → 工具调用 → agent_settled → 落盘可查",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-host-data-");
    const workDir = makeTmp("baimo-host-work-");
    writeStubModels(dataDir, stub.url);
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const session = await host.openSession({
        title: "桩模型会话",
        workspaceDir: workDir,
        piArgs: ["--provider", "stub", "--model", "stub-model"],
        modelRef: { provider: "stub", modelId: "stub-model" },
      });

      const events = [];
      session.on("event", (r) => events.push(r));
      const outcome = await session.prompt("请打个招呼并执行工具", {
        timeoutMs: 90_000,
      });
      assert.equal(outcome.settled, true);
      assert.ok(outcome.eventsReceived > 0);

      // 流式文本：两轮文本增量都应到达
      const text = events
        .filter((e) => e.type === "message_update")
        .map((e) => e.assistantMessageEvent)
        .filter((u) => u && u.type === "text_delta")
        .map((u) => u.delta)
        .join("");
      assert.match(text, /Stub says hello\./);
      assert.match(text, /Stub final answer\./);

      // 工具调用事件与结果
      const toolStart = events.find((e) => e.type === "tool_execution_start");
      assert.ok(toolStart, "应有 tool_execution_start 事件");
      assert.equal(toolStart.toolName, "bash");
      assert.ok(
        JSON.stringify(events).includes("stub-tool-ok"),
        "工具执行结果应包含 echo 输出",
      );
      assert.ok(events.some((e) => e.type === "agent_settled"));

      // 桩服务器应收到恰好两轮请求（工具结果回传后第二轮）
      assert.equal(stub.requests.length, 2);

      // 落盘可查：事件日志含 agent_settled 的 rpc_event 记录
      const loaded = host.loadSession(session.id);
      const rpcTypes = loaded.events
        .filter((e) => e.kind === "rpc_event")
        .map((e) => e.event.type);
      assert.ok(rpcTypes.includes("agent_settled"));
      assert.ok(rpcTypes.includes("tool_execution_start"));
      assert.ok(
        loaded.events.some(
          (e) => e.kind === "lifecycle" && e.event === "run_settled",
        ),
      );

      await session.close();
    } finally {
      await host.close();
      await stub.close();
      cleanup(dataDir, workDir);
    }
  },
);
