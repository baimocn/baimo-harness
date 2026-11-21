/**
 * 白墨 Harness 桌面壳：三栏布局的组装与状态管理。
 *
 * 状态来源全部是真实数据：会话列表来自 agent-host 落盘索引（经主进程快照），
 * 执行流来自 Pi 事件（实时订阅 / 历史回放同一归约器），用量来自 get_session_stats。
 * 拿不到的数据就显示未接入，不编造。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalChoice,
  ApprovalRequestDto,
  BaimoBridge,
  BudgetDto,
  CheckpointDto,
  CostViewDto,
  HostSnapshotDto,
  IdleQueueViewDto,
  IdleTaskDto,
  ModelPriceDto,
  PermissionMode,
  PlanEditRequestDto,
  PlanRequestDto,
  PlanSelectChoice,
  PlanViewDto,
  PluginInfoDto,
  SessionMetaDto,
  SessionStatsDto,
  SteeringEntryDto,
} from "./bridge.js";
import {
  ApprovalCard,
  Composer,
  PlanCard,
  PlanEditorModal,
  ReplayBar,
  RightPanel,
  SessionList,
  StatusBar,
  StreamView,
  TopBar,
  fmtCost,
  type RightTab,
} from "./components.js";
import {
  applyDiffMark,
  applyHostEvent,
  applyHostEvents,
  diffPayload,
  initialStreamState,
  type DiffMark,
  type StreamState,
} from "./stream.js";
import { ReplayCursor } from "./replay.js";

export function App({ bridge }: { bridge: BaimoBridge }) {
  const [snapshot, setSnapshot] = useState<HostSnapshotDto | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streams, setStreams] = useState<Map<string, StreamState>>(new Map());
  const [statsMap, setStatsMap] = useState<Map<string, SessionStatsDto>>(
    new Map(),
  );
  const [checkpointsMap, setCheckpointsMap] = useState<
    Map<string, CheckpointDto[]>
  >(new Map());
  const [pendingApprovals, setPendingApprovals] = useState<
    Map<string, ApprovalRequestDto>
  >(new Map());
  const [planViews, setPlanViews] = useState<Map<string, PlanViewDto>>(
    new Map(),
  );
  const [pendingPlanSelects, setPendingPlanSelects] = useState<
    Map<string, PlanRequestDto>
  >(new Map());
  const [pendingPlanEdits, setPendingPlanEdits] = useState<
    Map<string, PlanEditRequestDto>
  >(new Map());
  const [queuesMap, setQueuesMap] = useState<Map<string, SteeringEntryDto[]>>(
    new Map(),
  );
  const [costView, setCostView] = useState<CostViewDto | null>(null);
  const [idleView, setIdleView] = useState<IdleQueueViewDto | null>(null);
  const [plugins, setPlugins] = useState<PluginInfoDto[] | null>(null);
  /** 无会话上下文的失败显形（如新建会话时插件加载失败，报错点名插件）。 */
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);
  /* 会话回放（阶段 3）：游标在 ref 里（纯逻辑、单测覆盖），UI 状态只镜像下标/播放/倍速。 */
  const replayCursorRef = useRef<ReplayCursor | null>(null);
  const [replayUi, setReplayUi] = useState<{
    sessionId: string;
    index: number;
    total: number;
    playing: boolean;
    speed: number;
  } | null>(null);
  /** 已把「投递」呈现为执行流用户消息的条目 id（防实时推送与回放双份）。 */
  const deliveredInjectedRef = useRef<Map<string, Set<string>>>(new Map());
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
    },
    [bridge],
  );

  const loadCheckpoints = useCallback(
    async (id: string) => {
      const list = await bridge.listCheckpoints(id).catch(() => null);
      if (list) {
        setCheckpointsMap((prev) => new Map(prev).set(id, list));
      }
    },
    [bridge],
  );

  const loadPlan = useCallback(
    async (id: string) => {
      const view = await bridge.getPlan(id).catch(() => null);
      if (view) {
        setPlanViews((prev) => new Map(prev).set(id, view));
      }
    },
    [bridge],
  );

  const loadCost = useCallback(
    async (id: string) => {
      const view = await bridge.getCost(id).catch(() => null);
      if (view) setCostView(view);
    },
    [bridge],
  );

  const loadIdle = useCallback(async () => {
    const view = await bridge.getIdleQueue().catch(() => null);
    if (view) setIdleView(view);
  }, [bridge]);

  const loadPlugins = useCallback(async () => {
    const list = await bridge.listPlugins().catch(() => null);
    if (list) setPlugins(list);
  }, [bridge]);

  const loadQueue = useCallback(
    async (id: string) => {
      const entries = await bridge.getQueue(id).catch(() => null);
      if (entries) {
        // 已投递条目在回放里已由落盘记录呈现，实时注入集先行占位防双份
        const set = deliveredInjectedRef.current.get(id) ?? new Set<string>();
        for (const e of entries) {
          if (e.status === "delivered") set.add(e.id);
        }
        deliveredInjectedRef.current.set(id, set);
        setQueuesMap((prev) => new Map(prev).set(id, entries));
      }
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
      if (e.ok && e.fused) {
        // M-07 预算熔断：红色显形说明成本与上限，绝不呈现为正常完成
        updateStream(e.sessionId, {
          type: "notice",
          label: e.fuseMessage ?? "预算熔断：运行已停止",
          tone: "error",
        });
      } else if (e.ok) {
        // 完成/停止标记与回放同口径：由落盘 lifecycle 驱动，这里按结算结果注入同一事件
        updateStream(e.sessionId, {
          type: "lifecycle",
          event: e.stopped ? "run_stopped" : "run_settled",
        });
      } else {
        updateStream(e.sessionId, {
          type: "run_error",
          message: e.error ?? "运行异常终止（未以 agent_settled 结算）",
        });
      }
      // 检查点以主进程快照为准重新拉取；快照同步状态
      loadCheckpoints(e.sessionId).catch(() => undefined);
      loadPlan(e.sessionId).catch(() => undefined);
      loadCost(e.sessionId).catch(() => undefined);
      refreshSnapshot().catch(() => undefined);
    });
    const offCkpt = bridge.onCheckpointsChanged((e) => {
      loadCheckpoints(e.sessionId).catch(() => undefined);
    });
    const offCkptErr = bridge.onCheckpointError((e) => {
      updateStream(e.sessionId, {
        type: "notice",
        label: e.message,
        tone: "error",
      });
    });
    const offPlanRequested = bridge.onPlanRequested((e) => {
      setPendingPlanSelects((prev) => new Map(prev).set(e.sessionId, e));
      loadPlan(e.sessionId).catch(() => undefined);
    });
    const offPlanEdit = bridge.onPlanEditRequested((e) => {
      // 裁决已由「编辑计划」答复，select 不再挂起；编辑请求接棒
      setPendingPlanSelects((prev) => {
        const next = new Map(prev);
        next.delete(e.sessionId);
        return next;
      });
      setPendingPlanEdits((prev) => new Map(prev).set(e.sessionId, e));
    });
    const offPlanChanged = bridge.onPlanChanged((e) => {
      loadPlan(e.sessionId).catch(() => undefined);
    });
    const offCost = bridge.onCostChanged((e) => {
      loadCost(e.sessionId).catch(() => undefined);
    });
    const offIdle = bridge.onIdleChanged((view) => {
      setIdleView(view);
      // 闲时任务可能新建/续接会话：同步会话列表
      refreshSnapshot().catch(() => undefined);
    });
    const offPlugins = bridge.onPluginsChanged((list) => {
      setPlugins(list);
    });
    loadIdle().catch(() => undefined);
    loadPlugins().catch(() => undefined);
    const offQueue = bridge.onQueueChanged((e) => {
      setQueuesMap((prev) => new Map(prev).set(e.sessionId, e.entries));
      // 投递发生的那一刻，把这条指令呈现为执行流里的一条用户消息（去向可见）；
      // 回放路径由主进程把落盘 steering_delivered 归一化为同一形态，不双份。
      const set =
        deliveredInjectedRef.current.get(e.sessionId) ?? new Set<string>();
      for (const entry of e.entries) {
        if (entry.status === "delivered" && !set.has(entry.id)) {
          set.add(entry.id);
          updateStream(e.sessionId, {
            type: "user_prompt",
            message: entry.text,
          });
        }
      }
      deliveredInjectedRef.current.set(e.sessionId, set);
    });
    const offApproval = bridge.onApprovalRequested((e) => {
      setPendingApprovals((prev) => new Map(prev).set(e.sessionId, e));
    });
    const offApprovalNotice = bridge.onApprovalNotice((e) => {
      updateStream(e.sessionId, {
        type: "notice",
        label: e.message,
        tone: e.notifyType === "error" ? "error" : "info",
      });
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
      offCkpt();
      offCkptErr();
      offApproval();
      offApprovalNotice();
      offPlanRequested();
      offPlanEdit();
      offPlanChanged();
      offQueue();
      offCost();
      offIdle();
      offPlugins();
    };
  }, [bridge, loadCheckpoints, loadCost, loadHistory, loadIdle, loadPlan, loadPlugins, refreshSnapshot, updateStream]);

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

  /* ---------- 会话回放（阶段 3，只读） ---------- */

  const exitReplay = useCallback(() => {
    replayCursorRef.current = null;
    setReplayUi(null);
  }, []);

  const syncReplayIndex = useCallback(() => {
    const cursor = replayCursorRef.current;
    if (!cursor) return;
    setReplayUi((u) => (u ? { ...u, index: cursor.index } : u));
  }, []);

  const handleReplayStart = async () => {
    if (!activeId) return;
    const h = await bridge.history(activeId);
    const cursor = new ReplayCursor(h.events);
    replayCursorRef.current = cursor;
    setReplayUi({
      sessionId: activeId,
      index: 0,
      total: cursor.total,
      playing: false,
      speed: 1,
    });
  };

  const handleReplayToggle = () => {
    const cursor = replayCursorRef.current;
    if (!cursor) return;
    if (cursor.atEnd) cursor.reset();
    syncReplayIndex();
    setReplayUi((u) => (u ? { ...u, playing: !u.playing } : u));
  };

  // 回放播放定时器：按倍速逐步推进游标；到结尾自动停。
  useEffect(() => {
    if (!replayUi?.playing) return;
    const timer = setInterval(
      () => {
        const cursor = replayCursorRef.current;
        if (!cursor) return;
        if (!cursor.stepForward()) {
          setReplayUi((u) => (u ? { ...u, playing: false } : u));
          return;
        }
        syncReplayIndex();
      },
      Math.max(30, Math.round(300 / replayUi.speed)),
    );
    return () => clearInterval(timer);
  }, [replayUi?.playing, replayUi?.speed, replayUi?.sessionId, syncReplayIndex]);

  const handleSelect = async (id: string) => {
    exitReplay();
    setActiveId(id);
    if (!streams.has(id)) await loadHistory(id);
    loadCheckpoints(id).catch(() => undefined);
    loadPlan(id).catch(() => undefined);
    loadQueue(id).catch(() => undefined);
    loadCost(id).catch(() => undefined);
    const meta = allSessions.find((s) => s.id === id);
    if (meta?.live && !statsMap.has(id)) {
      const st = await bridge.stats(id).catch(() => null);
      if (st) setStatsMap((prev) => new Map(prev).set(id, st));
    }
  };

  const handleNew = async () => {
    exitReplay();
    try {
      const meta = await bridge.createSession();
      await refreshSnapshot();
      setStreams((prev) => new Map(prev).set(meta.id, initialStreamState));
      setCheckpointsMap((prev) => new Map(prev).set(meta.id, []));
      setActiveId(meta.id);
      loadPlan(meta.id).catch(() => undefined);
      loadQueue(meta.id).catch(() => undefined);
      loadCost(meta.id).catch(() => undefined);
    } catch (err) {
      // 会话没建成就没有执行流可写：用全局提示条显形（如插件加载失败会点名插件与原因）
      setGlobalNotice(
        `新建会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleSavePricing = async (modelKey: string, price: ModelPriceDto) => {
    if (!activeId) return;
    const res = await bridge.setPricing(modelKey, price);
    if (!res.ok) notice(activeId, `定价保存失败：${res.error ?? "未知错误"}`, "error");
    loadCost(activeId).catch(() => undefined);
  };

  const handleSaveBudgets = async (budgets: BudgetDto) => {
    if (!activeId) return;
    const res = await bridge.setBudgets(budgets);
    if (!res.ok) notice(activeId, `预算保存失败：${res.error ?? "未知错误"}`, "error");
    loadCost(activeId).catch(() => undefined);
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

  const handleStop = async () => {
    if (!activeId) return;
    await bridge.abortSession(activeId).catch(() => undefined);
    // 结算（run-settled 推送）会把流带回空闲并落「已停止」标记，这里不抢先改状态
  };

  /** 运行中排队：steer 注入纠正 / follow_up 排队；入队即落盘，投递时才进执行流。 */
  const handleQueue = async (text: string, kind: "steer" | "follow_up") => {
    if (!activeId) return;
    try {
      if (kind === "steer") await bridge.steer(activeId, text);
      else await bridge.followUp(activeId, text);
      loadQueue(activeId).catch(() => undefined);
    } catch (err) {
      notice(activeId, `排队失败：${String(err)}`, "error");
    }
  };

  const handleWithdrawQueue = async (entryId: string) => {
    if (!activeId) return;
    const res = await bridge.withdrawQueueEntry(activeId, entryId);
    if (!res.ok) {
      notice(activeId, `撤回失败：${res.error ?? "未知错误"}`, "error");
    }
    loadQueue(activeId).catch(() => undefined);
  };

  /* ---------- M-14 闲时队列 ---------- */

  const handleIdleEnqueue = async (
    prompt: string,
    target: IdleTaskDto["target"],
  ) => {
    const res = await bridge.enqueueIdleTask(prompt, target);
    if (!res.ok) {
      if (activeId) {
        notice(activeId, `闲时任务投递失败：${res.error ?? "未知错误"}`, "error");
      }
    }
    loadIdle().catch(() => undefined);
  };

  const handleIdleRemove = async (itemId: string) => {
    const res = await bridge.removeIdleTask(itemId);
    if (!res.ok && activeId) {
      notice(activeId, `移除闲时任务失败：${res.error ?? "未知错误"}`, "error");
    }
    loadIdle().catch(() => undefined);
  };

  const handleIdleMove = async (itemId: string, dir: -1 | 1) => {
    const res = await bridge.moveIdleTask(itemId, dir);
    if (!res.ok && activeId) {
      notice(activeId, `调整闲时任务顺序失败：${res.error ?? "未知错误"}`, "error");
    }
    loadIdle().catch(() => undefined);
  };

  const handleIdleSetEnabled = async (enabled: boolean) => {
    await bridge.setIdleEnabled(enabled);
    loadIdle().catch(() => undefined);
  };

  const handleIdleClearFinished = async () => {
    await bridge.clearFinishedIdleTasks();
    loadIdle().catch(() => undefined);
  };

  /* ---------- M-15 插件目录 ---------- */

  const handlePluginToggle = async (fileName: string, enabled: boolean) => {
    const res = await bridge.setPluginEnabled(fileName, enabled);
    if (!res.ok && activeId) {
      notice(activeId, `插件启停失败：${res.error ?? "未知错误"}`, "error");
    }
    loadPlugins().catch(() => undefined);
  };

  const idleLabel = !idleView
    ? null
    : idleView.haltedReason
      ? "闲时队列：已停摆（预算阻塞）"
      : !idleView.enabled
        ? "闲时队列：关"
        : idleView.items.some((i) => i.status === "running")
          ? "闲时队列：执行中"
          : `闲时队列：待命（排队 ${idleView.items.filter((i) => i.status === "queued").length}）`;

  const handleResume = async () => {
    if (!activeId) return;
    try {
      await bridge.resumeSession(activeId);
      await refreshSnapshot();
      if (!streams.has(activeId)) await loadHistory(activeId);
    } catch (err) {
      updateStream(activeId, {
        type: "run_error",
        message: `续接失败：${String(err)}`,
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

  const notice = useCallback(
    (id: string, label: string, tone: "info" | "ok" | "error" = "info") => {
      updateStream(id, { type: "notice", label, tone });
    },
    [updateStream],
  );

  /** diff 卡标记：接受只落标记；回滚走真实单文件回滚（恢复到最近检查点），成功才落标记。 */
  const handleDiffMark = async (toolCallId: string, mark: DiffMark) => {
    if (!activeId) return;
    const cur = streams.get(activeId);
    if (!cur) return;
    if (mark === "rolledback") {
      const item = cur.items.find(
        (it) => it.kind === "tool" && it.toolCallId === toolCallId,
      );
      const diff = item ? diffPayload(item) : null;
      if (!diff) {
        notice(activeId, "回滚失败：该条目没有可回滚的文件改动", "error");
        return;
      }
      const res = await bridge.rollbackFile(activeId, diff.path);
      if (!res.ok) {
        notice(activeId, `回滚失败：${res.error ?? "未知错误"}`, "error");
        return;
      }
      notice(
        activeId,
        `已把 ${diff.path} 回滚到最近检查点（${res.action}）`,
        "ok",
      );
      loadCheckpoints(activeId).catch(() => undefined);
    }
    setStreams((prev) => {
      const s = prev.get(activeId);
      if (!s) return prev;
      const next = new Map(prev);
      next.set(activeId, applyDiffMark(s, toolCallId, mark));
      return next;
    });
  };

  const handleManualCheckpoint = async () => {
    if (!activeId) return;
    const res = await bridge.createCheckpoint(activeId);
    notice(
      activeId,
      res.created
        ? `已打检查点「${res.checkpoint.label}」（${res.checkpoint.fileCount} 个文件）`
        : "工作区与最近检查点无差异，未重复打点",
    );
    loadCheckpoints(activeId).catch(() => undefined);
  };

  const handleRollbackCheckpoint = async (checkpointId: string) => {
    if (!activeId) return;
    const report = await bridge.rollbackCheckpoint(activeId, checkpointId);
    notice(
      activeId,
      `已回滚到检查点：恢复 ${report.restored.length} 个文件、删除 ${report.deleted.length} 个新建文件、校验${report.verified ? "通过" : `失败（${report.mismatches.join(", ")}）`}`,
      report.verified ? "ok" : "error",
    );
    loadCheckpoints(activeId).catch(() => undefined);
  };

  /** 计划裁决：回注主进程 → 计划门 select 往返；选「编辑」后编辑弹窗接棒，裁决不撤。 */
  const handlePlanSelect = async (choice: PlanSelectChoice) => {
    if (!activeId) return;
    const req = pendingPlanSelects.get(activeId);
    if (!req) return;
    const res = await bridge.respondPlanSelect(activeId, req.requestId, choice);
    if (!res.ok) {
      notice(activeId, `计划裁决发送失败：${res.error ?? "未知错误"}`, "error");
      return;
    }
    if (choice !== "edit") {
      setPendingPlanSelects((prev) => {
        const next = new Map(prev);
        next.delete(activeId);
        return next;
      });
    }
    const label =
      choice === "approve" ? "批准执行" : choice === "edit" ? "编辑计划" : "拒绝计划";
    notice(activeId, `计划裁决：${label}`);
    loadPlan(activeId).catch(() => undefined);
  };

  const handlePlanEditDone = async (text: string | null) => {
    if (!activeId) return;
    const req = pendingPlanEdits.get(activeId);
    if (!req) return;
    const res = await bridge.respondPlanEdit(activeId, req.requestId, text);
    if (!res.ok) {
      notice(activeId, `计划编辑发送失败：${res.error ?? "未知错误"}`, "error");
      return;
    }
    setPendingPlanEdits((prev) => {
      const next = new Map(prev);
      next.delete(activeId);
      return next;
    });
    notice(activeId, text === null ? "已取消编辑计划" : "计划编辑已保存，等待批准");
    loadPlan(activeId).catch(() => undefined);
  };

  const handlePlanRequiredChange = async (required: boolean) => {
    if (!activeId) return;
    // 先乐观更新本地视图（受控开关不能等 IPC 往返，否则勾选会被旧状态重置）
    setPlanViews((prev) => {
      const cur = prev.get(activeId);
      if (!cur) return prev;
      return new Map(prev).set(activeId, { ...cur, required });
    });
    await bridge.setPlanRequired(activeId, required);
    loadPlan(activeId).catch(() => undefined);
  };

  const handlePlanPauseChange = async (paused: boolean) => {
    if (!activeId) return;
    await bridge.setPlanPaused(activeId, paused);
    notice(
      activeId,
      paused
        ? "已请求暂停计划（当前步结束后生效）"
        : "已解除计划暂停（再发一条指令可继续执行）",
    );
    loadPlan(activeId).catch(() => undefined);
  };

  /** 审批裁决：回注主进程 → extension_ui_response；卡片随即撤下，结果以工具卡/提示显形。 */
  const handleApprovalRespond = async (choice: ApprovalChoice) => {
    if (!activeId) return;
    const req = pendingApprovals.get(activeId);
    if (!req) return;
    const res = await bridge.respondApproval(activeId, req.requestId, choice);
    if (!res.ok) {
      notice(activeId, `审批裁决发送失败：${res.error ?? "未知错误"}`, "error");
      return;
    }
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(activeId);
      return next;
    });
    const label =
      choice === "once"
        ? "允许一次"
        : choice === "session"
          ? "本会话始终允许"
          : "拒绝";
    notice(activeId, `审批裁决：${req.tool} → ${label}`);
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

  const replayActive = !!replayUi && replayUi.sessionId === activeId;
  const replayState = replayActive
    ? (replayCursorRef.current?.state() ?? initialStreamState)
    : null;

  const canSend = activeLive && !replayActive;
  const disabledHint = replayActive
    ? "回放中（只读）：退出回放后可继续操作"
    : !activeMeta
      ? "先新建或选择一个会话"
      : !activeMeta.live
        ? "历史会话（只读）：点上方「继续会话」续接后可继续发送"
        : activeId && exited.has(activeId)
          ? "子进程已退出，不能发送"
          : null;

  return (
    <div className="app-shell" data-testid="app-shell" data-mode={snapshot.permissionMode}>
      <TopBar
        snapshot={snapshot}
        mode={snapshot.permissionMode}
        onModeChange={handleMode}
        onModelChange={handleModel}
        runLabel={runLabel}
        costLabel={
          activeId && costView
            ? `本会话 ${fmtCost(costView.session.cost)} · 今日 ${fmtCost(costView.today.cost)}`
            : null
        }
      />
      {globalNotice && (
        <div className="global-notice" data-testid="global-notice">
          <span>{globalNotice}</span>
          <button type="button" onClick={() => setGlobalNotice(null)}>
            知道了
          </button>
        </div>
      )}
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
              历史会话（只读）：内容来自落盘记录，子进程未运行。
              <button
                type="button"
                data-testid="resume-session"
                onClick={handleResume}
              >
                继续会话
              </button>
              续接后可继续发送，上下文按 Pi 会话文件恢复。
            </div>
          )}
          {activeMeta && !replayActive && (
            <div className="replay-toolbar">
              <button
                type="button"
                data-testid="replay-start"
                onClick={handleReplayStart}
                title="从落盘事件流逐步重放本会话（只读，不产生新运行）"
              >
                回放本会话
              </button>
            </div>
          )}
          {replayActive && replayUi && (
            <ReplayBar
              index={replayUi.index}
              total={replayUi.total}
              playing={replayUi.playing}
              speed={replayUi.speed}
              onTogglePlay={handleReplayToggle}
              onStepBack={() => {
                replayCursorRef.current?.stepBack();
                syncReplayIndex();
              }}
              onStepForward={() => {
                replayCursorRef.current?.stepForward();
                syncReplayIndex();
              }}
              onSeek={(n) => {
                replayCursorRef.current?.seek(n);
                syncReplayIndex();
              }}
              onSpeedChange={(speed) =>
                setReplayUi((u) => (u ? { ...u, speed } : u))
              }
              onExit={exitReplay}
            />
          )}
          <StreamView state={replayState ?? activeStream ?? initialStreamState} onDiffMark={handleDiffMark} />
          {!replayActive && activeId && planViews.get(activeId)?.plan && (
            <PlanCard
              view={planViews.get(activeId)!}
              pendingSelect={!!pendingPlanSelects.get(activeId)}
              onSelect={handlePlanSelect}
              onPauseChange={handlePlanPauseChange}
            />
          )}
          {!replayActive && activeId && pendingApprovals.get(activeId) && (
            <ApprovalCard
              request={pendingApprovals.get(activeId)!}
              onRespond={handleApprovalRespond}
            />
          )}
          <Composer
            canSend={canSend}
            running={replayActive ? false : running}
            disabledHint={disabledHint}
            stats={activeId ? (statsMap.get(activeId) ?? null) : null}
            queue={activeId ? (queuesMap.get(activeId) ?? []) : []}
            onSend={handleSend}
            onQueue={handleQueue}
            onWithdraw={handleWithdrawQueue}
            onStop={handleStop}
          />
        </main>
        <RightPanel
          tab={tab}
          onTab={setTab}
          state={activeStream}
          checkpoints={activeId ? (checkpointsMap.get(activeId) ?? []) : []}
          onRollbackCheckpoint={handleRollbackCheckpoint}
          onManualCheckpoint={handleManualCheckpoint}
          planView={activeId ? (planViews.get(activeId) ?? null) : null}
          onPlanRequiredChange={handlePlanRequiredChange}
          onPlanPauseChange={handlePlanPauseChange}
          costView={costView}
          onSavePricing={handleSavePricing}
          onSaveBudgets={handleSaveBudgets}
          idleView={idleView}
          activeSessionId={activeId}
          onIdleEnqueue={handleIdleEnqueue}
          onIdleRemove={handleIdleRemove}
          onIdleMove={handleIdleMove}
          onIdleSetEnabled={handleIdleSetEnabled}
          onIdleClearFinished={handleIdleClearFinished}
          plugins={plugins}
          onPluginToggle={handlePluginToggle}
        />
      </div>
      <StatusBar
        kernelVersion={snapshot.kernelVersion}
        rpcLabel={rpc.label}
        rpcState={rpc.state}
        dataDir={snapshot.dataDir}
        idleLabel={idleLabel}
      />
      {activeId && pendingPlanEdits.get(activeId) && (
        <PlanEditorModal
          prefill={pendingPlanEdits.get(activeId)!.prefill}
          onSubmit={(text) => handlePlanEditDone(text)}
          onCancel={() => handlePlanEditDone(null)}
        />
      )}
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
