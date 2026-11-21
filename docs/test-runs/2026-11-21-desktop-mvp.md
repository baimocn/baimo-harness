# 桌面壳 MVP 测试记录 — 2026-11-21

## 结论

- **竖切已在真实界面打通**（Playwright Electron 无头实跑，非仅构建）：启动渲染三栏 →
  新建会话 → 发指令 → agent-host → Pi 1.6.0 → 本地桩模型 → 流式回复 + bash 工具卡
  （展开见 echo 输出 stub-tool-ok）→ agent_settled → 会话落盘；重启应用后会话与
  历史仍在（只读回放，同一归约器）。竖切 E2E 连跑多次全绿。
- **回归全绿**：test:regression 共 28 条（基线 15 = rpc 3 + agent-host 7 + 骨架 5，
  全部复核未破坏；本块新增 13 = ui 归约器单测 8 + 桌面回归 3 + 桌面 E2E 2）。
  test:e2e 共 20 条全绿。
- 环境：Electron 45.4.1 / playwright-core 1.65.1 / React 19.3.1 / esbuild 0.28.2，
  Linux VM + xvfb-run 无头运行；每次启动独立 XDG_CONFIG_HOME 隔离 userData 单例，
  应用句柄 finally 关闭（曾因默认 userData 单例 + 失败泄漏句柄导致套件挂死，已修复并记录在此）。

## 截图证据（docs/test-runs/assets/2026-11-21-desktop-mvp/）

- 01-vertical-slice.png：竖切完成态（流式回复、工具卡、检查点标记、圆环已接通真实统计）
- 02-history-after-restart.png：重启后历史回放（只读横幅 + 工具卡仍在）
- 03-trash.png：删除进回收站态（列表移除、回收站有条目、落盘未销毁）

## 本块如实标注的未做项

- 权限模式：仅状态与传递（记录进 desktop-settings.json 全局 + 每会话），**审批拦截未做**（下一块）；界面顶栏 YOLO 警示条与状态栏均明文标注。
- diff 卡：渲染与接受/回滚**状态标记**已实现（归约器单测覆盖 edit 载荷与行级 diff）；桩模型只发 bash，界面实跑未产生真实 edit diff；与检查点的真实回滚联动在下一块。
- 检查点页签：当前为会话事件日志里程碑（真实落盘）；Git 快照检查点（M-06）阶段 2 接入，页签内已标注。
- 右栏「文件」「计划」：结构占位并明文标注未实现。
- 模型选择：仅应用于新会话；会话内热切换未做（选择器 title 已标注）。
- 历史会话：只读回放，不可续发（agent-host 无 resume API）；发送键在运行中禁用，未做停止/steering（阶段 2）。

# test:e2e — 2026-11-21 09:02:02 UTC


> baimo-harness@0.0.0 test:e2e
> npm run build && node --test "packages/rpc/test/*.test.mjs" "apps/agent-host/test/*.test.mjs" "packages/ui/test/*.test.mjs" && node apps/desktop/scripts/run-e2e.mjs


> baimo-harness@0.0.0 build
> npm run build -w @baimo-harness/agent-host && npm run build -w @baimo-harness/ui && npm run build -w @baimo-harness/desktop


> @baimo-harness/agent-host@0.0.0 build
> tsc -p tsconfig.json


> @baimo-harness/ui@0.0.0 build
> tsc -p tsconfig.json && cp src/styles.css dist/styles.css


> @baimo-harness/desktop@0.0.0 build
> node scripts/build.mjs

desktop build ok: /home/hatch/workspace/harness/apps/desktop/dist
✔ 宿主启动+握手：get_state 成功、遥测三重关闭落地、命令错误显形（K-01） (812.822785ms)
✔ RPC 客户端：坏行记录不吞、无主响应上报、未知事件透传、超时与命令错误显形 (122.00538ms)
✔ 会话落盘：宿主重启后可列出并加载历史会话 (406.893732ms)
✔ 会话落盘：事件日志尾部损坏可检测并恢复到最后一个完整记录 (493.57593ms)
✔ 坏配置拒绝启动（K-03）：宿主未知键/非法值、Pi 设置未知键/非法值 (2.669978ms)
✔ K-02：运行中杀进程 → 异常终止显形（带事件计数），后续请求以进程错误结算 (539.27578ms)
✔ 桩模型完整轮次：流式文本 → 工具调用 → agent_settled → 落盘可查 (602.676586ms)
✔ RPC 握手：get_state 成功且会话空闲 (902.298097ms)
✔ RPC 错误面：坏 JSON 与未知命令都显形为 success:false（K-01） (2.45122ms)
✔ RPC 关闭：关闭 stdin 后进程有序退出且退出码为 0 (13.804275ms)
✔ 流式文本：增量拼接成完整回复，message_end 收尾 (1.606431ms)
✔ 只含工具调用的 assistant 消息不留空泡 (0.35959ms)
✔ 工具卡生命周期：start 建卡（摘要=命令）→ end 落结果与成败 (0.548753ms)
✔ agent_settled：运行结算、计数、检查点标记 (0.420561ms)
✔ 完整轮次回放：用户→流式文本→工具→结算（与 agent-host 真实事件同形） (0.601873ms)
✔ diff：edit 工具产出 diff 载荷；行级 diff 增删正确；标记可落 (0.716395ms)
✔ 改动总账：edit/write 聚合，read 不计入 (1.166381ms)
✔ 异常显形：run_error 成错误条目并停运行；未知事件忽略不崩 (0.25357ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16209.452478
✔ 竖切：发指令→流式回复+工具卡→落盘→重启后历史仍在 (4010.750357ms)
✔ 回收站：删除二次确认→进回收站→还原（落盘不销毁） (1983.693537ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6548.148678

# test:regression — 2026-11-21 09:02:32 UTC


> baimo-harness@0.0.0 test:regression
> npm run build && node --test "packages/rpc/test/*.test.mjs" "apps/agent-host/test/*.test.mjs" "packages/ui/test/*.test.mjs" "tests/regression/*.test.mjs" && node apps/desktop/scripts/run-e2e.mjs


> baimo-harness@0.0.0 build
> npm run build -w @baimo-harness/agent-host && npm run build -w @baimo-harness/ui && npm run build -w @baimo-harness/desktop


> @baimo-harness/agent-host@0.0.0 build
> tsc -p tsconfig.json


> @baimo-harness/ui@0.0.0 build
> tsc -p tsconfig.json && cp src/styles.css dist/styles.css


> @baimo-harness/desktop@0.0.0 build
> node scripts/build.mjs

desktop build ok: /home/hatch/workspace/harness/apps/desktop/dist
✔ 宿主启动+握手：get_state 成功、遥测三重关闭落地、命令错误显形（K-01） (1039.048224ms)
✔ RPC 客户端：坏行记录不吞、无主响应上报、未知事件透传、超时与命令错误显形 (122.777119ms)
✔ 会话落盘：宿主重启后可列出并加载历史会话 (410.038874ms)
✔ 会话落盘：事件日志尾部损坏可检测并恢复到最后一个完整记录 (443.656224ms)
✔ 坏配置拒绝启动（K-03）：宿主未知键/非法值、Pi 设置未知键/非法值 (2.109818ms)
✔ K-02：运行中杀进程 → 异常终止显形（带事件计数），后续请求以进程错误结算 (569.839236ms)
✔ 桩模型完整轮次：流式文本 → 工具调用 → agent_settled → 落盘可查 (627.02442ms)
✔ RPC 握手：get_state 成功且会话空闲 (1004.188668ms)
✔ RPC 错误面：坏 JSON 与未知命令都显形为 success:false（K-01） (5.637784ms)
✔ RPC 关闭：关闭 stdin 后进程有序退出且退出码为 0 (66.484845ms)
✔ 流式文本：增量拼接成完整回复，message_end 收尾 (1.649897ms)
✔ 只含工具调用的 assistant 消息不留空泡 (47.985102ms)
✔ 工具卡生命周期：start 建卡（摘要=命令）→ end 落结果与成败 (0.854333ms)
✔ agent_settled：运行结算、计数、检查点标记 (0.337747ms)
✔ 完整轮次回放：用户→流式文本→工具→结算（与 agent-host 真实事件同形） (0.431458ms)
✔ diff：edit 工具产出 diff 载荷；行级 diff 增删正确；标记可落 (0.744378ms)
✔ 改动总账：edit/write 聚合，read 不计入 (1.146712ms)
✔ 异常显形：run_error 成错误条目并停运行；未知事件忽略不崩 (0.260792ms)
✔ 桌面壳构建产物齐全（main/preload/renderer 三件套） (1.443417ms)
✔ preload 只暴露白名单桥，不透传 ipcRenderer (0.918649ms)
✔ 根脚本串联 ui 单测与桌面 E2E (0.35936ms)
✔ 骨架目录齐全 (1.309435ms)
✔ workspace 包命名统一且可解析 (0.567502ms)
✔ 随附 Pi 版本与 runtime 钉死版本一致 (0.532028ms)
✔ 根 package.json 保留测试脚本入口 (0.28013ms)
✔ 遥测审计文档在位且记录了关闭方法（K-04） (4.19648ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16228.523439
✔ 竖切：发指令→流式回复+工具卡→落盘→重启后历史仍在 (4062.61258ms)
✔ 回收站：删除二次确认→进回收站→还原（落盘不销毁） (2016.263646ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6675.446474
