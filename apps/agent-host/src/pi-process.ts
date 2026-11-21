/**
 * Pi 子进程管理器。
 *
 * 职责：
 * - 按遥测审计（docs/telemetry-audit.md §5）的三重关闭法拉起 RPC 模式子进程：
 *   env 强制 PI_TELEMETRY=0、PI_SKIP_VERSION_CHECK=1（可选 PI_OFFLINE=1），
 *   并在托管的 Pi 配置目录把 settings.json 的 enableInstallTelemetry 写死为 false。
 * - 捕获 exit code / signal / stderr 尾部；进程死亡以事件显形，绝不静默（K-01/K-08 补偿）。
 * - 优雅关闭：关 stdin → 等待 → SIGTERM → SIGKILL 逐级升级。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, PiProcessError } from "./errors.js";
import { validatePiSettings } from "./config.js";

export interface PiProcessOptions {
  /** Pi CLI 入口（bundle/cli.js）。 */
  cliPath: string;
  /** 子进程工作目录。 */
  cwd: string;
  /** Pi 配置目录（PI_CODING_AGENT_DIR）。 */
  agentDir: string;
  /** CLI 参数（不含 --mode rpc，由管理器固定拼装）。 */
  args?: string[];
  /** 硬离线（PI_OFFLINE=1）。 */
  offline?: boolean;
  /** 追加环境变量（遥测关闭变量不可被覆盖）。 */
  env?: Record<string, string>;
}

export interface PiExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

const STDERR_TAIL_LIMIT = 8192;

/**
 * 准备 Pi 配置目录：校验既有 settings.json（坏 JSON / 未知键 → ConfigError 拒绝启动，K-03），
 * 并写死 enableInstallTelemetry:false（遥测三重关闭之二）。
 * 返回最终生效的 settings 对象。
 */
export function preparePiAgentDir(agentDir: string): Record<string, unknown> {
  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`Pi settings.json 不是合法 JSON（${settingsPath}），拒绝启动`, {
        source: settingsPath,
      }, );
    }
    settings = validatePiSettings(parsed, settingsPath);
  }
  if (settings.enableInstallTelemetry !== false) {
    settings = { ...settings, enableInstallTelemetry: false };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return settings;
}

/** 构造子进程 env：遥测三重关闭变量强制覆盖任何继承/追加值。 */
export function buildPiEnv(opts: {
  agentDir: string;
  offline?: boolean;
  env?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.env ?? {}),
    // 三重关闭之一：env 强制（docs/telemetry-audit.md §5）
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: opts.agentDir,
  };
  if (opts.offline) env.PI_OFFLINE = "1";
  return env;
}

export declare interface PiProcess {
  on(event: "exit", listener: (info: PiExitInfo) => void): this;
  on(event: "stderr", listener: (chunk: string) => void): this;
}

export class PiProcess extends EventEmitter {
  readonly child: ChildProcess;
  /** 实际注入子进程的 env（供审计与测试断言遥测关闭变量）。 */
  readonly spawnedEnv: NodeJS.ProcessEnv;

  private stderrTail = "";
  private exitInfoValue: PiExitInfo | null = null;
  private readonly exitPromise: Promise<PiExitInfo>;

  private constructor(child: ChildProcess, spawnedEnv: NodeJS.ProcessEnv) {
    super();
    this.child = child;
    this.spawnedEnv = spawnedEnv;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      this.emit("stderr", chunk);
    });
    this.exitPromise = new Promise<PiExitInfo>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitInfoValue = { code, signal, stderrTail: this.stderrTail };
        this.emit("exit", this.exitInfoValue);
        resolve(this.exitInfoValue);
      });
    });
  }

  /** 拉起 Pi RPC 子进程；启动失败抛 PiProcessError（不静默）。 */
  static async start(opts: PiProcessOptions): Promise<PiProcess> {
    preparePiAgentDir(opts.agentDir);
    const env = buildPiEnv(opts);
    const args = [opts.cliPath, "--mode", "rpc", ...(opts.args ?? [])];
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new PiProcessError(`启动 Pi 子进程失败: ${String(err)}`, { cause: err });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(
          new PiProcessError(`启动 Pi 子进程失败: ${err.message}`, {
            context: { cliPath: opts.cliPath, cwd: opts.cwd },
            cause: err,
          }),
        );
      };
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        // spawn 之后的 error（如 stdin EPIPE）由 RpcClient 的流错误处理接管显形。
        child.on("error", () => undefined);
        resolve();
      });
    });
    return new PiProcess(child, env);
  }

  get alive(): boolean {
    return this.exitInfoValue === null;
  }

  get exitInfo(): PiExitInfo | null {
    return this.exitInfoValue;
  }

  /** 等待进程退出（不发送任何信号）。 */
  waitExit(): Promise<PiExitInfo> {
    return this.exitPromise;
  }

  /** 立即发送信号（看门狗/测试用）。 */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.alive) this.child.kill(signal);
  }

  /**
   * 优雅关闭：关 stdin 请进程自行退出（Pi 会等手头工作收尾）；
   * 超时后 SIGTERM，再超时 SIGKILL。返回退出信息。
   */
  async stop(opts: { shutdownTimeoutMs: number; killTimeoutMs: number }): Promise<PiExitInfo> {
    if (this.exitInfoValue) return this.exitInfoValue;
    this.child.stdin?.end();
    const exited = await this.waitWithTimeout(opts.shutdownTimeoutMs);
    if (exited) return exited;
    this.child.kill("SIGTERM");
    const afterTerm = await this.waitWithTimeout(opts.killTimeoutMs);
    if (afterTerm) return afterTerm;
    this.child.kill("SIGKILL");
    return this.exitPromise;
  }

  /** 把退出信息包装成带上下文的 PiProcessError（供传输层结算挂起请求时使用）。 */
  toExitError(): PiProcessError {
    const info = this.exitInfoValue;
    return new PiProcessError(
      info
        ? `Pi 子进程已退出（code=${info.code}, signal=${info.signal}）`
        : "Pi 子进程已退出",
      {
        exitCode: info?.code ?? null,
        signal: info?.signal ?? null,
        stderrTail: info?.stderrTail ?? this.stderrTail,
      },
    );
  }

  private async waitWithTimeout(ms: number): Promise<PiExitInfo | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    const result = await Promise.race([this.exitPromise, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
