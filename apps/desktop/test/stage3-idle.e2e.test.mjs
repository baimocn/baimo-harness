/*** 阶段 3 · 模块 1 桌面 E2E：闲时队列（M-14） *****
 * 真实链路：界面投递两条闲时任务（新会话 / 当前会话），未启用时
 * 只排队不执行（桩请求为空，D-01）；启用后全局空闲按序自动跑完，
 * 状态逐条落到「已完成」并回填执行会话；当前会话的任务在该会话
 * 执行流里真实发生，且运行前后的检查点照常打点（M-06 链路未被绕过）。
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
const assetsDir = join(repoRoot, "docs/test-runs/assets/2026-11-21-stage3");
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

test(
  "闲时队列：未启用只排队，启用后新会话与当前会话任务按序跑完",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer({});
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

      // 先建一个前台会话（第二条任务的目标）
      await page.click('[data-testid="new-session"]');
      const sessionItem = page.locator('[data-testid="session-item"]').first();
      await sessionItem.waitFor({ timeout: 30_000 });
      const fgSessionId = await sessionItem.getAttribute("data-session-id");
      assert.ok(fgSessionId);

      // 打开闲时页签：状态栏应显示队列关
      await page.click('[data-testid="tab-idle"]');
      await page.waitForSelector('[data-testid="panel-idle"]', { timeout: 15_000 });
      const idleStatus = await page.textContent('[data-testid="idle-status"]');
      assert.ok(idleStatus.includes("关"), `状态栏应显示闲时队列关，实际: ${idleStatus}`);

      // 投递任务一（新会话）
      await page.fill('[data-testid="idle-prompt-input"]', "闲时任务一：新会话执行");
      await page.click('[data-testid="idle-enqueue"]');
      await page.waitForSelector('[data-testid="idle-item"][data-status="queued"]', {
        timeout: 15_000,
      });
      // 投递任务二（当前会话）
      await page.selectOption('[data-testid="idle-target-select"]', "session");
      await page.fill('[data-testid="idle-prompt-input"]', "闲时任务二：当前会话执行");
      await page.click('[data-testid="idle-enqueue"]');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="idle-item"][data-status="queued"]').length === 2,
        { timeout: 15_000 },
      );
      // 未启用：给足调度窗口，桩不得收到任何请求（D-01 不自启动）
      await page.waitForTimeout(2000);
      assert.equal(stub.requests.length, 0, "未启用时闲时任务绝不自启动");
      await page.screenshot({
        path: join(assetsDir, "m1-idle-queued.png"),
        fullPage: true,
      });

      // 启用 → 按序自动执行
      await page.click('[data-testid="idle-enable-toggle"]');
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="idle-item"][data-status="done"]').length === 2,
        { timeout: 180_000 },
      );
      const allReq = JSON.stringify(stub.requests.map((r) => r.messages ?? []));
      const idx1 = allReq.indexOf("闲时任务一");
      const idx2 = allReq.indexOf("闲时任务二");
      assert.ok(idx1 >= 0 && idx2 > idx1, "应按入队顺序执行（任务一先于任务二）");
      // 任务二回填的执行会话应为前台会话（界面截断显示前 8 位）
      const itemsText = await page.textContent('[data-testid="panel-idle"]');
      assert.ok(
        itemsText.includes(fgSessionId.slice(0, 8)),
        "任务二应回填前台会话 id",
      );
      await page.screenshot({
        path: join(assetsDir, "m1-idle-done.png"),
        fullPage: true,
      });

      // 当前会话执行流里有任务二的真实运行；检查点照常打点（链路未被绕过）
      await page.click('[data-testid="tab-checkpoints"]');
      await page.waitForSelector('[data-testid="checkpoint-item"]', {
        timeout: 30_000,
      });
      const streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(streamText.includes("Stub final answer."), "当前会话应有闲时任务的运行结果");
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
