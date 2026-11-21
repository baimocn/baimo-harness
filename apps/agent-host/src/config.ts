/**
 * 宿主配置与 Pi 设置的严格校验（K-03 壳层补偿）。
 *
 * Pi 原生设置加载器会静默忽略未知键与坏值；宿主在启动前逐条校验：
 * 未知键、类型错误、取值非法一律抛 ConfigError 并拒绝启动，不许静默忽略。
 */
import { ConfigError } from "./errors.js";

/** 宿主配置（用户传入形态，全部字段可选，dataDir 除外）。 */
export interface HostConfig {
  /** 本地数据目录：会话落盘根目录（产品设计文档第 6 章布局）。 */
  dataDir: string;
  /** Pi 配置目录（PI_CODING_AGENT_DIR）。默认 <dataDir>/pi-agent。 */
  piAgentDir?: string;
  /** Pi CLI 入口（bundle/cli.js）。默认按随附 runtime 的钉版路径解析。 */
  piCliPath?: string;
  /** Pi 子进程的工作目录默认值。默认宿主进程 cwd。 */
  workspaceDir?: string;
  /** RPC 请求默认超时（ms）。默认 30000。 */
  requestTimeoutMs?: number;
  /** 优雅关闭等待（ms）：关 stdin 后等进程自行退出。默认 10000。 */
  shutdownTimeoutMs?: number;
  /** SIGTERM 后等待 SIGKILL 的宽限（ms）。默认 3000。 */
  killTimeoutMs?: number;
  /** 硬离线：注入 PI_OFFLINE=1（遥测审计 §5 第 3 重保险）。默认 false。 */
  offline?: boolean;
  /** 追加给每个 Pi 子进程的 CLI 参数（如 --provider/--model）。 */
  extraPiArgs?: string[];
  /** 追加给 Pi 子进程的环境变量（遥测三重关闭变量不可被覆盖，见 pi-process）。 */
  env?: Record<string, string>;
}

/** 校验并补齐默认值后的宿主配置。 */
export interface ResolvedHostConfig {
  dataDir: string;
  piAgentDir: string;
  piCliPath: string;
  workspaceDir: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  killTimeoutMs: number;
  offline: boolean;
  extraPiArgs: string[];
  env: Record<string, string>;
}

const HOST_CONFIG_KEYS = new Set([
  "dataDir",
  "piAgentDir",
  "piCliPath",
  "workspaceDir",
  "requestTimeoutMs",
  "shutdownTimeoutMs",
  "killTimeoutMs",
  "offline",
  "extraPiArgs",
  "env",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`配置 ${field} 必须是非空字符串`, { field, value: v });
  }
  return v;
}

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  return requireNonEmptyString(v, field);
}

function positiveMs(v: unknown, field: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`配置 ${field} 必须是正数（毫秒）`, { field, value: v });
  }
  return v;
}

/** 校验用户传入的宿主配置并解析为完整配置；任何问题抛 ConfigError。 */
export function resolveHostConfig(input: HostConfig, defaultPiCliPath: string): ResolvedHostConfig {
  if (!isPlainObject(input)) {
    throw new ConfigError("宿主配置必须是对象", { value: input });
  }
  const unknown = Object.keys(input).filter((k) => !HOST_CONFIG_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ConfigError(`宿主配置含未知键: ${unknown.join(", ")}（不许静默忽略，请删除或更正）`, {
      unknownKeys: unknown,
    });
  }

  const dataDir = requireNonEmptyString(input.dataDir, "dataDir");

  let extraPiArgs: string[] = [];
  if (input.extraPiArgs !== undefined) {
    if (!Array.isArray(input.extraPiArgs) || input.extraPiArgs.some((a) => typeof a !== "string")) {
      throw new ConfigError("配置 extraPiArgs 必须是字符串数组", { value: input.extraPiArgs });
    }
    extraPiArgs = [...input.extraPiArgs];
  }

  let env: Record<string, string> = {};
  if (input.env !== undefined) {
    if (!isPlainObject(input.env)) {
      throw new ConfigError("配置 env 必须是字符串键值对象", { value: input.env });
    }
    for (const [k, v] of Object.entries(input.env)) {
      if (typeof v !== "string") {
        throw new ConfigError(`配置 env.${k} 必须是字符串`, { field: `env.${k}`, value: v });
      }
    }
    env = { ...input.env };
  }

  if (input.offline !== undefined && typeof input.offline !== "boolean") {
    throw new ConfigError("配置 offline 必须是布尔值", { value: input.offline });
  }

  return {
    dataDir,
    piAgentDir: optionalString(input.piAgentDir, "piAgentDir") ?? `${dataDir}/pi-agent`,
    piCliPath: optionalString(input.piCliPath, "piCliPath") ?? defaultPiCliPath,
    workspaceDir: optionalString(input.workspaceDir, "workspaceDir") ?? process.cwd(),
    requestTimeoutMs: positiveMs(input.requestTimeoutMs, "requestTimeoutMs", 30_000),
    shutdownTimeoutMs: positiveMs(input.shutdownTimeoutMs, "shutdownTimeoutMs", 10_000),
    killTimeoutMs: positiveMs(input.killTimeoutMs, "killTimeoutMs", 3_000),
    offline: input.offline ?? false,
    extraPiArgs,
    env,
  };
}

/**
 * Pi settings.json 的已知键（来源：随附 Pi 1.6.0 的 docs/settings.md 设置表）。
 * Pi 原生加载器静默忽略未知键，宿主在此大声报错（K-03）。
 */
export const PI_SETTINGS_KEYS = new Set([
  "autocompleteMaxVisible",
  "cacheWarming",
  "collapseChangelog",
  "defaultModel",
  "defaultProjectTrust",
  "defaultProvider",
  "defaultThinkingLevel",
  "defaultTools",
  "doubleEscapeAction",
  "editorPaddingX",
  "enableAnalytics",
  "enableInstallTelemetry",
  "enableSkillCommands",
  "enabledModels",
  "extensions",
  "externalEditor",
  "followUpMode",
  "fullscreenCopyOnSelect",
  "fullscreenExitOutput",
  "fullscreenScrollbar",
  "fullscreenWheelScrollLines",
  "hideThinkingBlock",
  "httpIdleTimeoutMs",
  "httpProxy",
  "modelThinkingLevels",
  "npmCommand",
  "outputPad",
  "packages",
  "prompts",
  "quietStartup",
  "selfUpdateCommand",
  "sessionDir",
  "sessionShareDestination",
  "shellCommandPrefix",
  "shellPath",
  "showCacheMissNotices",
  "showHardwareCursor",
  "skills",
  "steeringMode",
  "theme",
  "themes",
  "thinkingBudgets",
  "transport",
  "treeFilterMode",
  "tuiMode",
  "websocketConnectTimeoutMs",
]);

const PI_SETTINGS_TYPES: Record<string, "string" | "boolean" | "number" | "array"> = {
  defaultProvider: "string",
  defaultModel: "string",
  defaultThinkingLevel: "string",
  theme: "string",
  externalEditor: "string",
  httpProxy: "string",
  sessionDir: "string",
  shellPath: "string",
  transport: "string",
  steeringMode: "string",
  followUpMode: "string",
  enableInstallTelemetry: "boolean",
  enableAnalytics: "boolean",
  enableSkillCommands: "boolean",
  collapseChangelog: "boolean",
  quietStartup: "boolean",
  hideThinkingBlock: "boolean",
  showCacheMissNotices: "boolean",
  showHardwareCursor: "boolean",
  cacheWarming: "boolean",
  editorPaddingX: "number",
  httpIdleTimeoutMs: "number",
  websocketConnectTimeoutMs: "number",
  autocompleteMaxVisible: "number",
  enabledModels: "array",
  extensions: "array",
  skills: "array",
  packages: "array",
  prompts: "array",
  themes: "array",
  defaultTools: "array",
};

/**
 * 校验一份已解析的 Pi settings 对象：未知键 / 已知键类型错误 → ConfigError。
 * source 用于错误信息定位（如文件路径）。
 */
export function validatePiSettings(settings: unknown, source: string): Record<string, unknown> {
  if (!isPlainObject(settings)) {
    throw new ConfigError(`Pi 设置必须是 JSON 对象（来源: ${source}）`, { source, value: settings });
  }
  const unknown = Object.keys(settings).filter((k) => !PI_SETTINGS_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Pi 设置含未知键: ${unknown.join(", ")}（来源: ${source}；Pi 原生会静默忽略，宿主拒绝启动）`,
      { source, unknownKeys: unknown },
    );
  }
  for (const [key, value] of Object.entries(settings)) {
    const expected = PI_SETTINGS_TYPES[key];
    if (!expected || value === undefined) continue;
    const ok =
      expected === "array" ? Array.isArray(value) : typeof value === expected;
    if (!ok) {
      throw new ConfigError(`Pi 设置 ${key} 类型应为 ${expected}（来源: ${source}）`, {
        source,
        field: key,
        value,
      });
    }
  }
  return settings;
}
