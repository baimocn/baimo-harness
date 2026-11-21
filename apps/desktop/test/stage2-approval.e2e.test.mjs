/*** 阶段 2 · 模块 4 桌面 E2E：权限模式与分级审批 *****
 * 单会话内逐模式实测（模式切换经策略文件即时生效）：
 * 计划 → write 被拦、显形、文件未变；
 * 编辑 → 审批卡出现，拒绝 → 文件未变；再发 → 允许一次 → 文件落盘；
 * 构建 → 普通写无卡自动过；危险 bash 弹卡（带危险标记），拒绝收尾；
 * YOLO → 危险 bash 无卡自动完成。
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
import {
  createStubModelServer,
  STUB_WRITE_CONTENT,
  STUB_WRITE_PATH,
} from "../../agent-host/test/fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..");
const assetsDir = join(repoRoot, "docs/test-runs/assets/2026-11-21-stage2-control");
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

async function sendAndSettle(page, message) {
  await page.fill('[data-testid="composer-input"]', message);
  await page.click('[data-testid="composer-send"]');
  await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
}

test(
  "四模式审批：计划拦截 / 编辑弹卡裁决 / 构建危险弹卡 / YOLO 全自动",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    const writePath = join(workDir, STUB_WRITE_PATH);
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

      /* ---------- 计划模式：拦截 + 显形 + 文件未变 ---------- */
      await page.click('[data-testid="mode-plan"]');
      await sendAndSettle(page, "[[stub:write]] 请写文件");
      await waitText(page, '[data-testid="stream"]', "计划模式已拦截写操作");
      assert.ok(!existsSync(writePath), "计划模式下文件不得被创建");
      await page.screenshot({
        path: join(assetsDir, "m4-plan-blocked.png"),
        fullPage: true,
      });

      /* ---------- 编辑模式：弹卡 → 拒绝 → 文件未变 ---------- */
      await page.click('[data-testid="mode-edit"]');
      await page.fill('[data-testid="composer-input"]', "[[stub:write]] 请写文件");
      await page.click('[data-testid="composer-send"]');
      await page.waitForSelector('[data-testid="approval-card"]', {
        timeout: 30_000,
      });
      const cardText = await page.textContent('[data-testid="approval-card"]');
      assert.ok(cardText.includes("write"), cardText);
      assert.ok(cardText.includes(STUB_WRITE_PATH), cardText);
      assert.ok(cardText.includes("编辑模式"), cardText);
      await page.screenshot({
        path: join(assetsDir, "m4-approval-card-edit.png"),
        fullPage: true,
      });
      await page.click('[data-testid="approval-deny"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      await waitText(page, '[data-testid="stream"]', "已拒绝执行");
      assert.ok(!existsSync(writePath), "拒绝后文件不得被创建");

      /* ---------- 编辑模式：弹卡 → 允许一次 → 文件落盘 ---------- */
      await page.fill('[data-testid="composer-input"]', "[[stub:write]] 请写文件");
      await page.click('[data-testid="composer-send"]');
      await page.waitForSelector('[data-testid="approval-card"]', {
        timeout: 30_000,
      });
      await page.click('[data-testid="approval-allow-once"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      assert.equal(readFileSync(writePath, "utf8"), STUB_WRITE_CONTENT);

      /* ---------- 构建模式：普通写无卡自动过 ---------- */
      await page.click('[data-testid="mode-build"]');
      rmSync(writePath);
      await sendAndSettle(page, "[[stub:write]] 请写文件");
      assert.equal(
        await page.locator('[data-testid="approval-card"]').count(),
        0,
        "构建模式普通写不应弹卡",
      );
      assert.equal(readFileSync(writePath, "utf8"), STUB_WRITE_CONTENT);

      /* ---------- 构建模式：危险 bash 弹卡（危险标记）→ 拒绝 ---------- */
      await page.fill('[data-testid="composer-input"]', "[[stub:bash-danger]] 请清理");
      await page.click('[data-testid="composer-send"]');
      await page.waitForSelector('[data-testid="approval-card"]', {
        timeout: 30_000,
      });
      const dangerText = await page.textContent('[data-testid="approval-card"]');
      assert.ok(dangerText.includes("危险命令"), dangerText);
      assert.ok(dangerText.includes("rm -rf"), dangerText);
      await page.screenshot({
        path: join(assetsDir, "m4-approval-card-danger.png"),
        fullPage: true,
      });
      await page.click('[data-testid="approval-deny"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);

      /* ---------- YOLO：危险 bash 无卡自动完成 ---------- */
      await page.click('[data-testid="mode-yolo"]');
      await sendAndSettle(page, "[[stub:bash-danger]] 请清理");
      assert.equal(
        await page.locator('[data-testid="approval-card"]').count(),
        0,
        "YOLO 不应弹卡",
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
