/**
 * 插件目录服务（M-15）。
 *
 * 约定：<dataDir>/plugins/ 下每个 .mjs/.js 文件是一个插件（Pi 扩展
 * 模块，默认导出工厂函数）；可选 sidecar `<base>.plugin.json` 提供
 * 展示元数据 { name, version, description }；启停注册表落在同目录
 * plugins.json（{ version, disabled: [fileName] }），缺省全部启用。
 *
 * 坏插件显形（K-03 精神，探针实证 Pi 1.6.0 的两层口径）：
 * 1. 静态层（本服务 list 时执行）：node --check 语法校验 + sidecar
 *    JSON 校验——错误以「文件名 + 原因」写进条目的 error 字段，
 *    面板红字呈现，绝不静默跳过坏插件。
 * 2. 加载层（Pi 进程启动时）：工厂抛错、无默认导出等运行时错误会让
 *    Pi 以退出码 1 拒绝启动，stderr 点名 `Failed to load extension
 *    "<路径>": <原因>`，经宿主 PiProcessError 原样透传到界面。
 *
 * 启停生效口径：扩展在 Pi 进程启动时经 --extension 加载，故启停
 * 只对新建/续接的会话生效，进行中的会话不变（面板明示此口径）。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { AgentHostError, SessionStoreError } from "./errors.js";

export interface PluginInfo {
  /** 插件文件名（目录内唯一标识，启停按它落盘）。 */
  fileName: string;
  /** 展示名：sidecar 的 name 优先，缺省用去扩展名的文件名。 */
  name: string;
  /** 来源：插件文件的绝对路径（本地目录扫描）。 */
  source: string;
  version?: string;
  description?: string;
  enabled: boolean;
  /** 静态校验错误（语法 / sidecar 损坏）：名称之外的具体原因。 */
  error?: string;
}

interface PluginRegistry {
  version: 1;
  disabled: string[];
}

const PLUGIN_EXTS = [".mjs", ".js"];
const REGISTRY_FILE = "plugins.json";

export class PluginService {
  private readonly dir: string;
  /** 语法校验缓存：fileName → { mtimeMs, size, error }，文件没变不重复起进程。 */
  private readonly syntaxCache = new Map<
    string,
    { mtimeMs: number; size: number; error?: string }
  >();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "plugins");
  }

  get pluginsDir(): string {
    return this.dir;
  }

  /** 扫描目录并返回全部插件（含坏的，坏的带 error 显形）。 */
  list(): PluginInfo[] {
    const disabled = new Set(this.loadRegistry().disabled);
    return this.scanFiles().map((fileName) => {
      const source = join(this.dir, fileName);
      const base = fileName.replace(/\.(mjs|js)$/, "");
      const info: PluginInfo = {
        fileName,
        name: base,
        source,
        enabled: !disabled.has(fileName),
      };
      const errors: string[] = [];
      // sidecar 元数据（可选）：损坏必须显形，不许静默当没有
      const sidecarPath = join(this.dir, `${base}.plugin.json`);
      if (existsSync(sidecarPath)) {
        try {
          const meta = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
            name?: unknown;
            version?: unknown;
            description?: unknown;
          };
          if (typeof meta?.name === "string" && meta.name) info.name = meta.name;
          if (typeof meta?.version === "string") info.version = meta.version;
          if (typeof meta?.description === "string") {
            info.description = meta.description;
          }
        } catch (err) {
          errors.push(
            `元数据文件 ${base}.plugin.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const syntaxError = this.checkSyntax(fileName, source);
      if (syntaxError) errors.push(syntaxError);
      if (errors.length > 0) info.error = errors.join("；");
      return info;
    });
  }

  /** 启用/停用一个插件（落盘注册表）；未知文件大声报错。 */
  setEnabled(fileName: string, enabled: boolean): PluginInfo {
    if (!this.scanFiles().includes(fileName)) {
      throw new AgentHostError(
        "PLUGIN_NOT_FOUND",
        `插件不存在: ${fileName}（目录 ${this.dir}）`,
        { fileName },
      );
    }
    const registry = this.loadRegistry();
    const disabled = new Set(registry.disabled);
    if (enabled) disabled.delete(fileName);
    else disabled.add(fileName);
    this.saveRegistry({ version: 1, disabled: [...disabled].sort() });
    const info = this.list().find((p) => p.fileName === fileName);
    return info!;
  }

  /** 已启用插件的绝对路径清单（会话启动时逐个 --extension 挂载）。 */
  enabledExtensionPaths(): string[] {
    return this.list()
      .filter((p) => p.enabled)
      .map((p) => p.source);
  }

  private scanFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() && PLUGIN_EXTS.some((ext) => e.name.endsWith(ext)),
      )
      .map((e) => e.name)
      .sort();
  }

  /** node --check 语法校验：失败返回「文件名 + 首行原因」，成功返回 undefined。 */
  private checkSyntax(fileName: string, path: string): string | undefined {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(path);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return `插件文件不可读: ${path}`;
    }
    const cached = this.syntaxCache.get(fileName);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.error;
    }
    let error: string | undefined;
    try {
      execFileSync(process.execPath, ["--check", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
    } catch (err) {
      const stderr =
        (err as { stderr?: string }).stderr ?? "";
      const firstLine =
        stderr
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(" ") || (err instanceof Error ? err.message : String(err));
      error = `语法校验失败（${basename(path)}）：${firstLine}`;
    }
    this.syntaxCache.set(fileName, { ...stat, error });
    return error;
  }

  private loadRegistry(): PluginRegistry {
    const file = join(this.dir, REGISTRY_FILE);
    if (!existsSync(file)) return { version: 1, disabled: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new SessionStoreError(
        `插件注册表损坏，无法解析: ${file}`,
        {},
        err,
      );
    }
    const disabled = (parsed as { disabled?: unknown })?.disabled;
    if (!Array.isArray(disabled)) {
      throw new SessionStoreError(`插件注册表结构非法: ${file}`, {});
    }
    return {
      version: 1,
      disabled: disabled.filter((d): d is string => typeof d === "string"),
    };
  }

  private saveRegistry(registry: PluginRegistry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      join(this.dir, REGISTRY_FILE),
      JSON.stringify(registry, null, 2) + "\n",
      "utf8",
    );
  }
}
