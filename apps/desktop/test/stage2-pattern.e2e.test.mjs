/*** 阶段 2 · 引导簇模块 4 桌面 E2E：D-01 命令模式授权 *****
 * 编辑模式下 bash 审批卡多一档「按模式始终允许（touch *）」：点击后
 * 同命令头命令免问直接执行（文件系统断言），审批卡不再出现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStubModelServer } from "../../agent-host/test/fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..");
const assetsDir = join(repoRoot, "docs/test-runs/assets/2026-11-21-stage2-guidance");
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
  "模式授权：审批卡按模式放行 touch → 同头第二条免问执行",
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
    let launched = null;
    try {
      launched = await launchApp(env);
      const { page, pageErrors } = launched;
      await page.click('[data-testid="new-session"]');
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      await page.click('[data-testid="mode-edit"]');

      // 第一条 touch：审批卡出现且带模式档按钮
      await page.fill(
        '[data-testid="composer-input"]',
        "执行 [[stub:bash:touch stub-p-a]]",
      );
      await page.click('[data-testid="composer-send"]');
      await page.waitForSelector('[data-testid="approval-card"]', {
        timeout: 30_000,
      });
      const patternBtn = page.locator('[data-testid="approval-allow-pattern"]');
      await patternBtn.waitFor({ timeout: 10_000 });
      assert.ok(
        (await patternBtn.textContent()).includes("touch *"),
        "模式按钮应预览将授权的模式",
      );
      await page.screenshot({
        path: join(assetsDir, "m4-approval-pattern.png"),
        fullPage: true,
      });
      await patternBtn.click();
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      assert.ok(existsSync(join(workDir, "stub-p-a")), "获准命令应已执行");

      // 第二条同头 touch：不再弹卡，直接执行
      await page.fill(
        '[data-testid="composer-input"]',
        "执行 [[stub:bash:touch stub-p-b]]",
      );
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      assert.equal(
        await page.locator('[data-testid="approval-card"]').count(),
        0,
        "命中模式的命令不得再弹审批卡",
      );
      assert.ok(existsSync(join(workDir, "stub-p-b")), "免问命令应已执行");
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
