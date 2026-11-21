/*** 阶段 2 · 引导簇模块 3 宿主 E2E：成本账本 + 预算熔断（M-07） *****
 * 桩模型每轮固定 usage（input 10 / output 5），测试定价 input $1000、
 * output $5000（每 1M tokens）→ 单轮 $0.035，普通一轮运行（2 次调用）$0.07。
 * 覆盖：结算差分记账与汇总对得上 / 单次上限运行中熔断（disposition
 * budget_fused、不冒充完成）/ 单日上限运行中熔断 / 单日已超限发起前拒绝 /
 * 未定价口径（cost=null、不熔断、不冒充 0）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 240_000;
const PRICE = { input: 1000, output: 5000, cacheRead: 100, cacheWrite: 1000 };

async function openCostSession(t, { chunkDelayMs = 5, pricing = true, budgets = null } = {}) {
  const stub = await createStubModelServer({ chunkDelayMs });
  const dataDir = mkdtempSync(join(tmpdir(), "baimo-cost-data-"));
  const workDir = mkdtempSync(join(tmpdir(), "baimo-cost-work-"));
  mkdirSync(join(dataDir, "pi-agent"), { recursive: true });
  writeFileSync(join(dataDir, "pi-agent", "models.json"), stubModelsJson(stub.url), "utf8");
  if (pricing) {
    mkdirSync(join(dataDir, "cost"), { recursive: true });
    writeFileSync(
      join(dataDir, "cost", "pricing.json"),
      JSON.stringify({ version: 1, currency: "USD", models: { "stub/stub-model": PRICE } }),
      "utf8",
    );
  }
  if (budgets) {
    mkdirSync(join(dataDir, "cost"), { recursive: true });
    writeFileSync(
      join(dataDir, "cost", "budgets.json"),
      JSON.stringify(budgets),
      "utf8",
    );
  }
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  t.after(async () => {
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const session = await host.openSession({
    title: "成本会话",
    workspaceDir: workDir,
    piArgs: ["--provider", "stub", "--model", "stub-model"],
    modelRef: { provider: "stub", modelId: "stub-model" },
  });
  return { stub, host, session, dataDir };
}

/** 等 costRecorded 事件（记账在结算后异步完成）。 */
function waitCostRecorded(session, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("等待 costRecorded 超时")),
      timeoutMs,
    );
    session.on("costRecorded", (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

test(
  "记账：普通运行结算后落一笔差分账目，会话/今日汇总对得上",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { host, session } = await openCostSession(t);
    const recordedPromise = waitCostRecorded(session);
    const outcome = await session.prompt("普通任务");
    assert.equal(outcome.disposition, "started");
    const { entry, sessionTotals, dayTotals } = await recordedPromise;
    // 一轮运行 2 次调用：input 20 / output 10 / total 30 → $0.07
    assert.deepEqual(
      {
        input: entry.tokens.input,
        output: entry.tokens.output,
        total: entry.tokens.total,
      },
      { input: 20, output: 10, total: 30 },
    );
    assert.ok(Math.abs(entry.cost - 0.07) < 1e-9, `成本应为 0.07，实际 ${entry.cost}`);
    assert.ok(Math.abs(sessionTotals.cost - 0.07) < 1e-9);
    assert.ok(Math.abs(dayTotals.cost - 0.07) < 1e-9);
    assert.equal(sessionTotals.unpricedTokens, 0);
    // 第二轮再记一笔，累计 0.14（差分不是重复累计）
    const second = waitCostRecorded(session);
    await session.prompt("再跑一轮");
    const again = await second;
    assert.ok(Math.abs(again.sessionTotals.cost - 0.14) < 1e-9);
    assert.equal(host.costLedger.entries().length, 2);
  },
);

test(
  "单次上限熔断：第一轮成本即超限 → budget_fused、不落 run_settled、账目照记部分成本",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { host, session } = await openCostSession(t, {
      chunkDelayMs: 200,
      budgets: { perRunCap: 0.03, perDayCap: null },
    });
    const recordedPromise = waitCostRecorded(session);
    const outcome = await session.prompt("会熔断的任务");
    assert.equal(outcome.disposition, "budget_fused", "熔断不得冒充正常完成");
    assert.equal(outcome.fuse?.scope, "run");
    assert.ok(outcome.fuse.cost > 0.03);
    assert.equal(outcome.fuse.cap, 0.03);
    const { events } = await host.loadSession(session.id);
    const kinds = events.map((e) => `${e.kind}:${e.event ?? ""}`);
    assert.ok(kinds.includes("lifecycle:budget_fuse_tripped"), "熔断事件必须显形落盘");
    assert.ok(kinds.includes("lifecycle:run_budget_fused"));
    assert.ok(!kinds.includes("lifecycle:run_settled"), "熔断轮次不得记为正常结算");
    // 熔断轮次的已消耗成本照样记账（账要对得上）
    const { entry } = await recordedPromise;
    assert.ok(entry.cost !== null && entry.cost > 0, "熔断轮次应记部分成本");
  },
);

test(
  "单日上限：第一轮正常，第二轮运行中因今日累计超限熔断（scope=day）",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { session } = await openCostSession(t, {
      chunkDelayMs: 200,
      budgets: { perRunCap: null, perDayCap: 0.1 },
    });
    const first = waitCostRecorded(session);
    const o1 = await session.prompt("第一轮");
    assert.equal(o1.disposition, "started");
    await first; // 今日累计 $0.07
    const second = waitCostRecorded(session);
    const o2 = await session.prompt("第二轮");
    assert.equal(o2.disposition, "budget_fused");
    assert.equal(o2.fuse?.scope, "day");
    await second;
  },
);

test(
  "单日已超限：发起新运行前直接拒绝（BUDGET_EXCEEDED），模型零请求",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { stub, session } = await openCostSession(t, {
      budgets: { perRunCap: null, perDayCap: 0.05 },
    });
    const first = waitCostRecorded(session);
    await session.prompt("先花掉 0.07");
    await first;
    const before = stub.requests.length;
    await assert.rejects(
      () => session.prompt("不该发起的运行"),
      (err) => err?.code === "BUDGET_EXCEEDED",
    );
    assert.equal(stub.requests.length, before, "被拒绝的运行不得打扰模型");
  },
);

test(
  "未定价口径：无定价时账目 cost=null、设了上限也不熔断、汇总不冒充 0",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const { host, session, dataDir } = await openCostSession(t, {
      pricing: false,
      budgets: { perRunCap: 0.001, perDayCap: 0.001 },
    });
    const recordedPromise = waitCostRecorded(session);
    const outcome = await session.prompt("未定价任务");
    assert.equal(outcome.disposition, "started", "未定价无法折算金额，不应熔断");
    const { entry, sessionTotals } = await recordedPromise;
    assert.equal(entry.cost, null);
    assert.equal(entry.tokens.total, 30);
    assert.equal(sessionTotals.cost, null);
    assert.equal(sessionTotals.unpricedTokens, 30);
    assert.ok(existsSync(join(dataDir, "cost", "ledger.jsonl")), "账本文件应落盘");
    const { events } = await host.loadSession(session.id);
    assert.ok(
      !events.some((e) => e.event === "budget_fuse_tripped"),
      "未定价不得出现熔断事件",
    );
  },
);
