# 本地真模型接入（第七块）

白墨 Harness 除桩模型外，可接一个**只在本机回环地址推理**的真实开源
模型做实跑：运行时 Ollama、模型 Qwen2.5-Coder 0.5B（用户拍板的 0.5B 尺寸，Q4 量化）。
全程不需要任何 API key，请求不离开本机。

## 运行时（用户态安装）

```bash
# 官方 tarball 现为 zstd 包（.tgz 链接已 404），解到 ~/.local/ollama
curl -fL -o ollama.tar.zst \
  https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst
mkdir -p ~/.local/ollama && tar --zstd -xf ollama.tar.zst -C ~/.local/ollama

# 只监听回环，后台启动
OLLAMA_HOST=127.0.0.1:11434 ~/.local/ollama/bin/ollama serve

# 拉模型（约 0.4GB）
~/.local/ollama/bin/ollama pull qwen2.5-coder:0.5b
```

验收实测数据（VM 1.5 核 / 6GB 档）见
`docs/test-runs/2026-11-24-local-model.md`。

## 桌面应用切换到本地模型

与桩模式同口径，靠 env 注入（`apps/desktop/src/main/main.ts`）：

```bash
BAIMO_LOCAL_MODEL_URL=http://localhost:11434/v1 \
BAIMO_LOCAL_MODEL_ID=qwen2.5-coder:0.5b \
  <启动桌面应用>
```

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
