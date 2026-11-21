# K-04 抓包遥测审计（2026-11-21，阶段 3 · 模块 4）

结论：**通过**（经历一轮「抓到真外发 → 定位 → 修复 → 复验」后通过）。
完整桌面应用跑一轮真实任务（本地桩模型）期间，应用进程树（Electron
主进程全部后代，含 Pi 子进程）除「配置的模型端点（本地桩，环回）」外
**零对外连接**；Pi→桩端点连接被真实抓到（修复后复验 18 次观测），
抓包敏感度自证成立。

## 方法

- 脚本：`tests/capture/telemetry-capture.mjs`，已以子进程方式纳入
  `test:regression`（`tests/regression/telemetry-capture.test.mjs`，
  无 DISPLAY 时自动套 xvfb-run），每次回归刷新证据 JSON。
- 抓取口径：驱动真实应用（新建会话 → 发送提示 → 桩模型完成一轮
  bash 工具调用与最终答复 → 结算后再观察 2 秒）的同时，以 100ms
  间隔轮询 `ss -tanpH` / `ss -uanpH`，用 `ps` 维护应用进程树 pid
  集合，只记录进程树内进程的连接。
- Pi 识别：Pi 的 bundle 会把进程名改成 `pi`（`ps` 的 args 只剩
  `pi`），按命令行匹配会漏判——首轮抓包即因此把 Pi→桩连接误归
  Electron 树、敏感度自证为 0 而判失败（失败如实发生过）。修正后
  以 `/proc/<pid>/comm === "pi"` 为准、命令行匹配为辅。
- 判定：进程树内连接出现非环回远端（端口非 0）即不通过；
  Pi→桩端点观测为 0（抓包失效）同样不通过。

## 审计实录：抓到一次壳层自带外发，并已修复

1. **首轮回归抓到外发**：抓包回归第一次随全量回归运行时失败——
   进程树内一个 Electron 进程与本机出口代理
   `[fd8b:…::1]:3128` 建立过一次 ESTAB 连接（1 次观测）。本机环境
   全局设 `http_proxy` 指向该代理，任何读环境代理的组件外发都会
   先连它——连接真实存在，不能当没看见。（此前两次独立运行未抓到：
   该连接存活不足一次轮询间隔，正是轮询式抓包的已知局限。）
2. **日志代理探针定性**：把应用的代理环境指向自建记录型代理后，
   两次复现同一请求：`CONNECT redirector.gvt1.com:443`，UA 为
   本应用的 Chromium UA；挂住连接后经 `ss` 定位属主为 Chromium
   的 Network Service 进程。
3. **NetLog 定案**：Chromium NetLog 显示真实请求为
   `GET https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-2.bdic`
   ——**Chromium 拼写检查的英文词典下载**，与 Pi、与应用代码无关，
   是壳层 Chromium 在新 profile 下的自带行为。按零外发红线口径，
   同样不允许。
4. **修复（含两次无效尝试，如实记录）**：
   - `disable-component-update` / `disable-background-networking`
     开关：无效（不是组件更新路径）——仍保留作纵深防御；
   - 预写 profile 的 Preferences 关拼写检查：无效（最小实验验证）；
   - `webPreferences.spellcheck=false` + `setSpellCheckerEnabled(false)`：
     仍无效——最小实验进一步定位：无窗口不触发（窗口/会话创建
     触发），且必须**同时清空词典语言列表**；
   - **生效修复**：`app.whenReady` 里、建窗口之前执行
     `session.defaultSession.setSpellCheckerEnabled(false)` +
     `session.defaultSession.setSpellCheckerLanguages([])`，
     辅以 `webPreferences.spellcheck = false`。结构断言已入
     `tests/regression/desktop.test.mjs`。
5. **复验**：日志代理探针连跑 3 次，请求日志全空；`ss` 抓包复跑
   通过（见下表）。

## 修复后证据摘要（本次运行）

证据 JSON：`docs/test-runs/assets/2026-11-21-stage3/capture-evidence.json`
（轮询 28 次，进程树连接观测 130 条）：

| 端点 | 归属 | 观测 | 说明 |
|---|---|---|---|
| TCP LISTEN 127.0.0.1:34083 + ESTAB 对 | Electron 树 | 28 | Playwright 远程调试口及驱动连接（环回） |
| TCP LISTEN 127.0.0.1:46361 + ESTAB 对 | Pi | 25 | Pi 侧环回监听与内部连接对 |
| TCP ESTAB → 127.0.0.1:&lt;桩端口&gt; | **Pi** | **18** | **Pi→桩模型端点（敏感度自证）** |

非环回远端端点：**0**。UDP：进程树内无观测。

## 已知局限（如实记录）

- 轮询式抓包可能漏掉存活 <100ms 的短连接——本次的外发正是先被
  一次侥幸抓到、再靠日志代理探针坐实的；日常守门以抓包回归 +
  静态代码审计（`docs/telemetry-audit.md`：RPC 模式无遥测代码
  路径、三重关已落地）互为印证，单靠任一侧都不下结论。
- 进程归属在进程启动瞬间有个别观测抖动（同一环回监听在最初几次
  轮询被归到 Electron 树、之后归 Pi）：不影响判定——判定口径是
  「整个进程树对非环回远端零连接」，抖动只发生在树内。
- 本轮模型端点为本地桩；接真实模型后，允许清单即用户配置的那个
  模型端点，判定口径不变（回归脚本届时按配置端点放行）。
- 拼写检查在本产品中整体禁用（中文编程场景不需要 Chromium 的
  英文词典，且其下载行为与零外发红线冲突）——这是有意取舍。
