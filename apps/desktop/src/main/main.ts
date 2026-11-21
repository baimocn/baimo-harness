/**
 * Electron 主进程：内嵌 agent-host，随应用生命周期启停。
 *
 * 职责：
 * - 启动时构造 AgentHost（数据目录、桩模型模式、HOME 隔离都走 env，便于无头 E2E 复现）；
 * - 把门面能力收敛成一组白名单 IPC：渲染层只能经 preload 桥调用这里注册的通道；
 * - 壳层自有状态落盘：权限模式与模型选择（desktop-settings.json，M-02 本块仅记录）、
 *   回收站标记（desktop-trash.json，M-01 本块实现：删除确认 + 回收站标记，不销毁落盘数据）；
 * - 退出时先关宿主（子进程逐级优雅退出）再退应用，不留孤儿 Pi 进程。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentHost,
  type SessionHandle,
  type SessionMeta,
} from "@baimo-harness/agent-host";
import type {
  HostSnapshotDto,
  MilestoneDto,
  PermissionMode,
  SessionMetaDto,
  SessionStatsDto,
} from "@baimo-harness/ui";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..");

const STUB_REF = { provider: "stub", modelId: "stub-model" };

interface DesktopSettings {
  permissionMode: PermissionMode;
  perSessionMode: Record<string, PermissionMode>;
  selectedModel: { provider: string; modelId: string } | null;
}

const DEFAULT_SETTINGS: DesktopSettings = {
  permissionMode: "build",
  perSessionMode: {},
  selectedModel: null,
};

class JsonFile<T> {
  private data: T;
  constructor(
    private readonly path: string,
    fallback: T,
  ) {
    this.data = fallback;
    if (existsSync(path)) {
      try {
        this.data = { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as T) };
      } catch {
        // 壳层自有设置损坏：回退默认值但保留原文件供排查（不静默覆盖用户数据以外的东西不适用——此文件仅壳层状态）
        this.data = fallback;
      }
    }
  }
  get value(): T {
    return this.data;
  }
  update(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    return this.data;
  }
}

const dataDir =
  process.env.BAIMO_DATA_DIR ?? join(app.getPath("userData"), "data");
const workspaceDir =
  process.env.BAIMO_WORKSPACE_DIR ?? join(app.getPath("userData"), "workspace");
const stubUrl = process.env.BAIMO_STUB_MODEL_URL ?? null;
const piHome = process.env.BAIMO_PI_HOME ?? null;
const stubMode = stubUrl !== null;

mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

const settings = new JsonFile<DesktopSettings>(
  join(dataDir, "desktop-settings.json"),
  DEFAULT_SETTINGS,
);
const trash = new JsonFile<{ entries: Record<string, string> }>(
  join(dataDir, "desktop-trash.json"),
  { entries: {} },
);

function kernelVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(
          projectRoot,
          "runtime/node_modules/@earendil-works/pi-coding-agent/package.json",
        ),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? "未知";
  } catch {
    return "未知";
  }
}

/** 桩模式：在宿主启动前把 models.json 写进 Pi 配置目录（与测试 fixture 同形）。 */
function prepareStubModels(): void {
  if (!stubUrl) return;
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          stub: {
            baseUrl: stubUrl,
            api: "openai-completions",
            apiKey: "stub-key",
            models: [{ id: "stub-model" }],
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

prepareStubModels();

const host = new AgentHost({
  dataDir,
  workspaceDir,
  env: piHome ? { HOME: piHome } : {},
});

const live = new Map<string, SessionHandle>();
let activeSessionId: string | null = null;
let mainWindow: BrowserWindow | null = null;

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function toDto(meta: SessionMeta): SessionMetaDto {
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    eventCount: meta.eventCount,
    modelRef: meta.modelRef,
    live: live.has(meta.id),
    trashed: meta.id in trash.value.entries,
  };
}

function selectedModel(): { provider: string; modelId: string } | null {
  return settings.value.selectedModel ?? (stubMode ? STUB_REF : null);
}

function snapshot(): HostSnapshotDto {
  const metas = host.listSessions().map(toDto);
  return {
    kernelVersion: kernelVersion(),
    dataDir,
    workspaceDir,
    stubMode,
    permissionMode: settings.value.permissionMode,
    availableModels: stubMode
      ? [{ ...STUB_REF, label: "stub-model（本地桩）" }]
      : [],
    selectedModel: selectedModel(),
    sessions: metas.filter((m) => !m.trashed),
    trashedSessions: metas.filter((m) => m.trashed),
    activeSessionId,
  };
}

async function pushStats(sessionId: string): Promise<void> {
  const handle = live.get(sessionId);
  if (!handle) return;
  try {
    const resp = await handle.command<SessionStatsDto>({
      type: "get_session_stats",
    });
    if (resp.data) send("session:stats", { sessionId, stats: resp.data });
  } catch {
    // 统计拿不到就保持未接入显示，不编造数字（界面侧有未接入态）
  }
}

function wireHandle(handle: SessionHandle): void {
  handle.on("event", (record) => {
    send("session:event", { sessionId: handle.id, record });
  });
  handle.on("processExit", (info) => {
    live.delete(handle.id);
    send("session:process-exit", {
      sessionId: handle.id,
      code: info.code,
      signal: info.signal,
    });
  });
}

const MILESTONE_LABELS: Record<string, string> = {
  session_opened: "会话打开",
  handshake: "握手完成",
  session_resumed: "会话续接",
  run_settled: "检查点 · 运行完成",
  run_stopped: "检查点 · 已停止",
  run_aborted: "运行异常终止",
  run_timeout: "运行超时",
  process_exit: "Pi 进程退出",
  session_closed: "会话关闭",
};

function registerIpc(): void {
  ipcMain.handle("host:snapshot", () => snapshot());

  ipcMain.handle("session:create", async (_e, title?: string) => {
    const model = selectedModel();
    const handle = await host.openSession({
      title: title ?? `新会话 ${new Date().toLocaleTimeString()}`,
      workspaceDir,
      piArgs: model
        ? ["--provider", model.provider, "--model", model.modelId]
        : [],
      modelRef: model,
    });
    live.set(handle.id, handle);
    wireHandle(handle);
    activeSessionId = handle.id;
    // 权限模式随会话记录（本块仅记录，审批拦截下一块）
    settings.update({
      perSessionMode: {
        ...settings.value.perSessionMode,
        [handle.id]: settings.value.permissionMode,
      },
    });
    return toDto(handle.meta);
  });

  ipcMain.handle("session:activate", (_e, id: string) => {
    const meta = host.listSessions().find((m) => m.id === id);
    if (!meta) throw new Error(`未知会话: ${id}`);
    activeSessionId = id;
    return { meta: toDto(meta), live: live.has(id) };
  });

  ipcMain.handle("session:history", (_e, id: string) => {
    const { events, recovery } = host.loadSession(id);
    const normalized: Array<Record<string, unknown>> = [];
    const milestones: MilestoneDto[] = [];
    for (const e of events) {
      if (e.kind === "rpc_event") {
        normalized.push(e.event as Record<string, unknown>);
      } else if (e.kind === "prompt") {
        normalized.push({ type: "user_prompt", message: e.message });
      } else if (e.kind === "lifecycle") {
        normalized.push({ type: "lifecycle", event: e.event });
        const label = MILESTONE_LABELS[String(e.event)];
        if (label) {
          milestones.push({ seq: e.seq, ts: e.ts, event: String(e.event), label });
        }
      }
    }
    return { events: normalized, milestones, recovery };
  });

  ipcMain.handle("session:prompt", (_e, id: string, message: string) => {
    const handle = live.get(id);
    if (!handle) return { accepted: false, error: "会话未在运行（历史会话请先点「继续会话」）" };
    if (handle.busy) return { accepted: false, error: "会话忙：上一轮尚未结算" };
    handle.prompt(message).then(
      (outcome) => {
        send("session:run-settled", {
          sessionId: id,
          ok: true,
          stopped: outcome.disposition === "aborted",
        });
        void pushStats(id);
      },
      (err: unknown) => {
        const e = err as { message?: string; code?: string };
        send("session:run-settled", {
          sessionId: id,
          ok: false,
          error: e?.message ?? String(err),
          code: e?.code,
        });
      },
    );
    return { accepted: true };
  });

  ipcMain.handle("session:resume", async (_e, id: string) => {
    const existing = live.get(id);
    if (existing) return { meta: toDto(existing.meta), live: true };
    const meta = host.listSessions().find((m) => m.id === id);
    if (!meta) throw new Error(`未知会话: ${id}`);
    const model = meta.modelRef ?? selectedModel();
    const handle = await host.resumeSession(id, {
      piArgs: model
        ? ["--provider", model.provider, "--model", model.modelId]
        : [],
    });
    live.set(handle.id, handle);
    wireHandle(handle);
    activeSessionId = id;
    return { meta: toDto(handle.meta), live: true };
  });

  ipcMain.handle("session:abort", async (_e, id: string) => {
    const handle = live.get(id);
    if (!handle) return { aborted: false };
    const aborted = await handle.abort();
    return { aborted };
  });

  ipcMain.handle("session:close", async (_e, id: string) => {
    const handle = live.get(id);
    if (handle) {
      live.delete(id);
      await handle.close();
    }
  });

  ipcMain.handle("session:trash", async (_e, id: string) => {
    const handle = live.get(id);
    if (handle) {
      live.delete(id);
      await handle.close().catch(() => undefined);
    }
    trash.update({
      entries: { ...trash.value.entries, [id]: new Date().toISOString() },
    });
    if (activeSessionId === id) activeSessionId = null;
  });

  ipcMain.handle("session:restore", (_e, id: string) => {
    const entries = { ...trash.value.entries };
    delete entries[id];
    trash.update({ entries });
  });

  ipcMain.handle(
    "mode:set",
    (_e, mode: PermissionMode, sessionId?: string) => {
      settings.update({
        permissionMode: mode,
        perSessionMode: sessionId
          ? { ...settings.value.perSessionMode, [sessionId]: mode }
          : settings.value.perSessionMode,
      });
      return { mode };
    },
  );

  ipcMain.handle(
    "model:set",
    (_e, model: { provider: string; modelId: string }) => {
      settings.update({ selectedModel: model });
      return { selectedModel: model };
    },
  );

  ipcMain.handle("session:stats", async (_e, id: string) => {
    const handle = live.get(id);
    if (!handle) return null;
    const resp = await handle.command<SessionStatsDto>({
      type: "get_session_stats",
    });
    return resp.data ?? null;
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: "#14161a",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadFile(join(here, "renderer", "index.html"));
}

let quitting = false;

async function boot(): Promise<void> {
  await host.start();
  registerIpc();
  await createWindow();
}

app.whenReady().then(() => {
  boot().catch((err) => {
    console.error("白墨 Harness 启动失败:", err);
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  host
    .close()
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
