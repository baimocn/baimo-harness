# 白墨 Harness

自己的编程 Agent 壳：Pi 当内核（RPC 模式子进程）+ Electron 壳 + 借 ZCode 的上层零件。
设计依据：产品设计文档 v1.0（10 章、16 个功能模块、21 条验收清单）与 30,450 条真实用户反馈落盘的 29 条设计决策；每块功能的端到端验证记录见 `docs/test-runs/`。

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

## 当前状态（2026-11-27，十块开发全部收官，回归 119/119）

- [x] 项目骨架 + Pi 1.6.0 内核（RPC 子进程托管、遥测三重关闭）+ 遥测审计（`docs/telemetry-audit.md`）
- [x] agent-host：PiProcess 管理器、RpcClient（id 关联/超时/坏行不吞）、SessionStore（append-only JSONL + 索引、尾部损坏可恢复）；内核债壳层补偿 K-01 错误显形 / K-02 工具循环终止检测 / K-03 配置校验
- [x] Electron 桌面壳：三栏界面、会话列表、执行流、工具卡、真实 diff 卡、上下文圆环
- [x] 控制簇：会话续跑与停止、检查点快照与逐文件校验回滚、四权限模式与分级审批（含命令模式持久授权，危险命令永远优先拦截）
- [x] 引导簇：计划面板（先审后行、可编辑/拒绝/中途暂停）、引导队列（steer/follow_up、单条撤回）、成本账本与预算熔断（YOLO 也熔断）
- [x] 阶段 3：空闲队列（默认关）、插件目录（坏插件显形报错）、会话回放（与实时流同一归约器）
- [x] K-04 抓包审计：全程零非回环外联实证（含揪出并关掉 Chromium 拼写词典下载）
- [x] 宽容工具调用解析：本地模型把工具调用写成纯文本时，本地代理转成原生调用（仅回环模型，转出调用照样走审批与计划裁决）；Qwen2.5-Coder 3B 已跑通未改动的全链真任务验收（计划裁决 → 落盘逐字一致 → 回滚 → 账本对账）
- [x] 两轮视觉打磨（第二轮构图级对标 ZCode）：五级表面分层、无边框回复流、浮起输入卡、墨蓝单品牌主色
- 已知限度：空闲内存约 618MB（≤500MB 红线未达）；3B 不是每次都稳；本地模型暂无逐字流式（代理强制非流式）；短用户气泡仍横向拉满

## 测试

```bash
npm run build            # 依次编译 agent-host（tsc）、ui（tsc）、desktop（esbuild 三件套）
npm run test:e2e         # 端到端：Pi RPC 冒烟 + agent-host E2E（含桩模型完整轮次）+ ui 单测 + 桌面无头 E2E
npm run test:regression  # 回归：E2E 全部 + 骨架/版本/红线文档基线（119 条）
```

规矩：每个功能落地时同步往 `test:e2e` 或 `tests/regression/` 加用例；改动后先跑 `test:regression` 复核旧功能没被破坏。

## 红线

- 零遥测、零外传：agent-host 拉起 Pi 时必须注入 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`，并在托管的 Pi 配置目录写死 `enableInstallTelemetry: false`（详见 `docs/telemetry-audit.md` §5）。
- 数据只落本地；密钥进系统钥匙串，不落明文配置。
- 无限制 agent 只在隔离环境跑，不接主力账号与生产服务器。
