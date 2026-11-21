# 阶段 2 · 控制簇测试记录（2026-11-21）

范围：模块 1 会话续接+停止、模块 2 Git 检查点（M-06）、模块 3 真实 edit diff、
模块 4 权限模式与分级审批（M-02）。规矩：每模块做完立即跑该模块 E2E +
全量回归，全绿才进下一个模块。截图在 `assets/2026-11-21-stage2-control/`。

## 总结果

| 阶段 | node 套件 | 桌面 E2E | 结论 |
|---|---|---|---|
| 基线（本块开始前） | 28/28 | 2/2 | — |
| 模块 1 后 | 30/30 | 4/4 | 全绿 |
| 模块 2 后 | 34/34 | 5/5 | 全绿 |
| 模块 3 后 | 35/35 | 6/6 | 全绿 |
| 模块 4 后（最终） | **40/40** | **7/7** | **全绿（合计 47 条）** |

每模块一个 git 提交：`2a0b35b`（M1）、`843c4b6`（M2）、`26bb3ed`（M3）、
模块 4 与本记录同提交。

## 模块 1 · 会话续接 + 停止

- 实现：每会话独立 `--session-dir` 落盘 Pi 会话文件；`AgentHost.resumeSession()`
  以 `--session <file>` 重新挂接；无 Pi 会话文件的旧会话抛类型化错误
  `SESSION_NOT_RESUMABLE` 大声拒绝。停止走 RPC `abort`：宿主以 abortRequested
  标记结算，落盘 lifecycle 为 `run_stopped`、prompt 以 disposition `"aborted"`
  结算，绝不冒充 `run_settled`。界面：历史会话「继续会话」键、运行中发送键变
  停止键；完成/停止标记只由 lifecycle 记录驱动（与回放同口径，顺带修掉回放
  双标记）。
- E2E（+3 宿主 / +2 桌面 / UI 单测 +1）：换新宿主实例续接后，第二轮模型请求
  同时带第一轮 prompt 与第一轮工具结果（上下文真续上）；hang 桩下 abort 约
  20ms 响应、运行以已停止收尾、落盘一致、会话仍可用。
- 探针实证：Pi 在 abort 后仍发 `agent_end`+`agent_settled`，故「已停止」只能
  靠宿主标记区分，不能看 settled 事件本身。

## 模块 2 · Git 检查点（M-06）

- 实现：`packages/core` 的 `CheckpointStore`。快照 = sha256 清单 + 文件内容
  拷贝，存数据目录 `checkpoints/<sessionId>/<checkpointId>/`，**不进用户仓库**
  （PRD 标题为「Git 检查点」，但任务约束「不污染用户仓库」优先，故不用
  git 对象/分支实现——此为有意取舍，在此明示）。触发：运行开始、运行结算
  （无变化自动去重）、手动打点、回滚前自动快照；YOLO 开启前快照在模块 4
  接入（trigger `yolo_start`）。跳过类（`.git`、`node_modules`、符号链接、
  >5MiB 文件）记录在清单 `skipped` 里显形，回滚绝不碰。回滚恢复改动文件、
  重建被删文件、删除新建文件、清理空目录，并逐文件哈希复验出报告。
- 界面：检查点页签换真实快照列表（手动打点/逐条回滚）；diff 卡「回滚」改为
  经**最近检查点**的真实单文件恢复，成功才落「已回滚」标记（PRD 的逐 diff
  对应检查点语义本块以最近检查点近似，见局限）。
- E2E（+4 core 单测 / +1 桌面）：v1 → 跑一轮打点 → 外部改 v2 → 再跑打点 →
  回滚最旧快照 → 断言文件内容回到 v1 且校验通过；工作区零新增文件
  （快照只落数据目录）实证。截图 `m2-checkpoints-panel.png`。

## 模块 3 · 真实 edit diff 实跑

- 实现：桩 fixture 扩展剧本——最后一条用户消息含 `[[stub:write]]` /
  `[[stub:edit]]` / `[[stub:bash-danger]]` 时第一轮改发对应工具调用；
  轮次判定改为「最后一条用户消息之后是否有 tool 结果」（多轮脚本成立，
  既有单轮行为不变）。edit 用 Pi 现行参数形态 `edits: [{oldText, newText}]`。
- E2E（+1 宿主 / +1 桌面）：宿主层断言 write/edit 工具事件与磁盘内容逐字
  一致；桌面断言 diff 卡 `+ stub line alpha/beta`、`- line two / + line TWO`
  与桩改动逐行一致，改动页签列出两文件。截图 `m3-real-diff.png`。

## 模块 4 · 权限模式与分级审批（M-02，本块核心）

### 机制（实证，非假拦截）

一句话：**审批门是跑在 Pi 进程内的扩展（`apps/agent-host/extensions/approval-gate.mjs`，
经 `--extension` 挂载），在 `tool_call` 事件上按策略文件裁决；需要审批时经
`ctx.ui.select` 的 RPC 阻塞往返（`extension_ui_request` → 宿主路由到界面
审批卡 → `extension_ui_response` 回注）等用户裁决，拒绝即
`return { block: true, reason }`，工具根本不执行、理由作为工具结果回到 agent。**

- 策略通道：每会话一份 JSON 策略文件（数据目录 `approval/<key>.json`，
  key 落盘在壳层设置里），扩展**逐次 tool_call 现读**——界面切换模式即时
  生效，含运行中的会话；「本会话始终允许」由扩展把工具名追加进策略文件
  `grants` 落盘，进程重启/会话续接后仍有效。
- 分级：只读工具（read/grep/find/ls）与只读 bash 恒放行；写类 = write/edit
  等文件工具 + 变更型/危险 bash。
  - 计划：写类一律 block + notify 显形，不弹卡。
  - 编辑：写类弹卡（允许一次 / 本会话始终允许 / 拒绝）；已授权工具免问；
    危险命令不被授权豁免。
  - 构建：普通写自动过；危险命令清单（rm -rf、git reset --hard、
    git clean -f、sudo、chmod/chown 777、mkfs、dd of=/dev/、关机类、
    curl|sh、写块设备）弹卡。
  - YOLO：全自动（见局限 2）。
- 审批卡（PRD 禁止盲签）：工具名 + 全参数 JSON 原文 + 理由位
  （「命中危险命令清单」/「编辑模式：写操作需审批」）+ 危险标记。
- 超时：`ctx.ui.select` 带 5 分钟 timeout，Pi 侧自动以 undefined 结算，
  扩展按拒绝处理并显形（不会无限挂死，也不会超时默认放行）。
- 审批/拦截全程落盘：请求与裁决进会话事件日志（rpc_event +
  `extension_ui_responded` lifecycle），可回放审计。
- YOLO 前置快照（M-06）：切换到 YOLO 时主进程强制打一张 `yolo_start`
  快照（且每轮运行开始本来就自动打点），失败经 checkpoint:error 显形。

### E2E（+5 宿主 / +1 桌面）

- 宿主逐模式：计划（write 与危险 bash 均拦、文件未变、理由回到 agent、
  notify 显形）；编辑（拒绝→不执行且理由回 agent；允许一次→落盘；
  本会话始终允许→第二次免问且 grants 已落盘）；构建（普通写无请求自动过；
  危险 bash 弹卡、payload danger=true、拒绝后无成功执行记录）；YOLO
  （write 与危险 bash 零请求全自动、危险 bash 真实执行成功）。
- 桌面单会话逐模式切换实测同一条链路（含审批卡截图
  `m4-approval-card-edit.png`、`m4-approval-card-danger.png`、计划拦截
  `m4-plan-blocked.png`）。

### 局限与降级（如实记录）

1. **三级授权只做了两级**：PRD M-02/D-01 的第三级「按命令模式永久允许」
   （`cargo *` 式模式语法）本块未做 UI 与匹配引擎；已落地的两级
   （仅本次 / 本会话）中「本会话」按**工具名**粒度并落盘跨续接有效。
   D-01 验收中「对 `cargo *` 永久允许、重启后免问」一条未达，留待后续块。
2. **YOLO 与 PRD 的一处张力**：PRD M-02 写「危险命令任何模式下二次确认」，
   本块按任务书口径实现 YOLO 全自动（危险命令也不弹卡）；YOLO 的预算
   熔断在下一块，本块只留了策略文件与模式通道接口。开启 YOLO 前有强制
   快照兜底。
3. **计划模式的 bash 变更判定是启发式**（命令头清单 + 重定向检测），不是
   沙箱：`python -c` 写文件这类形态不在清单内，可能漏拦。文件工具
   （write/edit）是硬拦截，无此问题。
4. **Pi 先发 `tool_execution_start` 再过门**：被拦的调用在事件流里有
   start、end 以 `isError=true` 收尾且结果为拦截理由；界面工具卡据此
   呈现失败态。判「未执行」的依据是 end 的 isError + 文件系统状态，
   本块 E2E 均按此断言。
5. 非审批门来源的扩展对话框请求（confirm/input/editor 等）本块不渲染
   通用对话框：一律回 `cancelled: true` 并成条显形，防 Pi 挂死。

## 备注

- 模块 3 开发中曾因新测试误用不存在的宿主 API（`host.stopAll`）导致
  进程未关、整套回归挂死被超时杀掉一次；定位后改用 `host.close()` 并
  给回归命令加了硬超时。已修复，与最终结果无关，特此留痕。
