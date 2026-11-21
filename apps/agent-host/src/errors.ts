/**
 * agent-host 的类型化错误族。
 *
 * 设计原则（K-01/K-03）：内核与传输层的任何失败都必须显形——带错误码、
 * 带上下文、带原始原因——抛给调用方，禁止静默成功、禁止吞掉。
 */

export interface HostErrorContext {
  [key: string]: unknown;
}

export class AgentHostError extends Error {
  readonly code: string;
  readonly context: HostErrorContext;

  constructor(code: string, message: string, context: HostErrorContext = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

/** 配置非法（未知键 / 类型错误 / 取值非法）。宿主拒绝启动时抛此错误（K-03）。 */
export class ConfigError extends AgentHostError {
  constructor(message: string, context: HostErrorContext = {}) {
    super("CONFIG_INVALID", message, context);
  }
}

/** Pi 子进程层面的失败：启动失败、异常退出。携带退出码、信号与 stderr 尾部。 */
export class PiProcessError extends AgentHostError {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;

  constructor(
    message: string,
    opts: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string;
      context?: HostErrorContext;
      cause?: unknown;
    } = {},
  ) {
    super("PI_PROCESS_FAILED", message, opts.context ?? {}, opts.cause);
    this.exitCode = opts.exitCode ?? null;
    this.signal = opts.signal ?? null;
    this.stderrTail = opts.stderrTail ?? "";
  }
}

/** Pi 对一条命令返回 success:false（K-01：不许当成功吞掉）。 */
export class RpcCommandError extends AgentHostError {
  readonly command: string;
  readonly piError: string;

  constructor(command: string, piError: string, context: HostErrorContext = {}) {
    super("RPC_COMMAND_FAILED", `Pi 命令 ${command} 失败: ${piError}`, {
      ...context,
      command,
      piError,
    });
    this.command = command;
    this.piError = piError;
  }
}

/** RPC 请求在期限内没有等到响应。 */
export class RpcTimeoutError extends AgentHostError {
  constructor(command: string, timeoutMs: number, context: HostErrorContext = {}) {
    super("RPC_TIMEOUT", `RPC 请求 ${command} 超时（${timeoutMs}ms 内无响应）`, {
      ...context,
      command,
      timeoutMs,
    });
  }
}

/** 传输层已关闭（进程退出 / 流结束），挂起请求无法完成。 */
export class RpcTransportError extends AgentHostError {
  constructor(message: string, context: HostErrorContext = {}, cause?: unknown) {
    super("RPC_TRANSPORT_CLOSED", message, context, cause);
  }
}

/**
 * 一轮 agent 运行在没有 agent_settled 的情况下结束（K-02）。
 * 携带已收到的事件数与最后一个事件类型，便于定位终止点。
 */
export class AbnormalTerminationError extends AgentHostError {
  readonly eventsReceived: number;
  readonly lastEventType: string | null;

  constructor(
    message: string,
    opts: { eventsReceived: number; lastEventType?: string | null; context?: HostErrorContext; cause?: unknown },
  ) {
    super("RUN_ABNORMALLY_TERMINATED", message, opts.context ?? {}, opts.cause);
    this.eventsReceived = opts.eventsReceived;
    this.lastEventType = opts.lastEventType ?? null;
  }
}

/** 会话落盘层面的失败：元数据损坏、索引不一致等。 */
export class SessionStoreError extends AgentHostError {
  constructor(message: string, context: HostErrorContext = {}, cause?: unknown) {
    super("SESSION_STORE_FAILED", message, context, cause);
  }
}
