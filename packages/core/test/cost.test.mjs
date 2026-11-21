/*** M-07 成本账本：纯逻辑单测（定价折算 / 落盘汇总 / 未定价口径 / 预算存取） *****/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CostLedger,
  computeCost,
  dayKeyOf,
} from "../dist/index.js";

function makeLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), "baimo-cost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new CostLedger(dir);
}

const PRICE = { input: 1000, output: 5000, cacheRead: 100, cacheWrite: 1000 };
const TOKENS = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 };

test("computeCost：按每 1M tokens 单价折算，四项分开计价", () => {
  const cost = computeCost(PRICE, TOKENS);
  assert.ok(Math.abs(cost - 0.07) < 1e-12, `应为 0.07，实际 ${cost}`);
  const withCache = computeCost(PRICE, {
    input: 0,
    output: 0,
    cacheRead: 1000,
    cacheWrite: 1000,
    total: 2000,
  });
  // cacheRead 1000×$100/1M = $0.1，cacheWrite 1000×$1000/1M = $1.0
  assert.ok(Math.abs(withCache - 1.1) < 1e-12);
});

test("记账与汇总：已定价按会话/按天对得上，条目带单价快照", (t) => {
  const ledger = makeLedger(t);
  ledger.setPrice("stub/stub-model", PRICE);
  const ref = { provider: "stub", modelId: "stub-model" };
  const e1 = ledger.record({ sessionId: "s1", modelRef: ref, tokens: TOKENS });
  assert.ok(Math.abs(e1.cost - 0.07) < 1e-12);
  assert.deepEqual(e1.priceSnapshot, PRICE);
  ledger.record({ sessionId: "s1", modelRef: ref, tokens: TOKENS });
  ledger.record({ sessionId: "s2", modelRef: ref, tokens: TOKENS });

  const s1 = ledger.sessionTotals("s1");
  assert.equal(s1.entries, 2);
  assert.ok(Math.abs(s1.cost - 0.14) < 1e-12);
  assert.equal(s1.tokens.total, 60);
  const today = ledger.todayTotals();
  assert.equal(today.entries, 3);
  assert.ok(Math.abs(today.cost - 0.21) < 1e-12);
  // 昨天没有账目
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(ledger.dayTotals(dayKeyOf(yesterday)).entries, 0);
});

test("未定价口径：cost=null、tokens 照记、汇总单列 unpricedTokens 不冒充 0", (t) => {
  const ledger = makeLedger(t);
  const ref = { provider: "stub", modelId: "stub-model" };
  const e = ledger.record({ sessionId: "s1", modelRef: ref, tokens: TOKENS });
  assert.equal(e.cost, null);
  const totals = ledger.sessionTotals("s1");
  assert.equal(totals.cost, null, "全部未定价时合计必须是 null，不是 0");
  assert.equal(totals.unpricedTokens, 30);
  assert.equal(totals.tokens.total, 30);
  // 混入一笔已定价：合计只算已定价部分，未定价 token 仍单列
  ledger.setPrice("stub/stub-model", PRICE);
  ledger.record({ sessionId: "s1", modelRef: ref, tokens: TOKENS });
  const mixed = ledger.sessionTotals("s1");
  assert.ok(Math.abs(mixed.cost - 0.07) < 1e-12);
  assert.equal(mixed.unpricedTokens, 30);
});

test("预算存取：缺省不限；非法值（负数/NaN）落盘时归 null 不许蒙混", (t) => {
  const ledger = makeLedger(t);
  assert.deepEqual(ledger.loadBudgets(), { perRunCap: null, perDayCap: null });
  ledger.saveBudgets({ perRunCap: 0.03, perDayCap: 5 });
  assert.deepEqual(ledger.loadBudgets(), { perRunCap: 0.03, perDayCap: 5 });
  ledger.saveBudgets({ perRunCap: -1, perDayCap: Number.NaN });
  assert.deepEqual(ledger.loadBudgets(), { perRunCap: null, perDayCap: null });
  // 非法定价大声失败
  assert.throws(
    () => ledger.setPrice("a/b", { input: -5, output: 0, cacheRead: 0, cacheWrite: 0 }),
    /非法单价/,
  );
});
