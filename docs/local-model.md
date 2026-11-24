# 本地真模型接入（第七块）

白墨 Harness 除桩模型外，可接一个**只在本机回环地址推理**的真实开源
模型做实跑：运行时 Ollama；首轮接入 Qwen2.5-Coder 0.5B（用户拍板的
0.5B 尺寸，Q4 量化），补验换 Qwen2.5-Coder 3B（Q4 量化）——验收测试
的默认模型已切至 3B，两模型均已拉取到本机。全程不需要任何 API key，
请求不离开本机。

## 运行时（用户态安装）

```bash
# 官方 tarball 现为 zstd 包（.tgz 链接已 404），解到 ~/.local/ollama
curl -fL -o ollama.tar.zst \
  https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst
mkdir -p ~/.local/ollama && tar --zstd -xf ollama.tar.zst -C ~/.local/ollama

# 只监听回环，后台启动
OLLAMA_HOST=127.0.0.1:11434 ~/.local/ollama/bin/ollama serve

# 拉模型（0.5B 约 0.4GB；3B 约 1.9GB）
~/.local/ollama/bin/ollama pull qwen2.5-coder:0.5b
~/.local/ollama/bin/ollama pull qwen2.5-coder:3b
```

验收实测数据（VM 1.5 核 / 6GB 档）见
`docs/test-runs/2026-11-24-local-model.md`。

## 桌面应用切换到本地模型

与桩模式同口径，靠 env 注入（`apps/desktop/src/main/main.ts`）：

```bash
BAIMO_LOCAL_MODEL_URL=http://localhost:11434/v1 \
BAIMO_LOCAL_MODEL_ID=qwen2.5-coder:3b \
  <启动桌面应用>
```

`BAIMO_LOCAL_MODEL_ID` 缺省即 qwen2.5-coder:3b（第九块起）；0.5B
仍可经该 env 指定。本地模式下宿主自动开启宽容工具调用代理
（见下节），models.json 里的回环端点会被临时改写指向宿主代理、
宿主关闭时还原，用户无需手动配置。

启动时主进程把 provider `ollama` 写进 Pi 的 `models.json`
（`api: "openai-completions"`、占位 key `ollama`，端点忽略它），
模型出现在选择器里（标签「qwen2.5-coder:0.5b（本地真模型）」），
与桩条目可并存切换。不设 env 时行为与之前完全一致。

宿主层等价写法就是测试 fixture 的形状：往
`<dataDir>/pi-agent/models.json` 写同一个 providers 对象，
开会话时 `--provider ollama --model qwen2.5-coder:0.5b`。

## 成本账本

本地推理没有 API 账单。账本要验证金额折算时，可在
`<dataDir>/cost/pricing.json` 给 `ollama/qwen2.5-coder:0.5b` 设一个
**名义测试单价**（验收用 input $150 / output $200 每 1M tokens）；
不设则按未定价口径记账（cost=null、tokens 照记），不会冒充 0 元。

## 验收测试（env 门控，不进默认回归）

```bash
npm run test:local-model
# = BAIMO_LOCAL_MODEL=1 node --test tests/local-model/*.test.mjs
```

覆盖：计划批准 → 建文件 → 改一行 → 检查点回滚 → 账本核对，
证据写 `tests/local-model/last-run-evidence.json`。
未设 `BAIMO_LOCAL_MODEL=1` 时整套跳过，默认回归不依赖模型是否已下载。
默认模型为 `qwen2.5-coder:3b`（`BAIMO_LOCAL_MODEL_ID` 可覆盖）。
实跑结论如实：0.5B 首轮与 3B 补验均未通过——两模型都把 submit_plan
写成 JSON 纯文本、从未发出可解析的 tool_call，全链路卡在第一步；
见 `docs/test-runs/2026-11-24-local-model.md` 与
`docs/test-runs/2026-11-24-local-model-3b.md`。

## 宽容工具调用解析（第九块）与收官结论

小模型把工具调用写成 JSON 纯文本是格式问题，产品化解法是给
harness 加一层宽容解析：AgentHost 托管一个本地 OpenAI 兼容代理
（配置开关 `lenientProxy`，桌面本地模式自动开启），Pi 指向代理、
代理转发 Ollama，仅在响应无原生 tool_calls 时把文本里的裸 JSON /
```json 围栏块调用转成原生 tool_calls（工具名须在清单内、参数过
模式回声清洗与 schema 基本校验，拿不准就不转、绝不凭猜执行）。
转换后的调用在 Pi 内与原生调用走同一通路：审批门与计划门照样
拦截裁决（回归内有 E2E 实证）。

收官实跑（2026-11-24）：**3B 验收通过**（第 2 次尝试全链走通，
账本 2 笔、回滚 verified），落盘/回滚/账本取得真模型证据；
**0.5B 附带验收仍未通过**——它臆造清单外工具名 `create_file`，
属能力问题、解析器按规则拒绝放水。详见
`docs/test-runs/2026-11-24-lenient-toolcall.md`。
