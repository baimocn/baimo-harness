/**
 * Pi RPC 客户端：JSONL over stdio。
 *
 * 协议要点（随附 Pi 1.6.0 docs/rpc.md）：
 * - 严格按 LF 分帧，禁止用 readline（会误切 U+2028/U+2029）；容忍 CRLF。
 * - 请求/响应按 id 关联，响应顺序不保证。
 * - success:false 必须显形为 RpcCommandError（K-01），不许当成功吞掉。
 * - 坏行（非法 JSON）不许吞掉：记录进 protocolErrors 并以事件上报，连接不断。
 * - 无 id 的 response（如 Pi 的 parse 错误回执）无处关联：记录并以事件上报。
 * - 每个请求带超时，超时抛 RpcTimeoutError；传输关闭时全部挂起请求以类型化错误结算。
 */
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  RpcCommandError,
  RpcTimeoutError,
  RpcTransportError,
} from "./errors.js";

export type RpcRecord = Record<string, unknown> & { type?: string };

export interface RpcResponse<T = unknown> {
  id: string;
  command: string;
  success: true;
  data: T;
}

export interface ProtocolErrorInfo {
  /** 出错的原始行（截断到 200 字符）。 */
  line: string;
  message: string;
  at: string;
}

interface PendingRequest {
  command: string;
  resolve: (res: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcClientOptions {
  /** 单请求默认超时（ms）。 */
  requestTimeoutMs?: number;
}

/** stdout 结束时等待进程退出路径先行结算的宽限（ms）。 */
const STREAM_END_GRACE_MS = 50;

export declare interface RpcClient {
  /** 每条成功解析的记录（响应与事件）都会触发。 */
  on(event: "record", listener: (record: RpcRecord) => void): this;
  /** 非 response 记录（会话事件流）。 */
  on(event: "event", listener: (record: RpcRecord) => void): this;
  /** 无挂起请求可关联的 response（如 parse 错误回执、超时后迟到的响应）。 */
  on(event: "unmatchedResponse", listener: (record: RpcRecord) => void): this;
  /** 坏行：非法 JSON。已记录在 protocolErrors 中，此处同步上报。 */
  on(event: "protocolError", listener: (info: ProtocolErrorInfo) => void): this;
  /** 传输关闭（只触发一次）。 */
  on(event: "close", listener: (err: Error) => void): this;
}

export class RpcClient extends EventEmitter {
  private input: Writable | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private closed = false;
  private closeError: Error | null = null;
  private streamEndTimer: NodeJS.Timeout | null = null;
  private readonly defaultTimeoutMs: number;

  /** 全部坏行记录（不吞掉，供审计与测试断言）。 */
  readonly protocolErrors: ProtocolErrorInfo[] = [];
  /** 全部无处关联的 response 记录。 */
  readonly unmatchedResponses: RpcRecord[] = [];

  constructor(options: RpcClientOptions = {}) {
    super();
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 绑定子进程的 stdin/stdout。绑定后即可收发。 */
  attach(input: Writable, output: Readable): void {
    if (this.input) throw new RpcTransportError("RpcClient 已绑定流，不可重复绑定");
    this.input = input;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.onData(chunk));
    output.on("end", () => {
      // stdout 结束通常与进程退出同时发生，但 exit 事件可能晚几毫秒到达。
      // 给一个短暂宽限：让宿主持有的进程退出路径先以带退出码/stderr 的
      // PiProcessError 结算（上下文更完整）；宽限内无人结算才用通用错误。
      this.streamEndTimer = setTimeout(() => {
        this.failTransport(new RpcTransportError("Pi stdout 已结束（进程可能已退出）"));
      }, STREAM_END_GRACE_MS);
    });
    output.on("error", (err: Error) =>
      this.failTransport(new RpcTransportError("Pi stdout 出错", {}, err)),
    );
    input.on("error", (err: Error) =>
      this.failTransport(new RpcTransportError("Pi stdin 出错", {}, err)),
    );
  }

  /**
   * 发送一条命令并等待其 response。
   * success:false → RpcCommandError；超时 → RpcTimeoutError；传输关闭 → RpcTransportError/PiProcessError。
   */
  request<T = unknown>(
    command: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<RpcResponse<T>> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new RpcTransportError("RPC 传输已关闭，无法发送请求"),
      );
    }
    if (!this.input) {
      return Promise.reject(new RpcTransportError("RpcClient 尚未绑定流"));
    }
    const id =
      typeof command.id === "string" && command.id.length > 0
        ? command.id
        : `req-${++this.counter}`;
    const commandType = typeof command.type === "string" ? command.type : "<unknown>";
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(commandType, timeoutMs, { id }));
      }, timeoutMs);
      this.pending.set(id, {
        command: commandType,
        resolve: resolve as (res: RpcResponse) => void,
        reject,
        timer,
      });
      const line = JSON.stringify({ ...command, id }) + "\n";
      this.input!.write(line, (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new RpcTransportError(`写入 Pi stdin 失败（命令 ${commandType}）`, { id }, err));
        }
      });
    });
  }

  /** 发送原始文本（一行）。供协议级测试与特殊场景使用。 */
  sendRaw(text: string): void {
    if (this.closed || !this.input) {
      throw new RpcTransportError("RPC 传输已关闭或未绑定，无法写入");
    }
    this.input.write(text.endsWith("\n") ? text : text + "\n");
  }

  /**
   * 关闭传输：全部挂起请求以给定错误（或默认 RpcTransportError）结算。
   * 进程退出时由 PiProcess/AgentHost 以 PiProcessError 调用，保证上下文不丢。
   */
  failTransport(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    if (this.streamEndTimer) {
      clearTimeout(this.streamEndTimer);
      this.streamEndTimer = null;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.emit("close", err);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch (err) {
      const info: ProtocolErrorInfo = {
        line: line.slice(0, 200),
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      this.protocolErrors.push(info);
      this.emit("protocolError", info);
      return;
    }
    this.emit("record", record);

    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : null;
      const pending = id ? this.pending.get(id) : undefined;
      if (!pending) {
        // 无处关联（如 Pi 的 parse 回执无 id，或请求已超时）：记录并上报，不吞掉。
        this.unmatchedResponses.push(record);
        this.emit("unmatchedResponse", record);
        return;
      }
      this.pending.delete(id!);
      clearTimeout(pending.timer);
      if (record.success === true) {
        pending.resolve({
          id: id!,
          command: String(record.command ?? pending.command),
          success: true,
          data: record.data,
        });
      } else {
        pending.reject(
          new RpcCommandError(
            String(record.command ?? pending.command),
            typeof record.error === "string" ? record.error : "未知错误（Pi 未给出 error 字段）",
            { id },
          ),
        );
      }
      return;
    }

    this.emit("event", record);
  }
}
