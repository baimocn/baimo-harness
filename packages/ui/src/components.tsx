/**
 * 三栏界面组件（GUI-SPEC v0.2）。全部为受控展示组件，状态由 App 持有。
 * 凡本块未接入的能力（文件树、计划面板、审批拦截等）都在界面上明文标注，不装作可用。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PERMISSION_MODES,
  type ApprovalChoice,
  type ApprovalRequestDto,
  type BudgetDto,
  type CheckpointDto,
  type CostViewDto,
  type HostSnapshotDto,
  type ModelPriceDto,
  type PermissionMode,
  type PlanSelectChoice,
  type PlanStateDto,
  type PlanViewDto,
  type SessionMetaDto,
  type SessionStatsDto,
  type SteeringEntryDto,
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
  /** M-07 成本读数（本会话/今日真实花费）；无数据时不渲染。 */
  costLabel?: string | null;
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
        {props.costLabel && (
          <span
            className="cost-readout"
            data-testid="cost-readout"
            title="成本账本（M-07）：按会话统计与定价折算的真实花费（本会话 · 今日）"
          >
            {props.costLabel}
          </span>
        )}
        <span className="run-status" data-testid="run-status">
          {props.runLabel}
        </span>
      </div>
      {mode === "yolo" && (
        <div className="topbar-alert" data-testid="yolo-alert">
          YOLO 模式：工具调用全自动执行，不弹审批卡（开启前已强制留快照）。
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
        <span className="dim">标记：{props.mark === "pending" ? "未处理" : props.mark === "accepted" ? "已接受" : "已回滚"}</span>
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
          title="把该文件恢复到最近检查点的状态（真实回滚，M-06）"
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

export type RightTab = "changes" | "files" | "checkpoints" | "plan" | "ledger";

/** 成本显示口径：null 必须是「未定价」，绝不显示成 $0。 */
export function fmtCost(cost: number | null): string {
  return cost === null ? "未定价" : `$${cost.toFixed(4)}`;
}

/**
 * 成本账本面板（M-07）：本会话/今日真实花费 vs 预算、当前模型定价编辑、
 * 预算上限编辑、最近账目。数字全部来自宿主账本落盘汇总，不做前端估算。
 */
export function LedgerPanel(props: {
  costView: CostViewDto | null;
  onSavePricing: (modelKey: string, price: ModelPriceDto) => void;
  onSaveBudgets: (budgets: BudgetDto) => void;
}) {
  const view = props.costView;
  const modelKey = view?.currentModelKey ?? null;
  const currentPrice = modelKey ? view?.pricing[modelKey] : undefined;
  const [priceInputs, setPriceInputs] = useState({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [budgetInputs, setBudgetInputs] = useState({ perRun: "", perDay: "" });
  const budgetsSig = view ? JSON.stringify(view.budgets) : "";
  const priceSig = currentPrice ? JSON.stringify(currentPrice) : "";
  useEffect(() => {
    setBudgetInputs({
      perRun: view?.budgets.perRunCap != null ? String(view.budgets.perRunCap) : "",
      perDay: view?.budgets.perDayCap != null ? String(view.budgets.perDayCap) : "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetsSig]);
  useEffect(() => {
    setPriceInputs(
      currentPrice
        ? {
            input: String(currentPrice.input),
            output: String(currentPrice.output),
            cacheRead: String(currentPrice.cacheRead),
            cacheWrite: String(currentPrice.cacheWrite),
          }
        : { input: "", output: "", cacheRead: "", cacheWrite: "" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceSig, modelKey]);
  if (!view) {
    return (
      <div data-testid="panel-ledger">
        <p className="dim pad">成本账本加载中…</p>
      </div>
    );
  }
  const parseNum = (s: string): number | null => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  return (
    <div data-testid="panel-ledger">
      <div className="ledger-totals">
        <div>
          本会话花费{" "}
          <strong data-testid="ledger-session-cost">{fmtCost(view.session.cost)}</strong>
          <span className="dim">
            {" "}· {view.session.tokens.total} tokens · {view.session.entries} 笔
          </span>
        </div>
        <div>
          今日花费{" "}
          <strong data-testid="ledger-today-cost">{fmtCost(view.today.cost)}</strong>
          <span className="dim">
            {" "}· {view.today.tokens.total} tokens · {view.today.entries} 笔
          </span>
        </div>
        {(view.session.unpricedTokens > 0 || view.today.unpricedTokens > 0) && (
          <p className="dim">
            另有未定价用量（本会话 {view.session.unpricedTokens} / 今日{" "}
            {view.today.unpricedTokens} tokens）：该模型未配单价，成本未知，不计入金额。
          </p>
        )}
      </div>
      <div className="ledger-section">
        <h4>预算上限（美元，超限熔断，YOLO 也不例外）</h4>
        <label>
          单次运行上限
          <input
            type="number"
            min="0"
            step="0.01"
            data-testid="budget-run-cap"
            value={budgetInputs.perRun}
            placeholder="不限"
            onChange={(e) => setBudgetInputs({ ...budgetInputs, perRun: e.target.value })}
          />
        </label>
        <label>
          单日上限
          <input
            type="number"
            min="0"
            step="0.01"
            data-testid="budget-day-cap"
            value={budgetInputs.perDay}
            placeholder="不限"
            onChange={(e) => setBudgetInputs({ ...budgetInputs, perDay: e.target.value })}
          />
        </label>
        <button
          type="button"
          data-testid="budgets-save"
          onClick={() =>
            props.onSaveBudgets({
              perRunCap: parseNum(budgetInputs.perRun),
              perDayCap: parseNum(budgetInputs.perDay),
            })
          }
        >
          保存预算
        </button>
      </div>
      <div className="ledger-section">
        <h4>模型定价（每 1M tokens，美元）</h4>
        {modelKey ? (
          <>
            <p className="dim">
              当前模型：{modelKey}
              {!currentPrice && "（未定价：成本显示为未定价、预算熔断不生效）"}
            </p>
            {(
              [
                ["input", "输入", "price-input"],
                ["output", "输出", "price-output"],
                ["cacheRead", "缓存读", "price-cache-read"],
                ["cacheWrite", "缓存写", "price-cache-write"],
              ] as const
            ).map(([key, label, testid]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min="0"
                  step="any"
                  data-testid={testid}
                  value={priceInputs[key]}
                  onChange={(e) =>
                    setPriceInputs({ ...priceInputs, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <button
              type="button"
              data-testid="pricing-save"
              onClick={() => {
                const price: ModelPriceDto = {
                  input: parseNum(priceInputs.input) ?? 0,
                  output: parseNum(priceInputs.output) ?? 0,
                  cacheRead: parseNum(priceInputs.cacheRead) ?? 0,
                  cacheWrite: parseNum(priceInputs.cacheWrite) ?? 0,
                };
                props.onSavePricing(modelKey, price);
              }}
            >
              保存定价
            </button>
          </>
        ) : (
          <p className="dim">先选择或新建一个会话后可编辑其模型定价。</p>
        )}
      </div>
      <div className="ledger-section">
        <h4>最近账目</h4>
        <div data-testid="ledger-entries">
          {view.recentEntries.length === 0 && (
            <p className="dim">暂无账目：跑一轮运行后按差分自动记账。</p>
          )}
          {view.recentEntries.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="ledger-entry" data-testid="ledger-entry">
              <span className="dim">{new Date(e.ts).toLocaleTimeString()}</span>
              <span>{e.modelKey ?? "未知模型"}</span>
              <span className="dim">{e.tokens.total} tokens</span>
              <span>{fmtCost(e.cost)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 审批卡（M-02）：写类工具被审批门截停时出现，Pi 在裁决前不会执行。
 * 展示工具名 + 全参数 + 理由位（禁止盲签），三档裁决：
 * 允许一次 / 本会话始终允许 / 拒绝。
 */
export function ApprovalCard(props: {
  request: ApprovalRequestDto;
  onRespond: (choice: ApprovalChoice) => void;
}) {
  const r = props.request;
  return (
    <div className="approval-card" data-testid="approval-card" data-tool={r.tool}>
      <div className="approval-head">
        <strong>需要审批：{r.tool}</strong>
        {r.danger && <span className="badge-danger">危险命令</span>}
        <span className="dim" data-testid="approval-reason">
          {r.reason}（模式：{r.mode}）
        </span>
      </div>
      <pre className="approval-args" data-testid="approval-args">
        {JSON.stringify(r.args, null, 2)}
      </pre>
      <div className="approval-actions">
        <button
          type="button"
          data-testid="approval-allow-once"
          onClick={() => props.onRespond("once")}
        >
          允许一次
        </button>
        <button
          type="button"
          data-testid="approval-allow-session"
          onClick={() => props.onRespond("session")}
        >
          本会话始终允许
        </button>
        <button
          type="button"
          data-testid="approval-deny"
          className="btn-danger"
          onClick={() => props.onRespond("deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

/* ---------------- M-03 计划面板 ---------------- */

export const PLAN_STATUS_LABELS: Record<string, string> = {
  awaiting_approval: "待批准",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  completed_with_failures: "已完成（含失败）",
  incomplete: "已结束（未完成）",
  rejected: "已拒绝",
};

export function planStatusLabel(status: string): string {
  return PLAN_STATUS_LABELS[status] ?? status;
}

function PlanStepsList(props: { plan: PlanStateDto }) {
  return (
    <ol className="plan-steps">
      {props.plan.steps.map((s, i) => (
        <li
          key={i}
          className={`plan-step plan-step-${s.status}`}
          data-testid="plan-step"
          data-status={s.status}
        >
          <span className="plan-step-icon">
            {s.status === "done" ? "✓" : s.status === "failed" ? "✗" : "○"}
          </span>
          <span className="plan-step-title">{s.title}</span>
          <span className="dim">{s.action}</span>
          {s.note && <span className="dim">（{s.note}）</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * 计划卡（中栏，执行流下方）：计划提交后出现。
 * 待批准且裁决请求在途时给三档裁决（批准 / 编辑 / 拒绝，规则见 M-03）；
 * 执行中可「在这一步后暂停」；暂停中可恢复（恢复后需再发指令继续）。
 */
export function PlanCard(props: {
  view: PlanViewDto;
  pendingSelect: boolean;
  onSelect: (choice: PlanSelectChoice) => void;
  onPauseChange: (paused: boolean) => void;
}) {
  const plan = props.view.plan;
  if (!plan) return null;
  return (
    <div className="plan-card" data-testid="plan-card" data-status={plan.status}>
      <div className="plan-head">
        <strong>计划</strong>
        <span className="dim" data-testid="plan-status">
          {planStatusLabel(plan.status)}
        </span>
        {plan.status === "executing" && (
          <button
            type="button"
            data-testid="plan-pause"
            onClick={() => props.onPauseChange(true)}
            title="当前步结束后暂停：后续工具调用在边界被拦，进度原样保留"
          >
            在这一步后暂停
          </button>
        )}
        {plan.status === "paused" && (
          <button
            type="button"
            data-testid="plan-resume"
            onClick={() => props.onPauseChange(false)}
            title="解除暂停；随后发一条指令（如「继续执行计划」）即可续跑"
          >
            恢复执行
          </button>
        )}
      </div>
      <PlanStepsList plan={plan} />
      {props.pendingSelect && plan.status === "awaiting_approval" && (
        <div className="approval-actions">
          <button
            type="button"
            data-testid="plan-approve"
            onClick={() => props.onSelect("approve")}
          >
            批准执行
          </button>
          <button
            type="button"
            data-testid="plan-edit"
            onClick={() => props.onSelect("edit")}
          >
            编辑计划
          </button>
          <button
            type="button"
            data-testid="plan-deny"
            className="btn-danger"
            onClick={() => props.onSelect("deny")}
          >
            拒绝计划
          </button>
        </div>
      )}
    </div>
  );
}

/** 计划编辑弹窗：逐行一步，可增删行、调整顺序；确认后回到裁决（再点批准）。 */
export function PlanEditorModal(props: {
  prefill: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.prefill);
  return (
    <div className="modal-mask" data-testid="plan-editor">
      <div className="modal plan-editor-modal">
        <p>编辑计划：每行一步，可增删行、调整顺序。保存后回到裁决，点「批准执行」生效。</p>
        <textarea
          data-testid="plan-editor-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
        />
        <div className="modal-actions">
          <button type="button" onClick={props.onCancel}>
            取消编辑
          </button>
          <button
            type="button"
            data-testid="plan-editor-save"
            onClick={() => props.onSubmit(text)}
          >
            保存编辑
          </button>
        </div>
      </div>
    </div>
  );
}

export function RightPanel(props: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  state: StreamState | null;
  checkpoints: CheckpointDto[];
  onRollbackCheckpoint: (checkpointId: string) => void;
  onManualCheckpoint: () => void;
  planView: PlanViewDto | null;
  onPlanRequiredChange: (required: boolean) => void;
  onPlanPauseChange: (paused: boolean) => void;
  costView: CostViewDto | null;
  onSavePricing: (modelKey: string, price: ModelPriceDto) => void;
  onSaveBudgets: (budgets: BudgetDto) => void;
}) {
  const changes = props.state ? selectFileChanges(props.state) : [];
  const tabs: Array<{ id: RightTab; label: string }> = [
    { id: "changes", label: "改动" },
    { id: "files", label: "文件" },
    { id: "checkpoints", label: "检查点" },
    { id: "plan", label: "计划" },
    { id: "ledger", label: "账本" },
  ];
  const checkpoints = [...props.checkpoints].reverse();
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
            <div className="checkpoint-head">
              <span className="dim">
                工作区快照（存于数据目录，不进你的仓库）；运行开始/完成自动打点。
              </span>
              <button
                type="button"
                data-testid="checkpoint-create"
                onClick={props.onManualCheckpoint}
              >
                手动打点
              </button>
            </div>
            {checkpoints.length === 0 && (
              <p className="dim pad">暂无检查点：发一轮指令或点「手动打点」生成。</p>
            )}
            {checkpoints.map((c) => (
              <div
                key={c.id}
                className="checkpoint-row"
                data-testid="checkpoint-item"
                data-checkpoint-id={c.id}
              >
                <div className="checkpoint-main">
                  <span>{c.label}</span>
                  <span className="dim">
                    {new Date(c.createdAt).toLocaleTimeString()} · {c.fileCount} 个文件
                    {c.skippedCount > 0 ? ` · ${c.skippedCount} 个跳过` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="checkpoint-rollback"
                  onClick={() => props.onRollbackCheckpoint(c.id)}
                  title="把工作区恢复到这个检查点的状态（回滚前会自动再留一张快照）"
                >
                  回滚
                </button>
              </div>
            ))}
          </div>
        )}
        {props.tab === "plan" && (
          <div data-testid="panel-plan">
            <div className="plan-tab-head">
              <label className="plan-required-toggle">
                <input
                  type="checkbox"
                  data-testid="plan-required-toggle"
                  checked={props.planView?.required ?? false}
                  onChange={(e) => props.onPlanRequiredChange(e.target.checked)}
                />
                计划先行（写操作先过计划批准）
              </label>
              <span className="dim">
                开启后 agent 动手前必须提交计划并获批准，未批准的写操作会被硬拦；暂停在工具调用边界生效。
              </span>
            </div>
            {!props.planView?.plan ? (
              <p className="dim pad">
                本会话暂无计划：开启「计划先行」后发一条任务，agent 会先提交计划到这里。
              </p>
            ) : (
              <div className="pad">
                <div className="plan-head">
                  <strong>当前计划</strong>
                  <span className="dim" data-testid="plan-tab-status">
                    {planStatusLabel(props.planView.plan.status)}
                  </span>
                  {props.planView.plan.status === "executing" && (
                    <button
                      type="button"
                      data-testid="plan-tab-pause"
                      onClick={() => props.onPlanPauseChange(true)}
                    >
                      暂停
                    </button>
                  )}
                  {props.planView.plan.status === "paused" && (
                    <button
                      type="button"
                      data-testid="plan-tab-resume"
                      onClick={() => props.onPlanPauseChange(false)}
                    >
                      恢复
                    </button>
                  )}
                </div>
                {props.planView.plan.task && (
                  <p className="dim plan-task">任务：{props.planView.plan.task}</p>
                )}
                <PlanStepsList plan={props.planView.plan} />
              </div>
            )}
          </div>
        )}
        {props.tab === "ledger" && (
          <LedgerPanel
            costView={props.costView}
            onSavePricing={props.onSavePricing}
            onSaveBudgets={props.onSaveBudgets}
          />
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

/**
 * Steering 队列条（M-04）：输入区上方逐条展示排队指令与去向。
 * 待投递可撤回；已投递/已撤回保留显示到下一轮开始（去向必须可见）。
 */
export function QueueStrip(props: {
  queue: SteeringEntryDto[];
  onWithdraw: (entryId: string) => void;
}) {
  if (props.queue.length === 0) return null;
  return (
    <div className="queue-strip" data-testid="queue-strip">
      <span className="dim">
        已排队 {props.queue.filter((e) => e.status === "queued").length} 条
      </span>
      {props.queue.map((e) => (
        <div
          key={e.id}
          className={`queue-entry queue-${e.status}`}
          data-testid="queue-entry"
          data-kind={e.kind}
          data-status={e.status}
        >
          <span className="queue-kind">
            {e.kind === "steer" ? "注入纠正" : "排队"}
          </span>
          <span className="queue-text">{e.text}</span>
          <span className="dim">
            {e.status === "queued"
              ? "待投递"
              : e.status === "delivered"
                ? "已投递"
                : "已撤回"}
          </span>
          {e.status === "queued" && (
            <button
              type="button"
              data-testid="queue-withdraw"
              onClick={() => props.onWithdraw(e.id)}
              title="撤回这条待投递指令（Pi 整表清除后其余条目按原序重新入队）"
            >
              撤回
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Composer(props: {
  /** 会话是否 live（live 时空闲可发送、运行中可排队；非 live 整体禁用）。 */
  canSend: boolean;
  running: boolean;
  disabledHint: string | null;
  stats: SessionStatsDto | null;
  queue: SteeringEntryDto[];
  onSend: (text: string) => void;
  /** 运行中发送：kind=steer 注入纠正（下一轮次边界）/ follow_up 排队（收尾后）。 */
  onQueue: (text: string, kind: "steer" | "follow_up") => void;
  onWithdraw: (entryId: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [queueKind, setQueueKind] = useState<"steer" | "follow_up">("follow_up");
  const send = () => {
    const t = text.trim();
    if (!t || !props.canSend) return;
    setText("");
    if (props.running) props.onQueue(t, queueKind);
    else props.onSend(t);
  };
  return (
    <div className="composer" data-testid="composer">
      <QueueStrip queue={props.queue} onWithdraw={props.onWithdraw} />
      <div className="composer-row">
        <textarea
          data-testid="composer-input"
          value={text}
          placeholder={
            props.disabledHint ??
            (props.running
              ? "运行中：输入后排队投递，不打断当前运行（Enter 入队）"
              : "输入指令，Enter 发送，Shift+Enter 换行")
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
          <div className="composer-actions">
            {props.running && (
              <span className="queue-kind-switch" role="group" aria-label="排队方式">
                <button
                  type="button"
                  data-testid="queue-kind-followup"
                  className={queueKind === "follow_up" ? "active" : ""}
                  aria-pressed={queueKind === "follow_up"}
                  onClick={() => setQueueKind("follow_up")}
                  title="排队：当前运行收尾后投递"
                >
                  排队
                </button>
                <button
                  type="button"
                  data-testid="queue-kind-steer"
                  className={queueKind === "steer" ? "active" : ""}
                  aria-pressed={queueKind === "steer"}
                  onClick={() => setQueueKind("steer")}
                  title="注入纠正：下一轮次边界立即并入"
                >
                  注入纠正
                </button>
              </span>
            )}
            <button
              type="button"
              data-testid="composer-send"
              disabled={!props.canSend || text.trim() === ""}
              onClick={send}
            >
              {props.running ? "入队" : "发送"}
            </button>
            {props.running && (
              <button
                type="button"
                data-testid="composer-stop"
                className="btn-stop"
                onClick={props.onStop}
                title="停止当前运行（RPC abort）：运行以「已停止」收尾，不记完成"
              >
                停止
              </button>
            )}
          </div>
        </div>
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
        审批门已接入（M-02）：写操作按当前模式裁决；计划先行见「计划」页签（M-03）
      </span>
    </footer>
  );
}
