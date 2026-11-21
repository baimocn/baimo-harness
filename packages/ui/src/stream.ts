/**
 * 执行流归约器：把宿主事件（实时 RPC 记录与落盘回放的归一化事件）折叠成界面条目。
 *
 * 纯函数、无 React 依赖，实时与历史回放共用同一条路径——重启后看到的历史
 * 与当时实时看到的流由同一份代码生成，不会两套口径。
 *
 * 输入事件形态：
 * - { type: "user_prompt", message } —— 用户指令（实时发送时本地注入 / 回放时由落盘 prompt 记录归一化）
 * - { type: "lifecycle", event, ... } —— 落盘生命周期记录（仅回放）
 * - Pi RPC 记录原样：message_start / message_update / message_end /
 *   tool_execution_start / tool_execution_update / tool_execution_end /
 *   agent_start / agent_settled / turn_* 等
 * - { type: "run_error", message } —— 一轮运行未正常结算（K-02 显形后由主进程推送）
 */

export type StreamItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      /** 一行摘要里的目标：bash 取命令、文件工具取路径。 */
      target: string;
      args: unknown;
      output: string;
      status: "running" | "ok" | "error";
      durationMs?: number;
      /** 文件类工具（edit/write/read）的目标路径，供 diff 卡与「改动」总账聚合。 */
      filePath?: string;
    }
  | {
      kind: "marker";
      id: string;
      label: string;
      tone: "info" | "ok" | "error";
    }
  | { kind: "error"; id: string; message: string };

export type DiffMark = "pending" | "accepted" | "rolledback";

export interface StreamState {
  items: StreamItem[];
  running: boolean;
  /** 已结算轮次（agent_settled 次数）。 */
  settledRuns: number;
  /** diff 卡的人工标记（接受/回滚按钮本块只落状态标记，检查点回滚联动在下一块）。 */
  diffMarks: Record<string, DiffMark>;
  seq: number;
  /** 当前正在流式输出的 assistant 条目 id（内部游标）。 */
  openAssistantId: string | null;
}

export const initialStreamState: StreamState = {
  items: [],
  running: false,
  settledRuns: 0,
  diffMarks: {},
  seq: 0,
  openAssistantId: null,
};

type AnyEvent = Record<string, unknown> & { type: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if ("content" in c) return textOf(c.content);
  }
  return "";
}

/** 从工具结果/部分结果里抽出可展示文本。 */
export function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    const fromContent = textOf(r.content);
    if (fromContent) return fromContent;
    if (typeof r.output === "string") return r.output;
  }
  return "";
}

/** 工具一行摘要的目标：bash→命令首行，文件工具→路径，其余→参数 JSON 摘要。 */
export function toolTarget(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof a.command === "string") {
    return a.command.split("\n")[0] ?? a.command;
  }
  if (typeof a.path === "string") return a.path;
  if (typeof a.command === "string") return a.command.split("\n")[0] ?? "";
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return "";
  }
}

const FILE_TOOLS = new Set(["edit", "write", "read"]);

function closeAssistant(state: StreamState): StreamState {
  if (!state.openAssistantId) return state;
  const openId = state.openAssistantId;
  return {
    ...state,
    // 只含工具调用、无文本的 assistant 消息不留空泡（Pi 会为这类消息也发 message_start）
    items: state.items
      .filter(
        (it) =>
          !(it.kind === "assistant" && it.id === openId && it.text === ""),
      )
      .map((it) =>
        it.kind === "assistant" && it.id === openId
          ? { ...it, streaming: false }
          : it,
      ),
    openAssistantId: null,
  };
}

function pushItem(state: StreamState, item: StreamItem): StreamState {
  return { ...state, items: [...state.items, item] };
}

function nextId(state: StreamState): { id: string; seq: number } {
  const seq = state.seq + 1;
  return { id: `i${seq}`, seq };
}

/** 生命周期事件 → 流内标记（只有真实落盘/真实发生的事件才会走到这里，不造假检查点）。 */
const LIFECYCLE_MARKERS: Record<string, { label: string; tone: "info" | "ok" | "error" }> = {
  session_opened: { label: "会话打开", tone: "info" },
  session_resumed: { label: "会话已续接（上下文恢复）", tone: "info" },
  run_settled: { label: "检查点 · 一轮运行完成并落盘", tone: "ok" },
  run_stopped: { label: "已停止 · 本轮运行被用户停止", tone: "info" },
  run_aborted: { label: "运行异常终止（未结算）", tone: "error" },
  process_exit: { label: "Pi 进程退出", tone: "error" },
  session_closed: { label: "会话关闭", tone: "info" },
};

export function applyHostEvent(state: StreamState, raw: unknown): StreamState {
  if (!raw || typeof raw !== "object") return state;
  const ev = raw as AnyEvent;
  switch (ev.type) {
    case "user_prompt": {
      const s = closeAssistant(state);
      const { id, seq } = nextId(s);
      return {
        ...pushItem(s, { kind: "user", id, text: String(ev.message ?? "") }),
        seq,
      };
    }
    case "lifecycle": {
      const spec = LIFECYCLE_MARKERS[String(ev.event ?? "")];
      if (!spec) return state;
      const { id, seq } = nextId(state);
      return {
        ...pushItem(state, { kind: "marker", id, label: spec.label, tone: spec.tone }),
        seq,
      };
    }
    case "run_error": {
      const s = closeAssistant(state);
      const { id, seq } = nextId(s);
      return {
        ...pushItem(s, {
          kind: "error",
          id,
          message: String(ev.message ?? "运行异常终止"),
        }),
        seq,
        running: false,
      };
    }
    case "agent_start":
      return { ...state, running: true };
    case "message_start": {
      const s = closeAssistant(state);
      const { id, seq } = nextId(s);
      return {
        ...pushItem(s, { kind: "assistant", id, text: "", streaming: true }),
        seq,
        openAssistantId: id,
      };
    }
    case "message_update": {
      const upd = ev.assistantMessageEvent as
        | Record<string, unknown>
        | undefined;
      if (!upd || upd.type !== "text_delta" || typeof upd.delta !== "string") {
        return state;
      }
      let s = state;
      if (!s.openAssistantId) {
        const { id, seq } = nextId(s);
        s = {
          ...pushItem(s, { kind: "assistant", id, text: "", streaming: true }),
          seq,
          openAssistantId: id,
        };
      }
      const openId = s.openAssistantId;
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "assistant" && it.id === openId
            ? { ...it, text: it.text + (upd.delta as string) }
            : it,
        ),
      };
    }
    case "message_end":
      return closeAssistant(state);
    case "tool_execution_start": {
      const s = closeAssistant(state);
      const { id, seq } = nextId(s);
      const toolName = String(ev.toolName ?? "tool");
      const args = (ev as Record<string, unknown>).args;
      const a = (args ?? {}) as Record<string, unknown>;
      const item: StreamItem = {
        kind: "tool",
        id,
        toolCallId: String(ev.toolCallId ?? id),
        toolName,
        target: toolTarget(toolName, args),
        args,
        output: "",
        status: "running",
        filePath:
          FILE_TOOLS.has(toolName) && typeof a.path === "string"
            ? a.path
            : undefined,
      };
      return { ...pushItem(s, item), seq };
    }
    case "tool_execution_update": {
      const text = extractResultText(
        (ev as Record<string, unknown>).partialResult,
      );
      if (!text) return state;
      const toolCallId = String(ev.toolCallId ?? "");
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.toolCallId === toolCallId
            ? { ...it, output: it.output + text }
            : it,
        ),
      };
    }
    case "tool_execution_end": {
      const toolCallId = String(ev.toolCallId ?? "");
      const text = extractResultText((ev as Record<string, unknown>).result);
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.toolCallId === toolCallId
            ? {
                ...it,
                status: ev.isError ? ("error" as const) : ("ok" as const),
                output: text || it.output,
                durationMs:
                  typeof ev.durationMs === "number" ? ev.durationMs : it.durationMs,
              }
            : it,
        ),
      };
    }
    case "agent_settled": {
      // 只做结算（停运行、计数）：完成/停止标记一律由落盘 lifecycle 记录产生
      // （run_settled / run_stopped），保证实时与回放同口径、且已停止的运行
      // 绝不被标成「完成」。实时流由主进程在 run-settled 推送时注入 lifecycle。
      const s = closeAssistant(state);
      return { ...s, running: false, settledRuns: s.settledRuns + 1 };
    }
    default:
      return state;
  }
}

/** 一批事件顺序折叠（历史回放用）。 */
export function applyHostEvents(
  state: StreamState,
  events: Array<unknown>,
): StreamState {
  let s = state;
  for (const ev of events) s = applyHostEvent(s, ev);
  return s;
}

/** diff 卡的人工标记（本块只落状态；与检查点的真实回滚联动在下一块）。 */
export function applyDiffMark(
  state: StreamState,
  toolCallId: string,
  mark: DiffMark,
): StreamState {
  return { ...state, diffMarks: { ...state.diffMarks, [toolCallId]: mark } };
}

/** 该工具条目是否应渲染 diff 卡：edit/write 已成功完成且参数里有可展示的改动内容。 */
export function diffPayload(
  item: StreamItem,
): { path: string; oldText: string; newText: string } | null {
  if (item.kind !== "tool" || item.status !== "ok") return null;
  if (item.toolName !== "edit" && item.toolName !== "write") return null;
  const a = (item.args ?? {}) as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : item.filePath;
  if (!path) return null;
  if (item.toolName === "write" && typeof a.content === "string") {
    return { path, oldText: "", newText: a.content };
  }
  if (item.toolName === "edit") {
    if (typeof a.oldText === "string" && typeof a.newText === "string") {
      return { path, oldText: a.oldText, newText: a.newText };
    }
    if (Array.isArray(a.edits)) {
      const parts = a.edits
        .map((e) => {
          const ed = (e ?? {}) as Record<string, unknown>;
          return typeof ed.newText === "string" ? ed.newText : "";
        })
        .filter(Boolean);
      const olds = a.edits
        .map((e) => {
          const ed = (e ?? {}) as Record<string, unknown>;
          return typeof ed.oldText === "string" ? ed.oldText : "";
        })
        .filter(Boolean);
      if (parts.length > 0) {
        return { path, oldText: olds.join("\n"), newText: parts.join("\n") };
      }
    }
  }
  return null;
}

export interface FileChange {
  path: string;
  toolCallId: string;
  toolName: string;
  status: "running" | "ok" | "error";
}

/** 右栏「改动」总账：由工具事件聚合的真实文件改动（无改动即空，不编造）。 */
export function selectFileChanges(state: StreamState): FileChange[] {
  const out: FileChange[] = [];
  for (const it of state.items) {
    if (it.kind === "tool" && it.filePath && it.toolName !== "read") {
      out.push({
        path: it.filePath,
        toolCallId: it.toolCallId,
        toolName: it.toolName,
        status: it.status,
      });
    }
  }
  return out;
}

export type DiffRow =
  | { kind: "context"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string }
  | { kind: "gap"; text: string };

const MAX_DIFF_LINES = 1500;

/** 简单行级 diff（LCS），带上下文折叠；超大输入截断并显形标注。 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  contextLines = 2,
): DiffRow[] {
  let oldLines = oldText === "" ? [] : oldText.split("\n");
  let newLines = newText === "" ? [] : newText.split("\n");
  let truncated = false;
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    oldLines = oldLines.slice(0, MAX_DIFF_LINES);
    newLines = newLines.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }
  const m = oldLines.length;
  const n = newLines.length;
  // LCS 动态规划（行数已封顶，最坏 1500x1500 可接受）
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ kind: "context", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: "del", text: oldLines[i] });
      i++;
    } else {
      raw.push({ kind: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < m) raw.push({ kind: "del", text: oldLines[i++] });
  while (j < n) raw.push({ kind: "add", text: newLines[j++] });

  // 上下文折叠：变更块之间超过 2*context+1 行的 context 收成一行 gap
  const rows: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = (isTail: boolean) => {
    if (run.length === 0) return;
    const keepHead = rows.length === 0 ? 0 : contextLines;
    const keepTail = isTail ? 0 : contextLines;
    if (run.length > keepHead + keepTail + 1) {
      rows.push(...run.slice(0, keepHead));
      rows.push({
        kind: "gap",
        text: `… ${run.length - keepHead - keepTail} 行未改动 …`,
      });
      rows.push(...run.slice(run.length - keepTail));
    } else {
      rows.push(...run);
    }
    run = [];
  };
  for (const row of raw) {
    if (row.kind === "context") {
      run.push(row);
    } else {
      flush(false);
      rows.push(row);
    }
  }
  flush(true);
  if (truncated) {
    rows.push({ kind: "gap", text: `… 输入超过 ${MAX_DIFF_LINES} 行，已截断 …` });
  }
  return rows;
}
