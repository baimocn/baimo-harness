# Pi 遥测审计报告（K-04）

- **审计对象**：`@earendil-works/pi-coding-agent@1.6.0`（含依赖 `@earendil-works/pi-telemetry@1.6.0`、`@earendil-works/pi-ai@1.6.0`），安装于 `runtime/node_modules/`
- **审计日期**：2026-11-21
- **审计方式**：静态代码审计（发行包 `dist/` 产物 + 随包文档）。审计期间未向任何外部端点发送真实数据；运行验证只用本地无模型 RPC 命令（见 `tests/e2e/rpc-smoke.test.mjs`）。
- **对应红线**：零遥测、零外传——除用户配置的模型端点外零外发请求。

## 结论（一句话）

**可以彻底关闭，无需 fork 摘除。** Pi 1.6.0 唯一默认开启的外发是「安装/更新匿名上报」（仅版本号 + UA，且只在交互模式触发）；本项目用 RPC 模式运行，该代码路径根本不加载，再叠加环境变量与设置双保险即可确定性关闭（方法见 §4）。`pi-telemetry` 包本身只是契约/类型层，没有导出器、不联网。

## 1. `pi-telemetry` 包：只有契约，没有外发

`runtime/node_modules/@earendil-works/pi-telemetry/`（`package.json` 自述 "Vendor-neutral telemetry contracts and typed schema utilities"）：

- 提供 `TelemetryContext`/`TelemetrySpan` 回调契约、指标 schema、两个实现：`NOOP_TELEMETRY_CONTEXT`（`dist/noop.js`）与内存实现 `InMemoryTelemetryContext`（`dist/memory.js`）。
- README 明言："no exporter, global current-span state, or dependency on a telemetry backend"——数据只进内存或 no-op，除非宿主应用自己接 OpenTelemetry/Sentry 等适配器。
- 对 `dist/*.js` 全量 grep `fetch|http|otlp|endpoint`：零命中（网络相关代码不存在）。

即：PLAN 里担心的「telemetry 包」在 1.6.0 形态下是内部埋点 API，不是上报通道。pi-coding-agent 也未随包附带任何把 span 发出去的适配器。

## 2. 真正默认开启的外发：安装/更新上报（默认 ON）

**证据**：`dist/modes/interactive/interactive-mode.js`，`reportInstallTelemetry(version)`（约第 1135–1150 行）：

```js
reportInstallTelemetry(version) {
    if (process.env.PI_OFFLINE) return;
    if (!isInstallTelemetryEnabled(this.settingsManager)) return;
    void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
        headers: { "User-Agent": getPiUserAgent(version) },
        signal: AbortSignal.timeout(5000),
    }).then(() => undefined).catch(() => undefined);
}
```

- **发到哪里**：`GET https://pi.dev/api/report-install?version=<版本>`
- **发什么**：仅版本号（query 参数）+ `User-Agent` 头。UA 为 detailed 形态（`@earendil-works/pi-ai` `dist/utils/identity.js` 的 `formatUserAgent`）：`pi/<版本> (<platform>; node/<node版本>; <arch>)`，如 `pi/1.6.0 (linux; node/v24.22.1; x64)`。不含主机名、用户名、路径、会话内容。
- **何时触发**：仅交互（TUI）模式启动时，走 changelog 展示路径——全新安装或版本变化后首次启动（`getChangelogForDisplay()` 调用点，同文件约第 1060、1076 行）。失败静默吞掉，不影响功能。
- **默认状态**：**开**。设置项 `enableInstallTelemetry` 默认 `true`（`docs/settings.md`「Updates, telemetry, and warnings」节；`dist/core/settings-defaults.js`）。
- **开关逻辑**：`dist/core/telemetry.js` 的 `isInstallTelemetryEnabled()`——环境变量 `PI_TELEMETRY` 优先于设置：`1/true/yes` 开，`0/false/no` 关；未设环境变量时读设置 `enableInstallTelemetry`。`PI_OFFLINE` 存在时直接跳过发送。

## 3. 其他外发面（逐项核查）

| 面 | 端点/去向 | 默认 | 触发 | 关闭方式 | 证据 |
|---|---|---|---|---|---|
| 版本检查 | `GET https://pi.dev/api/latest-version`（带 UA） | 开（仅交互模式与包管理 CLI 调用） | 启动时检查新版本 | `PI_SKIP_VERSION_CHECK=1` 或 `PI_OFFLINE` | `dist/utils/version-check.js`（`LATEST_VERSION_URL`）；调用方仅 `interactive-mode.js`、`package-manager-cli.js` |
| Provider 归因头 | 用户**自己配置的**模型端点 | 随安装遥测开关 | 每次模型请求 | 同 §2 开关（关后 `attribution: null`） | `dist/core/client-identity.js`；归因体 `PI_ATTRIBUTION = {name:"pi", url:"https://pi.dev", categories:["cli-agent"]}`（pi-ai `dist/utils/identity.js`） |
| 统计分析 `enableAnalytics` | —（实验性首次运行设置流程用） | **关**（默认 `false`，opt-in） | 仅实验流程 | 保持默认不开启 | `docs/settings.md`；`dist/core/settings-defaults.js:32` |
| Bug 报告上传 | pi.dev（用户点名上传时） | 用户主动 | 用户显式操作 | 不触发即可；`PI_OFFLINE` 时上传被拒 | `dist/core/bug-report-upload.js`；`dist/modes/interactive/bug-report.js:22` |
| 包管理 | `https://pi.dev/api/installer/releases` + npm/git 源 | 用户主动 | 执行包安装/更新命令时 | `PI_OFFLINE` 时跳过全部网络 | `dist/package-manager-cli.js:22`；`dist/core/package-manager.js:52` |
| 远程模型目录 | 用户配置的各 provider 端点 | 开 | 启动/刷新模型目录 | `PI_OFFLINE` 时以离线模式构造（`online=false`） | `dist/core/model-runtime.js:97`；`dist/core/remote-catalog-provider.js` |

对 `dist/` 全量枚举 `https://` 字面量：除上述 pi.dev 三个端点外，其余全部是模型 provider 的 API 地址（OpenAI/Anthropic/OpenRouter 等，即用户自己配置的模型端点）与文档链接，**没有发现第三方分析/广告/追踪域名**。

## 4. RPC 模式核查（本项目的运行形态）

- 对 `dist/modes/rpc/*.js` 与 `dist/main.js` grep `telemetry|version-check|reportInstall`：**零命中**。安装上报与版本检查的代码只存在于交互模式与包管理 CLI，RPC 子进程不加载、不触发。
- `main.js:488`：`--offline` 参数会被归一化为 `PI_OFFLINE=1`（"Disable startup network operations"，见 `dist/cli/args.js:336,460`）。

## 5. 本项目强制关闭方法（确定性，agent-host 执行）

agent-host 拉起每个 Pi 子进程时，三重保险叠加（任一生效即关，互不依赖）：

1. **环境变量**（子进程 env 注入）：
   - `PI_TELEMETRY=0` —— 关安装上报 + provider 归因头
   - `PI_SKIP_VERSION_CHECK=1` —— 关版本检查
2. **设置文件**：agent-host 托管的 Pi 配置目录（经 `PI_CODING_AGENT_DIR` 指定，默认 `~/.pi/agent`）内 `settings.json` 写死 `"enableInstallTelemetry": false`，防 env 丢失时回退到默认开。
3. **硬离线开关（可选，最强）**：`PI_OFFLINE=1` —— 一并停掉安装上报、版本检查、包管理联网与远程模型目录刷新；代价是模型目录不自动刷新，日常运行默认不启用，仅在审计/隔离场景使用。

本轮的 RPC 冒烟测试已按 1+2 的策略 env 实际运行（另加 `PI_CODING_AGENT_DIR` 指向临时目录隔离），握手与关闭全程正常。

**fork 摘除点（将来若要物理删除，备查）**：`dist/modes/interactive/interactive-mode.js` 的 `reportInstallTelemetry` 及其两个调用点、`dist/core/telemetry.js`、`dist/core/client-identity.js` 的 attribution 分支、`dist/utils/version-check.js`。当前结论是不需要动 fork。

## 6. 验收对应（K-04）

- 本轮：代码审计（本文件）+ RPC 冒烟以策略 env 跑通 —— 证明关闭方法可执行、RPC 形态下无遥测路径。
- 待阶段 1 壳层成型后补：按验收标准做**抓包审计**（运行时全部外发请求抓包，除用户配置的模型端点外为零），纳入 `test:regression`。
