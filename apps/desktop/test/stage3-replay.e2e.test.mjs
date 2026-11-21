/*** 阶段 3 · 模块 3 桌面 E2E：会话回放 *****
 * 真实链路：先跑一轮真实运行（bash 工具 + 最终答复），再进回放：
 * 起点画面为空、单步推进、4 倍速播放到结尾时画面与实时一致
 * （最终答复 + 工具卡 + 完成标记）；全程只读——落盘 eventCount
 * 与桩模型请求数在回放前后严格不变（不产生新运行、不改落盘）；
 * 退出回放后原执行流原样恢复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  try {
    await page.waitForSelector('[data-testid="statusbar"]', { timeout: 90_000 });
  } catch (err) {
    await app.close().catch(() => undefined);
    cleanup(configHome);
    throw err;
  }
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

function readEventCount(dataDir, sessionId) {
  const meta = JSON.parse(
    readFileSync(join(dataDir, "sessions", sessionId, "session.json"), "utf8"),
  );
  return meta.eventCount;
}

test(
  "会话回放：逐步重放与实时同口径，全程只读不改落盘",
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

      // 先跑一轮真实运行
      await page.click('[data-testid="new-session"]');
      const sessionItem = page.locator('[data-testid="session-item"]').first();
      await sessionItem.waitFor({ timeout: 30_000 });
      const sessionId = await sessionItem.getAttribute("data-session-id");
      assert.ok(sessionId);
      await page.fill('[data-testid="composer-input"]', "回放素材：跑一轮工具调用");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 90_000);
      await waitText(page, '[data-testid="stream"]', "Stub final answer.", 30_000);

      const eventCountBefore = readEventCount(dataDir, sessionId);
      const stubRequestsBefore = stub.requests.length;
      assert.ok(eventCountBefore > 10, "落盘事件应已积累");

      // 进入回放：起点画面为空、进度 0/N
      await page.click('[data-testid="replay-start"]');
      await page.waitForSelector('[data-testid="replay-bar"]', { timeout: 15_000 });
      const progress0 = await page.textContent('[data-testid="replay-progress"]');
      const total = Number(progress0.match(/\/\s*(\d+)/)?.[1]);
      assert.ok(total > 5, `回放事件总数应 >5，实际进度: ${progress0}`);
      assert.ok(progress0.includes("事件 0"), `起点应为 0，实际: ${progress0}`);
      let streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(
        !streamText.includes("Stub final answer."),
        "回放起点不应出现最终答复",
      );
      // 回放中输入区禁用（只读）
      assert.equal(
        await page.isDisabled('[data-testid="composer-input"]'),
        true,
        "回放中输入区应禁用",
      );

      // 单步前进 3 步
      for (let i = 0; i < 3; i++) {
        await page.click('[data-testid="replay-step-forward"]');
      }
      const progress3 = await page.textContent('[data-testid="replay-progress"]');
      assert.ok(progress3.includes("事件 3"), `单步后应为 3，实际: ${progress3}`);
      await page.screenshot({
        path: join(assetsDir, "m3-replay-mid.png"),
        fullPage: true,
      });

      // 4 倍速播放到结尾：画面与实时一致
      await page.selectOption('[data-testid="replay-speed"]', "4");
      await page.click('[data-testid="replay-toggle"]');
      await page.waitForFunction(
        (t) =>
          document
            .querySelector('[data-testid="replay-progress"]')
            ?.textContent?.includes(`事件 ${t} /`),
        total,
        { timeout: 90_000 },
      );
      streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(streamText.includes("Stub final answer."), "回放结尾应有最终答复");
      assert.ok(
        (await page.locator('[data-testid="tool-card"]').count()) >= 1,
        "回放结尾应有工具卡",
      );
      await page.screenshot({
        path: join(assetsDir, "m3-replay-end.png"),
        fullPage: true,
      });

      // 只读铁证：落盘事件数与桩请求数不变
      assert.equal(
        readEventCount(dataDir, sessionId),
        eventCountBefore,
        "回放不得改落盘（eventCount 不变）",
      );
      assert.equal(
        stub.requests.length,
        stubRequestsBefore,
        "回放不得产生新运行（桩请求数不变）",
      );

      // 退出回放：原执行流恢复、输入区可用
      await page.click('[data-testid="replay-exit"]');
      await page.waitForSelector('[data-testid="replay-bar"]', {
        state: "detached",
        timeout: 15_000,
      });
      streamText = await page.textContent('[data-testid="stream"]');
      assert.ok(streamText.includes("Stub final answer."), "退出回放后原执行流应恢复");
      assert.equal(
        await page.isDisabled('[data-testid="composer-input"]'),
        false,
        "退出回放后输入区应恢复可用",
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
