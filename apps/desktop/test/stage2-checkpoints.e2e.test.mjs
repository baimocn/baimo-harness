/*** 阶段 2 · 模块 2 桌面 E2E：Git 检查点（M-06） *****
 * 流程：工作区预置 note.txt=v1 → 跑一轮（运行开始自动打点）→
 * 外部把 note.txt 改成 v2 → 再跑一轮（打点捕获 v2）→ 在检查点页签
 * 回滚到第一张快照 → 断言文件内容回到 v1、流里有回滚报告 →
 * 手动打点（状态已变，新增一张）。快照只落数据目录，不进工作区。
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
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStubModelServer } from "../../agent-host/test/fixtures/stub-model-server.mjs";

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

async function waitFileContent(path, expected, timeout = 20_000) {
  const start = Date.now();
  for (;;) {
    try {
      if (readFileSync(path, "utf8") === expected) return;
    } catch {
      /* 文件可能正被写入 */
    }
    if (Date.now() - start > timeout) {
      throw new Error(`等待文件内容超时: ${path} 期望 ${JSON.stringify(expected)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test(
  "检查点：自动打点 → 再改 → 回滚断言文件恢复到检查点时刻",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    const notePath = join(workDir, "note.txt");
    writeFileSync(notePath, "v1");
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

      // 第一轮：运行开始自动打点（v1 状态）
      await page.fill('[data-testid="composer-input"]', "第一轮");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="stream"]', "Stub final answer.");
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      await page.click('[data-testid="tab-checkpoints"]');
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="checkpoint-item"]').length === 1,
        undefined,
        { timeout: 20_000 },
      );

      // 外部改动（模拟一批文件改动落盘）→ 第二轮打点捕获 v2
      writeFileSync(notePath, "v2");
      await page.fill('[data-testid="composer-input"]', "第二轮");
      await page.click('[data-testid="composer-send"]');
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="stream"]')?.textContent ?? "")
            .split("Stub final answer.").length >= 3,
        undefined,
        { timeout: 60_000 },
      );
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="checkpoint-item"]').length === 2,
        undefined,
        { timeout: 20_000 },
      );
      assert.equal(readFileSync(notePath, "utf8"), "v2");

      // 回滚到最旧一张（v1 时刻）：列表最新在前，最旧在末行
      const items = page.locator('[data-testid="checkpoint-item"]');
      await items
        .last()
        .locator('[data-testid="checkpoint-rollback"]')
        .click();
      await waitFileContent(notePath, "v1");
      await waitText(page, '[data-testid="stream"]', "已回滚到检查点");
      await waitText(page, '[data-testid="stream"]', "校验通过");

      // 手动打点：当前 v1 与最近检查点（v2）不同 → 新增一张
      await page.click('[data-testid="checkpoint-create"]');
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="checkpoint-item"]').length === 3,
        undefined,
        { timeout: 20_000 },
      );
      await page.screenshot({
        path: join(assetsDir, "m2-checkpoints-panel.png"),
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
      await closeQuietly(launched);
      launched = null;

      // 落盘证据：快照在数据目录下，工作区里没有多出任何快照文件
      const index = JSON.parse(
        readFileSync(join(dataDir, "sessions/index.json"), "utf8"),
      );
      const sid = index.sessions[0].id;
      const ckptRoot = join(dataDir, "checkpoints", sid);
      assert.ok(existsSync(ckptRoot), "检查点应落在数据目录");
      assert.ok(readdirSync(ckptRoot).length >= 3);
      assert.deepEqual(readdirSync(workDir).sort(), ["note.txt"]);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
