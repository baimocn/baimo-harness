/*** 白墨 Harness 计划门扩展（M-03 计划面板） *****
* 在 Pi 进程内运行，经 --extension 挂载（与审批门并列）。注册两个工具：
*
* - submit_plan({ steps: [{ title, action}]})：agent 动手前提交计划。
* execute 内先把计划写入状态文件（status=awaiting_approval），再经
* ctx.ui.select 的 RPC 阻塞往返等用户裁决（批准 / 编辑 / 拒绝）；
* 选「编辑」时经 ctx.ui.editor 让用户逐行改步骤（增删行、调顺序），
* 改完回到 select 再裁决。批准后状态转 executing 并把定稿计划作为
* 工具结果回给 agent；拒绝/超时则状态转 rejected（超时保留
* awaiting_approval，表示用户未表态），工具结果明确告知未获批准。
* - plan_progress({ stepIndex, status})：agent 每完成一步回报，
* 扩展据此更新状态文件；全部步入终态后计划转 completed /
* completed_with_failures。步骤状态只由该工具的真实调用驱动，
* 不做事后推测（不冒充进度）。
*
* 执行纪律（tool_call 拦截，与审批门并行，任一 block 即拦）：
* - 策略文件（env BAIMO_PLAN_POLICY，{ required, paused}）逐次现读。
* - required=true 时：本轮未获批准前（内存态 planPhase，非进程内
* 批准），写类工具一律 block——先审后行是硬约束，不是提示词自觉。
* - paused=true 时：除 submit_plan 外一切工具（含 plan_progress）
* block，计划状态转 paused；清除 paused 后下一个工具调用起恢复，
* 状态回 executing。暂停在工具调用边界生效（在飞的调用不打断），
* 与 PRD「在这一步后暂停」同义。
* - planPhase 在 agent_start 时重置；状态文件（env BAIMO_PLAN_STATE）
* 是计划的权威落盘，宿主/界面只读它渲染计划面板。
*
* before_agent_start：required 时给系统提示词追加计划流程指令
* （先 submit_plan、批准后逐步执行并回报 plan_progress、未获批准
* 立即停手）。指令是引导，硬约束在 tool_call 拦截层。
*/
import { mkdirSync, readFileSync, writeFileSync} from "node:fs";
import { dirname} from "node:path";
import { Type} from "typebox";

const STATE_FILE = process.env.BAIMO_PLAN_STATE?? "";
const POLICY_FILE = process.env.BAIMO_PLAN_POLICY?? "";

export const PLAN_OPT_APPROVE = "批准执行";
export const PLAN_OPT_EDIT = "编辑计划";
export const PLAN_OPT_REJECT = "拒绝计划";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EDIT_ROUNDS = 10;

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PLAN_TOOLS = new Set(["submit_plan", "plan_progress"]);

/* 写类判定：与审批山口径一致（文件工具恒写类；bash 看危险/变更启发式）。 */
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
const MUTATING_HEADS = new Set([
"rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "kill",
"pkill", "npm", "pnpm", "yarn", "pip", "pip3", "cargo", "go", "make",
"tee", "dd", "truncate", "shred", "curl", "wget",
]);

function isMutatingBash(command) {
if (DANGER_PATTERNS.some((p) => p.test(command))) return true;
if (/(^|[^>])>>?[^>]/.test(command)) return true;
const segments = command.split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
for (const seg of segments) {
const tokens = seg.split(/\s+/);
const head = (tokens[0]?? "").replace(/^.*\//, "");
if (MUTATING_HEADS.has(head)) return true;
if (head === "sed" && tokens.some((t) => t === "-i" || t.startsWith("-i"))) return true;
if (head === "git") {
const sub = tokens[1]?? "";
if (["commit", "checkout", "merge", "rebase", "reset", "clean", "push", "pull", "add", "stash", "restore", "rm", "mv"].includes(sub)) return true;
}
}
return false;
}

function isWriteClass(tool, input) {
if (READ_TOOLS.has(tool)) return false;
if (tool === "bash") return isMutatingBash(String(input?.command?? ""));
return true;
}

function readPolicy() {
if (POLICY_FILE) {
try {
const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
return {
required: parsed?.required === true,
paused: parsed?.paused === true,
};
} catch {
/* 文件缺失/损坏：计划流程关闭（不拦截），状态文件仍可独立工作 */
}
}
return { required: false, paused: false};
}

function readState() {
if (!STATE_FILE) return null;
try {
const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
if (parsed && Array.isArray(parsed.steps)) return parsed;
} catch {
/* 无状态文件 = 尚无计划 */
}
return null;
}

function writeState(state) {
if (!STATE_FILE) return;
mkdirSync(dirname(STATE_FILE), { recursive: true});
writeFileSync(
STATE_FILE,
JSON.stringify({...state, updatedAt: new Date().toISOString()}, null, 2) + "\n",
"utf8",
);
}

function notifyPlan(ctx, event, state) {
ctx.ui.notify(
JSON.stringify({
baimoPlan: 1,
kind: "state",
event,
status: state?.status?? null,
stepCount: state?.steps?.length?? 0,
}),
"info",
);
}

const PLAN_INSTRUCTION = [
"",
"本会话开启了「计划先行」：",
"1. 动手执行任何写操作之前，先调用 submit_plan 工具提交行动计划（步骤列表，每步一句话标题 + 动作类型）。submit_plan 会阻塞等待用户批准/编辑/拒绝，并把定稿计划作为结果返回。",
"2. 只有 submit_plan 返回「计划已获批准」后才能执行写操作；返回未获批准时立即停手，只用一句话向用户说明，不要重试。",
"3. 执行时严格按批准的步骤顺序推进，每完成一步立即调用 plan_progress({ stepIndex, status}) 回报（status 为 done 或 failed，failed 时在 note 里写明原因）。",
"4. 全部步骤回报完毕后再给最终总结。",
].join("\n");

export default function (pi) {
/** 本轮（agent run）内的计划阶段：none / awaiting / approved / rejected。 */
let planPhase = "none";
/** before_agent_start 捕获的用户任务原文（写进状态文件供计划面板展示）。 */
let pendingTask = "";

pi.on("agent_start", () => {
planPhase = "none";
});

// 运行结算时把仍挂在 executing 的计划如实收尾：全部步已入终态由
// plan_progress 处理；这里处理「某步失败后 agent 收手」「agent 提前
// 结束」等情形——有 failed 步 → completed_with_failures；无失败但
// 还有 pending 步 → incomplete。绝不让计划永远假装 executing。
// paused 不动（暂停是用户有意状态，跨运行保留）。
pi.on("agent_settled", (_event, ctx) => {
const state = readState();
if (!state || state.status !== "executing") return;
const allTerminal = state.steps.every(
(s) => s.status === "done" || s.status === "failed",
);
const anyFailed = state.steps.some((s) => s.status === "failed");
const status = allTerminal
? anyFailed
? "completed_with_failures"
: "completed"
: anyFailed
? "completed_with_failures"
: "incomplete";
const next = { ...state, status };
writeState(next);
notifyPlan(ctx, "settled", next);
});

pi.on("before_agent_start", (event) => {
if (event.messageType === "user" && typeof event.prompt === "string") {
pendingTask = event.prompt;
}
const policy = readPolicy();
if (!policy.required || event.messageType!== "user") return undefined;
return { systemPrompt: event.systemPrompt + "\n" + PLAN_INSTRUCTION};
});

pi.registerTool({
name: "submit_plan",
label: "提交计划",
description:
"执行写操作之前提交行动计划给用户审批。会阻塞等待用户批准、编辑或拒绝，并返回定稿计划；未获批准时必须停手。",
promptSnippet: "submit_plan: 先提交计划给用户审批，批准后才执行",
parameters: Type.Object({
steps: Type.Array(
Type.Object({
title: Type.String({ description: "步骤一句话标题"}),
action: Type.Optional(
Type.String({ description: "动作类型，如 read/write/bash/edit"}),
),
}),
{ minItems: 1, description: "计划步骤列表（至少一步）"},
),
}),
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
const rawSteps = Array.isArray(params?.steps)? params.steps: [];
let steps = rawSteps
.filter((s) => s && typeof s.title === "string" && s.title.trim())
.map((s) => ({
title: s.title.trim(),
action: typeof s.action === "string"? s.action: "task",
status: "pending",
}));
if (steps.length === 0) {
return {
content: [
{ type: "text", text: "计划为空（steps 至少需要一步），请重新提交。"},
],
details: {},
};
}
let state = {
version: 1,
status: "awaiting_approval",
task: pendingTask,
steps,
createdAt: new Date().toISOString(),
};
writeState(state);
planPhase = "awaiting";
notifyPlan(ctx, "submitted", state);

let approved = false;
let timedOut = false;
for (let round = 0; round < MAX_EDIT_ROUNDS &&!approved; round++) {
const choice = await ctx.ui.select(
JSON.stringify({ baimoPlan: 1, kind: "select", steps: state.steps}),
[PLAN_OPT_APPROVE, PLAN_OPT_EDIT, PLAN_OPT_REJECT],
{ timeout: APPROVAL_TIMEOUT_MS},
);
if (choice === PLAN_OPT_APPROVE) {
approved = true;
break;
}
if (choice === PLAN_OPT_EDIT) {
const prefill = state.steps.map((s) => s.title).join("\n");
const edited = await ctx.ui.editor(
JSON.stringify({ baimoPlan: 1, kind: "editor"}),
prefill,
);
if (typeof edited === "string") {
const prevByTitle = new Map(state.steps.map((s) => [s.title, s]));
const lines = edited
.split("\n")
.map((l) => l.trim())
.filter(Boolean);
if (lines.length > 0) {
steps = lines.map((title) => ({
title,
action: prevByTitle.get(title)?.action?? "task",
status: "pending",
}));
state = {...state, steps};
writeState(state);
notifyPlan(ctx, "edited", state);
}
}
continue;
}
// 拒绝，或 select 超时/被取消（undefined）：未获批准。
timedOut = choice === undefined;
break;
}

if (!approved) {
planPhase = "rejected";
state = {
...state,
status: timedOut? "awaiting_approval": "rejected",
};
writeState(state);
notifyPlan(ctx, timedOut? "approval_timeout": "rejected", state);
return {
content: [
{
type: "text",
text: timedOut
? "计划未获批准（用户在 5 分钟内未裁决，审批超时）。请立即停手，不要执行任何写操作，只用一句话向用户说明并等待新指令。"
: "计划未获批准（用户拒绝了该计划）。请立即停手，不要执行任何写操作，只用一句话向用户说明并等待新指令。",
},
],
details: { approved: false},
};
}

state = {...state, status: "executing", steps};
writeState(state);
planPhase = "approved";
notifyPlan(ctx, "approved", state);
const listing = steps
.map((s, i) => `${i + 1}. ${s.title}（${s.action}）`)
.join("\n");
return {
content: [
{
type: "text",
text: `计划已获批准，共 ${steps.length} 步：\n${listing}\n请按顺序执行，每完成一步立即调用 plan_progress({ stepIndex, status}) 回报。`,
},
],
details: { approved: true, steps},
};
},
});

pi.registerTool({
name: "plan_progress",
label: "回报计划进度",
description:
"计划获批后，每完成一步调用一次，回报该步结果（done/failed）。计划面板的进度只由此工具的真实调用驱动。",
parameters: Type.Object({
stepIndex: Type.Number({ description: "步骤序号（从 0 开始）"}),
status: Type.Union([Type.Literal("done"), Type.Literal("failed")], {
description: "该步结果",
}),
note: Type.Optional(Type.String({ description: "备注（失败原因等）"})),
}),
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
const state = readState();
if (!state || (state.status!== "executing" && state.status!== "paused" && state.status!== "incomplete")) {
return {
content: [
{
type: "text",
text: `当前没有执行中的计划（状态：${state?.status?? "无"}），plan_progress 未生效。`,
},
],
details: { applied: false},
};
}
const idx = params?.stepIndex;
if (
typeof idx!== "number" ||
!Number.isInteger(idx) ||
idx < 0 ||
idx >= state.steps.length
) {
return {
content: [
{
type: "text",
text: `stepIndex ${String(idx)} 越界（共 ${state.steps.length} 步），plan_progress 未生效。`,
},
],
details: { applied: false},
};
}
const stepStatus = params.status === "failed"? "failed": "done";
const steps = state.steps.map((s, i) =>
i === idx
? {
...s,
status: stepStatus,
...(typeof params.note === "string" && params.note
? { note: params.note}
: {}),
}
: s,
);
const allTerminal = steps.every(
(s) => s.status === "done" || s.status === "failed",
);
const anyFailed = steps.some((s) => s.status === "failed");
const next = {
...state,
steps,
status: allTerminal
? anyFailed
? "completed_with_failures"
: "completed"
: state.status === "incomplete"
? "executing"
: state.status,
};
writeState(next);
notifyPlan(ctx, "progress", next);
return {
content: [
{
type: "text",
text: `已记录：第 ${idx + 1} 步「${steps[idx].title}」→ ${stepStatus}。${allTerminal? "全部步骤已回报完毕，请给最终总结。": "请继续下一步。"}`,
},
],
details: { applied: true},
};
},
});

pi.on("tool_call", async (event, ctx) => {
const tool = event.toolName;
if (tool === "submit_plan") return undefined;
const policy = readPolicy();

// 暂停：在工具调用边界拦下除 submit_plan 外的一切工具（含进度回报）。
if (policy.paused) {
const state = readState();
if (state && (state.status === "executing" || state.status === "paused")) {
if (state.status!== "paused") {
const pausedState = {...state, status: "paused"};
writeState(pausedState);
notifyPlan(ctx, "paused", pausedState);
}
return {
block: true,
reason:
"白墨 Harness：计划已被用户暂停，后续步骤暂不执行。请停止调用工具，用一句话向用户说明已暂停并等待恢复指令。",
};
}
} else {
// 暂停已解除且计划仍挂在 paused：恢复 executing（下一个工具调用起生效）。
const state = readState();
if (state && state.status === "paused" && planPhase === "approved") {
const resumed = {...state, status: "executing"};
writeState(resumed);
notifyPlan(ctx, "resumed", resumed);
}
}

if (tool === "plan_progress") return undefined;

// 先审后行：required 且本轮未获批准时，写类工具硬拦。
if (policy.required && planPhase!== "approved") {
if (isWriteClass(tool, event.input?? {})) {
return {
block: true,
reason:
"白墨 Harness 计划先行：本轮计划尚未获用户批准，写操作一律拦截。请先调用 submit_plan 提交计划，获批后再执行。",
};
}
}
return undefined;
});
}
