/*** 阶段 3 · 模块 1：闲时队列（M-14）—— agent-host E2E *****
 * 口径实证（全部走既有机制，不另开后门）：
 * - 未显式启用（D-01）时任务只排队、绝不自启动；启用后全局空闲按序执行；
 * - 执行 = SessionHandle.prompt 本身：成本差分记账照常落账（账本断言）；
 * - 前台忙时不调度；前台让路 preempt 后任务回队列、不记失败，空闲后自动续跑；
 * - 预算纪律照常生效：运行中熔断（budget_fused）与发起前超限
 *   （BudgetExceededError）都让任务标 blocked + 队列停摆显形，不跳过不硬闯；
 * - 移除/排序只作用于待执行条目；落盘恢复时 running 残留如实记中断。
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
  IdleQueueStore,
  createHostIdleQueueRunner,
} from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`等待超时: ${label}`);
}

async function openIdleHost(t, { chunkDelayMs = 5 } = {}) {
  const stub = await createStubModelServer({ chunkDelayMs });
  const dataDir = makeTmp("baimo-idle-data-");
  const workDir = makeTmp("baimo-idle-work-");
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
  const host = new AgentHost({
    dataDir,
    env: { HOME: workDir },
    extraPiArgs: ["--provider", "stub", "--model", "stub-model"],
  });
  await host.start();
  const runner = createHostIdleQueueRunner(host, {
    newSessionPiArgs: ["--provider", "stub", "--model", "stub-model"],
    newSessionModelRef: { provider: "stub", modelId: "stub-model" },
    tickMs: 150,
  });
  t.after(async () => {
    runner.stop();
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  return { stub, host, runner, dataDir, workDir };
}

function itemByPrompt(runner, prompt) {
  return runner.getState().items.find((it) => it.prompt === prompt);
}

test(
  "未启用不自启动；启用后按序执行且成本照常记账",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, host, runner } = await openIdleHost(t);
    runner.enqueue("闲时任务一", { kind: "new" });
    runner.enqueue("闲时任务二", { kind: "new" });
    runner.start();
    await sleep(1500);
    assert.equal(stub.requests.length, 0, "未启用时不得自启动（D-01）");
    assert.ok(
      runner.getState().items.every((it) => it.status === "queued"),
      "两条都应仍在排队",
    );

    runner.setEnabled(true);
    await waitFor(
      () => runner.getState().items.every((it) => it.status === "done"),
      120_000,
      "两条闲时任务执行完成",
    );
    const items = runner.getState().items;
    assert.ok(items[0].sessionId && items[1].sessionId, "应回填执行会话");
    assert.notEqual(items[0].sessionId, items[1].sessionId);
    assert.equal(items[0].disposition, "started");
    // 顺序：桩收到的首个请求属于任务一
    const firstReq = JSON.stringify(stub.requests[0].messages ?? []);
    assert.ok(firstReq.includes("闲时任务一"), "应按入队顺序执行");
    // 成本记账照常：两个会话在账本里各有账目（未定价时 cost=null 但账目存在）
    for (const it of items) {
      await waitFor(
        () => host.costLedger.sessionTotals(it.sessionId).entries >= 1,
        30_000,
        `会话 ${it.sessionId} 已记账`,
      );
    }
    // 落盘：queue.json 与内存状态一致
    const onDisk = JSON.parse(
      readFileSync(join(host.config.dataDir, "idle-queue", "queue.json"), "utf8"),
    );
    assert.equal(onDisk.items.filter((i) => i.status === "done").length, 2);
  },
);

test(
  "前台忙时不调度；让路后回队列不记失败，空闲后自动续跑",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, host, runner } = await openIdleHost(t, { chunkDelayMs: 200 });
    // 先占住前台：一条慢运行
    const fg = await host.openSession({
      title: "前台会话",
      workspaceDir: makeTmp("baimo-idle-fg-"),
      piArgs: ["--provider", "stub", "--model", "stub-model"],
      modelRef: { provider: "stub", modelId: "stub-model" },
    });
    const fgRun = fg.prompt("前台主任务", { timeoutMs: 120_000 });
    await waitFor(() => fg.busy, 10_000, "前台运行开始");

    runner.enqueue("闲时任务甲", { kind: "new" });
    runner.setEnabled(true);
    await runner.tick();
    assert.equal(
      itemByPrompt(runner, "闲时任务甲").status,
      "queued",
      "前台忙时不得调度",
    );
    await fgRun;

    // 前台空闲后调度起来；等桩真正收到任务请求（证明运行已开始、
    // abort 已登记）后再让路——状态先翻 running、执行器随后才就绪
    runner.start();
    await waitFor(
      () =>
        itemByPrompt(runner, "闲时任务甲").status === "running" &&
        JSON.stringify(stub.requests.map((r) => r.messages ?? [])).includes(
          "闲时任务甲",
        ),
      60_000,
      "闲时任务开始执行并已到达模型",
    );
    assert.equal(runner.preempt("前台任务优先，闲时任务让路"), true);
    // 让路后的 queued 状态只存在一个调度间隔（随即被自动续跑取走），
    // 轮询未必抓得到；持久证据是条目上的让路 note（回队列时写入、
    // 续跑后保留）且全程不记 error——以此断言让路真实发生过。
    await waitFor(
      () => (itemByPrompt(runner, "闲时任务甲").note ?? "").includes("让路"),
      60_000,
      "让路回队列（note 落盘）",
    );
    const afterPreempt = itemByPrompt(runner, "闲时任务甲");
    assert.ok(afterPreempt.sessionId, "让路也应留执行会话痕迹");
    assert.equal(afterPreempt.error, undefined, "让路不记失败原因");
    // 自动续跑并完成（不记失败）
    await waitFor(
      () => itemByPrompt(runner, "闲时任务甲").status === "done",
      120_000,
      "让路任务自动续跑完成",
    );
    assert.ok(stub.requests.length > 0);
  },
);

test(
  "排序与移除：只作用于待执行条目，被移除的任务绝不执行",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, runner } = await openIdleHost(t);
    const a = runner.enqueue("任务A", { kind: "new" });
    runner.enqueue("任务B", { kind: "new" });
    const c = runner.enqueue("任务C", { kind: "new" });
    // C 上移两位到最前
    runner.move(c.id, -1);
    runner.move(c.id, -1);
    assert.deepEqual(
      runner.getState().items.filter((i) => i.status === "queued").map((i) => i.prompt),
      ["任务C", "任务A", "任务B"],
    );
    // 移除 A
    runner.remove(a.id);
    assert.equal(itemByPrompt(runner, "任务A").status, "withdrawn");
    // 已撤回的不能再移除/移动：大声报错
    assert.throws(() => runner.remove(a.id), /不能移除/);
    assert.throws(() => runner.move(a.id, -1), /只有待执行任务/);

    runner.setEnabled(true);
    runner.start();
    await waitFor(
      () =>
        runner
          .getState()
          .items.filter((i) => i.prompt !== "任务A")
          .every((i) => i.status === "done"),
      120_000,
      "C、B 执行完成",
    );
    const allReq = JSON.stringify(stub.requests.map((r) => r.messages ?? []));
    assert.ok(!allReq.includes("任务A"), "被移除的任务绝不到达模型");
    const cIdx = allReq.indexOf("任务C");
    const bIdx = allReq.indexOf("任务B");
    assert.ok(cIdx >= 0 && bIdx > cIdx, "应按调整后的顺序执行（C 先于 B）");
  },
);

test(
  "预算熔断与发起前超限：任务 blocked + 队列停摆显形",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { host, runner } = await openIdleHost(t);
    // 桩每轮 10 入 / 5 出，一次运行两轮 = 20 入 / 10 出；单价 $1000/1M → 一次运行 $0.03
    host.costLedger.setPrice("stub/stub-model", {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
    });
    host.costLedger.saveBudgets({ perRunCap: 0.001, perDayCap: null });

    runner.enqueue("会被熔断的任务", { kind: "new" });
    runner.setEnabled(true);
    runner.start();
    await waitFor(
      () => itemByPrompt(runner, "会被熔断的任务")?.status === "blocked",
      120_000,
      "熔断任务标 blocked",
    );
    const blocked = itemByPrompt(runner, "会被熔断的任务");
    assert.equal(blocked.disposition, "budget_fused");
    assert.ok(blocked.error?.includes("熔断"), "blocked 原因应显形");
    assert.ok(runner.getState().haltedReason, "队列应停摆并写明原因");

    // 停摆期间新任务只排队；处理预算后重新启用，改走「发起前超限」路径
    runner.enqueue("会被发起前拒绝的任务", { kind: "new" });
    await sleep(800);
    assert.equal(
      itemByPrompt(runner, "会被发起前拒绝的任务").status,
      "queued",
      "停摆期间不得继续调度",
    );
    host.costLedger.saveBudgets({ perRunCap: null, perDayCap: 0.0001 });
    await waitFor(
      () => (host.costLedger.todayTotals().cost ?? 0) > 0.0001,
      30_000,
      "熔断运行的成本已落账（今日累计超过新设的单日上限）",
    );
    runner.setEnabled(true);
    await waitFor(
      () => itemByPrompt(runner, "会被发起前拒绝的任务")?.status === "blocked",
      60_000,
      "发起前超限任务标 blocked",
    );
    const blocked2 = itemByPrompt(runner, "会被发起前拒绝的任务");
    assert.ok(
      blocked2.error?.includes("单日预算上限"),
      `blocked 原因应含超限说明，实际: ${blocked2.error}`,
    );
    assert.ok(runner.getState().haltedReason, "再次停摆并显形");
  },
);

test(
  "落盘恢复：running 残留如实记中断，队列文件损坏大声报错",
  { timeout: 30_000 },
  async () => {
    const dataDir = makeTmp("baimo-idle-store-");
    try {
      const dir = join(dataDir, "idle-queue");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "queue.json"),
        JSON.stringify({
          version: 1,
          enabled: true,
          haltedReason: null,
          items: [
            {
              id: "x1",
              prompt: "残留任务",
              target: { kind: "new" },
              status: "running",
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
            },
          ],
        }),
        "utf8",
      );
      const store = new IdleQueueStore(dataDir);
      const state = store.load();
      assert.equal(state.items[0].status, "failed");
      assert.ok(state.items[0].error?.includes("中断"), "中断原因应显形");
      assert.ok(existsSync(join(dir, "queue.json")));

      writeFileSync(join(dir, "queue.json"), "{ not json", "utf8");
      assert.throws(() => store.load(), /损坏/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
