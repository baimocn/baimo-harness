# 第七块补验记录：换 Qwen2.5-Coder 3B 重跑真任务验收（2026-11-24）

## 结论先行

- **真任务验收仍未通过**：实际模型 **qwen2.5-coder:3b**（用户改拍），
  与 0.5B 完全相同的卡点——3 次尝试内 `submit_plan` 始终以 ```json
  代码块纯文本输出，从未发出一次可解析的工具调用（planSelects=0、
  allTools=[]），全链路卡在第一步；下游（落盘/检查点回滚/账本）
  未触达、未取得真跑证据。未换其他模型、未人工代答。
- **桩模式全量回归 93/93 全绿**（node 78/78 + 桌面 E2E 15/15），
  与第八块（视觉打磨）收尾后的基线一致，只增不减、无破坏。
- 本块附带修复一处测试自身缺陷：`waitCostRecorded` 60 秒超时拒绝
  在慢模型首轮 prompt 在飞时无人处理、直接崩溃测试进程（见 §4）。

## 1. 模型与运行时

| 项 | 实测 |
|---|---|
| 模型 | qwen2.5-coder:3b，1,929,912,626 字节（约 1.93GB） |
| 量化 / 参数 | Q4_K_M / 3.1B，digest `f72c60cabf62` |
| 运行时 | Ollama 0.40.17（用户态 `~/.local/ollama`），只监听 127.0.0.1:11434 |
| 拉取 | `ollama pull qwen2.5-coder:3b`，约 3.8 分钟完成 |
| 环境 | 同第七块：cell 配额 1.5 核 / 6GiB，磁盘充足 |

## 2. 并行避让（如实）

本块与第八块（视觉打磨）同仓并行。按避让纪律：打磨收尾前
（判据 = 其测试记录提交出现且工作区干净）只做不碰仓库的工作——
拉模型、/tmp 探针脚本冒烟、只读监控 git 状态。打磨块于
02:49:31 UTC 提交收尾记录（`7707bfa`）、02:49:38 UTC 提交回归
重拍（`42e3551`），工作区归洁；本块监控等待约 30 分钟，未触发
90 分钟说明线，此后才动仓库。本块回归重拍刷新的 25 张截图已
`git checkout` 还原，未混入本块提交。

## 3. 冒烟（直连端点，未经 harness）

探针脚本放 /tmp（两支：对话+工具、热机复测+system 口径工具），
原始输出转录如下（脚本本体后被环境回收，见 §4 注）。

- 普通对话：正常。冷启动（与打磨块并行争抢期）加载 30.26s、
  生成 2.9 tok/s；热机复测加载 0s、prompt_eval **36.2 tok/s**、
  生成 **6.3 tok/s**。
- 模板核查：`/api/show` 确认 capabilities 含 `tools`，聊天模板含
  `<tools>` 段且明文要求以 `<tool_call>{...}</tool_call>` 返回、
  「NO other text. Do not include any backticks」——运行时支持解析。
- 工具调用探针共 4 发（同一题：调用 write_file 写 hello.txt），
  **全部未被解析**（`tool_calls=null`）：
  - 原生 /api/chat、temperature 0：输出裸 JSON，且参数值呈
    「模式回声」形态（把 schema 的 type/description 结构与值揉在一起）；
  - 原生 /api/chat、默认采样：同上；
  - /v1/chat/completions（Pi 实际口径）、temperature 0：同上；
  - 原生 /api/chat + system 明示须用 `<tool_call>`、temperature 0：
    改以 ```json 代码块输出，参数仍呈模式回声形态。
- 定性：与 0.5B 同类失败——模型未遵循模板的 `<tool_call>` 输出
  规范，非端点/模板缺失问题。

## 4. 首跑事故与测试缺陷修复（如实）

首跑于 02:50:25 UTC 启动（打磨刚收尾）：证据文件只剩裸 attempt
（startedAt 03:36 前的那份：startedAt 02:50:25、finishedAt
02:51:25，attempt 1 无 phases/error/rawAssistant）。定位：
阶段 A 的 `waitCostRecorded(session)` 在 prompt 发出**之前**就
启动 60 秒计时；3B 首轮迟迟不结算，60.6 秒时该 promise 超时
拒绝且无人处理 → Node 未处理拒绝直接杀死测试进程，after 钩子
只来得及写下裸证据；进程树随后挂死，约 44 分钟后被运行环境
SIGTERM 收走。Ollama 服务亦在此次环境回收中死掉，后以
`setsid nohup` 方式重启恢复（0.40.17、两模型俱在）。

修复（提交 `fe71033`，规格断言一字未动）：
- `costA`/`costB` 创建后立即预挂 no-op catch，拒绝留待后续
  `await ...catch(...)` 正常观察并记 costError；
- 验收默认模型按用户改拍切至 `qwen2.5-coder:3b`（文件头沿革
  已注明），`docs/local-model.md` 同步对齐。

注：/tmp 在该次环境回收中被清空，§3 探针脚本原件丢失，输出
已在当时完整转录（即本节与 §3 所据），后续正式重跑的证据在
仓库内证据文件中完好。

## 5. 真任务端到端验收（正式重跑，harness 真实链路）

命令：`npm run test:local-model`（默认模型已切 3B，其余与第七块
同口径：计划模式 required + 审批门 build、名义测试单价、检查点
桌面同口径打点）。运行 03:36:31 → 03:39:10 UTC，测试
duration 160.2s，结果 **fail 1**。证据：
`tests/local-model/last-run-evidence.json`（本提交内）。

3 次尝试（测试内建措辞递进，规格不变），**全部卡在同一步**：
计划裁决从未发生（planSelects=0），真实工具执行 0 次。

| # | 格式提示 | 阶段 A 耗时 | 模型原始输出（摘要） |
|---|---|---|---|
| 1 | 无 | 120.4s | submit_plan 以 ```json 代码块输出：name 与两步计划（创建文件 greeting.txt、核对内容）全对，无 `<tool_call>` 包裹 |
| 2 | 简版格式提示 | 19.7s | 与 #1 同形态（JSON 语义全对、纯文本） |
| 3 | 强提示 + `<tool_call>` 示例 | 15.7s | 仍以 ```json 代码块输出 submit_plan，语义全对，未用 `<tool_call>` |

断言停在「裁决时计划应已落盘为 awaiting_approval」——与 0.5B
首轮同一断言点。下游结论：落盘、检查点回滚、账本记账在本模型
下**未取得真跑证据**（第一步未过，后续阶段未执行）；这些机制
本身已由桩回归 93/93 覆盖证明，本块不以此冒充真模型验收通过。

旁注：尝试 1 的 costError 为「等待 costRecorded 超时」（120s
阶段内未及结算记账，属 §4 同源的慢模型时序问题，修复后已不
再崩溃、如实记录）；尝试 2/3 无 costError。

## 6. 性能

| 项 | 数值 |
|---|---|
| 模型加载 | 冷启动 30.26s（打磨并行争抢期，仅供参考）；热机 0s |
| 生成速度 | 6.3 tok/s（热机，3B Q4，1.5 核配额） |
| prompt_eval | 36.2 tok/s（热机短 prompt） |
| 验收三轮阶段 A | 120.4s / 19.7s / 15.7s（首轮含模型加载与长 prefill） |
| 验收总时长 | 160.2s（不含 build） |

## 7. 回归

`npm run test:regression`：node **78/78** + 桌面 E2E **15/15**
= **93/93 全绿**，与第八块收尾基线一致。桩模式原样保留，
本地模型仍靠 env/配置切换、不进默认回归。

## 8. 如实降级 / 未动项

- 真任务未通过即本块核心结论（见 §5），不做任何粉饰。
- 桌面应用 env 默认模型（`apps/desktop/src/main/main.ts` 的
  `BAIMO_LOCAL_MODEL_ID` 缺省）仍为 qwen2.5-coder:0.5b，本块
  未动；桌面侧可经 env 直接指定 3B。本块只切验收配置。
- 后续若再验真模型：需换在 Ollama 路径下能稳定按 `<tool_call>`
  规范输出的模型，或运行时解析层支持裸 JSON 工具调用时，
  直接重跑同一条验收即可（测试已是可执行记录）。

## 9. 提交

| 提交 | 内容 |
|---|---|
| `fe71033` | 验收默认模型切 3B + 修 waitCostRecorded 未处理拒绝 |
| （本提交） | 本补验记录 + 本轮证据 + docs/local-model.md 对齐 |
