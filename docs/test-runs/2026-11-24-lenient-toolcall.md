# 第九块测试记录：宽容工具调用解析 + 真模型验收收官（2026-11-24）

## 结论先行

- **真任务验收通过**：`npm run test:local-model` 以 **qwen2.5-coder:3b**
  重跑（断言规格一字未改），第 2 次尝试全链走通——submit_plan 裁决
  落盘 → 按计划建文件并逐字核对 → 改一行 → 检查点回滚恢复（verified）
  → 账本 2 笔、金额按单价快照折算。**落盘 / 回滚 / 账本至此取得真
  模型证据**（此前只有桩回归证明）。证据：
  `tests/local-model/last-run-evidence.json`（通过轮次）。
- **0.5B 附带验收未通过**（如实）：尝试 1/2 臆造清单外工具
  `create_file` 并跳过 submit_plan，解析器按规则拒绝凭猜转换；
  尝试 3 prompt 20 分钟超时。属模型能力上限，非格式问题。
  证据：`tests/local-model/last-run-evidence-0.5b.json`。
- **桩模式全量回归 119/119 全绿**（node 104/104 + 桌面 E2E 15/15），
  = 基线 93 + 本块新增 26（解析器 18 + 代理 4 + 安全通路 E2E 3 +
  记账时序 1），只增不减、无破坏。

## 1. 选层与理由

选 **(a) agent-host 托管的本地 OpenAI 兼容代理**：

- Pi（runtime/ 钉版 1.6.0）经 openai-completions 发请求，只认响应里
  的原生 `tool_calls`；其扩展机制只能在 Pi 解析出调用后钩 `tool_call`
  事件，**没有合法注入点**能把文本变成调用——候选 (b) 不成立。
- 代理是唯一不 patch Pi 本体、又能让转换出的调用与原生调用走完全
  相同通路的落点：转换发生在 HTTP 响应层，进入 Pi 后就是原生
  tool_calls，审批门与计划门（都钩 Pi 内 tool_call 事件）一视同仁
  （§4 E2E 实证）。
- 实现：`apps/agent-host/src/lenient-proxy.ts`。Pi 指向代理、代理转发
  上游（Ollama）；代理强制上游 `stream:false` 取回完整响应，仅当
  choice 无原生 tool_calls 时才对 content 跑解析器转换，再按 Pi 原始
  请求的 stream 标志合成 SSE / JSON 返回。原生 tool_calls 存在时零
  介入；上游非 2xx 原样回传；网络错误回 502 显形。
- 托管接线：AgentHost 新增配置开关 `lenientProxy`（默认关、严格
  校验）。start 时为 models.json 中**回环** openai-completions
  provider 启动代理并改写 baseUrl（改写前原文存 sidecar
  `<piAgentDir>/lenient-proxy.json`），改写结果经公开面
  `lenientProxyRoutes` 可查（不静默改写）；close 时还原原文并删
  sidecar；崩溃残留 sidecar 时下次 start 先自愈还原再重新接线。
  非回环 provider 永不代理（不拦截远程流量）。桌面端仅本地真模型
  模式开启（`lenientProxy: localMode`），桩/普通模式零影响；桌面
  本地模型默认值已由 0.5b 改为 **qwen2.5-coder:3b**。

## 2. 解析规则（lenient-parser.ts，纯函数）

- 候选段三类：```json / ``` 围栏块、`<tool_call>` 段、裸 JSON。
  裸 JSON 的确定性口径：全文仅由顶层 JSON 对象（可多个首尾相接）
  或一个对象数组构成、对象外只有空白时才逐个判定；混入任何说明
  文字则裸对象一律不转（围栏有定界符，不受此限；段内多对象/数组
  整段全有或全无）。顶层对象扫描为字符串/转义感知的平衡括号扫描，
  字符串内的大括号不计数（A18 实证内容逐字保真）。
- 调用形态：`{name, arguments}` / `{function: 名或{name,arguments}}`；
  arguments 可为对象或 JSON 字符串。工具名必须在**当前请求**的工具
  清单内（代理从请求体 tools 提取清单与 schema），未知工具名一律
  忽略不报错、原文保留。
- 「模式回声」清洗：参数值是只含 schema 元键（type/description/
  value/…）且带 `value` 的对象、且该参数期望类型非 object 时解包
  （最多 2 层）；只有 type/description 而无 value → 无法确信分离，
  **拒绝整个候选**，绝不凭猜执行。清洗后按 schema 做 required
  齐全 + 声明类型核对，不符拒绝。转换后的参数仍过 Pi 内工具自身
  校验与两道门。

## 3. 单测与代理直测（22 条，全过）

- 解析器 A1–A18：裸单对象、围栏块、`<tool_call>` 段、arguments
  字符串、回声带 value 解包、回声无 value 拒绝、畸形 JSON 忽略、
  未知工具忽略、多围栏块、合法+未知混合、带说明文字的裸 JSON
  不转、required 缺失/类型不符拒绝，以及本块实证新增形态 A13–A18
  （首尾相接多对象、多对象含未知工具、对象间夹文字不转、顶层
  数组全有或全无、围栏内多对象、字符串内大括号保真）。
- 代理 B1–B4：非流式转换（tool_calls/arguments/content/
  finish_reason/转换头 `x-baimo-lenient-converted`）、流式 SSE
  拼合还原、原生 tool_calls 零介入透传（无转换头）、回声缺
  value 无转换。

## 4. 安全通路断言（E2E 3 条，全过）

经 AgentHost + 真 Pi + 两道门 extension，被测模型为「小模型行为」
fixture（只吐文本调用），`lenientProxy: true`：

- **C1 计划裁决**：文本 submit_plan 经转换后，裁决 select 出现时
  计划已落盘 `awaiting_approval`（事前计划）；批准后逐步执行、
  文件落盘、计划 status=completed。与原生调用同一通路。
- **C2 计划门硬拦**：不交计划的文本 write 在 tool_call 层被拦
  （tool_execution_end isError、含「计划先行」），文件不存在。
- **C3 审批门拦截**：文本危险 bash（`rm -rf …`）经转换后照样弹
  审批卡（payload tool/danger/command 核对），拒绝后命令未执行、
  目标目录仍在、拒绝理由回送模型。

## 5. 真任务验收历程（3B，三轮重跑）

断言规格全程未动（验收文件仅 setup 接线加 `lenientProxy: true` 与
一句注释，git diff 已逐行核对）。三轮重跑各推进一格：

| 轮 | 结果 | 卡点与处置 |
|---|---|---|
| 1 | 未过 | submit_plan 已转换、裁决已发生（planSelects=1、awaiting_approval）——前两块的老墙已破；但获批后模型把 plan_progress+write 写成**首尾相接的裸 JSON 多对象**，旧「全文单对象」口径转不了 → 解析器按 §2 口径扩展（A13–A18），确定性不降 |
| 2 | 未过 | 尝试 2 全程走通至回滚（verified=true），仅栽在账本只落 1 笔 → 定位宿主记账时序竞态并修复（§6），尝试 1/3 则卡阶段 B 模型只回文字 |
| 3 | **通过** | 尝试 1 仍卡阶段 B（模型零调用、纯文字收尾）；**尝试 2 全链通过** |

通过轮次（尝试 2）逐步证据：

- 阶段 A（73.6s）：工具序列 submit_plan → plan_progress → write →
  plan_progress ×3；裁决时 planAtSelectStatus=awaiting_approval；
  greeting.txt 内容与规格逐字一致；计划 completed。
- 阶段 B（62.8s）：submit_plan → plan_progress → edit →
  plan_progress ×2；第二行改 version: 2、逐字一致。
- 阶段 C 回滚：restored=[greeting.txt]、verified=true、
  mismatches=[]，文件逐字恢复 V1。
- 阶段 D 账本：**2 笔齐全**，tokens 为真实计数（total 8043 /
  7425），金额按名义单价快照折算（$0.224435 / $0.200755，
  price={input 150, output 200, cacheRead 15, cacheWrite 150})。

性能：通过轮次全程（测试总时长）301.8s（含尝试 1 的 163s）；
3B 生成速度沿用补验实测 6.3 tok/s（热机）。证据文件每次运行会被
覆盖，通过轮次版本已随本记录提交；0.5B 证据另存独立文件。

## 6. 附带修复：宿主记账时序（真缺陷，非验收特调）

旧实现在 `agent_settled` 里把记账 `void` 异步甩出（记账还要再发
一次 RPC 取 stats 才落盘），与本轮 prompt 的 resolve 竞态：调用方
在 prompt 返回后紧接着同步读账会丢账——桌面端结算后即时读账同样
中招。修复：结算处理先定 outcome，**记账落盘完成后才 resolve**
（记账内部失败仍落 lifecycle `cost_accounting_failed` 显形）。
钉住测试 D1（桩模型连跑两轮、逐轮 resolve 后即时读账断言条目
已在账）已并入回归。验收证据里各尝试 phase A 的 costError
（「等待 costRecorded 超时」）是测试自身 60 秒预启动计时器在慢
模型长 prompt 下的既有伪影，与落账无关（阶段 D 实读账本为准）。

## 7. 0.5B 附带验收（如实未通过）

`BAIMO_LOCAL_MODEL_ID=qwen2.5-coder:0.5b` 同一条验收，总耗时
约 21 分钟：尝试 1/2 均臆造清单外工具 `create_file`（路径/内容
语义全对）且不交计划——解析器按「未知工具名不转、绝不凭猜」
拒绝，planSelects=0，卡在第一条断言；尝试 3 prompt 20 分钟
超时（模型长文本循环）。结论：宽容解析解决的是**格式**问题，
0.5B 的**工具名幻觉与任务规划**不在其射程，未做任何映射放水。

## 8. 如实降级 / 已知边界

- 3B 并非每试必过：阶段 B 模型偶发只回文字（含一次臆造
  `<tool_response>` 自我批准的文本），解析器无米下锅；通过依赖
  验收内建的 3 次尝试（本轮用掉 2 次）。这是小模型稳定性边界，
  不粉饰为「稳定可用」。
- 代理为取完整响应强制上游非流式：生成期间界面无逐字流式
  （整轮生成完一次到达），本地慢模型下体感延迟明显；换取的是
  转换确定性。原生 tool_calls 的云端 provider 不经此代理、
  不受影响。
- 代理只覆盖回环 openai-completions provider；其他 api 形态
  （anthropic-messages 等）与远程端点不在本块范围。
- 模式回声清洗只处理「带 value 的元键包装」一种已证形态；
  无 value 的回声一律拒绝转换（B4/A6 实证），模型在该形态下
  仍会卡住——保守优先于猜测执行。
- 桌面本地模型默认值改 3B 后，0.5B 仍可经 env 指定；验收
  默认模型本就是 3B，未动。

## 9. 提交

| 提交 | 内容 |
|---|---|
| `cc0f9b2` | 单元 1：解析器 + 代理 + index 导出 |
| `645e9c5` | 单元 2：AgentHost 托管接线（开关/改写/还原/自愈）+ 桌面默认 3B + 验收 setup 接线 |
| `c56ed47` | 单元 3：小模型 fixture + 测试 19 条（解析/代理/安全通路） |
| `99fbf92` | 单元 4：解析器扩展首尾相接多对象/数组形态 + A13–A18 |
| `1e914f5` | 单元 5：宿主记账时序修复 + D1 |
| （本提交） | 本测试记录 + 通过轮次证据 + 0.5B 证据 + 接入文档对齐 |
