# 白墨 Harness

自己的编程 Agent 壳：Pi 当内核（RPC 模式子进程）+ Electron 壳 + 借 ZCode 的上层零件。
设计依据：`~/workspace/your_files/pi-harness/` 下的 PLAN.md、GUI-SPEC.md、《白墨Harness-产品设计文档》与《用户反馈落盘-设计决策清单》。

## 环境

- Node **≥ 22.19.0**（Pi 1.6.0 的 engines 要求）。当前开发机为 Node v24.22.1，满足要求，未另装工具链；`.nvmrc` 钉 24。用 nvm 时在项目根执行 `nvm use` 即可。
- npm workspaces（根目录 `npm install` 安装全部 workspace 依赖）。

## 结构

```
apps/desktop/       Electron 壳（main / preload / renderer）— 阶段 1 MVP 已落地（见当前状态）
apps/agent-host/    Pi 子进程托管、RPC 转发与对账、会话落盘（已落地，见当前状态）
packages/ui/        React 组件库：执行流归约器 + 三栏界面组件（已落地）
packages/rpc/       RPC 协议与类型定义；test/ 下有 RPC 冒烟测试
packages/core/      壳层领域逻辑（会话/权限/账本/检查点等，见产品设计文档 3.7）
runtime/            随附运行时：@earendil-works/pi-coding-agent 钉死 1.6.0（独立安装，不进 workspaces）
docs/               项目内文档（telemetry-audit.md 等）
tests/regression/   回归基线用例
```

## 当前状态（2026-11-21，桌面壳 MVP 已落地）

- [x] 项目骨架 + npm workspaces + git
- [x] Pi 1.6.0 装入 `runtime/`，RPC 协议形态已摸清（JSONL over stdio，`get_state` 握手，关 stdin 有序退出）
- [x] 遥测审计完成 → `docs/telemetry-audit.md`：可彻底关闭（`PI_TELEMETRY=0` + 设置 `enableInstallTelemetry:false`），RPC 模式本身不触发上报
- [x] 测试套路立起：`test:e2e`（端到端冒烟）与 `test:regression`（回归基线）
- [x] **agent-host 落地**（`apps/agent-host`，TypeScript，`npm run build` 编译）：PiProcess 管理器（遥测三重关闭、退出显形、逐级关闭）、RpcClient（id 关联/超时/坏行不吞）、SessionStore（append-only JSONL + 索引、尾部损坏可恢复）、AgentHost 门面（每会话一进程、握手、事件落盘）
- [x] 内核债壳层补偿三条：K-01 错误显形（success:false/退出/超时一律类型化错误）、K-02 工具循环终止检测（无 agent_settled 的结束 = 异常终止事件 + 事件计数）、K-03 配置校验（宿主配置与 Pi 设置未知键/非法值拒绝启动）
- [x] 桩模型 E2E：本地 OpenAI 兼容桩服务器跑通完整轮次（流式文本 → bash 工具调用 → agent_settled → 落盘可查），测试记录 `docs/test-runs/2026-11-21-agent-host.md`
- [x] **桌面壳 MVP 落地**（阶段 1 第一条竖切）：Electron main 内嵌 agent-host（随应用启停、退出先关宿主）、preload 白名单桥（contextIsolation + sandbox）、packages/ui 三栏界面（四权限模式/会话列表/执行流/工具卡/diff 卡/右栏四页签/上下文圆环/状态栏）；界面发指令 → Pi → 桩模型 → 流式回复 + 工具卡 → 落盘，重启后历史可回放；Playwright 无头 E2E 2 条 + 回归 27/27 全绿，记录 `docs/test-runs/2026-11-21-desktop-mvp.md`。权限模式仅状态与记录（审批拦截下一块），「文件」「计划」页签为占位，检查点页签为事件日志里程碑
- [ ] 阶段 0：装原版 Pi 接一个模型跑通手感（后续）
- [ ] 阶段 1 后续：审批拦截、Git 检查点与 diff 回滚联动、会话内模型热切换

## 测试

```bash
npm run build            # 依次编译 agent-host（tsc）、ui（tsc）、desktop（esbuild 三件套）
npm run test:e2e         # 端到端：Pi RPC 冒烟 + agent-host E2E（含桩模型完整轮次）+ ui 单测 + 桌面无头 E2E
npm run test:regression  # 回归：E2E 全部 + 骨架/版本/红线文档基线（27 条）
```

规矩：每个功能落地时同步往 `test:e2e` 或 `tests/regression/` 加用例；改动后先跑 `test:regression` 复核旧功能没被破坏。

## 红线

- 零遥测、零外传：agent-host 拉起 Pi 时必须注入 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`，并在托管的 Pi 配置目录写死 `enableInstallTelemetry: false`（详见 `docs/telemetry-audit.md` §5）。
- 数据只落本地；密钥进系统钥匙串，不落明文配置。
- 无限制 agent 只在隔离环境跑，不接主力账号与生产服务器。
