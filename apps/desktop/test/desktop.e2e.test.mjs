/*** 桌面壳无头 E2E（Playwright Electron + xvfb） *****
 * 竖切：启动渲染三栏 → 新建会话 → 切 YOLO（仅记录）→ 发指令 →
 * 桩模型流式回复 + bash 工具卡（展开见 echo 输出）→ 结算后用量接通 →
 * 改动/检查点页签为真实数据 → 关闭应用 → 重启 → 会话与历史仍在（只读）。
 * 回收站：删除二次确认 → 进回收站 → 还原，全程只动壳层标记，不销毁落盘。
 * 模型一律走 agent-host 的本地桩 fixture，不碰真实账号。
 *
 * 隔离要点：每次启动给独立 XDG_CONFIG_HOME —— Electron 默认 userData 是
 * 全机单例目录，前一个应用未完全退出时后一个应用的窗口会开不出来；
 * 每个应用句柄都在 finally 里 close，失败不许把套件挂死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStubModelServer } from "../../agent-host/test/fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..");
const assetsDir = join(
  repoRoot,
  "docs/test-runs/assets/2026-11-21-desktop-mvp",
);
mkdirSync(assetsDir, { recursive: true });

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

async function launchApp(env) {
  const configHome = makeTmp("baimo-desk-xdg-");
  const app = await _electron.launch({
    executablePath: electronPath,
    args: ["--no-sandbox", desktopRoot],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      XDG_CONFIG_HOME: configHome,
      ...env,
    },
  });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.waitForSelector('[data-testid="statusbar"]', { timeout: 30_000 });
  return { app, page, pageErrors, configHome };
}

async function closeQuietly(launched) {
  if (!launched) return;
  await launched.app.close().catch(() => undefined);
  cleanup(launched.configHome);
}

async function waitText(page, selector, text, timeout = 60_000) {
  await page.waitForFunction(
    ([sel, t]) => document.querySelector(sel)?.textContent?.includes(t),
    [selector, text],
    { timeout },
  );
}

test(
  "竖切：发指令→流式回复+工具卡→落盘→重启后历史仍在",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    const env = {
      BAIMO_DATA_DIR: dataDir,
      BAIMO_WORKSPACE_DIR: workDir,
      BAIMO_PI_HOME: homeDir,
      BAIMO_STUB_MODEL_URL: stub.url,
    };
    let first = null;
    let second = null;
    let sessionTitle = "";
    try {
      // ---------- 第一次启动 ----------
      first = await launchApp(env);
      const { page, pageErrors } = first;
      // 三栏与状态栏：内核版本真实（随附 Pi 1.6.0）、RPC 初始未连接
      const kernel = await page.textContent('[data-testid="kernel-version"]');
      assert.match(kernel, /1\.6\.0/);
      const rpc0 = page.locator('[data-testid="rpc-status"]');
      assert.equal(await rpc0.getAttribute("data-state"), "off");

      // 新建会话 → 列表出现、RPC 转已连接
      await page.click('[data-testid="new-session"]');
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      assert.equal(await page.locator('[data-testid="session-item"]').count(), 1);
      sessionTitle =
        (await page.textContent('[data-testid="session-item"] .session-title'))?.trim() ??
        "";
      assert.ok(sessionTitle.length > 0);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="rpc-status"]')
            ?.getAttribute("data-state") === "on",
        undefined,
        { timeout: 15_000 },
      );

      // 权限模式切换：YOLO 选中 + 警示条如实标注「审批拦截未接入」
      await page.click('[data-testid="mode-yolo"]');
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="mode-yolo"]')
            ?.getAttribute("aria-pressed") === "true",
        undefined,
        { timeout: 10_000 },
      );
      await waitText(page, '[data-testid="yolo-alert"]', "审批拦截", 10_000);

      // 发指令 → 流式回复（先到第一轮文本，再到最终文本）
      await page.fill(
        '[data-testid="composer-input"]',
        "请打个招呼并执行工具",
      );
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="stream"]', "Stub says hello.");
      await waitText(page, '[data-testid="stream"]', "Stub final answer.");

      // 工具卡：bash 摘要出现，展开见 echo 输出
      await page.waitForSelector('[data-testid="tool-card"]', {
        timeout: 30_000,
      });
      const cardText = await page.textContent('[data-testid="tool-card"]');
      assert.match(cardText, /bash/);
      assert.match(cardText, /echo stub-tool-ok/);
      await page.click('[data-testid="tool-card-header"]');
      await waitText(page, '[data-testid="tool-card-output"]', "stub-tool-ok");

      // 结算后回到空闲；用量/圆环接通真实统计（不再是未接入）
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="context-ring"]')
            ?.getAttribute("data-state") === "live",
        undefined,
        { timeout: 20_000 },
      );
      const statsLine = await page.textContent('[data-testid="stats-line"]');
      assert.match(statsLine, /tokens 合计 [1-9]\d*/);

      // 右栏：改动为空（bash 不产生文件改动，如实空态）；检查点有真实里程碑
      await page.click('[data-testid="tab-changes"]');
      await waitText(page, '[data-testid="panel-changes"]', "暂无文件改动");
      await page.click('[data-testid="tab-checkpoints"]');
      await waitText(page, '[data-testid="panel-checkpoints"]', "运行完成");

      await page.screenshot({
        path: join(assetsDir, "01-vertical-slice.png"),
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
      await closeQuietly(first);
      first = null;

      // 落盘证据：模式被记录、事件日志含 agent_settled 与工具输出
      const settings = JSON.parse(
        readFileSync(join(dataDir, "desktop-settings.json"), "utf8"),
      );
      assert.equal(settings.permissionMode, "yolo");
      const index = JSON.parse(
        readFileSync(join(dataDir, "sessions/index.json"), "utf8"),
      );
      assert.equal(index.sessions.length, 1);
      const sid = index.sessions[0].id;
      assert.equal(settings.perSessionMode[sid], "yolo");
      const log = readFileSync(
        join(dataDir, "sessions", sid, "events.jsonl"),
        "utf8",
      );
      assert.match(log, /agent_settled/);
      assert.match(log, /stub-tool-ok/);

      // ---------- 重启：会话与历史仍在 ----------
      second = await launchApp(env);
      await second.page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      const title2 =
        (await second.page.textContent(
          '[data-testid="session-item"] .session-title',
        ))?.trim() ?? "";
      assert.equal(title2, sessionTitle);
      // 历史会话未托管子进程：RPC 未连接、只读横幅在
      assert.equal(
        await second.page
          .locator('[data-testid="rpc-status"]')
          .getAttribute("data-state"),
        "off",
      );
      await second.page.click('[data-testid="session-item"]');
      await waitText(
        second.page,
        '[data-testid="stream"]',
        "Stub final answer.",
        30_000,
      );
      await waitText(second.page, '[data-testid="msg-user"]', "请打个招呼并执行工具");
      assert.equal(
        await second.page.locator('[data-testid="tool-card"]').count(),
        1,
      );
      await second.page.waitForSelector('[data-testid="readonly-banner"]');
      await second.page.screenshot({
        path: join(assetsDir, "02-history-after-restart.png"),
        fullPage: true,
      });
      assert.deepEqual(second.pageErrors, []);
      await closeQuietly(second);
      second = null;
    } finally {
      await closeQuietly(first);
      await closeQuietly(second);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);

test(
  "回收站：删除二次确认→进回收站→还原（落盘不销毁）",
  { timeout: 180_000 },
  async () => {
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    const env = {
      BAIMO_DATA_DIR: dataDir,
      BAIMO_WORKSPACE_DIR: workDir,
      BAIMO_PI_HOME: homeDir,
    };
    let launched = null;
    try {
      launched = await launchApp(env);
      const { page, pageErrors } = launched;
      await page.click('[data-testid="new-session"]');
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      const indexPath = join(dataDir, "sessions/index.json");
      const sid = JSON.parse(readFileSync(indexPath, "utf8")).sessions[0].id;

      await page.hover('[data-testid="session-item"]');
      await page.click('[data-testid="delete-session"]');
      await page.waitForSelector('[data-testid="delete-dialog"]');
      await page.click('[data-testid="confirm-delete"]');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="session-item"]').length === 0,
        undefined,
        { timeout: 15_000 },
      );
      assert.equal(
        await page.locator('[data-testid="trash-item"]').count(),
        1,
      );
      // 落盘未销毁：会话目录仍在
      assert.ok(
        existsSync(join(dataDir, "sessions", sid, "events.jsonl")),
        "回收站只是标记，落盘数据不应被删除",
      );
      await page.screenshot({
        path: join(assetsDir, "03-trash.png"),
        fullPage: true,
      });

      await page.click('[data-testid="restore-session"]');
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 15_000,
      });
      assert.equal(
        await page.locator('[data-testid="trash-item"]').count(),
        0,
      );
      assert.deepEqual(pageErrors, []);
      await closeQuietly(launched);
      launched = null;
    } finally {
      await closeQuietly(launched);
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
