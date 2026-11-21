# 阶段 2 · 引导簇 测试记录（2026-11-21）

四个模块逐个推进：每模块 E2E 全绿 + 全量回归全绿后才提交、才进下一模块。
基线（上一块结束时）：node 40/40 + 桌面 7/7 = 47/47。
**最终回归：node 65/65 + 桌面 12/12 = 77/77 全绿**（基线 47 全部保留，新增 30 条）。
全程只用本地桩模型，无任何真实模型 API key。

提交列表（一模块一提交）：
- `177556e` 模块 1 计划面板 M-03
- `3267540` 模块 2 Steering 队列 M-04
- `d64038c` 模块 3 成本账本 + 预算熔断 M-07
- `a39e750` 模块 4 D-01 命令模式授权

截图目录：`docs/test-runs/assets/2026-11-21-stage2-guidance/`（9 张）。

---

## 模块 1 · 计划面板（M-03）

**机制（一句话）**：计划门是跑在 Pi 进程内的第二个扩展，注册 `submit_plan` /
`plan_progress` 两个自定义工具作为事前计划的唯一通道——计划状态文件由扩展在
agent 真实调用工具时写出（批准发生在任何写操作之前，批准后步骤状态只由
`plan_progress` 的真实调用推进），宿主/UI 只读状态文件呈现，绝不事后编造。

开工前探针实证的 Pi 能力边界：
- 纯 `.mjs` 扩展可 `import { Type } from "typebox"` 并 `pi.registerTool()` 注册
  自定义工具，模型可按名调用；工具 execute 拿到带 ui 的 ctx。
- `ctx.ui.select` / `ctx.ui.editor` 都是阻塞 RPC 往返（editor 回包同为
  extension_ui_response，value/cancelled 语义与 select 一致）。
- `before_agent_start` 可向系统提示词追加计划流程契约；多个扩展的 tool_call
  处理链式执行，任一 block 即拦下。

落点：
- 扩展 `apps/agent-host/extensions/plan-gate.mjs`：submit_plan 执行即写状态
  `awaiting_approval`（先落盘后弹裁决，界面看到的一定是模型真实产出的计划）→
  阻塞 select 三档（批准执行 / 编辑计划 / 拒绝计划，5 分钟超时按未批准）；
  编辑经 editor 往返（逐行一步，标题匹配保留原 action），最多 10 轮改后复审；
  批准后状态 `executing`，plan_progress 推进步骤，全部终态汇总为
  `completed` / `completed_with_failures`；agent 结算时仍在执行中的计划由
  agent_settled 处理器如实收尾（有失败→completed_with_failures，有未完步骤→
  `incomplete`，不冒充完成）。
- 硬规则（tool_call 拦截）：「计划先行」开启且本轮计划未批准 → 写类工具一律
  block（理由含「计划先行」，回到 agent）；暂停开启 → 除 submit_plan 外一切
  工具 block、状态转 `paused`，恢复后自动续 `executing`。计划权限模式
  （permission plan）与计划先行是两套独立机制，前者归审批门。
- 审批门豁免 submit_plan/plan_progress（协调工具不落盘改文件，否则计划提交
  本身会被审批卡截停）。
- 桌面：计划卡（中栏，批准/编辑/拒绝、暂停/恢复）、编辑弹窗（逐行编辑）、
  真实「计划」页签（计划先行开关、状态、步骤列表、暂停/恢复）；计划 notify
  在主进程翻成成条提示，原始 JSON 不进执行流。

E2E 新增：宿主 7 条（`stage2-guidance-plan.test.mjs`：批准全流程并断言计划在
裁决前已落盘、编辑定稿、拒绝不执行、计划先行硬拦 write、失败步骤→
completed_with_failures、暂停时文件未写且恢复后新一轮走完、未开启计划先行时
计划门完全惰性）+ 桌面 2 条（`stage2-plan.e2e.test.mjs`：批准/编辑/拒绝三段、
暂停/恢复）。截图：m1-plan-awaiting / m1-plan-completed / m1-plan-editor /
m1-plan-paused。
模块后回归：node 47/47、桌面 9/9。

如实降级：
- 步骤排序：编辑器是逐行文本，改序靠改行序（无拖拽排序 UI）。
- 暂停粒度是工具调用边界（当前工具调用会先完成），不是指令级冻结——已在
  计划页签文案明示。
- 计划卡与计划页签的暂停按钮作用于「后续步骤」，与上一条同口径。

## 模块 2 · Steering 队列（M-04）

**机制（一句话）**：直接用 Pi RPC 原生 `steer` / `follow_up` / `clear_queue`——
steer 在当前轮工具调用结束、下一轮 LLM 调用前投递，follow_up 在 agent 自然
停止后才投递（两者空闲时排队并入下一轮）；宿主维护一份落盘镜像记每条的
去向（queued/delivered/withdrawn），投递对账以投递时必发的 `message_start`
(role=user) 事件为准。

探针实证：steer/follow_up 在运行中与空闲时都被接受；agent_settled 只在排队
follow_up 全部处理完后才发；clear_queue 返回被清文本；queue_update 携带两类
队列现状。投递在桩请求记录里逐条可验（第几个请求带哪条文本、follow_up 在
「Stub final answer.」之后且在 settled 之前）。

落点：
- 宿主 `SteeringStore`（`<dataDir>/steering/<sessionId>.json`）+ SessionHandle
  的 steer/followUp/clearQueue/withdrawQueueEntry/restoreQueue/getQueue 与
  queueChanged 事件；全生命周期落 lifecycle 事件。**单条撤回**：Pi 只有整表
  清除命令，故实现为整表清除 + 幸存条目按原序重新入队（条目 id 不变，被撤
  文本永不到达模型，E2E 断言）；续接会话时未投递条目自动恢复进新进程。
- 桌面：输入区上方队列条（种类徽标 注入纠正/排队、状态 待投递/已投递/已撤回、
  待投递可撤回）；运行中输入区保持可用，发送=入队（缺省 follow_up，可切换
  steer）；投递瞬间该条以用户消息形态进入执行流（实时与回放同口径，回放由
  主进程把落盘 steering_delivered 归一化为 user_prompt，不双份）。

E2E 新增：宿主 7 条（`stage2-guidance-steering.test.mjs`）+ 桌面 1 条
（`stage2-steering.e2e.test.mjs`：入队两条→撤回一条→另一条投递进执行流，
桩请求记录交叉断言）。截图：m2-queue-strip / m2-queue-delivered。
模块后回归：node 54/54、桌面 10/10。

本模块 E2E 抓修的两个真问题（值得记）：
1. **PiProcess 退出结算可被监听器打断**：子进程 exit 时 SessionHandle 的落盘
   监听抛错会穿透 emit、使 exitPromise 永不兑现、stop() 永久挂起。已修：
   PiProcess 的 exit 结算对监听器异常免疫（resolve 必达）。
2. **queue_update 收缩对账竞态**：clear_queue 同样引起队列收缩，会把撤回误判
   成投递。对账依据改为 message_start 后竞态消失。

## 模块 3 · 成本账本 + YOLO 预算熔断（M-07）

**机制（一句话）**：`get_session_stats` 是会话累计口径（探针实证：9 次调用的
usage 精确累加），宿主在每轮运行前后各取一次快照做差分记账；熔断检查挂在
每个 turn_end（用量以轮为粒度更新的最早可判定点），超限即 abort 并以独立
disposition `budget_fused` 结算，YOLO 同样受约束（熔断在宿主层，与审批门无关）。

落点：
- core `CostLedger`（`packages/core/src/cost.ts`）：`<dataDir>/cost/` 下
  pricing.json（每模型四项单价，单位 $/1M tokens）、budgets.json（单次/单日
  上限，null=不限）、ledger.jsonl（append-only 账目，带单价快照）。汇总口径：
  未定价账目 cost=null、tokens 照记、单独累计 unpricedTokens，全部未定价时
  合计为 null——界面显示「未定价」，绝不用 0 冒充。
- 宿主：运行前单日上限已达 → 抛类型化 `BudgetExceededError`
  （BUDGET_EXCEEDED），模型零请求；运行中 turn_end 检查单次/单日两档，触发记
  `budget_fuse_tripped` + 结算记 `run_budget_fused`（不落 run_settled）；熔断
  轮次的已消耗成本照样差分记账；统计取不到时以 lifecycle
  `cost_accounting_failed` 显形，不静默。
- 桌面：顶栏成本读数（本会话 · 今日，真实汇总）；右侧「账本」页签（会话/今日
  总额与笔数、未定价提示、预算两档编辑、当前模型四项定价编辑、最近 20 笔
  账目）；熔断时执行流出现红色说明（范围 + 成本 vs 上限金额），不记完成。

E2E 新增：core 单测 4 条 + 宿主 5 条（`stage2-guidance-cost.test.mjs`：差分
记账 0.07 对得上且第二轮累计 0.14、单次上限熔断、单日上限第二轮熔断、
单日已超限发起前拒绝且模型零请求、未定价口径）+ 桌面 1 条
（`stage2-cost.e2e.test.mjs`：UI 定价→读数 $0.0700→设上限→切 YOLO→熔断显形）。
截图：m3-ledger-after-run / m3-budget-fused-yolo。
模块后回归：node 63/63、桌面 11/11。

口径说明：熔断判定只对已定价模型生效（金额无从折算时不熔断、也不假装在管）；
per-run 检查的最早时点是第一个 turn_end，第一轮的成本一旦超限即触发——E2E
的单轮 $0.035 vs 上限 $0.03 即按此断言。

## 模块 4 · D-01 第三级授权（命令模式持久允许）

**机制（一句话）**：审批门在编辑模式的非危险 bash 审批里多给一档「按命令模式
始终允许」——裁决后由门把命令头前缀规则（首 token + ` *`，如 `cargo *`）
落盘进策略文件 `patternGrants`，后续 tool_call 现读策略时前缀命中即免问；
危险命令在检查链上永远排在模式匹配之前，任何模式授权都不豁免。

落点：
- 审批门 `approval-gate.mjs`：loadPolicy 解析 patternGrants、matchesPattern
  （`*` 结尾=前缀匹配，否则全等）、derivePattern、persistPatternGrant（读改写
  保留 mode/grants）；危险命令的 select 不提供模式档。
- 桌面主进程：裁决映射加 pattern 档；writePolicy 改策略时保留 patternGrants
  （与 grants 同口径读合并写，不被模式切换冲掉）。
- 审批卡：仅当门下发的 options 含模式档时才渲染该按钮，并预览将授权的模式
  （`touch *`），title 写明口径（同命令头非危险命令免问、危险永不豁免）。

E2E 新增：宿主 2 条（`stage2-guidance-pattern.test.mjs`：授 `touch *` 后同头
免问/异头照常问/规则落盘断言；已授 `rm *` 后 `rm -rf` 仍弹卡且拒绝后目标
完好）+ 桌面 1 条（`stage2-pattern.e2e.test.mjs`）。截图：m4-approval-pattern。
最终回归：node 65/65、桌面 12/12 = 77/77。

如实降级：模式粒度是「命令头前缀」一档（PRD 例子 `cargo *` 的形态），不支持
多 token 复合模式（如 `git commit *`）与参数级规则；需要更细粒度时用「本会话
始终允许」（工具级）或逐次审批。

---

## 附带修复（本块 E2E 过程中抓到并修掉）

- PiProcess exit 结算对监听器异常免疫（见模块 2，防 stop() 永久挂起）。
- 计划先行开关受控竞态：点击后 React 以旧 planView 重置勾选——App 改为乐观
  更新 + 新建会话即预取计划视图。
- 桌面旧文案修正：状态栏与 YOLO 提示不再谎称「审批拦截下一块接入」（控制簇
  已落地），竖切测试的对应断言同步更新。
