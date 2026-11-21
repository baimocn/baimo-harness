/**
 * 白墨 Harness 桌面壳：三栏布局的组装与状态管理。
 *
 * 状态来源全部是真实数据：会话列表来自 agent-host 落盘索引（经主进程快照），
 * 执行流来自 Pi 事件（实时订阅 / 历史回放同一归约器），用量来自 get_session_stats。
 * 拿不到的数据就显示未接入，不编造。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BaimoBridge,
  HostSnapshotDto,
  MilestoneDto,
  PermissionMode,
  SessionMetaDto,
  SessionStatsDto,
} from "./bridge.js";
import {
  Composer,
  RightPanel,
  SessionList,
  StatusBar,
  StreamView,
  TopBar,
  type RightTab,
} from "./components.js";
import {
  applyDiffMark,
  applyHostEvent,
  applyHostEvents,
  initialStreamState,
  type StreamState,
} from "./stream.js";

export function App({ bridge }: { bridge: BaimoBridge }) {
  const [snapshot, setSnapshot] = useState<HostSnapshotDto | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streams, setStreams] = useState<Map<string, StreamState>>(new Map());
  const [statsMap, setStatsMap] = useState<Map<string, SessionStatsDto>>(
    new Map(),
  );
  const [milestonesMap, setMilestonesMap] = useState<
    Map<string, MilestoneDto[]>
  >(new Map());
  const [exited, setExited] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<RightTab>("changes");
  const [confirmDelete, setConfirmDelete] =
    useState<SessionMetaDto | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const refreshSnapshot = useCallback(async () => {
    const snap = await bridge.snapshot();
    setSnapshot(snap);
    return snap;
  }, [bridge]);

  const updateStream = useCallback((id: string, ev: unknown) => {
    setStreams((prev) => {
      const cur = prev.get(id) ?? initialStreamState;
      const next = new Map(prev);
      next.set(id, applyHostEvent(cur, ev));
      return next;
    });
  }, []);

  const loadHistory = useCallback(
    async (id: string) => {
      const h = await bridge.history(id);
      setStreams((prev) => {
        if (prev.has(id)) return prev;
        const next = new Map(prev);
        next.set(id, applyHostEvents(initialStreamState, h.events));
        return next;
      });
      setMilestonesMap((prev) => new Map(prev).set(id, h.milestones));
    },
    [bridge],
  );

  // 初次加载 + 事件订阅（订阅只注册一次，回调内用 ref 读最新 activeId）
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const snap = await refreshSnapshot();
        if (disposed) return;
        if (snap.activeSessionId) {
          setActiveId(snap.activeSessionId);
          await loadHistory(snap.activeSessionId);
        }
      } catch (err) {
        if (!disposed) setFatal(`加载宿主快照失败：${String(err)}`);
      }
    })();
    const offEvent = bridge.onSessionEvent((e) =>
      updateStream(e.sessionId, e.record),
    );
    const offSettled = bridge.onRunSettled(async (e) => {
      if (!e.ok) {
        updateStream(e.sessionId, {
          type: "run_error",
          message: e.error ?? "运行异常终止（未以 agent_settled 结算）",
        });
      }
      // 里程碑以落盘为准重新拉取；快照同步状态
      bridge
        .history(e.sessionId)
        .then((h) =>
          setMilestonesMap((prev) => new Map(prev).set(e.sessionId, h.milestones)),
        )
        .catch(() => undefined);
      refreshSnapshot().catch(() => undefined);
    });
    const offStats = bridge.onStats((e) =>
      setStatsMap((prev) => new Map(prev).set(e.sessionId, e.stats)),
    );
    const offExit = bridge.onProcessExit((e) => {
      setExited((prev) => new Set(prev).add(e.sessionId));
      refreshSnapshot().catch(() => undefined);
    });
    return () => {
      disposed = true;
      offEvent();
      offSettled();
      offStats();
      offExit();
    };
  }, [bridge, loadHistory, refreshSnapshot, updateStream]);

  const allSessions = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.sessions, ...snapshot.trashedSessions];
  }, [snapshot]);

  const activeMeta: SessionMetaDto | null = useMemo(() => {
    if (!snapshot || !activeId) return null;
    return (
      snapshot.sessions.find((s) => s.id === activeId) ??
      snapshot.trashedSessions.find((s) => s.id === activeId) ??
      null
    );
  }, [snapshot, activeId]);

  const activeStream: StreamState | null = activeId
    ? (streams.get(activeId) ?? null)
    : null;
  const activeLive = !!activeMeta?.live && !(activeId && exited.has(activeId));
  const running = !!activeStream?.running;

  const rpc: { label: string; state: "on" | "off" | "error" } = !activeMeta
    ? { label: "未连接（无活动会话）", state: "off" }
    : !activeMeta.live
      ? { label: "未连接（历史会话）", state: "off" }
      : activeId && exited.has(activeId)
        ? { label: "已断开（进程退出）", state: "error" }
        : { label: "已连接", state: "on" };

  const runLabel = !activeMeta
    ? "无会话"
    : !activeMeta.live
      ? "只读（历史）"
      : running
        ? "运行中"
        : "空闲";

  const handleSelect = async (id: string) => {
    setActiveId(id);
    if (!streams.has(id)) await loadHistory(id);
    const meta = allSessions.find((s) => s.id === id);
    if (meta?.live && !statsMap.has(id)) {
      const st = await bridge.stats(id).catch(() => null);
      if (st) setStatsMap((prev) => new Map(prev).set(id, st));
    }
  };

  const handleNew = async () => {
    const meta = await bridge.createSession();
    await refreshSnapshot();
    setStreams((prev) => new Map(prev).set(meta.id, initialStreamState));
    setMilestonesMap((prev) => new Map(prev).set(meta.id, []));
    setActiveId(meta.id);
  };

  const handleSend = async (text: string) => {
    if (!activeId) return;
    updateStream(activeId, { type: "user_prompt", message: text });
    const res = await bridge.prompt(activeId, text);
    if (!res.accepted) {
      updateStream(activeId, {
        type: "run_error",
        message: res.error ?? "发送失败",
      });
    }
  };

  const handleMode = async (mode: PermissionMode) => {
    await bridge.setMode(mode, activeId ?? undefined);
    setSnapshot((prev) => (prev ? { ...prev, permissionMode: mode } : prev));
  };

  const handleModel = async (provider: string, modelId: string) => {
    await bridge.setModel({ provider, modelId });
    setSnapshot((prev) =>
      prev ? { ...prev, selectedModel: { provider, modelId } } : prev,
    );
  };

  const handleTrashConfirm = async () => {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    await bridge.trashSession(target.id);
    const snap = await refreshSnapshot();
    if (activeIdRef.current === target.id) {
      setActiveId(snap.sessions[0]?.id ?? null);
    }
  };

  const handleRestore = async (id: string) => {
    await bridge.restoreSession(id);
    await refreshSnapshot();
  };

  if (fatal) {
    return (
      <div className="app-shell" data-testid="app-shell">
        <p className="pad error-text">{fatal}</p>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="app-shell" data-testid="app-shell">
        <p className="pad dim">正在启动 agent-host…</p>
      </div>
    );
  }

  const canSend = activeLive && !running;
  const disabledHint = !activeMeta
    ? "先新建或选择一个会话"
    : !activeMeta.live
      ? "历史会话（只读）：子进程未运行，不能继续发送"
      : activeId && exited.has(activeId)
        ? "子进程已退出，不能发送"
        : running
          ? "运行中，等待本轮结算…"
          : null;

  return (
    <div className="app-shell" data-testid="app-shell" data-mode={snapshot.permissionMode}>
      <TopBar
        snapshot={snapshot}
        mode={snapshot.permissionMode}
        onModeChange={handleMode}
        onModelChange={handleModel}
        runLabel={runLabel}
      />
      <div className="main-row">
        <SessionList
          sessions={snapshot.sessions}
          trashed={snapshot.trashedSessions}
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNew}
          onDeleteRequest={setConfirmDelete}
          onRestore={handleRestore}
        />
        <main className="center">
          {activeMeta && !activeMeta.live && (
            <div className="readonly-banner" data-testid="readonly-banner">
              历史会话（只读）：内容来自落盘记录，子进程未运行，不能继续发送。
            </div>
          )}
          <StreamView
            state={activeStream ?? initialStreamState}
            onDiffMark={(toolCallId, mark) => {
              if (!activeId) return;
              setStreams((prev) => {
                const cur = prev.get(activeId);
                if (!cur) return prev;
                const next = new Map(prev);
                next.set(activeId, applyDiffMark(cur, toolCallId, mark));
                return next;
              });
            }}
          />
          <Composer
            canSend={canSend}
            running={running}
            disabledHint={disabledHint}
            stats={activeId ? (statsMap.get(activeId) ?? null) : null}
            onSend={handleSend}
          />
        </main>
        <RightPanel
          tab={tab}
          onTab={setTab}
          state={activeStream}
          milestones={activeId ? (milestonesMap.get(activeId) ?? []) : []}
        />
      </div>
      <StatusBar
        kernelVersion={snapshot.kernelVersion}
        rpcLabel={rpc.label}
        rpcState={rpc.state}
        dataDir={snapshot.dataDir}
      />
      {confirmDelete && (
        <div className="modal-mask" data-testid="delete-dialog">
          <div className="modal">
            <p>
              删除会话「{confirmDelete.title}」？将移入回收站（壳层标记，可还原），不会立即销毁落盘数据。
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button
                type="button"
                data-testid="confirm-delete"
                onClick={handleTrashConfirm}
              >
                移入回收站
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
