/*** 阶段 2 · 引导簇模块 3 桌面 E2E：成本账本 + 预算熔断（M-07） *****
 * 真实链路：在账本页签给桩模型定价（input $1000 / output $5000 每 1M）→
 * 跑一轮（2 次调用 = $0.07）→ 顶栏读数与账本汇总显示 $0.0700、账目落盘 →
 * 设单次上限 $0.03 并切到 YOLO → 再跑一轮 → 执行流出现「预算熔断」红色
 * 说明（成本 vs 上限），不记正常完成；YOLO 同样受熔断约束。
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
  "成本账本：定价 → 记账读数对得上 → 设单次上限 → YOLO 下照样熔断",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer({ chunkDelayMs: 150 });
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

      // 账本页签：给当前模型（stub/stub-model）定价
      await page.click('[data-testid="tab-ledger"]');
      await page.waitForSelector('[data-testid="panel-ledger"]', {
        timeout: 15_000,
      });
      await page.fill('[data-testid="price-input"]', "1000");
      await page.fill('[data-testid="price-output"]', "5000");
      await page.fill('[data-testid="price-cache-read"]', "100");
      await page.fill('[data-testid="price-cache-write"]', "1000");
      await page.click('[data-testid="pricing-save"]');

      // 跑一轮普通任务（2 次调用 → $0.07）
      await page.fill('[data-testid="composer-input"]', "普通任务一轮");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="cost-readout"]', "$0.0700", 90_000);
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      // 账本汇总与账目
      await waitText(page, '[data-testid="ledger-session-cost"]', "$0.0700", 30_000);
      assert.equal(
        await page.locator('[data-testid="ledger-entry"]').count(),
        1,
        "应有恰好一笔账目",
      );
      await page.screenshot({
        path: join(assetsDir, "m3-ledger-after-run.png"),
        fullPage: true,
      });

      // 设单次上限 $0.03（低于单轮 $0.035），切 YOLO 再跑 → 熔断
      await page.fill('[data-testid="budget-run-cap"]', "0.03");
      await page.click('[data-testid="budgets-save"]');
      await page.click('[data-testid="mode-yolo"]');
      await page.fill('[data-testid="composer-input"]', "YOLO 也不能烧穿预算");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="stream"]', "预算熔断", 90_000);
      await waitText(page, '[data-testid="stream"]', "$0.0350", 30_000);
      await waitText(page, '[data-testid="run-status"]', "空闲", 60_000);
      const streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(
        streamText.includes("超过上限 $0.0300"),
        "熔断说明应含上限金额",
      );
      await page.screenshot({
        path: join(assetsDir, "m3-budget-fused-yolo.png"),
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
