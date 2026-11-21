/**
 * 成本账本（M-07）：把 token 用量按可配置单价折算成钱，落成对得上的账，
 * 并持有预算上限（熔断判定在 agent-host，账本只记账与汇总）。
 *
 * 落盘布局（<dir> 由宿主指定为 <dataDir>/cost）：
 * - pricing.json：{ version, currency, models: { "provider/modelId": 单价 } }
 *   单价单位为「每 1M tokens 的美元价」，四项：input/output/cacheRead/cacheWrite。
 * - budgets.json：{ perRunCap, perDayCap }（美元；null = 不限）。
 * - ledger.jsonl：append-only 账目，一行一轮运行的用量增量。
 *
 * 诚实口径：没有定价的模型，账目 cost=null、tokens 照记，汇总时单列
 * unpricedTokens，绝不用 0 冒充「不要钱」。汇总 cost 只累加已定价账目，
 * 全部未定价时 cost=null（界面显示「未定价」）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ModelPrice {
  /** 每 1M tokens 的价格（美元）。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingConfig {
  version: 1;
  currency: "USD";
  models: Record<string, ModelPrice>;
}

export interface BudgetConfig {
  /** 单次运行成本上限（美元）；null = 不限。 */
  perRunCap: number | null;
  /** 单日成本上限（美元）；null = 不限。 */
  perDayCap: number | null;
}

export interface CostEntry {
  ts: string;
  sessionId: string;
  modelRef: { provider: string; modelId: string } | null;
  /** 本轮运行的用量增量（相对上一轮结算时的会话累计值）。 */
  tokens: TokenUsage;
  /** 按记录时定价折算的成本；未定价为 null。 */
  cost: number | null;
  priceSnapshot: ModelPrice | null;
}

export interface CostTotals {
  tokens: TokenUsage;
  /** 已定价账目的成本合计；一笔已定价账目都没有时为 null。 */
  cost: number | null;
  /** 未定价账目的 token 总数（成本未知，单列显形）。 */
  unpricedTokens: number;
  entries: number;
}

export function modelKey(ref: { provider: string; modelId: string }): string {
  return `${ref.provider}/${ref.modelId}`;
}

/** 纯函数：按单价折算一笔用量（每 1M tokens 计价）。 */
export function computeCost(price: ModelPrice, tokens: TokenUsage): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

/** 本地日期键（YYYY-MM-DD），按账目 ts 的本地时区归日。 */
export function dayKeyOf(ts: string): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (k) => typeof p[k] === "number" && Number.isFinite(p[k]) && (p[k] as number) >= 0,
  );
}

function capOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export class CostLedger {
  private readonly pricingFile: string;
  private readonly budgetsFile: string;
  private readonly ledgerFile: string;

  constructor(private readonly dir: string) {
    this.pricingFile = join(dir, "pricing.json");
    this.budgetsFile = join(dir, "budgets.json");
    this.ledgerFile = join(dir, "ledger.jsonl");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /* ---------- 定价 ---------- */

  loadPricing(): PricingConfig {
    if (!existsSync(this.pricingFile)) {
      return { version: 1, currency: "USD", models: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.pricingFile, "utf8"));
    } catch (err) {
      throw new Error(`定价文件损坏，无法解析: ${this.pricingFile}: ${String(err)}`);
    }
    const modelsRaw =
      (parsed as { models?: Record<string, unknown> })?.models ?? {};
    const models: Record<string, ModelPrice> = {};
    for (const [key, value] of Object.entries(modelsRaw)) {
      if (!isPrice(value)) {
        throw new Error(`定价文件含非法单价（${key}）：四项必须为非负数`);
      }
      models[key] = value;
    }
    return { version: 1, currency: "USD", models };
  }

  savePricing(pricing: PricingConfig): void {
    this.ensureDir();
    writeFileSync(
      this.pricingFile,
      JSON.stringify(pricing, null, 2) + "\n",
      "utf8",
    );
  }

  setPrice(key: string, price: ModelPrice): PricingConfig {
    if (!isPrice(price)) {
      throw new Error(`非法单价（${key}）：四项必须为非负数`);
    }
    const pricing = this.loadPricing();
    pricing.models[key] = price;
    this.savePricing(pricing);
    return pricing;
  }

  priceFor(ref: { provider: string; modelId: string } | null): ModelPrice | null {
    if (!ref) return null;
    return this.loadPricing().models[modelKey(ref)] ?? null;
  }

  /* ---------- 预算 ---------- */

  loadBudgets(): BudgetConfig {
    if (!existsSync(this.budgetsFile)) {
      return { perRunCap: null, perDayCap: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.budgetsFile, "utf8"));
    } catch (err) {
      throw new Error(`预算文件损坏，无法解析: ${this.budgetsFile}: ${String(err)}`);
    }
    const b = (parsed ?? {}) as Record<string, unknown>;
    return {
      perRunCap: capOrNull(b.perRunCap),
      perDayCap: capOrNull(b.perDayCap),
    };
  }

  saveBudgets(budgets: BudgetConfig): void {
    this.ensureDir();
    writeFileSync(
      this.budgetsFile,
      JSON.stringify(
        {
          perRunCap: capOrNull(budgets.perRunCap),
          perDayCap: capOrNull(budgets.perDayCap),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  /* ---------- 账目 ---------- */

  /** 记一笔账：按当前定价折算并落盘，返回完整账目。 */
  record(input: {
    sessionId: string;
    modelRef: { provider: string; modelId: string } | null;
    tokens: TokenUsage;
    ts?: string;
  }): CostEntry {
    const price = this.priceFor(input.modelRef);
    const entry: CostEntry = {
      ts: input.ts ?? new Date().toISOString(),
      sessionId: input.sessionId,
      modelRef: input.modelRef,
      tokens: input.tokens,
      cost: price ? computeCost(price, input.tokens) : null,
      priceSnapshot: price,
    };
    this.ensureDir();
    appendFileSync(this.ledgerFile, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  /** 全部账目（按落盘顺序）。尾部损坏行跳过并计数不了——账本文件只由本类 append，损坏即抛错显形。 */
  entries(): CostEntry[] {
    if (!existsSync(this.ledgerFile)) return [];
    const raw = readFileSync(this.ledgerFile, "utf8");
    const out: CostEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as CostEntry);
    }
    return out;
  }

  private totalsOf(list: CostEntry[]): CostTotals {
    let tokens = emptyTokens();
    let cost: number | null = null;
    let unpricedTokens = 0;
    for (const e of list) {
      tokens = addTokens(tokens, e.tokens);
      if (e.cost === null) {
        unpricedTokens += e.tokens.total;
      } else {
        cost = (cost ?? 0) + e.cost;
      }
    }
    return { tokens, cost, unpricedTokens, entries: list.length };
  }

  sessionTotals(sessionId: string): CostTotals {
    return this.totalsOf(this.entries().filter((e) => e.sessionId === sessionId));
  }

  dayTotals(dayKey: string): CostTotals {
    return this.totalsOf(
      this.entries().filter((e) => dayKeyOf(e.ts) === dayKey),
    );
  }

  todayTotals(now = new Date()): CostTotals {
    return this.dayTotals(dayKeyOf(now.toISOString()));
  }
}
