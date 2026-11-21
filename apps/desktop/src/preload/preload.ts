/**
 * preload 安全桥：contextIsolation 下唯一允许的跨界通道。
 *
 * 只暴露 BaimoBridge 白名单方法：每个方法映射一条具名 IPC，
 * 事件订阅返回取消函数。绝不透传 ipcRenderer 本体。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  BaimoBridge,
  PermissionMode,
  ProcessExitPayload,
  RunSettledPayload,
  SessionEventPayload,
  SessionStatsDto,
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
  stats: (id: string) => ipcRenderer.invoke("session:stats", id),
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
