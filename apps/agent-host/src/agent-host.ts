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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbnormalTerminationError,
  AgentHostError,
  RpcTimeoutError,
} from "./errors.js";
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
   * 绝不冒充正常完成（落盘 lifecycle 为 run_stopped 而非 run_settled）。
   */
  disposition: string;
  /** 本轮收到的会话事件数（不含 response 本身）。 */
  eventsReceived: number;
  settled: true;
}

interface ActiveRun {
  eventsReceived: number;
  lastEventType: string | null;
  /** 用户已请求停止：结算时按 run_stopped 记账（见 PromptOutcome.aborted）。 */
  abortRequested: boolean;
  resolve: (outcome: PromptOutcome) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export declare interface SessionHandle {
  /** 每个 Pi 会话事件（已落盘）。 */
  on(event: "event", listener: (record: RpcRecord) => void): this;
  /** 子进程退出（无论会话是否在运行）。 */
  on(event: "processExit", listener: (info: PiExitInfo) => void): this;
  /** 一轮运行未以 agent_settled 收尾（K-02 显形事件）。 */
  on(event: "abnormalTermination", listener: (err: AbnormalTerminationError) => void): this;
}

export class SessionHandle extends EventEmitter {
  private run: ActiveRun | null = null;
  private closedFlag = false;

  constructor(
    readonly id: string,
    private readonly store: SessionStore,
    readonly process: PiProcess,
    readonly client: RpcClient,
    private readonly config: ResolvedHostConfig,
  ) {
    super();
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
    this.store.append(this.id, "prompt", { message });

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
    const run = this.run;
    if (!run) return;
    run.eventsReceived += 1;
    run.lastEventType = typeof record.type === "string" ? record.type : null;
    if (record.type === "agent_settled") {
      this.run = null;
      if (run.timer) clearTimeout(run.timer);
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
  private readonly sessions = new Map<string, SessionHandle>();
  private started = false;

  constructor(config: HostConfig) {
    super();
    // 配置在构造时即严格校验：坏配置连宿主对象都建不出来（K-03）。
    this.config = resolveHostConfig(config, defaultPiCliPath());
    this.store = new SessionStore(this.config.dataDir);
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
    return this.attachProcess(
      meta,
      ["--session", meta.piSessionFile, ...(opts.piArgs ?? [])],
      "session_resumed",
      opts.env,
    );
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
    const handle = new SessionHandle(meta.id, this.store, proc, client, this.config);
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

  /** 关闭全部活动会话与子进程。 */
  async close(): Promise<void> {
    const handles = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
    this.started = false;
  }
}
