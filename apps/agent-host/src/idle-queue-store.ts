/**
 * 闲时队列落盘（M-14，复用 M-04 的落盘队列底座思路，K-05）。
 *
 * 布局：<dataDir>/idle-queue/queue.json —— 全局一份队列：
 * { version, enabled, haltedReason, items[] }。入队即落盘，状态迁移
 * 即落盘；宿主重启后原样恢复。文件损坏抛 SessionStoreError 大声
 * 报错，不静默丢队列（与 SteeringStore 同口径）。
 *
 * 恢复口径：上次进程消亡时仍在 running 的任务不可能还在跑——加载时
 * 一律转为 failed 并写明中断原因，不假装它还会自己完成。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStoreError } from "./errors.js";

/** 任务目标：新建会话执行，或投递到某个已有会话（执行时续接）。 */
export type IdleTaskTarget =
  | { kind: "new"; title?: string }
  | { kind: "session"; sessionId: string };

/**
 * 任务状态：
 * - queued 待执行；running 执行中；
 * - done 正常结算；failed 执行失败/被停止（如实记原因）；
 * - blocked 被预算纪律挡住（熔断或发起前超限）——队列随之停摆显形，
 *   不静默跳过、不硬闯；
 * - withdrawn 已撤回（用户移除）。
 */
export type IdleTaskStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "withdrawn";

export interface IdleTaskItem {
  id: string;
  prompt: string;
  target: IdleTaskTarget;
  status: IdleTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 实际执行的会话 id（开始执行后回填）。 */
  sessionId?: string;
  /** 执行结算的 disposition（started / budget_fused / aborted / …）。 */
  disposition?: string;
  /** 本次运行收到的会话事件数。 */
  eventsReceived?: number;
  /** failed / blocked 的原因原文（显形，不吞）。 */
  error?: string;
  /** 补充说明（如前台任务让路后重新排队）。 */
  note?: string;
}

export interface IdleQueueState {
  version: 1;
  /** 显式启用开关（D-01：未经用户显式授权，闲时任务不得自启动）。缺省关。 */
  enabled: boolean;
  /** 队列停摆原因（预算阻塞时写入）；非 null 时调度停摆并在界面显形。 */
  haltedReason: string | null;
  items: IdleTaskItem[];
}

const DEFAULT_STATE: IdleQueueState = {
  version: 1,
  enabled: false,
  haltedReason: null,
  items: [],
};

export class IdleQueueStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "idle-queue");
    this.file = join(this.dir, "queue.json");
  }

  /** 读队列状态；无文件返回缺省（未启用、空队列）；损坏抛错显形。 */
  load(): IdleQueueState {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_STATE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw new SessionStoreError(
        `闲时队列文件损坏，无法解析: ${this.file}`,
        {},
        err,
      );
    }
    const state = parsed as Partial<IdleQueueState> | null;
    if (!state || !Array.isArray(state.items)) {
      throw new SessionStoreError(`闲时队列文件结构非法: ${this.file}`, {});
    }
    const items = state.items as IdleTaskItem[];
    let dirty = false;
    for (const item of items) {
      if (item.status === "running") {
        // 进程已消亡，这条任务不可能还在运行：如实记为中断失败。
        item.status = "failed";
        item.error = "宿主上次退出时任务仍在运行，已按中断处理（未完成）";
        item.finishedAt = new Date().toISOString();
        dirty = true;
      }
    }
    const loaded: IdleQueueState = {
      version: 1,
      enabled: state.enabled === true,
      haltedReason:
        typeof state.haltedReason === "string" ? state.haltedReason : null,
      items,
    };
    if (dirty) this.save(loaded);
    return loaded;
  }

  /** 整表落盘（条目量小，整写简单且不易写坏）。 */
  save(state: IdleQueueState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
}
