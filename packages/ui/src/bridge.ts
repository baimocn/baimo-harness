/**
 * 渲染层与主进程之间的桥接契约（由 apps/desktop 的 preload 实现、注入为 window.baimo）。
 *
 * 红线：这里的每个方法都对应 preload 白名单里的一条 IPC 通道；
 * 渲染层拿不到 ipcRenderer 本体，也拿不到任何文件系统/进程能力。
 */

export type PermissionMode = "plan" | "edit" | "build" | "yolo";

export const PERMISSION_MODES: Array<{
  id: PermissionMode;
  label: string;
  hint: string;
}> = [
  { id: "plan", label: "计划", hint: "只读" },
  { id: "edit", label: "编辑", hint: "改文件需确认" },
  { id: "build", label: "构建", hint: "自动执行" },
  { id: "yolo", label: "YOLO", hint: "全放开" },
];

export interface ModelRefDto {
  provider: string;
  modelId: string;
}

export interface SessionMetaDto {
  id: string;
  title: string;
  status: "live" | "closed" | "aborted";
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  modelRef: ModelRefDto | null;
  /** 是否有 Pi 子进程正在托管（false = 仅历史落盘，可看不可发）。 */
  live: boolean;
  /** 是否在回收站中（壳层标记，M-01 本块实现：删除确认 + 回收站标记）。 */
  trashed: boolean;
}

export interface MilestoneDto {
  seq: number;
  ts: string;
  event: string;
  label: string;
}

export interface SessionStatsDto {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** Pi get_session_stats 报告的费用数值（计费口径由 Pi/模型配置决定，桩模型为 0）。 */
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface CheckpointDto {
  id: string;
  sessionId: string;
  createdAt: string;
  label: string;
  trigger: "run_start" | "run_settled" | "manual" | "pre_rollback" | "yolo_start";
  fileCount: number;
  totalBytes: number;
  skippedCount: number;
}

export interface RollbackReportDto {
  checkpointId: string;
  restored: string[];
  deleted: string[];
  unchanged: number;
  skippedUntouched: string[];
  verified: boolean;
  mismatches: string[];
}

export interface ApprovalRequestDto {
  sessionId: string;
  requestId: string;
  /** 工具名（write/edit/bash/…）。 */
  tool: string;
  /** 工具全参数（审批卡原样展示，禁止盲签）。 */
  args: Record<string, unknown>;
  /** 是否命中危险命令清单。 */
  danger: boolean;
  /** 发起审批时的权限模式。 */
  mode: string;
  /** 理由位：为什么这次要审批（命中危险清单 / 编辑模式写操作）。 */
  reason: string;
}

export type ApprovalChoice = "once" | "session" | "deny";

export interface HostSnapshotDto {
  /** 随附 Pi 版本（读自 runtime 钉版包，读不到为「未知」）。 */
  kernelVersion: string;
  dataDir: string;
  workspaceDir: string;
  /** 开发/测试模式：模型指向本地桩端点。 */
  stubMode: boolean;
  permissionMode: PermissionMode;
  availableModels: Array<ModelRefDto & { label: string }>;
  selectedModel: ModelRefDto | null;
  sessions: SessionMetaDto[];
  trashedSessions: SessionMetaDto[];
  activeSessionId: string | null;
}

export interface SessionEventPayload {
  sessionId: string;
  record: Record<string, unknown>;
}

export interface RunSettledPayload {
  sessionId: string;
  ok: boolean;
  /** 本轮是被用户停止的（agent-host 以 disposition=aborted 结算）：界面记「已停止」，不记完成。 */
  stopped?: boolean;
  error?: string;
  code?: string;
}

export interface ProcessExitPayload {
  sessionId: string;
  code: number | null;
  signal: string | null;
}

export interface BaimoBridge {
  snapshot(): Promise<HostSnapshotDto>;
  createSession(title?: string): Promise<SessionMetaDto>;
  activateSession(
    id: string,
  ): Promise<{ meta: SessionMetaDto; live: boolean }>;
  /** 历史回放：归一化后的事件序列（与实时事件同形）+ 里程碑列表。 */
  history(
    id: string,
  ): Promise<{
    events: Array<Record<string, unknown>>;
    milestones: MilestoneDto[];
    recovery: { recoveredEvents: number; droppedLines: number; reason: string } | null;
  }>;
  prompt(
    id: string,
    message: string,
  ): Promise<{ accepted: boolean; error?: string }>;
  /** 续接历史会话：重新拉起子进程并指回原 Pi 会话文件，成功后会话恢复 live。 */
  resumeSession(id: string): Promise<{ meta: SessionMetaDto; live: boolean }>;
  /** 停止当前运行：返回是否确有运行被停止（无运行则 false，不假装）。 */
  abortSession(id: string): Promise<{ aborted: boolean }>;
  closeSession(id: string): Promise<void>;
  trashSession(id: string): Promise<void>;
  restoreSession(id: string): Promise<void>;
  /** 权限模式：落盘到壳层设置，并经策略文件即时下发到会话的审批门扩展。 */
  setMode(
    mode: PermissionMode,
    sessionId?: string,
  ): Promise<{ mode: PermissionMode }>;
  /** 审批裁决回注：主进程翻译成 extension_ui_response 交给 Pi 里的审批门。 */
  respondApproval(
    sessionId: string,
    requestId: string,
    choice: ApprovalChoice,
  ): Promise<{ ok: boolean; error?: string }>;
  onApprovalRequested(cb: (e: ApprovalRequestDto) => void): () => void;
  onApprovalNotice(
    cb: (e: { sessionId: string; message: string; notifyType: string }) => void,
  ): () => void;
  setModel(model: ModelRefDto): Promise<{ selectedModel: ModelRefDto }>;
  stats(id: string): Promise<SessionStatsDto | null>;
  /** 检查点列表（M-06，真实快照数据，来自宿主数据目录）。 */
  listCheckpoints(id: string): Promise<CheckpointDto[]>;
  /** 手动打点：与最近检查点无差异时 created=false（不堆空检查点）。 */
  createCheckpoint(
    id: string,
  ): Promise<{ created: boolean; checkpoint: CheckpointDto }>;
  /** 整体回滚到某检查点（主进程会先停运行、先留回滚前快照）。 */
  rollbackCheckpoint(
    id: string,
    checkpointId: string,
  ): Promise<RollbackReportDto>;
  /** diff 卡单文件回滚：恢复到最近检查点的该文件状态。 */
  rollbackFile(
    id: string,
    path: string,
  ): Promise<{ ok: boolean; action?: string; path?: string; error?: string }>;
  onSessionEvent(cb: (e: SessionEventPayload) => void): () => void;
  onCheckpointsChanged(cb: (e: { sessionId: string }) => void): () => void;
  onCheckpointError(
    cb: (e: { sessionId: string; message: string }) => void,
  ): () => void;
  onRunSettled(cb: (e: RunSettledPayload) => void): () => void;
  onProcessExit(cb: (e: ProcessExitPayload) => void): () => void;
  onStats(cb: (e: { sessionId: string; stats: SessionStatsDto }) => void): () => void;
}
