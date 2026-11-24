# 第八块测试记录：视觉打磨（2026-11-24 收尾补记）

> 本记录由收尾环节补写：前一协调者已完成并提交全部 6 个打磨单元，但未留测试记录即结束。本记录的结论均以 git 提交、代码现状与本次实跑（回归 + 内存实测）核实，不凭印象。

## 一、打磨单元与提交

| 单元 | 内容 | 提交 |
|---|---|---|
| 工具 | before/after 对照截图脚本（visual-shots.mjs）+ before 基线 11 张 | `9d4fe8b` |
| 单元 1 | 设计 token 体系：颜色/间距/字号/圆角/阴影收敛为 CSS 变量；模式即色彩；细滚动条/焦点环/悬停反馈 | `8507b07` |
| 单元 1.5 | token 校准：shadcn dark 成对命名 + 模式色成对配方 + faint 提亮达 WCAG 4.5 + elevation 五级；引入 lucide/fontsource 依赖 | `9bf5da2` |
| 单元 2 | 字体与图标：Fontsource 自托管 Inter/JetBrains Mono 接线；Lucide 全量替换字符符号（工具卡/计划步骤/回放/会话/审批） | `4f1d2c2` |
| 单元 3 | 去占位与设计化空状态：EmptyState/LoadingRow 替换裸灰字、文件页签改设计空状态、修插件说明裸 `**` 标记、文案去工程味（删「分支未接入」/M-xx 字样） | `debe6f3` |
| 单元 4 | 核心组件质感：diff 整行着色+对齐、审批/计划卡语义色调底、主次按钮层级（btn-primary/warn/plan/danger-fill）、工具卡状态轨、检查点时间线点、账本数字层级、列表悬停 | `aad3d8e` |
| 单元 5 | 应用身份：几何墨迹图标（make-icon.mjs 生成多尺寸 PNG）+ 窗口标题/图标接线 + 背景色对齐 token + 顶栏品牌标记 | `11d18cd` |

## 二、逐项对照

| 打磨项 | 结论 | 证据 |
|---|---|---|
| 设计 token 体系 | ✅ 完成 | `packages/ui/src/styles.css` 颜色/间距（`--sp-*`）/字号（`--fs-*`）/圆角（`--r-sm/md/lg/pill`）/阴影（`--shadow-card/pop`、`--elev-*`）全部变量化 |
| 模式色（计划/编辑/构建/YOLO） | ✅ 完成 | `--mode-build/edit/plan/yolo` 与成对前景色 `--mode-*-fg`；顶栏模式段+YOLO 红底横幅在截图中可辨（after-09、回归重拍 01-vertical-slice） |
| 去占位与设计化空状态 | ✅ 完成 | EmptyState/LoadingRow 组件落地；after-00（空状态）、after-01 右栏「本会话暂无文件改动」设计空状态可见 |
| 核心组件质感 | ✅ 完成 | diff 整行着色（after-02）、审批卡（after-03）、计划卡（after-04）、账本数字层级（after-05）、检查点时间线点（after-06）截图核对 |
| 应用身份 | ✅ 完成 | 顶栏「白墨 Harness」品牌标记 + 几何墨迹图标（make-icon.mjs 多尺寸 PNG），窗口标题/图标已接线 |
| 内存实测（D-07） | ⚠️ **未达标，如实记录** | 见第三节 |
| 全量回归 | ✅ 93/93 | 见第四节 |

## 三、内存实测（D-07 红线：空闲总 RSS ≤500MB、壳层 ≤300MB）

工具：`apps/desktop/scripts/measure-rss.mjs`（本次收尾提交），用法 `xvfb-run -a node apps/desktop/scripts/measure-rss.mjs`。两种空闲态各采样 3 次取中位；Xvfb 开销不计入进程树。环境：本机 VM（Electron 45、无头 Xvfb、`--no-sandbox`），与真实桌面环境存在差异。

| 态 | 进程数 | 总 RSS 中位 | PSS 中位 | 构成（末次采样） |
|---|---|---|---|---|
| A 无会话空闲（仅 Electron 进程树） | 6 | **615.3 MB**（采样 615.3/615.3/616.4） | 331.5 MB | electron 615.3MB |
| B 会话常驻空闲（跑完一轮后静置，含 Pi 子进程） | 11 | **1125.8 MB**（采样 1121.4/1125.8/1125.8） | 479.2 MB | electron 943.0MB · pi 178.4MB |

对照结论（两种口径都摆出来，不挑好看的）：

- **按 D-07 字面 RSS 口径：超标。** 总 RSS 两态均超 500MB（615.3 / 1125.8）；壳层口径 A 态全树即壳层，615.3MB 亦超 300MB。
- **按 PSS 口径（共享页按比例分摊，更接近真实物理占用）：** 总占用两态在 500MB 内（331.5 / 479.2），但壳层 A 态 PSS 331.5MB 仍略超 300MB 线。
- RSS 求和对 Chromium 多进程共享页存在重复计入，真实占用介于两口径之间；但即便按宽松口径，壳层 300MB 一项仍未达标。此项记为未达标项，留待后续优化与 PLAN 阶段 2 的 Tauri 复盘点作依据（裁决原文：实测超标即立项评估）。本次收尾不改产品代码，不在此处做优化承诺。

## 四、全量回归

命令：`npm run test:regression`（2026-11-24 收尾实跑，exit 0）。

- node 测试（rpc/core/agent-host/ui + tests/regression）：**78/78 通过，fail 0**
- 桌面 E2E（run-e2e.mjs，15 个场景：竖切/回收站/四模式审批/检查点/成本账本/真实 diff/模式授权/计划面板/计划暂停/续接/停止/steering 队列/闲时队列/插件目录/会话回放）：**15/15 通过，fail 0**
- **合计 93/93**，与第七块基线持平，打磨未破坏任何既有功能。

回归过程中 E2E 重拍了 2026-11-21 各阶段的证据截图（25 张）。抽查 `2026-11-21-desktop-mvp/01-vertical-slice.png` 与本次 after-01 对照：同为新 token 色板、新字体渲染、模式色片与 Lucide 风格图标，确认是界面更新后的重拍而非异常改动，已随收尾提交并在提交信息中注明「回归重拍：界面已更新」。

## 五、GitHub 设计调研采纳情况

依据 `~/workspace/your_files/pi-harness/视觉设计资源-GitHub调研.md` 的组合推荐，逐项以 git 提交与代码现状核实：

| 调研项 | 采纳 | 核实依据 |
|---|---|---|
| B2 shadcn/ui dark token 配方（抄配方不抄框架） | ✅ 已采纳 | 提交 `9bf5da2`；styles.css 现含 shadcn 式成对命名：`--background/--foreground`、`--card/--card-foreground`、`--popover/--popover-foreground`、`--muted/--muted-foreground`、`--accent`、`--destructive/--destructive-foreground`、`--border`、`--input`、`--ring`，与自有 `--bg/--panel/--text` 等并存 |
| B1 Lucide 图标 | ✅ 已采纳 | `packages/ui` 依赖 `lucide-react ^1.78.0`；提交 `4f1d2c2` 全量替换字符符号（工具卡/计划步骤/回放/会话/审批），截图中图标风格统一 |
| B5 字体 Inter + JetBrains Mono（Fontsource 自托管） | ✅ 已采纳 | `apps/desktop` 依赖 `@fontsource-variable/inter ^5.3.0`、`@fontsource/jetbrains-mono ^5.3.0`；渲染入口接线，`--font-ui`/`--font-mono` token 落地 |
| A1 Refactoring UI 检查表（规则层） | ⚠️ 部分可核实 | 提交记录显示 token 校准已按其对比度规则（faint 提亮达 WCAG 4.5:1）与 elevation 五级执行（`9bf5da2`）；但完整检查表逐项对照未在仓库中留痕，无法核实是否逐项执行，如实记录，不作「已全表执行」的表述 |
| B4 Style Dictionary（token 构建管线） | ❌ 未采纳 | 全仓无 style-dictionary 依赖；CSS 变量仍集中手写于 `packages/ui/src/styles.css` 单一文件（单一来源已保住，但无 DTCG 管线生成） |
| B3 Radix Primitives（交互原语按缺口补） | ❌ 未引入 | `packages/ui` 依赖仅 lucide-react + react/react-dom，组件仍为自研；本轮未出现必须换原语的缺口记录 |
| A2 官方 frontend-design（方向/流程层）、A3 token 实体结构 | — 无直接留痕 | 无对应提交或文件可核实，不臆断 |

## 六、截图证据

`docs/test-runs/assets/2026-11-24-visual-polish/`，before/after 各 11 张同名对照：
00 空状态 · 01 主执行流 · 02 diff · 03 审批卡 · 04 计划 · 05 账本 · 06 检查点 · 07 闲时队列 · 08 插件 · 09 YOLO 顶栏 · 10 回放。

## 七、未达标与留痕说明（汇总）

1. **D-07 内存预算未达标**（第三节）：RSS 口径总内存与壳层均超线，PSS 口径壳层仍超 300MB。后续优化/Tauri 复盘处理，本块不掩饰。
2. **Refactoring UI 完整检查表逐项对照未留痕**：仅对比度与 elevation 两条规则可由提交核实。
3. **Style Dictionary 管线未引入**：token 单一来源靠手写纪律维持，后续若 token 继续膨胀应补管线。
