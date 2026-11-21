/*** 阶段 2 · 引导簇模块 2：Steering 队列（M-04）—— agent-host E2E *****
 * 语义实证（Pi 1.6.0 RPC，非假队列）：
 * - steer：当前轮工具调用结束后、下一轮 LLM 调用前投递——断言桩模型
 *   收到的第 2 个请求里就带着 steer 文本（轮次边界注入）；
 * - follow_up：agent 自然停止后才投递——断言 follow 文本出现在某个
 *   已包含「最终答复」的请求之后，且 agent_settled 在其投递后才到；
 * - 空闲时 steer/follow_up 同样被 Pi 接受排队，并入下一次运行；
 * - 单条撤回 = clear_queue 整表清除 + 幸存条目重新入队：被撤文本
 *   绝不到达模型，保留文本照常投递；
 * - 队列镜像落盘：宿主关闭（Pi 进程消亡）后 resume，未投递条目被
 *   原样恢复进新进程并在下一轮运行中投递。
 * 慢桩（chunkDelayMs=150）把一轮拉长到约 0.8s，保证运行中插入指令。
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
import { AgentHost } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function openSteerSession(t, { chunkDelayMs = 150 } = {}) {
  const stub = await createStubModelServer({ chunkDelayMs });
  const dataDir = makeTmp("baimo-steer-data-");
  const workDir = makeTmp("baimo-steer-work-");
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  const session = await host.openSession({
    title: "steering 会话",
    workspaceDir: workDir,
    piArgs: ["--provider", "stub", "--model", "stub-model"],
    modelRef: { provider: "stub", modelId: "stub-model" },
  });
  t.after(async () => {
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  return { stub, host, session, dataDir, workDir };
}

function requestTexts(stub) {
  return stub.requests.map((r) => JSON.stringify(r.messages ?? []));
}

test(
  "steer 在下一轮次边界投递（第 2 个模型请求即带 steer 文本）",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    const run = session.prompt("主任务 A", { timeoutMs: 120_000 });
    await sleep(500);
    const entry = await session.steer("STEER-TEXT-1");
    assert.equal(entry.status, "queued");
    assert.equal(session.getQueue().length, 1);
    const outcome = await run;
    assert.equal(outcome.disposition, "started");
    const texts = requestTexts(stub);
    assert.ok(!texts[0].includes("STEER-TEXT-1"), "首轮请求不应带 steer");
    assert.ok(
      texts[1].includes("STEER-TEXT-1"),
      "steer 应在下一轮次边界（第 2 个请求）投递",
    );
    const after = session.getQueue();
    assert.equal(after.length, 1);
    assert.equal(after[0].status, "delivered", "投递后镜像应标 delivered");
  },
);

test(
  "follow_up 在主任务收尾后才投递，且 settled 在其后",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    const run = session.prompt("主任务 B", { timeoutMs: 120_000 });
    await sleep(500);
    await session.followUp("FOLLOWUP-TEXT-1");
    const outcome = await run;
    assert.equal(outcome.disposition, "started");
    const texts = requestTexts(stub);
    const followIdx = texts.findIndex((x) => x.includes("FOLLOWUP-TEXT-1"));
    assert.ok(followIdx > 0, "follow_up 应到达模型");
    assert.ok(
      texts[followIdx].includes("Stub final answer."),
      "follow_up 只能在主任务最终答复之后投递",
    );
    assert.equal(session.getQueue()[0].status, "delivered");
  },
);

test(
  "steer 与 follow_up 同轮排队：steer 先于 follow_up 投递",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    const run = session.prompt("主任务 C", { timeoutMs: 120_000 });
    await sleep(500);
    await session.steer("BOTH-STEER");
    await session.followUp("BOTH-FOLLOW");
    await run;
    const texts = requestTexts(stub);
    const steerIdx = texts.findIndex((x) => x.includes("BOTH-STEER"));
    const followIdx = texts.findIndex((x) => x.includes("BOTH-FOLLOW"));
    assert.ok(steerIdx > 0 && followIdx > steerIdx,
      `steer 应先投递（steer@${steerIdx}, follow@${followIdx}）`);
    assert.deepEqual(
      session.getQueue().map((e) => e.status),
      ["delivered", "delivered"],
    );
  },
);

test(
  "空闲排队：steer/follow_up 在下一次运行时投递",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    await session.steer("IDLE-STEER");
    await session.followUp("IDLE-FOLLOW");
    assert.deepEqual(
      session.getQueue().map((e) => e.status),
      ["queued", "queued"],
    );
    await session.prompt("主任务 D", { timeoutMs: 120_000 });
    const texts = requestTexts(stub);
    assert.ok(texts[0].includes("IDLE-STEER"), "空闲 steer 应并入首轮请求");
    assert.ok(
      texts.some((x) => x.includes("IDLE-FOLLOW")),
      "空闲 follow_up 应在运行中投递",
    );
    assert.deepEqual(
      session.getQueue().map((e) => e.status),
      ["delivered", "delivered"],
    );
  },
);

test(
  "单条撤回：被撤文本不到达模型，幸存条目照常投递且 id 不变",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    const run = session.prompt("主任务 E", { timeoutMs: 120_000 });
    await sleep(500);
    const keep = await session.steer("KEEP-STEER");
    const drop = await session.followUp("DROP-FOLLOW");
    const res = await session.withdrawQueueEntry(drop.id);
    assert.equal(res.withdrawn.id, drop.id);
    assert.equal(res.requeued, 1);
    assert.deepEqual(res.requeueFailed, []);
    await run;
    const texts = requestTexts(stub);
    assert.ok(
      !texts.some((x) => x.includes("DROP-FOLLOW")),
      "被撤回的 follow_up 绝不到达模型",
    );
    assert.ok(
      texts.some((x) => x.includes("KEEP-STEER")),
      "幸存的 steer 应照常投递",
    );
    const queue = session.getQueue();
    const keepAfter = queue.find((e) => e.id === keep.id);
    const dropAfter = queue.find((e) => e.id === drop.id);
    assert.equal(keepAfter.status, "delivered");
    assert.equal(dropAfter.status, "withdrawn");
    // 撤回已投递条目应大声失败（类型化错误码）
    await assert.rejects(
      () => session.withdrawQueueEntry(keep.id),
      (err) => err?.code === "QUEUE_ENTRY_NOT_QUEUED",
    );
  },
);

test(
  "整表清除：clearQueue 返回被清文本，两者都不到达模型",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openSteerSession(t);
    const run = session.prompt("主任务 F", { timeoutMs: 120_000 });
    await sleep(500);
    await session.steer("CLEAR-STEER");
    await session.followUp("CLEAR-FOLLOW");
    const cleared = await session.clearQueue();
    assert.deepEqual(cleared.steering, ["CLEAR-STEER"]);
    assert.deepEqual(cleared.followUp, ["CLEAR-FOLLOW"]);
    await run;
    const texts = requestTexts(stub);
    assert.ok(!texts.some((x) => x.includes("CLEAR-")));
    assert.deepEqual(
      session.getQueue().map((e) => e.status),
      ["withdrawn", "withdrawn"],
    );
  },
);

test(
  "落盘恢复：宿主关闭后 resume，未投递条目原样恢复并在下一轮投递",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const stub = await createStubModelServer({ chunkDelayMs: 150 });
    const dataDir = makeTmp("baimo-steer-data-");
    const workDir = makeTmp("baimo-steer-work-");
    const agentDir = join(dataDir, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
    // 单一 teardown：先关 host2（落盘还在时关），再关桩、删目录。
    // after 钩子按注册顺序执行，拆成两个钩子会让删目录抢先、关宿主挂起。
    const extraHosts = [];
    t.after(async () => {
      for (const h of extraHosts) await h.close().catch(() => undefined);
      await stub.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });

    const host1 = new AgentHost({ dataDir, env: { HOME: workDir } });
    await host1.start();
    const s1 = await host1.openSession({
      title: "恢复会话",
      workspaceDir: workDir,
      piArgs: ["--provider", "stub", "--model", "stub-model"],
      modelRef: { provider: "stub", modelId: "stub-model" },
    });
    const sessionId = s1.id;
    await s1.followUp("RESTORE-ME");
    // 镜像已落盘
    const mirrorFile = join(dataDir, "steering", `${sessionId}.json`);
    assert.ok(existsSync(mirrorFile));
    const mirror = JSON.parse(readFileSync(mirrorFile, "utf8"));
    assert.equal(mirror.entries[0].status, "queued");
    await host1.close(); // Pi 进程消亡，其内部队列随之丢失

    const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
    await host2.start();
    extraHosts.push(host2);
    const s2 = await host2.resumeSession(sessionId);
    assert.deepEqual(
      s2.getQueue().map((e) => e.status),
      ["queued"],
      "恢复后镜像仍为待投递",
    );
    await s2.prompt("主任务 G", { timeoutMs: 120_000 });
    const texts = requestTexts(stub);
    assert.ok(
      texts.some((x) => x.includes("RESTORE-ME")),
      "恢复的 follow_up 应在续接后的运行中投递",
    );
    assert.equal(s2.getQueue()[0].status, "delivered");
    const { events } = host2.loadSession(sessionId);
    assert.ok(
      events.some(
        (e) => e.kind === "lifecycle" && e.event === "steering_queue_restored",
      ),
      "恢复动作应以 lifecycle 显形落盘",
    );
  },
);
