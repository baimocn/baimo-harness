/**
 * 三栏界面组件（GUI-SPEC v0.2）。全部为受控展示组件，状态由 App 持有。
 * 凡本块未接入的能力（文件树、计划面板、审批拦截等）都在界面上明文标注，不装作可用。
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  PERMISSION_MODES,
  type HostSnapshotDto,
  type MilestoneDto,
  type PermissionMode,
  type SessionMetaDto,
  type SessionStatsDto,
} from "./bridge.js";
import {
  computeLineDiff,
  diffPayload,
  selectFileChanges,
  type DiffMark,
  type StreamItem,
  type StreamState,
} from "./stream.js";

/* ---------------- 顶栏 ---------------- */

export function TopBar(props: {
  snapshot: HostSnapshotDto;
  mode: PermissionMode;
  onModeChange: (m: PermissionMode) => void;
  onModelChange: (provider: string, modelId: string) => void;
  runLabel: string;
}) {
  const { snapshot, mode } = props;
  const wsName =
    snapshot.workspaceDir.split("/").filter(Boolean).pop() ?? snapshot.workspaceDir;
  const selected = snapshot.selectedModel;
  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-left">
        <span className="brand">白墨 Harness</span>
        <span className="dim">{wsName}</span>
        <span className="dim" title="Git 集成在阶段 2 接入">
          分支：未接入
        </span>
        {snapshot.stubMode && <span className="badge-stub">桩模型模式</span>}
      </div>
      <div
        className="mode-switch"
        role="group"
        aria-label="权限模式"
        data-mode={mode}
      >
        {PERMISSION_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            data-testid={`mode-${m.id}`}
            className={`mode-btn mode-${m.id}${mode === m.id ? " active" : ""}`}
            aria-pressed={mode === m.id}
            title={`${m.label}：${m.hint}`}
            onClick={() => props.onModeChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="topbar-right">
        {snapshot.availableModels.length > 0 ? (
          <select
            className="model-select"
            data-testid="model-select"
            value={selected ? `${selected.provider}/${selected.modelId}` : ""}
            onChange={(e) => {
              const found = snapshot.availableModels.find(
                (m) => `${m.provider}/${m.modelId}` === e.target.value,
              );
              if (found) props.onModelChange(found.provider, found.modelId);
            }}
            title="模型（应用于新会话；会话内热切换下一块接入）"
          >
            {snapshot.availableModels.map((m) => (
              <option
                key={`${m.provider}/${m.modelId}`}
                value={`${m.provider}/${m.modelId}`}
              >
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <select className="model-select" disabled title="未配置模型">
            <option>未配置模型</option>
          </select>
        )}
        <span className="run-status" data-testid="run-status">
          {props.runLabel}
        </span>
      </div>
      {mode === "yolo" && (
        <div className="topbar-alert" data-testid="yolo-alert">
          YOLO 模式：全放开。权限模式仅记录状态，审批拦截在阶段 2 控制簇接入。
        </div>
      )}
    </header>
  );
}

/* ---------------- 左栏：会话列表 ---------------- */

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  return "更早";
}

export function SessionList(props: {
  sessions: SessionMetaDto[];
  trashed: SessionMetaDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleteRequest: (s: SessionMetaDto) => void;
  onRestore: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, SessionMetaDto[]>();
    for (const s of props.sessions) {
      const g = dayGroup(s.createdAt);
      map.set(g, [...(map.get(g) ?? []), s]);
    }
    return [...map.entries()];
  }, [props.sessions]);
  return (
    <aside className="sidebar" data-testid="session-list">
      <div className="sidebar-head">
        <span>会话</span>
        <button type="button" data-testid="new-session" onClick={props.onNew}>
          + 新建会话
        </button>
      </div>
      <div className="session-scroll">
        {props.sessions.length === 0 && (
          <p className="dim pad">暂无会话，点「新建会话」开始。</p>
        )}
        {groups.map(([group, list]) => (
          <div key={group}>
            <div className="session-group">{group}</div>
            {list.map((s) => (
              <div
                key={s.id}
                data-testid="session-item"
                data-session-id={s.id}
                className={`session-item${s.id === props.activeId ? " active" : ""}`}
                onClick={() => props.onSelect(s.id)}
              >
                <span
                  className={`dot dot-${s.live ? "live" : s.status}`}
                  title={s.live ? "子进程托管中" : `历史会话（${s.status}）`}
                />
                <span className="session-title">{s.title}</span>
                <button
                  type="button"
                  className="session-del"
                  data-testid="delete-session"
                  title="删除（进回收站）"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDeleteRequest(s);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="trash-head">
          回收站
          <span className="dim">（壳层标记，M-01）</span>
        </div>
        {props.trashed.length === 0 && <p className="dim pad">回收站为空，会话完整性正常。</p>}
        {props.trashed.map((s) => (
          <div key={s.id} className="trash-item" data-testid="trash-item">
            <span className="session-title">{s.title}</span>
            <button
              type="button"
              data-testid="restore-session"
              onClick={() => props.onRestore(s.id)}
            >
              还原
            </button>
          </div>
        ))}
        <div className="sidebar-links dim">闲时队列 · 插件 · 设置（后续阶段）</div>
      </div>
    </aside>
  );
}

/* ---------------- 中栏：执行流 ---------------- */

function ToolCard(props: {
  item: Extract<StreamItem, { kind: "tool" }>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const it = props.item;
  const statusIcon =
    it.status === "running" ? "…" : it.status === "ok" ? "✓" : "✗";
  return (
    <div className="tool-card" data-testid="tool-card" data-tool={it.toolName}>
      <button
        type="button"
        className="tool-head"
        data-testid="tool-card-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{it.toolName}</span>
        <span className="tool-target">{it.target}</span>
        <span className={`tool-status tool-${it.status}`}>
          {statusIcon}
          {typeof it.durationMs === "number" ? ` ${it.durationMs}ms` : ""}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-sec">参数</div>
          <pre data-testid="tool-card-args">{JSON.stringify(it.args, null, 2)}</pre>
          <div className="tool-sec">输出</div>
          <pre data-testid="tool-card-output">{it.output || "（暂无输出）"}</pre>
        </div>
      )}
      {props.children}
    </div>
  );
}

function DiffCard(props: {
  path: string;
  oldText: string;
  newText: string;
  mark: DiffMark;
  onMark: (mark: DiffMark) => void;
}) {
  const rows = useMemo(
    () => computeLineDiff(props.oldText, props.newText),
    [props.oldText, props.newText],
  );
  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-head">
        <span className="diff-path">{props.path}</span>
        <span className="dim">标记：{props.mark === "pending" ? "未处理" : props.mark === "accepted" ? "已接受" : "已回滚（标记）"}</span>
        <button
          type="button"
          data-testid="diff-accept"
          onClick={() => props.onMark("accepted")}
        >
          接受
        </button>
        <button
          type="button"
          data-testid="diff-rollback"
          onClick={() => props.onMark("rolledback")}
          title="本块只落状态标记，与检查点的真实回滚联动在下一块"
        >
          回滚
        </button>
      </div>
      <pre className="diff-body">
        {rows.map((r, i) => (
          <div key={i} className={`diff-row diff-${r.kind}`}>
            {r.kind === "add" ? "+ " : r.kind === "del" ? "- " : r.kind === "gap" ? "  " : "  "}
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function StreamView(props: {
  state: StreamState;
  onDiffMark: (toolCallId: string, mark: DiffMark) => void;
}) {
  const { state } = props;
  return (
    <div className="stream" data-testid="stream">
      {state.items.length === 0 && (
        <p className="dim pad">执行流为空。在下方输入一条指令开始。</p>
      )}
      {state.items.map((it) => {
        switch (it.kind) {
          case "user":
            return (
              <div key={it.id} className="msg msg-user" data-testid="msg-user">
                {it.text}
              </div>
            );
          case "assistant":
            return (
              <div
                key={it.id}
                className="msg msg-assistant"
                data-testid="msg-assistant"
              >
                {it.text}
                {it.streaming && <span className="cursor">▍</span>}
              </div>
            );
          case "tool": {
            const diff = diffPayload(it);
            return (
              <ToolCard key={it.id} item={it}>
                {diff && (
                  <DiffCard
                    path={diff.path}
                    oldText={diff.oldText}
                    newText={diff.newText}
                    mark={state.diffMarks[it.toolCallId] ?? "pending"}
                    onMark={(m) => props.onDiffMark(it.toolCallId, m)}
                  />
                )}
              </ToolCard>
            );
          }
          case "marker":
            return (
              <div
                key={it.id}
                className={`marker marker-${it.tone}`}
                data-testid="stream-marker"
              >
                {it.label}
              </div>
            );
          case "error":
            return (
              <div key={it.id} className="error-card" data-testid="error-card">
                <div>类别：运行失败</div>
                <div>原因：{it.message}</div>
                <div>下一步：检查状态栏 RPC 状态，或新建会话重试。</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

/* ---------------- 右栏 ---------------- */

export type RightTab = "changes" | "files" | "checkpoints" | "plan";

export function RightPanel(props: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  state: StreamState | null;
  milestones: MilestoneDto[];
}) {
  const changes = props.state ? selectFileChanges(props.state) : [];
  const tabs: Array<{ id: RightTab; label: string }> = [
    { id: "changes", label: "改动" },
    { id: "files", label: "文件" },
    { id: "checkpoints", label: "检查点" },
    { id: "plan", label: "计划" },
  ];
  return (
    <aside className="rightpanel" data-testid="right-panel">
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            className={props.tab === t.id ? "active" : ""}
            onClick={() => props.onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {props.tab === "changes" && (
          <div data-testid="panel-changes">
            {changes.length === 0 ? (
              <p className="dim pad">
                本会话暂无文件改动（工具事件里还没有 edit/write 成功记录）。
              </p>
            ) : (
              changes.map((c) => (
                <div key={c.toolCallId} className="change-row">
                  <span>{c.path}</span>
                  <span className="dim">
                    {c.toolName} · {c.status}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
        {props.tab === "files" && (
          <div data-testid="panel-files">
            <p className="dim pad">文件树占位 —— 本块未实现，后续阶段接入（结构占位）。</p>
          </div>
        )}
        {props.tab === "checkpoints" && (
          <div data-testid="panel-checkpoints">
            <p className="dim pad">
              当前列出的是会话事件日志里程碑（真实落盘记录）；Git 快照检查点（M-06）在阶段 2 接入。
            </p>
            {props.milestones.length === 0 && (
              <p className="dim pad">暂无里程碑。</p>
            )}
            {props.milestones.map((m) => (
              <div key={m.seq} className="change-row">
                <span>{m.label}</span>
                <span className="dim">{new Date(m.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
        {props.tab === "plan" && (
          <div data-testid="panel-plan">
            <p className="dim pad">计划面板占位 —— M-03 在阶段 2 实现（结构占位，本块未实现）。</p>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ---------------- 底部输入区 ---------------- */

export function ContextRing(props: { stats: SessionStatsDto | null }) {
  const cu = props.stats?.contextUsage;
  const percent =
    cu && typeof cu.percent === "number" && Number.isFinite(cu.percent)
      ? cu.percent
      : null;
  const r = 16;
  const c = 2 * Math.PI * r;
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="ring-wrap" data-testid="context-ring" data-state={props.stats ? "live" : "unavailable"}>
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={r} className="ring-bg" />
        <circle
          cx="20"
          cy="20"
          r={r}
          className="ring-fg"
          strokeDasharray={`${(filled / 100) * c} ${c}`}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <div className="ring-text">
        {percent === null ? (
          <span>上下文：未接入</span>
        ) : (
          <span>
            {percent.toFixed(2)}% · {cu?.tokens ?? "?"} / {cu?.contextWindow} tokens
          </span>
        )}
        <span className="dim" data-testid="stats-line">
          {props.stats
            ? `本会话 tokens 合计 ${props.stats.tokens.total} · 费用 ${props.stats.cost.toFixed(4)}（口径：Pi get_session_stats）`
            : "用量未接入（会话未运行或已断开）"}
        </span>
      </div>
    </div>
  );
}

export function Composer(props: {
  canSend: boolean;
  running: boolean;
  disabledHint: string | null;
  stats: SessionStatsDto | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || !props.canSend) return;
    setText("");
    props.onSend(t);
  };
  return (
    <div className="composer" data-testid="composer">
      <textarea
        data-testid="composer-input"
        value={text}
        placeholder={
          props.disabledHint ?? "输入指令，Enter 发送，Shift+Enter 换行"
        }
        disabled={!props.canSend}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={3}
      />
      <div className="composer-side">
        <ContextRing stats={props.stats} />
        {props.running ? (
          <button
            type="button"
            data-testid="composer-stop"
            className="btn-stop"
            onClick={props.onStop}
            title="停止当前运行（RPC abort）：运行以「已停止」收尾，不记完成"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            data-testid="composer-send"
            disabled={!props.canSend || text.trim() === ""}
            onClick={send}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- 状态栏 ---------------- */

export function StatusBar(props: {
  kernelVersion: string;
  rpcLabel: string;
  rpcState: "on" | "off" | "error";
  dataDir: string;
}) {
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span>
        内核 Pi{" "}
        <span data-testid="kernel-version">{props.kernelVersion}</span>
      </span>
      <span>
        RPC{" "}
        <span data-testid="rpc-status" data-state={props.rpcState}>
          {props.rpcLabel}
        </span>
      </span>
      <span className="badge-telemetry" title="agent-host 强制 PI_TELEMETRY=0 且 settings 写死 enableInstallTelemetry:false">
        零遥测 · 已强制关闭
      </span>
      <span className="dim">会话存储：{props.dataDir}</span>
      <span className="spacer" />
      <span className="dim" data-testid="mode-note">
        权限模式仅状态与记录，审批拦截未接入（下一块）
      </span>
    </footer>
  );
}
