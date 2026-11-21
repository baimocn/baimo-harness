# test:e2e — 2026-11-21 08:38:07 UTC

> baimo-harness@0.0.0 test:e2e
> npm run build && node --test "packages/rpc/test/*.test.mjs" "apps/agent-host/test/*.test.mjs"
> baimo-harness@0.0.0 build
> npm run build -w @baimo-harness/agent-host
> @baimo-harness/agent-host@0.0.0 build
> tsc -p tsconfig.json
✔ 宿主启动+握手：get_state 成功、遥测三重关闭落地、命令错误显形（K-01） (816.966346ms)
✔ RPC 客户端：坏行记录不吞、无主响应上报、未知事件透传、超时与命令错误显形 (122.234364ms)
✔ 会话落盘：宿主重启后可列出并加载历史会话 (429.323977ms)
✔ 会话落盘：事件日志尾部损坏可检测并恢复到最后一个完整记录 (475.553152ms)
✔ 坏配置拒绝启动（K-03）：宿主未知键/非法值、Pi 设置未知键/非法值 (1.891209ms)
✔ K-02：运行中杀进程 → 异常终止显形（带事件计数），后续请求以进程错误结算 (624.35348ms)
✔ 桩模型完整轮次：流式文本 → 工具调用 → agent_settled → 落盘可查 (682.292576ms)
✔ RPC 握手：get_state 成功且会话空闲 (772.657934ms)
✔ RPC 错误面：坏 JSON 与未知命令都显形为 success:false（K-01） (7.582834ms)
✔ RPC 关闭：关闭 stdin 后进程有序退出且退出码为 0 (13.378266ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15945.263783

# test:regression — 2026-11-21 08:38:25 UTC

> baimo-harness@0.0.0 test:regression
> npm run build && node --test "packages/rpc/test/*.test.mjs" "apps/agent-host/test/*.test.mjs" "tests/regression/*.test.mjs"
> baimo-harness@0.0.0 build
> npm run build -w @baimo-harness/agent-host
> @baimo-harness/agent-host@0.0.0 build
> tsc -p tsconfig.json
✔ 宿主启动+握手：get_state 成功、遥测三重关闭落地、命令错误显形（K-01） (914.105454ms)
✔ RPC 客户端：坏行记录不吞、无主响应上报、未知事件透传、超时与命令错误显形 (122.220123ms)
✔ 会话落盘：宿主重启后可列出并加载历史会话 (473.030395ms)
✔ 会话落盘：事件日志尾部损坏可检测并恢复到最后一个完整记录 (459.031848ms)
✔ 坏配置拒绝启动（K-03）：宿主未知键/非法值、Pi 设置未知键/非法值 (2.099242ms)
✔ K-02：运行中杀进程 → 异常终止显形（带事件计数），后续请求以进程错误结算 (535.968254ms)
✔ 桩模型完整轮次：流式文本 → 工具调用 → agent_settled → 落盘可查 (678.036576ms)
✔ RPC 握手：get_state 成功且会话空闲 (822.272172ms)
✔ RPC 错误面：坏 JSON 与未知命令都显形为 success:false（K-01） (6.401981ms)
✔ RPC 关闭：关闭 stdin 后进程有序退出且退出码为 0 (76.096546ms)
✔ 骨架目录齐全 (6.476404ms)
✔ workspace 包命名统一且可解析 (0.743667ms)
✔ 随附 Pi 版本与 runtime 钉死版本一致 (0.51982ms)
✔ 根 package.json 保留测试脚本入口 (0.42626ms)
✔ 遥测审计文档在位且记录了关闭方法（K-04） (3.126003ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16078.39717
