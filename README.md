# 白墨 Harness

自己的编程 Agent 壳：Pi 当内核（RPC 模式子进程）+ Electron 壳 + 借 ZCode 的上层零件。
设计依据：`~/workspace/your_files/pi-harness/` 下的 PLAN.md、GUI-SPEC.md、《白墨Harness-产品设计文档》与《用户反馈落盘-设计决策清单》。

## 环境

- Node **≥ 22.19.0**（Pi 1.6.0 的 engines 要求）。当前开发机为 Node v24.22.1，满足要求，未另装工具链；`.nvmrc` 钉 24。用 nvm 时在项目根执行 `nvm use` 即可。
- npm workspaces（根目录 `npm install` 安装全部 workspace 依赖）。

## 结构

```
apps/desktop/       Electron 壳（main / preload / renderer）— 待阶段 1
apps/agent-host/    Pi 子进程托管、RPC 转发与对账、会话落盘 — 待阶段 1
packages/ui/        React 组件（将来 Web 版共用）
packages/rpc/       RPC 协议与类型定义；test/ 下有 RPC 冒烟测试
packages/core/      壳层领域逻辑（会话/权限/账本/检查点等，见产品设计文档 3.7）
runtime/            随附运行时：@earendil-works/pi-coding-agent 钉死 1.6.0（独立安装，不进 workspaces）
docs/               项目内文档（telemetry-audit.md 等）
tests/regression/   回归基线用例
```

## 当前状态（2026-11-21，阶段 0 前置）

- [x] 项目骨架 + npm workspaces + git
- [x] Pi 1.6.0 装入 `runtime/`，RPC 协议形态已摸清（JSONL over stdio，`get_state` 握手，关 stdin 有序退出）
- [x] 遥测审计完成 → `docs/telemetry-audit.md`：可彻底关闭（`PI_TELEMETRY=0` + 设置 `enableInstallTelemetry:false`），RPC 模式本身不触发上报
- [x] 测试套路立起：`test:e2e`（端到端冒烟）与 `test:regression`（回归基线）
- [ ] 阶段 0：装原版 Pi 接一个模型跑通手感（后续）

## 测试

```bash
npm run test:e2e         # 端到端：当前为 Pi RPC 冒烟（握手/错误面/关闭，全程无模型调用）
npm run test:regression  # 回归：冒烟 + 骨架/版本/红线文档基线
```

规矩：每个功能落地时同步往 `test:e2e` 或 `tests/regression/` 加用例；改动后先跑 `test:regression` 复核旧功能没被破坏。

## 红线

- 零遥测、零外传：agent-host 拉起 Pi 时必须注入 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`，并在托管的 Pi 配置目录写死 `enableInstallTelemetry: false`（详见 `docs/telemetry-audit.md` §5）。
- 数据只落本地；密钥进系统钥匙串，不落明文配置。
- 无限制 agent 只在隔离环境跑，不接主力账号与生产服务器。
