/**
 * 闲时队列调度器（M-14）。
 *
 * 调度口径（证据来自既有机制，不另造判定）：
 * - 「空闲」= 没有任何 live 会话处于运行中（SessionHandle.busy 为假）。
 *   steering 的实证语义表明 Pi 对空闲会话同样接受 prompt；故闲时任务
 *   本质是「全局空闲时按序发起的普通运行」，执行全程走既有机制：
 *   检查点（桌面执行器负责打点）、成本差分记账（SessionHandle 内建）、
 *   预算熔断（turn_end 检查 + 发起前单日上限拒绝）一个都不少。
 * - 显式授权（D-01）：enabled 缺省关；未开启时任务只排队、绝不自启动。
 * - 预算阻塞即停摆：任务结算为 budget_fused 或发起时抛
 *   BudgetExceededError → 该任务标 blocked、队列 halted 并写明原因，
 *   不静默跳过、不硬闯；用户处理（调高预算/移除任务）后重新启用续跑。
 * - 审批阻塞不绕过：闲时运行与前台运行同一条链路，审批卡照常弹、
 *   计划照常审；队列只是「替用户按下发送」，不替用户裁决。
 * - 前台让路（PRD 场景五）：前台任务到来时桌面层调 preempt()——
 *   正在跑的闲时任务被 abort，已落盘的检查点保留，任务回到 queued
 *   并注明让路原因，全局空闲后自动续跑。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentHostError } from "./errors.js";
import type { AgentHost } from "./agent-host.js";
import {
  IdleQueueStore,
  type IdleQueueState,
  type IdleTaskItem,
  type IdleTaskTarget,
} from "./idle-queue-store.js";

/** 一次任务执行的结果（由执行器回传，来自 SessionHandle.prompt 的结算）。 */
export interface IdleExecutionResult {
  sessionId: string;
  disposition: string;
  eventsReceived: number;
}

/** 执行器在运行期间向调度器登记的控制面。 */
export interface IdleExecutionControl {
  /** 登记「中止当前运行」的方法（前台让路时调度器调用）。 */
  registerAbort: (fn: () => void) => void;
  /** 回填实际执行的会话 id（会话建好后立即调用，供界面与让路判定使用）。 */
  noteSession: (sessionId: string) => void;
}

/**
 * 执行器：把一条闲时任务真正跑起来（开/续会话 + 发 prompt 并等结算）。
 * 桌面层与宿主层各有一份实现，但都必须走完整机制（检查点/账本/熔断）。
 */
export type IdleExecutor = (
  item: IdleTaskItem,
  ctl: IdleExecutionControl,
) => Promise<IdleExecutionResult>;

export declare interface IdleQueueRunner {
  /** 队列状态有任何变更（入队/迁移/停摆/开关）时推送全量快照。 */
  on(event: "changed", listener: (state: IdleQueueState) => void): this;
  /** 一条任务到达终态（done/failed/blocked）时触发。 */
  on(
    event: "itemSettled",
    listener: (item: IdleTaskItem) => void,
  ): this;
}

export class IdleQueueRunner extends EventEmitter {
  private state: IdleQueueState;
  private timer: NodeJS.Timeout | null = null;
  private current: IdleTaskItem | null = null;
  private currentAbort: (() => void) | null = null;
  private preemptReason: string | null = null;
  private ticking = false;

  constructor(
    private readonly store: IdleQueueStore,
    private readonly executor: IdleExecutor,
    private readonly isForegroundBusy: () => boolean,
    private readonly tickMs = 400,
  ) {
    super();
    this.state = store.load();
  }

  /** 当前状态深拷贝快照。 */
  getState(): IdleQueueState {
    return structuredClone(this.state);
  }

  /** 正在执行的任务（无则 null）。 */
  get currentItem(): IdleTaskItem | null {
    return this.current ? { ...this.current } : null;
  }

  /** 入队一条闲时任务（入队即落盘）。 */
  enqueue(prompt: string, target: IdleTaskTarget): IdleTaskItem {
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) {
      throw new AgentHostError("IDLE_TASK_INVALID", "闲时任务内容不能为空");
    }
    if (target.kind === "session" && !target.sessionId) {
      throw new AgentHostError("IDLE_TASK_INVALID", "投递到已有会话时必须给出 sessionId");
    }
    const item: IdleTaskItem = {
      id: randomUUID(),
      prompt: text,
      target,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.state.items.push(item);
    this.persistAndEmit();
    return { ...item };
  }

  /**
   * 移除一条任务：queued / blocked 可移除（标 withdrawn，保留在列表里
   * 让去向可见）；running 与已终态的拒绝并说明原因，不假装移除。
   */
  remove(itemId: string): IdleTaskItem {
    const item = this.requireItem(itemId);
    if (item.status !== "queued" && item.status !== "blocked") {
      throw new AgentHostError(
        "IDLE_TASK_NOT_REMOVABLE",
        `任务当前状态为 ${item.status}，不能移除（执行中请先让路/停止，已结束的请用清理）`,
        { itemId, status: item.status },
      );
    }
    item.status = "withdrawn";
    item.finishedAt = new Date().toISOString();
    this.persistAndEmit();
    return { ...item };
  }

  /** 在待执行序列里上移/下移一位（只影响 queued 条目的相对顺序）。 */
  move(itemId: string, dir: -1 | 1): IdleTaskItem {
    const item = this.requireItem(itemId);
    if (item.status !== "queued") {
      throw new AgentHostError(
        "IDLE_TASK_NOT_MOVABLE",
        `任务当前状态为 ${item.status}，只有待执行任务能调整顺序`,
        { itemId, status: item.status },
      );
    }
    const queuedIdxs = this.state.items
      .map((it, i) => (it.status === "queued" ? i : -1))
      .filter((i) => i >= 0);
    const pos = queuedIdxs.indexOf(this.state.items.indexOf(item));
    const swapPos = pos + dir;
    if (swapPos < 0 || swapPos >= queuedIdxs.length) {
      throw new AgentHostError(
        "IDLE_TASK_NOT_MOVABLE",
        dir < 0 ? "已在待执行序列最前" : "已在待执行序列最后",
        { itemId },
      );
    }
    const a = queuedIdxs[pos];
    const b = queuedIdxs[swapPos];
    [this.state.items[a], this.state.items[b]] = [
      this.state.items[b],
      this.state.items[a],
    ];
    this.persistAndEmit();
    return { ...item };
  }

  /**
   * 显式启用/停用。启用即清停摆（用户已处理阻塞的明确信号）；
   * 停用不打断正在执行的任务（它会自然结算），只停后续调度。
   */
  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    if (enabled) this.state.haltedReason = null;
    this.persistAndEmit();
  }

  /** 清理已结束条目（done/failed/withdrawn）；blocked 保留待处理。 */
  clearFinished(): number {
    const before = this.state.items.length;
    this.state.items = this.state.items.filter(
      (it) =>
        it.status !== "done" &&
        it.status !== "failed" &&
        it.status !== "withdrawn",
    );
    const removed = before - this.state.items.length;
    if (removed > 0) this.persistAndEmit();
    return removed;
  }

  /**
   * 前台让路：中止正在执行的闲时任务。任务不会记失败——结算后回到
   * queued 并注明让路原因，全局空闲后自动续跑。无任务在跑时返回 false。
   */
  preempt(reason: string): boolean {
    // 让路以 abort 真正送达为前提：执行器尚未登记 abort（会话还在
    // 打开中）时不假装让路成功——宁可两个运行短暂并行，也不把一条
    // 其实已完整跑完的任务误判成让路后重跑一遍。
    if (!this.current || !this.currentAbort) return false;
    this.preemptReason = reason;
    this.currentAbort();
    return true;
  }

  /** 启动调度轮询（幂等）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /** 停止调度轮询（不打断正在执行的任务）。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 单步调度（测试与桌面层可直接驱动；轮询内部亦走此路径）。 */
  async tick(): Promise<void> {
    if (this.ticking || this.current) return;
    if (!this.state.enabled || this.state.haltedReason) return;
    const next = this.state.items.find((it) => it.status === "queued");
    if (!next) return;
    if (this.isForegroundBusy()) return;
    this.ticking = true;
    try {
      await this.dispatch(next);
    } finally {
      this.ticking = false;
    }
  }

  private async dispatch(item: IdleTaskItem): Promise<void> {
    this.current = item;
    this.currentAbort = null;
    this.preemptReason = null;
    item.status = "running";
    item.startedAt = new Date().toISOString();
    delete item.finishedAt;
    delete item.error;
    this.persistAndEmit();

    let result: IdleExecutionResult | null = null;
    let thrown: unknown = null;
    try {
      result = await this.executor(item, {
        registerAbort: (fn) => {
          this.currentAbort = fn;
        },
        noteSession: (sessionId) => {
          item.sessionId = sessionId;
        },
      });
    } catch (err) {
      thrown = err;
    }

    const preempted = this.preemptReason !== null;
    this.current = null;
    this.currentAbort = null;
    const reason = this.preemptReason;
    this.preemptReason = null;

    if (preempted && !thrown) {
      // 让路：不记成败，回到队列等全局空闲后自动续跑（检查点已在执行器侧落盘）。
      item.status = "queued";
      delete item.startedAt;
      item.note = reason ?? "前台任务优先，闲时任务已让路";
      if (result) {
        item.sessionId = result.sessionId;
        item.eventsReceived = result.eventsReceived;
      }
      this.persistAndEmit();
      return;
    }

    item.finishedAt = new Date().toISOString();
    if (thrown) {
      const err = thrown as { code?: string; message?: string };
      const message = err?.message ?? String(thrown);
      if (err?.code === "BUDGET_EXCEEDED") {
        item.status = "blocked";
        item.error = message;
        this.halt(`闲时任务被预算挡住：${message}`);
      } else {
        item.status = "failed";
        item.error = message;
      }
    } else if (result) {
      item.sessionId = result.sessionId;
      item.disposition = result.disposition;
      item.eventsReceived = result.eventsReceived;
      if (result.disposition === "started") {
        item.status = "done";
      } else if (result.disposition === "budget_fused") {
        item.status = "blocked";
        item.error = "运行中触发预算熔断，已停止（成本账本 M-07）";
        this.halt("闲时任务触发预算熔断，队列已停摆；调高预算或移除任务后重新启用可续跑");
      } else if (result.disposition === "aborted") {
        item.status = "failed";
        item.error = "运行被停止（未记为完成）";
      } else {
        item.status = "failed";
        item.error = `运行未正常结算（disposition=${result.disposition}）`;
      }
    }
    this.persistAndEmit();
    this.emit("itemSettled", { ...item });
  }

  private halt(reason: string): void {
    this.state.haltedReason = reason;
  }

  private requireItem(itemId: string): IdleTaskItem {
    const item = this.state.items.find((it) => it.id === itemId);
    if (!item) {
      throw new AgentHostError("IDLE_TASK_NOT_FOUND", `闲时任务不存在: ${itemId}`, {
        itemId,
      });
    }
    return item;
  }

  private persistAndEmit(): void {
    this.store.save(this.state);
    this.emit("changed", this.getState());
  }
}

/**
 * 宿主层执行器：目标为新会话则 openSession，已有会话则取 live 或
 * resumeSession；执行就是 SessionHandle.prompt 本身——成本记账、
 * 预算熔断、异常终止显形全部内建于该路径，不另开后门。
 * isForegroundBusy 口径：任一 live 会话 busy 即视为前台忙。
 */
export function createHostIdleQueueRunner(
  host: AgentHost,
  opts: {
    /** 新会话的 Pi 参数（如 --provider/--model/--extension），与桌面执行器口径独立。 */
    newSessionPiArgs?: string[];
    newSessionModelRef?: { provider: string; modelId: string } | null;
    tickMs?: number;
  } = {},
): IdleQueueRunner {
  const executor: IdleExecutor = async (item, ctl) => {
    let handle;
    if (item.target.kind === "session") {
      handle =
        host.getLiveSession(item.target.sessionId) ??
        (await host.resumeSession(item.target.sessionId));
    } else {
      handle = await host.openSession({
        title: item.target.title ?? "闲时任务",
        piArgs: opts.newSessionPiArgs ?? [],
        modelRef: opts.newSessionModelRef ?? null,
      });
    }
    ctl.noteSession(handle.id);
    ctl.registerAbort(() => {
      void handle.abort().catch(() => undefined);
    });
    const outcome = await handle.prompt(item.prompt);
    return {
      sessionId: handle.id,
      disposition: outcome.disposition,
      eventsReceived: outcome.eventsReceived,
    };
  };
  return new IdleQueueRunner(
    host.idleQueueStore,
    executor,
    () => host.hasBusyLiveSession(),
    opts.tickMs,
  );
}
