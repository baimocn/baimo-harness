# 第七块测试记录：本地真模型接入与实跑验收（2026-11-24）

## 结论先行

- **接入完成**：Ollama 0.40.17 用户态安装、本机回环端点、Pi provider
  `ollama` 接线（宿主 models.json + 桌面 env 切换、与桩并存）全部落地。
- **真任务验收未通过**：实际模型 **qwen2.5-coder:0.5b**（用户最终拍板
  的 0.5B 尺寸）在 3 次尝试内始终无法发出一次可解析的工具调用——
  全链路卡在第一步 submit_plan，下游（落盘/检查点/回滚/账本）未触达。
  模型原始输出见 §5，未用桩或人工代答冒充。
- **桩模式全量回归 93/93 全绿**（node 78/78 + 桌面 E2E 15/15），基线无损。

## 1. 环境实测

| 项 | 实测 |
|---|---|
| CPU | AMD EPYC 9D25，宿主可见 4 核；本 cell 配额 1.5 核 |
| 内存 | 宿主 7.7GiB；本 cell 共享上限 6GiB（进程 RSS 总量低，无压力） |
| 磁盘 | 150G 总量、147G 可用 |
| OS / Node | Ubuntu 24.04.5 LTS / Node v24 |

## 2. 选型沿革（如实）

1. 任务书首选 Qwen2.5-Coder-3B：Ollama 包下载后，模型拉取至 822MB 时
   用户改选型，拉取中止（未注册、未使用）。
2. 用户改选「0.5B 的 DeepSeek」：核实 DeepSeek 官方无 0.5B，Ollama 上
   最小为 deepseek-r1:1.5b；其拉取同样按后续指示中止（未使用）。
3. **用户最终拍板：qwen2.5-coder:0.5b**——本记录全部实跑均用此模型。

## 3. 运行时安装

- 官方 `ollama-linux-amd64.tgz` 直链已 404；改用 GitHub Releases 的
  `ollama-linux-amd64.tar.zst`（1,545,470,208 字节，下载约 6 分 48 秒，
  链路限速约 2.4MB/s）。
- 系统无 zstd 二进制：用 Node 24 自带 `zlib.createZstdDecompress`
  解压（得 tar 2,535,106,560 字节），装至 `~/.local/ollama`。
- 版本 **Ollama 0.40.17**；`OLLAMA_HOST=127.0.0.1:11434 ollama serve`，
  `ss` 实证只监听 127.0.0.1:11434。
- 模型 `qwen2.5-coder:0.5b`：397MB（Q4 量化），ID `4ff64a7f502a`。

## 4. 冒烟（直连端点，未经 harness）

- 普通对话：正常。模型加载 3.7s；生成 **16.7 tok/s**（80 token 上限探针）。
- 工具调用探针（同一题：调用 write_file 写 hello.txt）共 4 次：
  - 采样默认：/v1 与原生 /api/chat 均返回 ```json 代码块纯文本，
    参数名漂移（`file` / `file_path`+`file_content`），`tool_calls` 为空；
  - temperature 0（×2，确定性一致）：JSON 语义**完全正确**
    （name 与 path/content 参数名全对），但仍是纯文本、无 `<tool_call>`
    包裹，Ollama 解析结果 `tool_calls=null`。
- 模型模板本身含 `# Tools` 段且要求 `<tool_call>` 格式（运行时支持
  解析）——失败属模型对输出格式的遵循能力不足，不是端点问题。

## 5. 真任务端到端验收（harness 真实链路）

命令：`npm run test:local-model`（env 门控测试
`tests/local-model/acceptance.test.mjs`，证据
`tests/local-model/last-run-evidence.json`）。
链路配置：计划模式 required + 审批门 build 模式；pricing 给
`ollama/qwen2.5-coder:0.5b` 设名义测试单价（input $150 / output $200
每 1M tokens）；检查点按桌面同口径 run_start/run_settled 自动打点。
任务：建 greeting.txt（三行定稿）→ 改第二行 → 回滚 → 账本核对。

3 次尝试（措辞递进，规格不变），**全部卡在同一步**：
计划裁决从未发生（planSelects=0），真实工具执行 0 次（allTools=[]）。

| # | 格式提示 | 耗时 | 模型原始输出（摘要） |
|---|---|---|---|
| 1 | 无 | 28.5s | 直接臆造工具 `create_file` 的 ```json 代码块（路径、内容全对），完全跳过 submit_plan |
| 2 | 简版格式提示 | 6.4s | 与 #1 逐字相同（temperature 0 确定性），提示无效 |
| 3 | 强提示 + `<tool_call>` 示例 | 23.7s | 改口调用 `submit_plan` 且步骤结构合理，但仍以 ```json 代码块纯文本输出，未用 `<tool_call>` 包裹 |

下游结论：落盘、检查点回滚、账本记账在本模型下**未取得真跑证据**
（第一步未过，后续阶段未执行）。这些机制本身已由桩回归 93/93
覆盖证明；本块不以此冒充真模型验收通过。
`npm run test:local-model` 当前状态为 **1 条失败**（断言停在
「裁决时计划应已落盘为 awaiting_approval」），即失败的可执行记录，
换更强模型或运行时解析层有变化时可直接重跑。

旁证：Pi 单轮请求 prompt 约 1978 tokens，Ollama 日志 `truncated=0`
——上下文未截断，排除窗口不足因素。

## 6. 性能

| 项 | 数值 |
|---|---|
| 模型加载 | 约 3.7s（首次请求） |
| 生成速度 | 16.7 tok/s（0.5B Q4，1.5 核配额） |
| 验收三轮耗时 | 28.5s / 6.4s / 23.7s（含 Pi 进程启动与多轮请求） |
| 验收总时长 | 约 63s |

## 7. 零遥测旁证

验收窗口内以 2 秒间隔 `ss` 采样：未见 ollama / Pi 进程的非回环
ESTABLISHED 连接；Ollama 服务日志全部请求来源为 127.0.0.1。
（正式 K-04 抓包回归仍在桩模式回归套件内常驻，本块 93/93 含之。）

## 8. 回归

`npm run test:regression`：node **78/78** + 桌面 E2E **15/15**
= **93/93 全绿**，与第六块基线一致，桩模式原样保留
（本地模型靠 env/配置切换，不进默认回归）。

## 9. 提交

| 提交 | 内容 |
|---|---|
| `d8f0c29` | 桌面本地真模型模式接线（env 注入 ollama provider，与桩并存可切换） |
| `31b1c03` | 本地真模型全链路验收测试（env 门控）+ test:local-model 脚本 |
| `42a33a4` | 默认模型改 qwen2.5-coder:0.5b + docs/local-model.md |
| `856a43b` | 验收精修：temperature 0、格式提示递进、原始输出证据采集 |
| （本提交） | 本测试记录 |
