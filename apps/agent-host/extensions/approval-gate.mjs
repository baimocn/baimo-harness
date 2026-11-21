/*** 白墨 Harness 审批门扩展（M-02 权限模式与分级审批） *****
 * 在 Pi 进程内运行，经 --extension 挂到每个会话。在 tool_call 事件上按
 * 当前权限模式裁决每个写类工具调用：
 *
 * - 计划（plan）：写类一律 block（write/edit/变更型 bash/危险命令），
 *   并 notify 显形；只读工具与只读 bash 放行（计划模式仍可调研）。
 * - 编辑（edit）：写类弹审批（宿主界面审批卡裁决）；已授「本会话始终
 *   允许」的工具免问；危险命令独立清单永远要问（授权不豁免）。
 * - 构建（build）：普通写类放行；危险命令弹审批。
 * - YOLO（yolo）：全部放行（预算熔断在后续块，策略文件预留字段）。
 *
 * 机制：ctx.ui.select 在 RPC 模式下是阻塞的 extension_ui_request /
 * extension_ui_response 往返——Pi 在宿主裁决前不会执行工具；拒绝时
 * return { block: true, reason }，理由作为工具结果回给 agent。
 * 审批带 5 分钟超时（Pi 侧自动以 undefined 结算），超时按拒绝处理。
 *
 * 策略通道：env BAIMO_APPROVAL_POLICY 指向一个 JSON 文件
 * { mode, grants: [toolName...] }，每次 tool_call 现读——壳层改模式
 * 只需改文件，运行中的会话立即生效；「本会话始终允许」由本扩展把
 * 工具名追加进 grants 落盘（进程重启/会话续接后仍有效）。
 * 策略文件缺失/损坏时 fail-closed：按 edit（写类要审批）处理。
 */
import { readFileSync, writeFileSync } from "node:fs";

const POLICY_FILE = process.env.BAIMO_APPROVAL_POLICY ?? "";
const FALLBACK_MODE = process.env.BAIMO_APPROVAL_DEFAULT_MODE ?? "edit";

export const OPT_ALLOW_ONCE = "允许一次";
export const OPT_ALLOW_SESSION = "本会话始终允许";
export const OPT_DENY = "拒绝";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** 计划门的协调工具（M-03）：不落盘改文件，由计划门扩展自身管控，审批门豁免。 */
const PLAN_TOOLS = new Set(["submit_plan", "plan_progress"]);

/** 危险命令清单（PRD M-02）：任何非 YOLO 模式下独立二次确认。 */
const DANGER_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f\b|-[a-z]*f[a-z]*r\b|--recursive\b[^|;&]*--force\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^|;&]*\b777\b/,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\b[^|;&]*\bof=\/dev\//i,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /(\bcurl\b|\bwget\b)[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  />\s*\/dev\/(sd[a-z]|nvme|disk)/i,
];

/** 变更型 bash 的命令头（计划模式拦截口径）：写文件/改状态类。 */
const MUTATING_HEADS = new Set([
  "rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "kill",
  "pkill", "npm", "pnpm", "yarn", "pip", "pip3", "cargo", "go", "make",
  "tee", "dd", "truncate", "shred", "curl", "wget",
]);

function isDangerousBash(command) {
  return DANGER_PATTERNS.some((p) => p.test(command));
}

function isMutatingBash(command) {
  if (/(^|[^>])>>?[^>]/.test(command)) return true; // 重定向写文件
  const segments = command.split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/);
    const head = (tokens[0] ?? "").replace(/^.*\//, "");
    if (MUTATING_HEADS.has(head)) return true;
    if (head === "sed" && tokens.some((t) => t === "-i" || t.startsWith("-i"))) return true;
    if (head === "git") {
      const sub = tokens[1] ?? "";
      if (["commit", "checkout", "merge", "rebase", "reset", "clean", "push", "pull", "add", "stash", "restore", "rm", "mv"].includes(sub)) return true;
    }
  }
  return false;
}

function loadPolicy() {
  if (POLICY_FILE) {
    try {
      const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
      return {
        mode: typeof parsed?.mode === "string" ? parsed.mode : FALLBACK_MODE,
        grants: Array.isArray(parsed?.grants) ? parsed.grants : [],
        raw: parsed ?? {},
      };
    } catch {
      /* 落到 fail-closed 缺省 */
    }
  }
  return { mode: FALLBACK_MODE, grants: [], raw: {} };
}

function persistGrant(tool) {
  if (!POLICY_FILE) return;
  try {
    const { grants, raw } = loadPolicy();
    if (grants.includes(tool)) return;
    writeFileSync(
      POLICY_FILE,
      JSON.stringify({ ...raw, grants: [...grants, tool] }, null, 2),
      "utf8",
    );
  } catch {
    /* 落盘失败不挡本次放行；下次调用会重新询问（不静默假装已授权由宿主日志兜底） */
  }
}

function summarize(tool, input) {
  if (tool === "bash") return `bash: ${String(input?.command ?? "")}`;
  if (input?.path) return `${tool}: ${String(input.path)}`;
  return tool;
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    const input = event.input ?? {};
    if (READ_TOOLS.has(tool)) return undefined;
    if (PLAN_TOOLS.has(tool)) return undefined;

    const isBash = tool === "bash";
    const command = isBash ? String(input.command ?? "") : "";
    const danger = isBash && isDangerousBash(command);
    // 写类判定：write/edit 等文件工具恒写类；bash 看危险/变更启发式，
    // 只读 bash（echo/ls/cat/git status…）不算写类，任何模式放行。
    const writeClass = !isBash || danger || isMutatingBash(command);
    if (!writeClass) return undefined;

    const policy = loadPolicy();
    const mode = policy.mode;

    if (mode === "yolo") return undefined;

    if (mode === "plan") {
      ctx.ui.notify(
        `计划模式已拦截写操作：${summarize(tool, input)}`,
        "warning",
      );
      return {
        block: true,
        reason:
          `白墨 Harness 计划模式：写操作一律拦截（本次：${summarize(tool, input)}）。` +
          "请先产出/完善计划，或请用户切换到编辑/构建模式后再执行。",
      };
    }

    // edit / build
    const needsAsk = danger || mode === "edit";
    if (!needsAsk) return undefined;
    if (!danger && policy.grants.includes(tool)) return undefined;

    const reason = danger
      ? "命中危险命令清单（任何模式下二次确认）"
      : "编辑模式：写操作需审批";
    const payload = JSON.stringify({
      baimoApproval: 1,
      tool,
      args: input,
      danger,
      mode,
      reason,
    });
    const choice = await ctx.ui.select(
      payload,
      [OPT_ALLOW_ONCE, OPT_ALLOW_SESSION, OPT_DENY],
      { timeout: APPROVAL_TIMEOUT_MS },
    );
    if (choice === OPT_ALLOW_ONCE) return undefined;
    if (choice === OPT_ALLOW_SESSION) {
      persistGrant(tool);
      return undefined;
    }
    const why =
      choice === undefined
        ? "审批超时（5 分钟未裁决），默认拒绝"
        : "用户在审批卡上拒绝";
    ctx.ui.notify(`已拒绝执行：${summarize(tool, input)}（${why}）`, "warning");
    return {
      block: true,
      reason: `白墨 Harness 审批未通过：${why}。工具 ${tool} 未执行，请勿重试同一调用，可向用户说明或改用只读方式推进。`,
    };
  });
}
