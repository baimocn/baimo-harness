/**
 * Electron 主进程：内嵌 agent-host，随应用生命周期启停。
 *
 * 职责：
 * - 启动时构造 AgentHost（数据目录、桩模型模式、HOME 隔离都走 env，便于无头 E2E 复现）；
 * - 把门面能力收敛成一组白名单 IPC：渲染层只能经 preload 桥调用这里注册的通道；
 * - 壳层自有状态落盘：权限模式与模型选择（desktop-settings.json，M-02）、
 *   回收站标记（desktop-trash.json，M-01 本块实现：删除确认 + 回收站标记，不销毁落盘数据）；
 * - M-02 审批：每个会话进程挂审批门扩展（agent-host 随附），策略文件在
 *   数据目录 approval/ 下按会话一份（模式 + 本会话授权，扩展逐次现读）；
 *   扩展的审批请求（extension_ui_request）由 wireHandle 拦截转成审批卡
 *   事件推给渲染层，裁决经 approval:respond 回注 extension_ui_response。
 * - 退出时先关宿主（子进程逐级优雅退出）再退应用，不留孤儿 Pi 进程。
 */
import { app, BrowserWindow, ipcMain, session } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentHost,
  IdleQueueRunner,
  approvalGateExtensionPath,
  planGateExtensionPath,
  type IdleExecutor,
  type PromptOutcome,
  type SessionHandle,
  type SessionMeta,
} from "@baimo-harness/agent-host";
import {
  CheckpointStore,
  type CheckpointManifest,
  type RollbackReport,
} from "@baimo-harness/core";
import type {
  ApprovalRequestDto,
  CheckpointDto,
  HostSnapshotDto,
  MilestoneDto,
  PermissionMode,
  PlanSelectChoice,
  PlanStateDto,
  PlanStepDto,
  PlanViewDto,
  SessionMetaDto,
  SessionStatsDto,
} from "@baimo-harness/ui";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..");

/*
 * 零外发红线（K-04 抓包审计实测）：壳层 Chromium 会在新 profile
 * 启动时自行联网下载英文拼写词典（GET redirector.gvt1.com/
 * edgedl/chrome/dict/en-us-10-2.bdic，NetLog 实测定位）——不是应用
 * 代码发起的，但按「除配置的模型端点外零对外连接」的口径同样不
 * 允许。正解是关掉拼写检查（createWindow 的 webPreferences.
 * spellcheck=false + 下面的会话级禁用）；这里再在启动最早期关掉
 * 组件更新、域名可靠性上报与后台联网服务，作为纵深防御。行为由
 * tests/regression/telemetry-capture.test.mjs 的抓包回归守住
 * （全过程见 docs/test-runs/2026-11-21-telemetry-capture.md）。
 */
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-background-networking");

const STUB_REF = { provider: "stub", modelId: "stub-model" };

interface DesktopSettings {
  permissionMode: PermissionMode;
  perSessionMode: Record<string, PermissionMode>;
  /** 会话 → 审批策略文件 key（策略文件在 approval/<key>.json，含本会话授权）。 */
  approvalKeys: Record<string, string>;
  /** 会话 → 计划文件 key（状态 plan/<key>.state.json + 策略 plan/<key>.policy.json）。 */
  planKeys: Record<string, string>;
  /** 会话 → 是否开启「计划先行」（M-03，缺省关闭，界面开关）。 */
  perSessionPlanRequired: Record<string, boolean>;
  /** 会话 → 计划是否被用户暂停（经策略文件在工具调用边界生效）。 */
  perSessionPlanPaused: Record<string, boolean>;
  selectedModel: { provider: string; modelId: string } | null;
}

const DEFAULT_SETTINGS: DesktopSettings = {
  permissionMode: "build",
  perSessionMode: {},
  approvalKeys: {},
  planKeys: {},
  perSessionPlanRequired: {},
  perSessionPlanPaused: {},
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
/** 本地真模型模式（第七块）：env 指向本机回环推理端点（如 Ollama
 * http://localhost:11434/v1），模型 id 可经 BAIMO_LOCAL_MODEL_ID 覆盖。
 * 与桩模式并列，靠 env 切换；端点只许回环，推理不出本机。 */
const localModelUrl = process.env.BAIMO_LOCAL_MODEL_URL ?? null;
const localModelId =
  process.env.BAIMO_LOCAL_MODEL_ID ?? "qwen2.5-coder:0.5b";
const LOCAL_REF = { provider: "ollama", modelId: localModelId };
const localMode = localModelUrl !== null;

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

/** 桩/本地模型模式：在宿主启动前把 models.json 写进 Pi 配置目录
 * （桩条目与测试 fixture 同形；本地真模型条目按 Pi 文档的 Ollama 兼容
 * 端点形态，占位 key 由端点忽略）。两者可并存，模型选择器里切换。 */
function prepareStubModels(): void {
  if (!stubUrl && !localModelUrl) return;
  const providers: Record<string, unknown> = {};
  if (stubUrl) {
    providers.stub = {
      baseUrl: stubUrl,
      api: "openai-completions",
      apiKey: "stub-key",
      models: [{ id: "stub-model" }],
    };
  }
  if (localModelUrl) {
    providers.ollama = {
      baseUrl: localModelUrl,
      api: "openai-completions",
      apiKey: "ollama",
      // temperature 0：小模型在采样下工具调用格式漂移严重，
      // 探针实证 temp=0 时输出稳定（见 docs/test-runs/2026-11-24-local-model.md）。
      models: [{ id: localModelId, samplingParams: { temperature: 0 } }],
    };
  }
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({ providers }, null, 2) + "\n",
    "utf8",
  );
}

prepareStubModels();

const host = new AgentHost({
  dataDir,
  workspaceDir,
  env: piHome ? { HOME: piHome } : {},
});

/** 检查点存储（M-06）：快照落在数据目录，不污染用户工作区。 */
const checkpoints = new CheckpointStore(join(dataDir, "checkpoints"));
/** 进行中的 prompt 承诺（按会话）：回滚前等运行结算用。 */
const pendingRuns = new Map<string, Promise<void>>();

function toCheckpointDto(m: CheckpointManifest): CheckpointDto {
  return {
    id: m.id,
    sessionId: m.sessionId,
    createdAt: m.createdAt,
    label: m.label,
    trigger: m.trigger,
    fileCount: m.files.length,
    totalBytes: m.files.reduce((sum, f) => sum + f.size, 0),
    skippedCount: m.skipped.length,
  };
}

function sessionWorkspace(sessionId: string): string {
  const meta = host.listSessions().find((m) => m.id === sessionId);
  return meta?.workspaceDir ?? workspaceDir;
}

/** 自动打点：失败不挡运行，但必须显形（推送给界面成条提示），不静默。 */
function autoSnapshot(
  sessionId: string,
  label: string,
  trigger: "run_start" | "run_settled",
): void {
  try {
    const { created } = checkpoints.createSnapshot(
      sessionId,
      sessionWorkspace(sessionId),
      { label, trigger },
    );
    if (created) send("checkpoint:changed", { sessionId });
  } catch (err) {
    send("checkpoint:error", {
      sessionId,
      message: `检查点${label}失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/* ---------- M-02 审批：策略文件与扩展挂载 ---------- */

const approvalDir = join(dataDir, "approval");

/** 审批卡裁决 → 扩展 select 的选项原文（与 approval-gate.mjs 保持一致）。 */
const APPROVAL_CHOICE_VALUES = {
  once: "允许一次",
  session: "本会话始终允许",
  pattern: "按命令模式始终允许",
  deny: "拒绝",
} as const;

function effectiveMode(sessionId?: string): PermissionMode {
  return (
    (sessionId ? settings.value.perSessionMode[sessionId] : undefined) ??
    settings.value.permissionMode
  );
}

function approvalKeyFor(sessionId: string): string {
  let key = settings.value.approvalKeys[sessionId];
  if (!key) {
    key = randomUUID();
    settings.update({
      approvalKeys: { ...settings.value.approvalKeys, [sessionId]: key },
    });
  }
  return key;
}

function policyFileFor(sessionId: string): string {
  return join(approvalDir, `${approvalKeyFor(sessionId)}.json`);
}

/** 写/刷新某会话的策略文件：模式取最新设置，grants 与 patternGrants 保留扩展已落盘的授权。 */
function writePolicy(sessionId: string): string {
  mkdirSync(approvalDir, { recursive: true });
  const file = policyFileFor(sessionId);
  let grants: string[] = [];
  let patternGrants: Array<{ tool: string; pattern: string }> = [];
  try {
    const prev = JSON.parse(readFileSync(file, "utf8")) as {
      grants?: unknown;
      patternGrants?: unknown;
    };
    if (Array.isArray(prev?.grants)) {
      grants = prev.grants.filter((g): g is string => typeof g === "string");
    }
    if (Array.isArray(prev?.patternGrants)) {
      patternGrants = prev.patternGrants.filter(
        (g): g is { tool: string; pattern: string } =>
          !!g &&
          typeof (g as { tool?: unknown }).tool === "string" &&
          typeof (g as { pattern?: unknown }).pattern === "string",
      );
    }
  } catch {
    /* 首次写或文件损坏：从空授权开始（fail-closed，写类会重新询问） */
  }
  writeFileSync(
    file,
    JSON.stringify(
      { mode: effectiveMode(sessionId), grants, patternGrants },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return file;
}

/** 新会话在拿到宿主 id 之前先备好策略文件，返回 key 与文件路径。 */
function prepareGate(mode: PermissionMode): { key: string; policyFile: string } {
  mkdirSync(approvalDir, { recursive: true });
  const key = randomUUID();
  const policyFile = join(approvalDir, `${key}.json`);
  writeFileSync(
    policyFile,
    JSON.stringify({ mode, grants: [], patternGrants: [] }, null, 2) + "\n",
    "utf8",
  );
  return { key, policyFile };
}

function gatePiArgs(): string[] {
  const args = [
    "--extension",
    approvalGateExtensionPath(),
    "--extension",
    planGateExtensionPath(),
  ];
  // M-15：已启用插件随会话进程一并加载（启停只对新建/续接生效，进行中不变）
  for (const pluginPath of host.plugins.enabledExtensionPaths()) {
    args.push("--extension", pluginPath);
  }
  return args;
}

/* ---------- M-03 计划：状态/策略文件与扩展挂载 ---------- */

const planDir = join(dataDir, "plan");

/** 计划裁决三档 → 计划门 select 的选项原文（与 plan-gate.mjs 保持一致）。 */
const PLAN_CHOICE_VALUES: Record<PlanSelectChoice, string> = {
  approve: "批准执行",
  edit: "编辑计划",
  deny: "拒绝计划",
};

/** 计划状态变更 notify → 界面成条提示文案（progress/settled 太频繁，只刷新不提示）。 */
const PLAN_NOTICE_LABELS: Record<string, string> = {
  submitted: "计划已提交，等待批准",
  approved: "计划已批准，开始执行",
  rejected: "计划被拒绝，本轮不执行写操作",
  approval_timeout: "计划审批超时（5 分钟未裁决），未获批准",
  edited: "计划已按你的编辑更新，等待批准",
  paused: "计划已暂停",
  resumed: "计划已恢复执行",
};

function planKeyFor(sessionId: string): string {
  let key = settings.value.planKeys[sessionId];
  if (!key) {
    key = randomUUID();
    settings.update({
      planKeys: { ...settings.value.planKeys, [sessionId]: key },
    });
  }
  return key;
}

function planStateFileFor(sessionId: string): string {
  return join(planDir, `${planKeyFor(sessionId)}.state.json`);
}

function planPolicyFileFor(sessionId: string): string {
  return join(planDir, `${planKeyFor(sessionId)}.policy.json`);
}

/** 写/刷新某会话的计划策略文件：required/paused 取壳层设置的最新值。 */
function writePlanPolicy(sessionId: string): string {
  mkdirSync(planDir, { recursive: true });
  const file = planPolicyFileFor(sessionId);
  writeFileSync(
    file,
    JSON.stringify(
      {
        required: settings.value.perSessionPlanRequired[sessionId] === true,
        paused: settings.value.perSessionPlanPaused[sessionId] === true,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return file;
}

/** 新会话在拿到宿主 id 之前先备好计划策略文件（状态文件由扩展在提交计划时创建）。 */
function preparePlan(): { key: string; stateFile: string; policyFile: string } {
  mkdirSync(planDir, { recursive: true });
  const key = randomUUID();
  const stateFile = join(planDir, `${key}.state.json`);
  const policyFile = join(planDir, `${key}.policy.json`);
  writeFileSync(
    policyFile,
    JSON.stringify({ required: false, paused: false }, null, 2) + "\n",
    "utf8",
  );
  return { key, stateFile, policyFile };
}

/** 读计划状态文件（扩展写、壳层只读）；无文件/损坏一律返回 null，不编造计划。 */
function readPlanState(sessionId: string): PlanStateDto | null {
  try {
    const raw = readFileSync(planStateFileFor(sessionId), "utf8");
    const parsed = JSON.parse(raw) as {
      status?: unknown;
      task?: unknown;
      steps?: unknown;
      updatedAt?: unknown;
    };
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    const steps: PlanStepDto[] = parsed.steps.map((s) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        title: String(step.title ?? ""),
        action: String(step.action ?? "task"),
        status: String(step.status ?? "pending"),
        ...(typeof step.note === "string" ? { note: step.note } : {}),
      };
    });
    return {
      status: String(parsed.status ?? ""),
      task: typeof parsed.task === "string" ? parsed.task : "",
      steps,
      updatedAt: String(parsed.updatedAt ?? ""),
    };
  } catch {
    return null;
  }
}

function planView(sessionId: string): PlanViewDto {
  return {
    plan: readPlanState(sessionId),
    required: settings.value.perSessionPlanRequired[sessionId] === true,
    paused: settings.value.perSessionPlanPaused[sessionId] === true,
  };
}

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
  return (
    settings.value.selectedModel ??
    (stubMode ? STUB_REF : localMode ? LOCAL_REF : null)
  );
}

function snapshot(): HostSnapshotDto {
  const metas = host.listSessions().map(toDto);
  return {
    kernelVersion: kernelVersion(),
    dataDir,
    workspaceDir,
    stubMode,
    permissionMode: settings.value.permissionMode,
    availableModels: [
      ...(stubMode ? [{ ...STUB_REF, label: "stub-model（本地桩）" }] : []),
      ...(localMode
        ? [{ ...LOCAL_REF, label: `${localModelId}（本地真模型）` }]
        : []),
    ],
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

/**
 * 扩展 UI 记录路由（M-02）：审批门的 select 请求转成审批卡事件推给渲染层；
 * notify 转成成条提示；其余对话框类请求（非审批门来源）明确取消并显形，
 * 绝不让 Pi 挂死等待；fire-and-forget 类（setStatus 等）放行不管。
 */
/** 解析扩展 UI 请求里夹带的 JSON 载荷（审批门/计划门都用 title/message 夹带）。 */
function parseJsonPayload(text: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(text ?? "")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function routeExtensionUi(
  handle: SessionHandle,
  record: Record<string, unknown>,
): void {
  const method = String(record.method ?? "");
  if (method === "notify") {
    // M-03：计划门的状态 notify 是机器载荷——转成 plan:changed 刷新 + 人话提示，不把 JSON 原文糊到执行流上
    const planPayload = parseJsonPayload(record.message);
    if (planPayload?.baimoPlan === 1 && planPayload.kind === "state") {
      send("plan:changed", { sessionId: handle.id });
      const label = PLAN_NOTICE_LABELS[String(planPayload.event ?? "")];
      if (label) {
        send("approval:notice", {
          sessionId: handle.id,
          message: label,
          notifyType:
            planPayload.event === "rejected" ||
            planPayload.event === "approval_timeout"
              ? "warning"
              : "info",
        });
      }
      return;
    }
    send("approval:notice", {
      sessionId: handle.id,
      message: String(record.message ?? ""),
      notifyType: String(record.notifyType ?? "info"),
    });
    return;
  }
  if (method === "select") {
    // M-03：计划门的裁决请求（submit_plan 阻塞中）→ 计划卡
    const planPayload = parseJsonPayload(record.title);
    if (planPayload?.baimoPlan === 1) {
      const steps = Array.isArray(planPayload.steps)
        ? (planPayload.steps as Array<Record<string, unknown>>).map((s) => ({
            title: String(s?.title ?? ""),
            action: String(s?.action ?? "task"),
            status: String(s?.status ?? "pending"),
          }))
        : [];
      send("plan:requested", {
        sessionId: handle.id,
        requestId: String(record.id),
        steps,
      });
      return;
    }
  }
  if (method === "editor") {
    // M-03：计划门的编辑请求 → 计划编辑弹窗（逐行改步骤）
    const planPayload = parseJsonPayload(record.title);
    if (planPayload?.baimoPlan === 1) {
      send("plan:edit-requested", {
        sessionId: handle.id,
        requestId: String(record.id),
        prefill: String(record.prefill ?? ""),
      });
      return;
    }
  }
  if (method === "select") {
    try {
      const payload = JSON.parse(String(record.title ?? "")) as {
        baimoApproval?: unknown;
        tool?: unknown;
        args?: unknown;
        danger?: unknown;
        mode?: unknown;
        reason?: unknown;
      };
      if (payload?.baimoApproval === 1) {
        const dto: ApprovalRequestDto = {
          sessionId: handle.id,
          requestId: String(record.id),
          tool: String(payload.tool ?? ""),
          args:
            payload.args && typeof payload.args === "object"
              ? (payload.args as Record<string, unknown>)
              : {},
          danger: payload.danger === true,
          mode: String(payload.mode ?? ""),
          reason: String(payload.reason ?? ""),
          options: Array.isArray(record.options)
            ? record.options.map(String)
            : [],
        };
        send("approval:requested", dto);
        return;
      }
    } catch {
      /* 标题不是审批载荷：落到下面的通用兜底 */
    }
  }
  if (
    method === "select" ||
    method === "confirm" ||
    method === "input" ||
    method === "editor"
  ) {
    handle.respondExtensionUi(String(record.id), { cancelled: true });
    send("approval:notice", {
      sessionId: handle.id,
      message: `未处理的扩展对话框请求已取消（method=${method}）`,
      notifyType: "warning",
    });
  }
}

function wireHandle(handle: SessionHandle): void {
  handle.on("event", (record) => {
    if ((record as { type?: unknown }).type === "extension_ui_request") {
      routeExtensionUi(handle, record as Record<string, unknown>);
    }
    send("session:event", { sessionId: handle.id, record });
  });
  handle.on("queueChanged", (entries) => {
    send("queue:changed", { sessionId: handle.id, entries });
  });
  handle.on("costRecorded", () => {
    send("cost:changed", { sessionId: handle.id });
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
  budget_fuse_tripped: "检查点 · 预算熔断触发",
  run_budget_fused: "检查点 · 预算熔断停止",
  run_aborted: "运行异常终止",
  run_timeout: "运行超时",
  process_exit: "Pi 进程退出",
  session_closed: "会话关闭",
};

/**
 * 把 PiProcessError 的 stderr 尾巴压进 message：插件加载失败时
 * 「Failed to load extension "<路径>": <原因>」只在 stderr 里，
 * 跨 IPC 只传 message——不压进去，界面就看不到是哪个插件坏了（K-01）。
 */
function flattenProcessError(err: unknown): Error {
  const e = err as { message?: string; stderrTail?: string };
  const tail = (e?.stderrTail ?? "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .slice(0, 400);
  const message = e?.message ?? String(err);
  if (tail && !message.includes(tail)) {
    return new Error(`${message}｜${tail}`);
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * 新建一个 live 会话（挂审批门/计划门/已启用插件，走完整机制）。
 * activate=false 时不抢用户当前焦点（闲时队列在后台建会话用）。
 */
async function createLiveSession(
  title?: string,
  activate = true,
): Promise<SessionHandle> {
  const model = selectedModel();
  // M-02：先备策略文件（模式=当前全局模式），进程挂审批门扩展
  const gate = prepareGate(settings.value.permissionMode);
  // M-03：计划策略文件（缺省未开启计划先行）与状态文件路径（扩展提交计划时创建）
  const plan = preparePlan();
  const handle = await host.openSession({
    title: title ?? `新会话 ${new Date().toLocaleTimeString()}`,
    workspaceDir,
    piArgs: [
      ...(model
        ? ["--provider", model.provider, "--model", model.modelId]
        : []),
      ...gatePiArgs(),
    ],
    env: {
      BAIMO_APPROVAL_POLICY: gate.policyFile,
      BAIMO_PLAN_STATE: plan.stateFile,
      BAIMO_PLAN_POLICY: plan.policyFile,
    },
    modelRef: model,
  }).catch((err) => {
    throw flattenProcessError(err);
  });
  live.set(handle.id, handle);
  wireHandle(handle);
  if (activate) activeSessionId = handle.id;
  settings.update({
    perSessionMode: {
      ...settings.value.perSessionMode,
      [handle.id]: settings.value.permissionMode,
    },
    approvalKeys: {
      ...settings.value.approvalKeys,
      [handle.id]: gate.key,
    },
    planKeys: {
      ...settings.value.planKeys,
      [handle.id]: plan.key,
    },
  });
  return handle;
}

/** 确保某会话有 live 进程：已有则复用，否则按落盘记录续接（挂门同新建）。 */
async function ensureLiveSession(
  id: string,
  activate = true,
): Promise<SessionHandle> {
  const existing = live.get(id);
  if (existing) return existing;
  const meta = host.listSessions().find((m) => m.id === id);
  if (!meta) throw new Error(`未知会话: ${id}`);
  const model = meta.modelRef ?? selectedModel();
  // M-02：续接同样挂审批门；策略文件按会话 key 找回（授权跨续接保留）
  const policyFile = writePolicy(id);
  // M-03：计划策略按会话 key 刷新（开关状态跨续接保留），状态文件同 key 找回
  const planPolicyFile = writePlanPolicy(id);
  const handle = await host.resumeSession(id, {
    piArgs: [
      ...(model
        ? ["--provider", model.provider, "--model", model.modelId]
        : []),
      ...gatePiArgs(),
    ],
    env: {
      BAIMO_APPROVAL_POLICY: policyFile,
      BAIMO_PLAN_STATE: planStateFileFor(id),
      BAIMO_PLAN_POLICY: planPolicyFile,
    },
  }).catch((err) => {
    throw flattenProcessError(err);
  });
  live.set(handle.id, handle);
  wireHandle(handle);
  if (activate) activeSessionId = id;
  return handle;
}

/**
 * 在 live 会话里跑一轮 prompt 并把结算推给渲染层（前台发送与闲时
 * 执行共用同一条链路：检查点自动打点、run-settled 推送、统计刷新）。
 * 结算结果返回给调用方；异常向上抛（前台路径自行吞掉只报界面，
 * 闲时路径据此给任务记 failed/blocked）。
 */
async function runSessionPrompt(
  id: string,
  message: string,
): Promise<PromptOutcome> {
  const handle = live.get(id);
  if (!handle) throw new Error("会话未在运行");
  // M-06：运行开始先给工作区打快照（改动前状态），结算后再打一张（改动后状态）
  autoSnapshot(id, "运行开始", "run_start");
  try {
    const outcome = await handle.prompt(message);
    const fused = outcome.disposition === "budget_fused";
    send("session:run-settled", {
      sessionId: id,
      ok: true,
      stopped: outcome.disposition === "aborted",
      // M-07：预算熔断如实呈现为熔断停止，绝不记正常完成
      fused,
      fuseMessage:
        fused && outcome.fuse
          ? `预算熔断（${outcome.fuse.scope === "run" ? "单次运行" : "单日"}）：成本 $${outcome.fuse.cost.toFixed(4)} 超过上限 $${outcome.fuse.cap.toFixed(4)}，运行已停止`
          : undefined,
    });
    void pushStats(id);
    return outcome;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    send("session:run-settled", {
      sessionId: id,
      ok: false,
      error: e?.message ?? String(err),
      code: e?.code,
    });
    throw err;
  } finally {
    autoSnapshot(id, "运行完成", "run_settled");
  }
}

/* ---------- M-14 闲时队列：桌面执行器（与前台同一条链路） ---------- */

const idleExecutor: IdleExecutor = async (item, ctl) => {
  const handle =
    item.target.kind === "session"
      ? await ensureLiveSession(item.target.sessionId, false)
      : await createLiveSession(item.target.title ?? "闲时任务", false);
  ctl.noteSession(handle.id);
  ctl.registerAbort(() => {
    void handle.abort().catch(() => undefined);
  });
  const outcome = await runSessionPrompt(handle.id, item.prompt);
  return {
    sessionId: handle.id,
    disposition: outcome.disposition,
    eventsReceived: outcome.eventsReceived,
  };
};

const idleRunner = new IdleQueueRunner(
  host.idleQueueStore,
  idleExecutor,
  () => [...live.values()].some((h) => h.busy),
  500,
);
idleRunner.on("changed", (state) => {
  send("idle:changed", state);
});

function registerIpc(): void {
  ipcMain.handle("host:snapshot", () => snapshot());

  ipcMain.handle("session:create", async (_e, title?: string) => {
    const handle = await createLiveSession(title);
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
      } else if (
        e.kind === "lifecycle" &&
        e.event === "steering_delivered" &&
        typeof e.text === "string"
      ) {
        // M-04：排队指令投递到 agent 的那一刻，它就是一条用户消息——回放同口径呈现
        normalized.push({ type: "user_prompt", message: e.text });
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

  ipcMain.handle("session:prompt", async (_e, id: string, message: string) => {
    const handle = live.get(id);
    if (!handle) return { accepted: false, error: "会话未在运行（历史会话请先点「继续会话」）" };
    if (handle.busy) return { accepted: false, error: "会话忙：上一轮尚未结算" };
    // M-14：前台任务优先——正在跑的闲时任务（别的会话）先让路回队列
    const currentIdle = idleRunner.currentItem;
    if (currentIdle && currentIdle.sessionId && currentIdle.sessionId !== id) {
      idleRunner.preempt("前台任务优先：闲时任务已让路，空闲后自动续跑");
    }
    const runPromise = runSessionPrompt(id, message)
      .catch(() => undefined)
      .finally(() => {
        pendingRuns.delete(id);
      });
    pendingRuns.set(id, runPromise);
    return { accepted: true };
  });

  ipcMain.handle("session:resume", async (_e, id: string) => {
    const handle = await ensureLiveSession(id);
    return { meta: toDto(handle.meta), live: true };
  });

  /* ---------- 闲时队列（M-14） ---------- */

  ipcMain.handle("idle:get", () => idleRunner.getState());

  ipcMain.handle(
    "idle:enqueue",
    (_e, prompt: string, target: { kind: "new" } | { kind: "session"; sessionId: string }) => {
      try {
        const item = idleRunner.enqueue(prompt, target);
        return { ok: true, item };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("idle:remove", (_e, itemId: string) => {
    try {
      idleRunner.remove(itemId);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("idle:move", (_e, itemId: string, dir: -1 | 1) => {
    try {
      idleRunner.move(itemId, dir);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("idle:set-enabled", (_e, enabled: boolean) => {
    idleRunner.setEnabled(enabled);
    return { ok: true };
  });

  ipcMain.handle("idle:clear-finished", () => {
    const removed = idleRunner.clearFinished();
    return { ok: true, removed };
  });

  /* ---------- 插件目录（M-15） ---------- */

  ipcMain.handle("plugins:list", () => host.plugins.list());

  ipcMain.handle(
    "plugins:set-enabled",
    (_e, fileName: string, enabled: boolean) => {
      try {
        host.plugins.setEnabled(fileName, enabled);
        const list = host.plugins.list();
        send("plugins:changed", list);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("session:abort", async (_e, id: string) => {
    const handle = live.get(id);
    if (!handle) return { aborted: false };
    const aborted = await handle.abort();
    return { aborted };
  });

  /* ---------- Steering 队列（M-04） ---------- */

  ipcMain.handle("session:steer", async (_e, id: string, text: string) => {
    const handle = live.get(id);
    if (!handle) throw new Error("会话未在运行，无法排队");
    return handle.steer(text);
  });

  ipcMain.handle("session:follow-up", async (_e, id: string, text: string) => {
    const handle = live.get(id);
    if (!handle) throw new Error("会话未在运行，无法排队");
    return handle.followUp(text);
  });

  ipcMain.handle("session:queue", (_e, id: string) => {
    const handle = live.get(id);
    return handle ? handle.getQueue() : [];
  });

  ipcMain.handle(
    "session:queue-withdraw",
    async (_e, id: string, entryId: string) => {
      const handle = live.get(id);
      if (!handle) return { ok: false, error: "会话未在运行" };
      try {
        await handle.withdrawQueueEntry(entryId);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /* ---------- 成本账本（M-07） ---------- */

  ipcMain.handle("cost:get", (_e, sessionId: string) => {
    const ledger = host.costLedger;
    const entries = ledger.entries();
    const meta =
      live.get(sessionId)?.meta ??
      host.listSessions().find((m) => m.id === sessionId);
    return {
      session: ledger.sessionTotals(sessionId),
      today: ledger.todayTotals(),
      budgets: ledger.loadBudgets(),
      pricing: ledger.loadPricing().models,
      currentModelKey: meta?.modelRef
        ? `${meta.modelRef.provider}/${meta.modelRef.modelId}`
        : null,
      recentEntries: entries
        .slice(-20)
        .reverse()
        .map((e) => ({
          ts: e.ts,
          sessionId: e.sessionId,
          modelKey: e.modelRef
            ? `${e.modelRef.provider}/${e.modelRef.modelId}`
            : null,
          tokens: e.tokens,
          cost: e.cost,
        })),
    };
  });

  ipcMain.handle(
    "cost:set-pricing",
    (_e, modelKey: string, price: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }) => {
      try {
        host.costLedger.setPrice(modelKey, price);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "cost:set-budgets",
    (_e, budgets: { perRunCap: number | null; perDayCap: number | null }) => {
      try {
        host.costLedger.saveBudgets(budgets);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

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
      // M-02：模式变更经策略文件即时生效（扩展逐次工具调用现读，含运行中会话）
      if (sessionId) {
        writePolicy(sessionId);
        if (mode === "yolo") {
          // M-06：YOLO 开启前强制留一张快照（失败显形，不静默放行）
          try {
            const { created } = checkpoints.createSnapshot(
              sessionId,
              sessionWorkspace(sessionId),
              { label: "YOLO 开启前快照", trigger: "yolo_start" },
            );
            if (created) send("checkpoint:changed", { sessionId });
          } catch (err) {
            send("checkpoint:error", {
              sessionId,
              message: `YOLO 开启前快照失败：${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
      return { mode };
    },
  );

  ipcMain.handle(
    "approval:respond",
    (
      _e,
      sessionId: string,
      requestId: string,
      choice: keyof typeof APPROVAL_CHOICE_VALUES,
    ) => {
      const handle = live.get(sessionId);
      if (!handle) return { ok: false, error: "会话未在运行" };
      const value = APPROVAL_CHOICE_VALUES[choice];
      if (!value) return { ok: false, error: `未知裁决: ${String(choice)}` };
      handle.respondExtensionUi(requestId, { value });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "model:set",
    (_e, model: { provider: string; modelId: string }) => {
      settings.update({ selectedModel: model });
      return { selectedModel: model };
    },
  );

  /* ---------- 计划（M-03） ---------- */

  ipcMain.handle("plan:get", (_e, id: string) => planView(id));

  ipcMain.handle(
    "plan:respond-select",
    (_e, sessionId: string, requestId: string, choice: PlanSelectChoice) => {
      const handle = live.get(sessionId);
      if (!handle) return { ok: false, error: "会话未在运行" };
      const value = PLAN_CHOICE_VALUES[choice];
      if (!value) return { ok: false, error: `未知裁决: ${String(choice)}` };
      handle.respondExtensionUi(requestId, { value });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "plan:respond-edit",
    (_e, sessionId: string, requestId: string, text: string | null) => {
      const handle = live.get(sessionId);
      if (!handle) return { ok: false, error: "会话未在运行" };
      if (text === null) {
        handle.respondExtensionUi(requestId, { cancelled: true });
      } else {
        handle.respondExtensionUi(requestId, { value: text });
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    "plan:set-required",
    (_e, sessionId: string, required: boolean) => {
      settings.update({
        perSessionPlanRequired: {
          ...settings.value.perSessionPlanRequired,
          [sessionId]: required,
        },
      });
      writePlanPolicy(sessionId);
      send("plan:changed", { sessionId });
      return { ok: true };
    },
  );

  ipcMain.handle("plan:set-paused", (_e, sessionId: string, paused: boolean) => {
    settings.update({
      perSessionPlanPaused: {
        ...settings.value.perSessionPlanPaused,
        [sessionId]: paused,
      },
    });
    writePlanPolicy(sessionId);
    send("plan:changed", { sessionId });
    return { ok: true };
  });

  ipcMain.handle("session:stats", async (_e, id: string) => {
    const handle = live.get(id);
    if (!handle) return null;
    const resp = await handle.command<SessionStatsDto>({
      type: "get_session_stats",
    });
    return resp.data ?? null;
  });

  /* ---------- 检查点（M-06） ---------- */

  ipcMain.handle("checkpoint:list", (_e, id: string) => {
    return checkpoints.listCheckpoints(id).map(toCheckpointDto);
  });

  ipcMain.handle("checkpoint:create", (_e, id: string) => {
    const { checkpoint, created } = checkpoints.createSnapshot(
      id,
      sessionWorkspace(id),
      { label: "手动打点", trigger: "manual" },
    );
    if (created) send("checkpoint:changed", { sessionId: id });
    return { created, checkpoint: toCheckpointDto(checkpoint) };
  });

  ipcMain.handle(
    "checkpoint:rollback",
    async (_e, id: string, checkpointId: string): Promise<RollbackReport> => {
      const handle = live.get(id);
      if (handle?.busy) {
        // PRD 5.4.4：回滚前先停止运行中等其结算
        await handle.abort().catch(() => undefined);
        await (pendingRuns.get(id) ?? Promise.resolve()).catch(() => undefined);
      }
      const ws = sessionWorkspace(id);
      // 回滚本身也要可回滚：先给当前状态留一张自动快照（无变化时自动去重）
      checkpoints.createSnapshot(id, ws, {
        label: "回滚前自动快照",
        trigger: "pre_rollback",
      });
      const report = checkpoints.rollback(id, ws, checkpointId);
      send("checkpoint:changed", { sessionId: id });
      return report;
    },
  );

  ipcMain.handle(
    "checkpoint:rollback-file",
    (_e, id: string, path: string) => {
      const handle = live.get(id);
      if (handle?.busy) {
        return { ok: false, error: "运行中，请先停止后再回滚文件" };
      }
      const latest = checkpoints.latestCheckpoint(id);
      if (!latest) return { ok: false, error: "尚无检查点可回滚" };
      const ws = sessionWorkspace(id);
      // 工具参数里的路径可能是绝对路径：在工作区内则换算为相对路径，区外拒绝
      let rel = path;
      if (path.startsWith("/")) {
        const prefix = ws.endsWith("/") ? ws : ws + "/";
        if (!path.startsWith(prefix)) {
          return { ok: false, error: `文件不在工作区内：${path}` };
        }
        rel = path.slice(prefix.length);
      }
      try {
        const result = checkpoints.rollbackFile(id, ws, latest.id, rel);
        send("checkpoint:changed", { sessionId: id });
        return { ok: true, ...result };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "白墨 Harness",
    icon: join(here, "icon.png"),
    backgroundColor: "#101216",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关拼写检查：Chromium 会为默认语言联网下载拼写词典
      // （redirector.gvt1.com/edgedl/chrome/dict/*.bdic），属壳层
      // 自带外发，违反零外发红线（K-04 抓包审计实测，见文首注释）。
      spellcheck: false,
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
  idleRunner.start();
  await createWindow();
}

app.whenReady().then(() => {
  // 防拼写词典下载外发（K-04 实测定位）：词典下载由建窗口/会话创建
  // 触发，故必须在建窗口前关拼写检查并清空词典语言列表——只关
  // enabled 不够（实测仍会下载），语言列表为空才没有要下的词典。
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.setSpellCheckerLanguages([]);
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
