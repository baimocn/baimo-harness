/**
 * preload 安全桥：contextIsolation 下唯一允许的跨界通道。
 *
 * 只暴露 BaimoBridge 白名单方法：每个方法映射一条具名 IPC，
 * 事件订阅返回取消函数。绝不透传 ipcRenderer 本体。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalRequestDto,
  BaimoBridge,
  CheckpointDto,
  IdleQueueViewDto,
  IdleTaskDto,
  PermissionMode,
  PlanEditRequestDto,
  PlanRequestDto,
  PluginInfoDto,
  ProcessExitPayload,
  RollbackReportDto,
  RunSettledPayload,
  SessionEventPayload,
  SessionStatsDto,
  SteeringEntryDto,
} from "@baimo-harness/ui";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BaimoBridge = {
  snapshot: () => ipcRenderer.invoke("host:snapshot"),
  createSession: (title?: string) =>
    ipcRenderer.invoke("session:create", title),
  activateSession: (id: string) => ipcRenderer.invoke("session:activate", id),
  history: (id: string) => ipcRenderer.invoke("session:history", id),
  prompt: (id: string, message: string) =>
    ipcRenderer.invoke("session:prompt", id, message),
  resumeSession: (id: string) => ipcRenderer.invoke("session:resume", id),
  abortSession: (id: string) => ipcRenderer.invoke("session:abort", id),
  closeSession: (id: string) => ipcRenderer.invoke("session:close", id),
  trashSession: (id: string) => ipcRenderer.invoke("session:trash", id),
  restoreSession: (id: string) => ipcRenderer.invoke("session:restore", id),
  setMode: (mode: PermissionMode, sessionId?: string) =>
    ipcRenderer.invoke("mode:set", mode, sessionId),
  setModel: (model: { provider: string; modelId: string }) =>
    ipcRenderer.invoke("model:set", model),
  respondApproval: (sessionId: string, requestId: string, choice: string) =>
    ipcRenderer.invoke("approval:respond", sessionId, requestId, choice),
  onApprovalRequested: (cb: (e: ApprovalRequestDto) => void) =>
    subscribe("approval:requested", cb),
  onApprovalNotice: (
    cb: (e: { sessionId: string; message: string; notifyType: string }) => void,
  ) => subscribe("approval:notice", cb),
  stats: (id: string) => ipcRenderer.invoke("session:stats", id),
  listCheckpoints: (id: string) => ipcRenderer.invoke("checkpoint:list", id),
  createCheckpoint: (id: string) => ipcRenderer.invoke("checkpoint:create", id),
  rollbackCheckpoint: (id: string, checkpointId: string) =>
    ipcRenderer.invoke("checkpoint:rollback", id, checkpointId),
  rollbackFile: (id: string, path: string) =>
    ipcRenderer.invoke("checkpoint:rollback-file", id, path),
  onCheckpointsChanged: (
    cb: (e: { sessionId: string }) => void,
  ) => subscribe("checkpoint:changed", cb),
  onCheckpointError: (
    cb: (e: { sessionId: string; message: string }) => void,
  ) => subscribe("checkpoint:error", cb),
  steer: (id: string, text: string) => ipcRenderer.invoke("session:steer", id, text),
  followUp: (id: string, text: string) =>
    ipcRenderer.invoke("session:follow-up", id, text),
  getQueue: (id: string) => ipcRenderer.invoke("session:queue", id),
  withdrawQueueEntry: (id: string, entryId: string) =>
    ipcRenderer.invoke("session:queue-withdraw", id, entryId),
  onQueueChanged: (
    cb: (e: { sessionId: string; entries: SteeringEntryDto[] }) => void,
  ) => subscribe("queue:changed", cb),
  getCost: (sessionId: string) => ipcRenderer.invoke("cost:get", sessionId),
  setPricing: (modelKey: string, price: unknown) =>
    ipcRenderer.invoke("cost:set-pricing", modelKey, price),
  setBudgets: (budgets: unknown) => ipcRenderer.invoke("cost:set-budgets", budgets),
  onCostChanged: (cb: (e: { sessionId: string }) => void) =>
    subscribe("cost:changed", cb),
  getPlan: (id: string) => ipcRenderer.invoke("plan:get", id),
  respondPlanSelect: (sessionId: string, requestId: string, choice: string) =>
    ipcRenderer.invoke("plan:respond-select", sessionId, requestId, choice),
  respondPlanEdit: (
    sessionId: string,
    requestId: string,
    text: string | null,
  ) => ipcRenderer.invoke("plan:respond-edit", sessionId, requestId, text),
  setPlanRequired: (sessionId: string, required: boolean) =>
    ipcRenderer.invoke("plan:set-required", sessionId, required),
  setPlanPaused: (sessionId: string, paused: boolean) =>
    ipcRenderer.invoke("plan:set-paused", sessionId, paused),
  onPlanRequested: (cb: (e: PlanRequestDto) => void) =>
    subscribe("plan:requested", cb),
  onPlanEditRequested: (cb: (e: PlanEditRequestDto) => void) =>
    subscribe("plan:edit-requested", cb),
  onPlanChanged: (cb: (e: { sessionId: string }) => void) =>
    subscribe("plan:changed", cb),
  getIdleQueue: () => ipcRenderer.invoke("idle:get"),
  enqueueIdleTask: (prompt: string, target: IdleTaskDto["target"]) =>
    ipcRenderer.invoke("idle:enqueue", prompt, target),
  removeIdleTask: (itemId: string) => ipcRenderer.invoke("idle:remove", itemId),
  moveIdleTask: (itemId: string, dir: -1 | 1) =>
    ipcRenderer.invoke("idle:move", itemId, dir),
  setIdleEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("idle:set-enabled", enabled),
  clearFinishedIdleTasks: () => ipcRenderer.invoke("idle:clear-finished"),
  onIdleChanged: (cb: (e: IdleQueueViewDto) => void) =>
    subscribe("idle:changed", cb),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  setPluginEnabled: (fileName: string, enabled: boolean) =>
    ipcRenderer.invoke("plugins:set-enabled", fileName, enabled),
  onPluginsChanged: (cb: (e: PluginInfoDto[]) => void) =>
    subscribe("plugins:changed", cb),
  onSessionEvent: (cb: (e: SessionEventPayload) => void) =>
    subscribe("session:event", cb),
  onRunSettled: (cb: (e: RunSettledPayload) => void) =>
    subscribe("session:run-settled", cb),
  onProcessExit: (cb: (e: ProcessExitPayload) => void) =>
    subscribe("session:process-exit", cb),
  onStats: (cb: (e: { sessionId: string; stats: SessionStatsDto }) => void) =>
    subscribe("session:stats", cb),
};

contextBridge.exposeInMainWorld("baimo", api);
