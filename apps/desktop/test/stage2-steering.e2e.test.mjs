/*** 阶段 2 · 引导簇模块 2 桌面 E2E：Steering 队列（M-04） *****
 * 真实链路：运行中在输入区排队两条（注入纠正 steer + 排队 follow_up），
 * 队列条逐条可见；撤回 follow_up 后它绝不到达模型（桩请求记录断言），
 * steer 在运行中投递并以用户消息形态出现在执行流里，队列条标已投递。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  "steering 队列：运行中入队两条 → 撤回一条 → 另一条投递进执行流",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer({ chunkDelayMs: 250 });
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

      // 主任务开始运行（慢桩每轮约 1.25s）
      await page.fill('[data-testid="composer-input"]', "主任务：先做一轮工具调用");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="run-status"]', "运行中", 30_000);

      // 注入纠正（steer）
      await page.fill('[data-testid="composer-input"]', "STEER-TEXT-UI");
      await page.click('[data-testid="queue-kind-steer"]');
      await page.click('[data-testid="composer-send"]');
      // 排队（follow_up，缺省方式）
      await page.fill('[data-testid="composer-input"]', "FOLLOW-TEXT-UI");
      await page.click('[data-testid="queue-kind-followup"]');
      await page.click('[data-testid="composer-send"]');

      // 队列条：两条待投递、种类正确
      await page.waitForSelector('[data-testid="queue-strip"]', { timeout: 15_000 });
      assert.equal(
        await page.locator('[data-testid="queue-entry"]').count(),
        2,
      );
      assert.equal(
        await page
          .locator('[data-testid="queue-entry"][data-status="queued"]')
          .count(),
        2,
      );
      await page.screenshot({
        path: join(assetsDir, "m2-queue-strip.png"),
        fullPage: true,
      });

      // 撤回 follow_up
      await page.click(
        '[data-testid="queue-entry"][data-kind="follow_up"] [data-testid="queue-withdraw"]',
      );
      await page.waitForSelector(
        '[data-testid="queue-entry"][data-kind="follow_up"][data-status="withdrawn"]',
        { timeout: 15_000 },
      );

      // 运行结算：steer 已投递并出现在执行流（用户消息形态）
      await waitText(page, '[data-testid="run-status"]', "空闲", 90_000);
      const streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(streamText.includes("STEER-TEXT-UI"), "steer 应投递进执行流");
      assert.ok(
        !streamText.includes("FOLLOW-TEXT-UI"),
        "被撤回的 follow_up 不得出现在执行流",
      );
      await page.waitForSelector(
        '[data-testid="queue-entry"][data-kind="steer"][data-status="delivered"]',
        { timeout: 15_000 },
      );
      // 模型侧铁证：steer 到达过、follow 从未到达
      const allRequests = JSON.stringify(stub.requests);
      assert.ok(allRequests.includes("STEER-TEXT-UI"));
      assert.ok(!allRequests.includes("FOLLOW-TEXT-UI"));
      await page.screenshot({
        path: join(assetsDir, "m2-queue-delivered.png"),
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
