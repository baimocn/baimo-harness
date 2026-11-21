/**
 * AgentHost 门面：把 PiProcess + RpcClient + SessionStore 组装成会话级 API。
 *
 * 关键行为：
 * - 每会话一个 Pi 子进程（设计文档 3.2）；握手用 get_state，Pi 会话 id 回填元数据。
 * - 每个 Pi 事件都落盘到会话事件日志（K-05），并转发给订阅者。
 * - 运行对账（K-02）：prompt 发起的运行必须以 agent_settled 收尾；进程死亡 /
 *   传输关闭 / 会话关闭导致未结算时，以 AbnormalTerminationError 显形结算，
 *   携带已收到的事件数与最后一个事件类型，绝不静默挂起或假装完成。
 * - 命令失败（success:false）由 RpcClient 抛 RpcCommandError 直接透传（K-01）。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbnormalTerminationError,
  AgentHostError,
  BudgetExceededError,
  RpcTimeoutError,
} from "./errors.js";
import {
  CostLedger,
  computeCost,
  type CostEntry,
  type CostTotals,
  type TokenUsage,
} from "@baimo-harness/core";
import {
  resolveHostConfig,
  type HostConfig,
  type ResolvedHostConfig,
} from "./config.js";
import { PiProcess, preparePiAgentDir, type PiExitInfo } from "./pi-process.js";
import { RpcClient, type RpcRecord, type RpcResponse } from "./rpc-client.js";
import {
  SessionStore,
  type LoadSessionResult,
  type SessionMeta,
} from "./session-store.js";
import {
  SteeringStore,
  type SteeringEntry,
  type SteeringKind,
} from "./steering-store.js";
import { IdleQueueStore } from "./idle-queue-store.js";
import { PluginService } from "./plugin-service.js";

/** 从 Pi 消息 content（string 或 [{type:"text",text}...]）抽纯文本。 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: unknown; text?: unknown } | null;
        return p && p.type === "text" && typeof p.text === "string"
          ? p.text
          : "";
      })
      .join("");
  }
  return "";
}

/** 随附 Pi 的默认 CLI 路径（apps/agent-host/{src,dist} 上溯三级即项目根）。 */
export function defaultPiCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(
    here,
    "..",
    "..",
    "..",
    "runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
}

/**
 * 随附的审批门扩展（M-02）：apps/agent-host/extensions/approval-gate.mjs。
 * 壳层以 --extension 挂到每个会话进程；策略经 BAIMO_APPROVAL_POLICY 指向的
 * JSON 文件逐次工具调用现读（模式热切换、本会话授权落盘都在这个文件里）。
 */
export function approvalGateExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "extensions", "approval-gate.mjs");
}

/**
 * 随附的计划门扩展（M-03）：apps/agent-host/extensions/plan-gate.mjs。
 * 注册 submit_plan / plan_progress 工具；策略（required/paused）经
 * BAIMO_PLAN_POLICY 文件逐次现读，计划状态写 BAIMO_PLAN_STATE 文件
 * （扩展写、宿主/界面只读），先审后行与暂停都在 tool_call 层硬拦。
 */
export function planGateExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "extensions", "plan-gate.mjs");
}

export interface OpenSessionOptions {
  title?: string;
  workspaceDir?: string;
  /** 本会话追加的 Pi CLI 参数（在宿主配置 extraPiArgs 之后）。 */
  piArgs?: string[];
  /** 本会话追加的环境变量（与宿主级 env 合并，本会话优先）。 */
  env?: Record<string, string>;
  modelRef?: { provider: string; modelId: string } | null;
}

export interface PromptOutcome {
  /**
   * Pi 对 prompt 的处置：handled = 未起运行；started = 已启动并结算；
   * aborted = 用户经 abort() 停止，运行以 agent_settled 收尾但按「已停止」记账，
   * 绝不冒充正常完成（落盘 lifecycle 为 run_stopped 而非 run_settled）；
   * budget_fused = 预算熔断停止（M-07），落盘 run_budget_fused + budget_fuse_tripped。
   */
  disposition: string;
  /** 本轮收到的会话事件数（不含 response 本身）。 */
  eventsReceived: number;
  settled: true;
  /** 熔断详情（disposition=budget_fused 时有值）。 */
  fuse?: { scope: "run" | "day"; cost: number; cap: number };
}

interface ActiveRun {
  eventsReceived: number;
  lastEventType: string | null;
  /** 用户已请求停止：结算时按 run_stopped 记账（见 PromptOutcome.aborted）。 */
  abortRequested: boolean;
  /** 运行开始时的会话累计用量快照（M-07 差分记账基准）；取不到为 null（本轮不记账并显形）。 */
  statsBefore: TokenUsage | null;
  /** 预算熔断已触发（M-07）：结算时按 run_budget_fused 记账，优先于 aborted。 */
  fuse: { scope: "run" | "day"; cost: number; cap: number } | null;
  /** 熔断检查进行中（防 turn_end 并发重复检查）。 */
  fuseCheckBusy: boolean;
  resolve: (outcome: PromptOutcome) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** 用量差分（结算累计 − 运行前累计），负数钳到 0（累计值理论单调递增）。 */
function subTokens(after: TokenUsage, before: TokenUsage): TokenUsage {
  const d = (a: number, b: number) => Math.max(0, a - b);
  return {
    input: d(after.input, before.input),
    output: d(after.output, before.output),
    cacheRead: d(after.cacheRead, before.cacheRead),
    cacheWrite: d(after.cacheWrite, before.cacheWrite),
    total: d(after.total, before.total),
  };
}

export declare interface SessionHandle {
  /** 每个 Pi 会话事件（已落盘）。 */
  on(event: "event", listener: (record: RpcRecord) => void): this;
  /** 子进程退出（无论会话是否在运行）。 */
  on(event: "processExit", listener: (info: PiExitInfo) => void): this;
  /** 一轮运行未以 agent_settled 收尾（K-02 显形事件）。 */
  on(event: "abnormalTermination", listener: (err: AbnormalTerminationError) => void): this;
  /** steering 队列镜像变更（入队/投递/撤回/恢复后推送全量快照）。 */
  on(event: "queueChanged", listener: (entries: SteeringEntry[]) => void): this;
  /** 一轮运行的成本已记账（M-07）：账目 + 本会话/今日汇总。 */
  on(
    event: "costRecorded",
    listener: (e: {
      entry: CostEntry;
      sessionTotals: CostTotals;
      dayTotals: CostTotals;
    }) => void,
  ): this;
}

export class SessionHandle extends EventEmitter {
  private run: ActiveRun | null = null;
  private closedFlag = false;
  /** steering 队列镜像（落盘由 SteeringStore 托管，投递以 message_start 对账）。 */
  private queueEntries: SteeringEntry[] = [];

  constructor(
    readonly id: string,
    private readonly store: SessionStore,
    readonly process: PiProcess,
    readonly client: RpcClient,
    private readonly config: ResolvedHostConfig,
    private readonly steeringStore?: SteeringStore,
    private readonly costLedger?: CostLedger,
  ) {
    super();
    this.queueEntries = steeringStore ? steeringStore.load(id) : [];
    client.on("event", (record) => this.onPiEvent(record));
    // 进程退出 → 传输层以带退出码/stderr 的 PiProcessError 结算全部挂起请求（上下文不丢）。
    // PiProcess 的 exit 监听在其构造时先注册，故此处 exitInfo 已就绪。
    process.on("exit", () => {
      client.failTransport(process.toExitError());
    });
    client.on("close", (err) => {
      this.failRun(
        new AbnormalTerminationError("RPC 传输关闭时运行尚未结算（agent_settled 未到达）", {
          eventsReceived: this.run?.eventsReceived ?? 0,
          lastEventType: this.run?.lastEventType ?? null,
          context: { sessionId: this.id },
          cause: err,
        }),
      );
    });
    process.on("exit", (info) => {
      this.store.append(this.id, "lifecycle", { event: "process_exit", ...info });
      // 优雅关闭（close() 已置位）导致的退出不算异常终止，不覆盖状态。
      if (!this.closedFlag && this.store.getMeta(this.id).status === "live") {
        this.store.updateMeta(this.id, { status: "aborted" });
      }
      this.emit("processExit", info);
    });
  }

  get meta(): SessionMeta {
    return this.store.getMeta(this.id);
  }

  get busy(): boolean {
    return this.run !== null;
  }

  /**
   * 回复一条扩展 UI 请求（extension_ui_response）：对话框类方法（select/
   * confirm/input/editor）的裁决通道，无响应回执（协议即如此）。
   * fields 形如 { value } / { confirmed } / { cancelled: true }。
   */
  respondExtensionUi(
    requestId: string,
    fields: Record<string, unknown>,
  ): void {
    this.store.append(this.id, "lifecycle", {
      event: "extension_ui_responded",
      requestId,
      fields,
    });
    this.client.sendRaw(
      JSON.stringify({
        type: "extension_ui_response",
        id: requestId,
        ...fields,
      }),
    );
  }

  /** 透传一条 RPC 命令；失败以类型化错误抛出（K-01）。 */
  async command<T = unknown>(
    cmd: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<RpcResponse<T>> {
    return this.client.request<T>(cmd, opts);
  }

  async getState(): Promise<RpcResponse> {
    return this.command({ type: "get_state" });
  }

  /**
   * 发送一条 prompt 并等到运行结算（agent_settled）。
   * 进程死亡/传输关闭导致未结算 → AbnormalTerminationError（K-02）。
   */
  async prompt(message: string, opts: { timeoutMs?: number } = {}): Promise<PromptOutcome> {
    if (this.closedFlag) {
      throw new AgentHostError("SESSION_CLOSED", `会话 ${this.id} 已关闭，无法发送 prompt`, {
        sessionId: this.id,
      });
    }
    if (this.run) {
      throw new AgentHostError("SESSION_BUSY", `会话 ${this.id} 已有运行在进行中`, {
        sessionId: this.id,
      });
    }
    // M-07 预算纪律：今日已定价成本已达单日上限 → 发起前直接拒绝，不闷头扣费。
    if (this.costLedger) {
      const budgets = this.costLedger.loadBudgets();
      if (budgets.perDayCap !== null) {
        const today = this.costLedger.todayTotals();
        if (today.cost !== null && today.cost >= budgets.perDayCap) {
          throw new BudgetExceededError(today.cost, budgets.perDayCap, {
            sessionId: this.id,
          });
        }
      }
    }
    // 新一轮开始：上一轮的投递/撤回结果从镜像里清掉（记录仍在事件日志里），
    // 队列条只保留待投递与本轮新入队的，界面队列条不堆历史。
    if (this.queueEntries.some((e) => e.status !== "queued")) {
      this.queueEntries = this.queueEntries.filter((e) => e.status === "queued");
      this.persistQueue();
      this.emitQueueChanged();
    }
    this.store.append(this.id, "prompt", { message });
    // M-07：运行前用量快照（差分记账基准）；取不到则本轮不记账，结算时显形。
    const statsBefore = this.costLedger ? await this.fetchStats() : null;

    let response: RpcResponse;
    try {
      response = await this.client.request({ type: "prompt", message });
    } catch (err) {
      // 请求阶段进程死亡/传输关闭：这轮运行连起点都没确认，按异常终止显形（K-02）。
      if (err instanceof Error && (err as { code?: string }).code === "PI_PROCESS_FAILED") {
        throw new AbnormalTerminationError("prompt 发送阶段 Pi 进程退出，运行未开始即终止", {
          eventsReceived: 0,
          lastEventType: null,
          context: { sessionId: this.id },
          cause: err,
        });
      }
      throw err;
    }

    const disposition =
      (response.data as { disposition?: string } | undefined)?.disposition ?? "started";
    if (disposition === "handled") {
      this.store.append(this.id, "lifecycle", { event: "prompt_handled", disposition });
      return { disposition, eventsReceived: 0, settled: true };
    }

    return new Promise<PromptOutcome>((resolve, reject) => {
      const run: ActiveRun = {
        eventsReceived: 0,
        lastEventType: null,
        abortRequested: false,
        statsBefore,
        fuse: null,
        fuseCheckBusy: false,
        resolve,
        reject,
        timer: null,
      };
      if (opts.timeoutMs !== undefined) {
        run.timer = setTimeout(() => {
          if (this.run === run) {
            this.run = null;
            this.store.append(this.id, "lifecycle", {
              event: "run_timeout",
              timeoutMs: opts.timeoutMs,
              eventsReceived: run.eventsReceived,
            });
            reject(
              new RpcTimeoutError("prompt", opts.timeoutMs!, {
                sessionId: this.id,
                eventsReceived: run.eventsReceived,
              }),
            );
          }
        }, opts.timeoutMs);
      }
      this.run = run;
    });
  }

  /**
   * 停止当前运行（RPC abort）：Pi 中止当前操作并等会话空闲后才回响应，
   * 运行仍以 agent_settled 收尾，但本轮按「已停止」结算（disposition=aborted，
   * 落盘 run_stopped）。无运行在进行时返回 false（不假装停了什么）。
   * 注意：abort 命令的响应要等 Pi 空闲，若模型层迟迟不理会中止信号，
   * 本方法会等到 RPC 请求超时才以 RpcTimeoutError 显形——不静默。
   */
  async abort(): Promise<boolean> {
    const run = this.run;
    if (!run) return false;
    run.abortRequested = true;
    this.store.append(this.id, "lifecycle", { event: "run_stop_requested" });
    await this.client.request({ type: "abort" });
    return true;
  }

  /* ---------- M-04 Steering 队列 ----------
   * 语义实证（Pi 1.6.0 RPC）：steer 在当前轮工具调用结束后、下一轮
   * LLM 调用前投递；follow_up 在 agent 自然停止后才投递；两者在会话
   * 空闲时同样被接受排队，并入下一次运行。投递对账依据是投递时
   * 必发的 message_start（role=user）事件（见 markDeliveredFromMessageStart）。
   * clear_queue 是唯一的队列清除命令（整表清除并返回文本），
   * 故单条撤回 = 整表清除 + 把幸存条目按原序重新入队（见 withdrawQueueEntry）。
   */

  /** 当前队列镜像快照（入队顺序）。 */
  getQueue(): SteeringEntry[] {
    return this.queueEntries.map((e) => ({ ...e }));
  }

  /** 注入纠正：运行中在下一轮次边界投递；空闲时排入下一次运行。 */
  async steer(message: string): Promise<SteeringEntry> {
    return this.enqueue("steer", message);
  }

  /** 排队：当前运行自然结束（settled 前）投递；空闲时排入下一次运行。 */
  async followUp(message: string): Promise<SteeringEntry> {
    return this.enqueue("follow_up", message);
  }

  private async enqueue(
    kind: SteeringKind,
    message: string,
  ): Promise<SteeringEntry> {
    if (this.closedFlag) {
      throw new AgentHostError("SESSION_CLOSED", `会话 ${this.id} 已关闭，无法排队`, {
        sessionId: this.id,
      });
    }
    const resp = await this.client.request({
      type: kind === "steer" ? "steer" : "follow_up",
      message,
    });
    const disposition =
      (resp.data as { disposition?: string } | undefined)?.disposition ?? "queued";
    const entry: SteeringEntry = {
      id: randomUUID(),
      kind,
      text: message,
      // "handled" = 被输入处理器当场消费（本产品未装此类处理器，理论分支）：按已投递记账并显形
      status: disposition === "handled" ? "delivered" : "queued",
      createdAt: new Date().toISOString(),
      ...(disposition === "handled"
        ? { deliveredAt: new Date().toISOString() }
        : {}),
    };
    this.queueEntries.push(entry);
    this.persistQueue();
    this.store.append(this.id, "lifecycle", {
      event: "steering_queued",
      entryId: entry.id,
      kind,
      text: message,
      disposition,
    });
    this.emitQueueChanged();
    return { ...entry };
  }

  /**
   * 撤回一条待投递指令。Pi 只有整表 clear_queue：先整表清除，再把
   * 其余待投递条目按原序重新入队（同条目 id 不变）；目标条目标记
   * withdrawn。重新入队失败的条目同样落 withdrawn 并以 lifecycle
   * 显形，绝不假装还在队列里。返回被撤回条目与重新入队结果。
   */
  async withdrawQueueEntry(entryId: string): Promise<{
    withdrawn: SteeringEntry;
    requeued: number;
    requeueFailed: string[];
  }> {
    const target = this.queueEntries.find((e) => e.id === entryId);
    if (!target) {
      throw new AgentHostError("QUEUE_ENTRY_NOT_FOUND", `队列条目不存在: ${entryId}`, {
        sessionId: this.id,
        entryId,
      });
    }
    if (target.status !== "queued") {
      throw new AgentHostError(
        "QUEUE_ENTRY_NOT_QUEUED",
        `队列条目已是 ${target.status} 状态，不能撤回: ${entryId}`,
        { sessionId: this.id, entryId, status: target.status },
      );
    }
    const survivors = this.queueEntries.filter(
      (e) => e.status === "queued" && e.id !== entryId,
    );
    await this.client.request({ type: "clear_queue" });
    target.status = "withdrawn";
    const requeueFailed: string[] = [];
    let requeued = 0;
    for (const s of survivors) {
      try {
        await this.client.request({
          type: s.kind === "steer" ? "steer" : "follow_up",
          message: s.text,
        });
        requeued += 1;
      } catch (err) {
        s.status = "withdrawn";
        requeueFailed.push(s.id);
        this.store.append(this.id, "lifecycle", {
          event: "steering_requeue_failed",
          entryId: s.id,
          kind: s.kind,
          text: s.text,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.persistQueue();
    this.store.append(this.id, "lifecycle", {
      event: "steering_withdrawn",
      entryId: target.id,
      kind: target.kind,
      text: target.text,
      requeued,
      requeueFailed,
    });
    this.emitQueueChanged();
    return { withdrawn: { ...target }, requeued, requeueFailed };
  }

  /** 整表撤回全部待投递指令（返回 Pi 清出的文本清单）。 */
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const resp = await this.client.request({ type: "clear_queue" });
    const data = (resp.data ?? {}) as {
      steering?: string[];
      followUp?: string[];
    };
    let changed = false;
    for (const e of this.queueEntries) {
      if (e.status === "queued") {
        e.status = "withdrawn";
        changed = true;
      }
    }
    if (changed) this.persistQueue();
    this.store.append(this.id, "lifecycle", {
      event: "steering_cleared",
      steering: data.steering ?? [],
      followUp: data.followUp ?? [],
    });
    if (changed) this.emitQueueChanged();
    return {
      steering: data.steering ?? [],
      followUp: data.followUp ?? [],
    };
  }

  /**
   * 会话续接后恢复队列：把镜像里仍为 queued 的条目按原序重新发给
   * 新 Pi 进程（旧进程的队列已随进程消亡）。恢复动作以 lifecycle
   * 显形；单条失败保留 queued 状态并单独记录，不假装已恢复。
   */
  async restoreQueue(): Promise<{ restored: number; failed: number }> {
    const pending = this.queueEntries.filter((e) => e.status === "queued");
    if (pending.length === 0) return { restored: 0, failed: 0 };
    let restored = 0;
    let failed = 0;
    for (const e of pending) {
      try {
        await this.client.request({
          type: e.kind === "steer" ? "steer" : "follow_up",
          message: e.text,
        });
        restored += 1;
      } catch (err) {
        failed += 1;
        this.store.append(this.id, "lifecycle", {
          event: "steering_restore_failed",
          entryId: e.id,
          kind: e.kind,
          text: e.text,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (restored > 0) {
      this.store.append(this.id, "lifecycle", {
        event: "steering_queue_restored",
        count: restored,
        failed,
      });
    }
    if (restored > 0 || failed > 0) this.emitQueueChanged();
    return { restored, failed };
  }

  private persistQueue(): void {
    this.steeringStore?.save(this.id, this.queueEntries);
  }

  private emitQueueChanged(): void {
    this.emit("queueChanged", this.getQueue());
  }

  /**
   * 投递对账：Pi 投递一条排队消息时必发 message_start（role=user，
   * 探针实证），据此把镜像里最早一条同文本的 queued 条目标记
   * delivered 并落 lifecycle（界面据此把投递消息呈现为用户消息，
   * 去向可见）。不用 queue_update 的队列收缩做推断——clear_queue
   * 同样引起收缩，会把撤回误判成投递（E2E 实证的竞态）。
   * 初始 prompt 的 message_start 文本与任何队列条目都不匹配，自然跳过。
   */
  private markDeliveredFromMessageStart(record: RpcRecord): void {
    const message = record.message as
      | { role?: unknown; content?: unknown }
      | undefined;
    if (!message || message.role !== "user") return;
    const text = extractMessageText(message.content);
    if (!text) return;
    const entry = this.queueEntries.find(
      (e) => e.status === "queued" && e.text === text,
    );
    if (!entry) return;
    entry.status = "delivered";
    entry.deliveredAt = new Date().toISOString();
    this.persistQueue();
    this.store.append(this.id, "lifecycle", {
      event: "steering_delivered",
      entryId: entry.id,
      kind: entry.kind,
      text: entry.text,
    });
    this.emitQueueChanged();
  }

  /** 立即杀死子进程（看门狗/测试用）；运行中会触发异常终止结算。 */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.process.kill(signal);
  }

  /** 优雅关闭：停子进程、结算未完成运行、元数据置 closed。 */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.failRun(
      new AbnormalTerminationError("会话关闭时运行尚未结算（agent_settled 未到达）", {
        eventsReceived: this.run?.eventsReceived ?? 0,
        lastEventType: this.run?.lastEventType ?? null,
        context: { sessionId: this.id },
      }),
    );
    await this.process.stop({
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killTimeoutMs: this.config.killTimeoutMs,
    });
    this.client.failTransport(new AgentHostError("SESSION_CLOSED", `会话 ${this.id} 已关闭`));
    this.store.append(this.id, "lifecycle", { event: "session_closed" });
    if (this.store.getMeta(this.id).status === "live") {
      this.store.updateMeta(this.id, { status: "closed" });
    }
  }

  private onPiEvent(record: RpcRecord): void {
    this.store.append(this.id, "rpc_event", { event: record });
    this.emit("event", record);
    if (record.type === "message_start") {
      this.markDeliveredFromMessageStart(record);
    }
    const run = this.run;
    if (!run) return;
    run.eventsReceived += 1;
    run.lastEventType = typeof record.type === "string" ? record.type : null;
    if (record.type === "turn_end" && !run.fuse) {
      // M-07：每轮结束查一次预算（用量以轮为粒度更新，这是最早可熔断点）
      void this.checkBudgetFuse(run);
    }
    if (record.type === "agent_settled") {
      this.run = null;
      if (run.timer) clearTimeout(run.timer);
      // M-07：本轮记账（差分）在结算后异步完成，结果经 costRecorded 事件推送
      void this.recordRunCost(run);
      if (run.fuse) {
        // 预算熔断：Pi 仍以 agent_settled 收尾，但记账必须是「熔断停止」。
        this.store.append(this.id, "lifecycle", {
          event: "run_budget_fused",
          eventsReceived: run.eventsReceived,
          fuse: run.fuse,
        });
        run.resolve({
          disposition: "budget_fused",
          eventsReceived: run.eventsReceived,
          settled: true,
          fuse: run.fuse,
        });
        return;
      }
      if (run.abortRequested) {
        // 用户停止：Pi 仍以 agent_settled 收尾（实测），但记账必须是「已停止」。
        this.store.append(this.id, "lifecycle", {
          event: "run_stopped",
          eventsReceived: run.eventsReceived,
        });
        run.resolve({
          disposition: "aborted",
          eventsReceived: run.eventsReceived,
          settled: true,
        });
        return;
      }
      this.store.append(this.id, "lifecycle", {
        event: "run_settled",
        eventsReceived: run.eventsReceived,
      });
      run.resolve({
        disposition: "started",
        eventsReceived: run.eventsReceived,
        settled: true,
      });
    }
  }

  /** 读 Pi 会话累计用量（get_session_stats）；失败返回 null（调用方显形处理）。 */
  private async fetchStats(): Promise<TokenUsage | null> {
    try {
      const resp = await this.client.request({ type: "get_session_stats" });
      const tokens = (resp.data as { tokens?: TokenUsage } | undefined)?.tokens;
      if (!tokens) return null;
      return {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cacheRead: tokens.cacheRead ?? 0,
        cacheWrite: tokens.cacheWrite ?? 0,
        total: tokens.total ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * M-07 预算熔断检查（每 turn_end 一次）：本轮差分成本或今日累计
   * （已落账 + 本轮）超过上限 → 记 budget_fuse_tripped 并 abort 本轮，
   * 结算按 budget_fused 记账。未定价模型无法折算金额，不熔断
   * （账本以未定价口径显形）；统计取不到时跳过本次检查，不误杀。
   */
  private async checkBudgetFuse(run: ActiveRun): Promise<void> {
    const ledger = this.costLedger;
    if (!ledger || !run.statsBefore || run.fuse || run.fuseCheckBusy) return;
    const budgets = ledger.loadBudgets();
    if (budgets.perRunCap === null && budgets.perDayCap === null) return;
    const price = ledger.priceFor(this.meta.modelRef);
    if (!price) return;
    run.fuseCheckBusy = true;
    try {
      const now = await this.fetchStats();
      if (!now || this.run !== run || run.fuse) return;
      const runCost = computeCost(price, subTokens(now, run.statsBefore));
      let fuse: ActiveRun["fuse"] = null;
      if (budgets.perRunCap !== null && runCost > budgets.perRunCap) {
        fuse = { scope: "run", cost: runCost, cap: budgets.perRunCap };
      } else if (budgets.perDayCap !== null) {
        const dayCost = (ledger.todayTotals().cost ?? 0) + runCost;
        if (dayCost > budgets.perDayCap) {
          fuse = { scope: "day", cost: dayCost, cap: budgets.perDayCap };
        }
      }
      if (!fuse) return;
      run.fuse = fuse;
      this.store.append(this.id, "lifecycle", {
        event: "budget_fuse_tripped",
        scope: fuse.scope,
        cost: fuse.cost,
        cap: fuse.cap,
      });
      // abort 本轮：Pi 以 agent_settled 收尾，结算分支按 run.fuse 记账为熔断
      await this.client
        .request({ type: "abort" })
        .catch(() => undefined);
    } finally {
      run.fuseCheckBusy = false;
    }
  }

  /** M-07 结算记账：差分用量落账并推送 costRecorded；失败以 lifecycle 显形，不静默。 */
  private async recordRunCost(run: ActiveRun): Promise<void> {
    const ledger = this.costLedger;
    if (!ledger) return;
    try {
      if (!run.statsBefore) {
        this.store.append(this.id, "lifecycle", {
          event: "cost_accounting_failed",
          reason: "运行前用量快照获取失败，本轮未记账",
        });
        return;
      }
      const after = await this.fetchStats();
      if (!after) {
        this.store.append(this.id, "lifecycle", {
          event: "cost_accounting_failed",
          reason: "结算时用量获取失败，本轮未记账",
        });
        return;
      }
      const entry = ledger.record({
        sessionId: this.id,
        modelRef: this.meta.modelRef,
        tokens: subTokens(after, run.statsBefore),
      });
      this.emit("costRecorded", {
        entry,
        sessionTotals: ledger.sessionTotals(this.id),
        dayTotals: ledger.todayTotals(),
      });
    } catch (err) {
      this.store.append(this.id, "lifecycle", {
        event: "cost_accounting_failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private failRun(err: AbnormalTerminationError): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.timer) clearTimeout(run.timer);
    // 用实际对账数据回填错误上下文（构造时只能预估）。
    const finalErr = new AbnormalTerminationError(err.message, {
      eventsReceived: run.eventsReceived,
      lastEventType: run.lastEventType,
      context: { sessionId: this.id },
      cause: err,
    });
    this.store.append(this.id, "lifecycle", {
      event: "run_aborted",
      eventsReceived: run.eventsReceived,
      lastEventType: run.lastEventType,
      reason: err.message,
    });
    if (this.store.getMeta(this.id).status === "live" && !this.process.alive) {
      this.store.updateMeta(this.id, { status: "aborted" });
    }
    this.emit("abnormalTermination", finalErr);
    run.reject(finalErr);
  }
}

export declare interface AgentHost {
  on(
    event: "sessionProcessExit",
    listener: (info: { sessionId: string; exit: PiExitInfo }) => void,
  ): this;
}

export class AgentHost extends EventEmitter {
  readonly config: ResolvedHostConfig;
  private readonly store: SessionStore;
  private readonly steeringStore: SteeringStore;
  /** 成本账本（M-07）：<dataDir>/cost 下 pricing.json / budgets.json / ledger.jsonl。 */
  readonly costLedger: CostLedger;
  /** 闲时队列落盘（M-14）：<dataDir>/idle-queue/queue.json。调度器由调用方按需构造并显式启动（D-01）。 */
  readonly idleQueueStore: IdleQueueStore;
  /** 插件目录（M-15）：<dataDir>/plugins/ 扫描 + 启停注册表 + 静态校验。 */
  readonly plugins: PluginService;
  private readonly sessions = new Map<string, SessionHandle>();
  private started = false;

  constructor(config: HostConfig) {
    super();
    // 配置在构造时即严格校验：坏配置连宿主对象都建不出来（K-03）。
    this.config = resolveHostConfig(config, defaultPiCliPath());
    this.store = new SessionStore(this.config.dataDir);
    this.steeringStore = new SteeringStore(this.config.dataDir);
    this.costLedger = new CostLedger(join(this.config.dataDir, "cost"));
    this.idleQueueStore = new IdleQueueStore(this.config.dataDir);
    this.plugins = new PluginService(this.config.dataDir);
  }

  /** 启动宿主：校验 Pi 设置（K-03）、准备数据目录与索引。 */
  async start(): Promise<void> {
    if (this.started) return;
    preparePiAgentDir(this.config.piAgentDir);
    this.store.init();
    this.started = true;
  }

  /** 每个宿主会话一个独立的 Pi 会话目录（--session-dir），互不干扰、可按会话定位。 */
  private piSessionDir(sessionId: string): string {
    return join(this.config.dataDir, "pi-sessions", sessionId);
  }

  /** 打开一个新会话：建落盘记录 → 拉起 Pi 子进程 → get_state 握手。 */
  async openSession(opts: OpenSessionOptions = {}): Promise<SessionHandle> {
    if (!this.started) await this.start();
    const workspaceDir = opts.workspaceDir ?? this.config.workspaceDir;
    const meta = this.store.createSession({
      title: opts.title ?? "未命名会话",
      workspaceDir,
      modelRef: opts.modelRef ?? null,
    });
    this.store.append(meta.id, "lifecycle", { event: "session_opened" });
    return this.attachProcess(meta, opts.piArgs ?? [], "session_opened", opts.env);
  }

  /**
   * 续接一个已落盘的历史会话：用元数据里记录的 Pi 会话文件重新拉起子进程
   * （--session 指回原文件），握手校验后会话恢复 live，可继续发 prompt，
   * 且模型请求会带上此前的完整上下文（Pi 原生会话续接，实测验证）。
   * 无 Pi 会话文件的旧会话（--no-session 时代）抛 SESSION_NOT_RESUMABLE，不假装续接。
   */
  async resumeSession(
    sessionId: string,
    opts: { piArgs?: string[]; env?: Record<string, string> } = {},
  ): Promise<SessionHandle> {
    if (!this.started) await this.start();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const meta = this.store.getMeta(sessionId);
    if (!meta.piSessionFile) {
      throw new AgentHostError(
        "SESSION_NOT_RESUMABLE",
        `会话 ${sessionId} 没有 Pi 会话文件（可能是旧版临时会话），无法续接`,
        { sessionId },
      );
    }
    this.store.append(sessionId, "lifecycle", { event: "session_resume_requested" });
    const handle = await this.attachProcess(
      meta,
      ["--session", meta.piSessionFile, ...(opts.piArgs ?? [])],
      "session_resumed",
      opts.env,
    );
    // M-04：旧进程的 Pi 队列已随进程消亡，把镜像里未投递的条目原样恢复进新进程
    await handle.restoreQueue().catch(() => undefined);
    return handle;
  }

  /** 拉起 Pi 子进程并完成握手；新建与续接共用。握手后回填 piSessionId/piSessionFile。 */
  private async attachProcess(
    meta: SessionMeta,
    extraArgs: string[],
    lifecycleEvent: string,
    sessionEnv?: Record<string, string>,
  ): Promise<SessionHandle> {
    let proc: PiProcess;
    try {
      proc = await PiProcess.start({
        cliPath: this.config.piCliPath,
        cwd: meta.workspaceDir,
        agentDir: this.config.piAgentDir,
        offline: this.config.offline,
        env: { ...this.config.env, ...(sessionEnv ?? {}) },
        args: [
          "--session-dir",
          this.piSessionDir(meta.id),
          ...this.config.extraPiArgs,
          ...extraArgs,
        ],
      });
    } catch (err) {
      this.store.updateMeta(meta.id, { status: "aborted" });
      throw err;
    }

    const client = new RpcClient({ requestTimeoutMs: this.config.requestTimeoutMs });
    client.attach(proc.child.stdin!, proc.child.stdout!);
    const handle = new SessionHandle(
      meta.id,
      this.store,
      proc,
      client,
      this.config,
      this.steeringStore,
      this.costLedger,
    );
    handle.on("processExit", (info) => {
      this.emit("sessionProcessExit", { sessionId: meta.id, exit: info });
    });
    this.sessions.set(meta.id, handle);

    try {
      const state = await handle.getState();
      const data = state.data as
        | { sessionId?: string; sessionFile?: string }
        | undefined;
      const piSessionId = data?.sessionId ?? null;
      const piSessionFile = data?.sessionFile ?? null;
      this.store.updateMeta(meta.id, { piSessionId, piSessionFile, status: "live" });
      this.store.append(meta.id, "lifecycle", {
        event: "handshake",
        piSessionId,
        via: lifecycleEvent,
      });
      if (lifecycleEvent === "session_resumed") {
        this.store.append(meta.id, "lifecycle", {
          event: "session_resumed",
          piSessionId,
          piSessionFile,
        });
      }
    } catch (err) {
      this.sessions.delete(meta.id);
      this.store.updateMeta(meta.id, { status: "aborted" });
      proc.kill("SIGKILL");
      throw err;
    }
    return handle;
  }

  /** 全部会话（含历史，来自落盘索引；宿主重启后仍可列出）。 */
  listSessions(): SessionMeta[] {
    if (!this.started) {
      throw new AgentHostError("HOST_NOT_STARTED", "宿主尚未 start()，无法列出会话");
    }
    return this.store.listSessions();
  }

  /** 加载历史会话（含尾部损坏恢复信息）。 */
  loadSession(sessionId: string): LoadSessionResult {
    if (!this.started) {
      throw new AgentHostError("HOST_NOT_STARTED", "宿主尚未 start()，无法加载会话");
    }
    return this.store.loadSession(sessionId);
  }

  getLiveSession(sessionId: string): SessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  /** 任一 live 会话正在运行（闲时队列的「全局空闲」判定口径，M-14）。 */
  hasBusyLiveSession(): boolean {
    for (const handle of this.sessions.values()) {
      if (handle.busy) return true;
    }
    return false;
  }

  /** 关闭全部活动会话与子进程。 */
  async close(): Promise<void> {
    const handles = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
    this.started = false;
  }
}
