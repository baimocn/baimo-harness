/*** 阶段 2 · 模块 3 桌面 E2E：真实 edit/write diff *****
 * 桩模型按标记发真实 write / edit 工具调用，Pi 在工作区真改文件；
 * 断言界面 diff 卡渲染的 +/- 行与桩的改动逐行一致、磁盘内容一致、
 * 改动页签列出两个文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStubModelServer,
  STUB_EDIT_NEW,
  STUB_EDIT_OLD,
  STUB_EDIT_PATH,
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

test(
  "真实 diff：write/edit 工具卡渲染与桩改动逐行一致",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    writeFileSync(
      join(workDir, STUB_EDIT_PATH),
      `line one\n${STUB_EDIT_OLD}\nline three\n`,
    );
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

      // write：diff 卡出现，+ 行与桩内容一致，磁盘一致
      await page.fill('[data-testid="composer-input"]', "[[stub:write]] 请写文件");
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="stream"]', "Stub final answer.");
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      const writeCard = page
        .locator('[data-testid="diff-card"]')
        .filter({ hasText: STUB_WRITE_PATH });
      await writeCard.waitFor({ timeout: 20_000 });
      const writeText = await writeCard.textContent();
      assert.ok(writeText.includes("+ stub line alpha"), writeText);
      assert.ok(writeText.includes("+ stub line beta"), writeText);
      assert.equal(
        readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
        STUB_WRITE_CONTENT,
      );

      // edit：diff 卡 - 旧行 / + 新行，磁盘一致
      await page.fill('[data-testid="composer-input"]', "[[stub:edit]] 请改文件");
      await page.click('[data-testid="composer-send"]');
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="stream"]')?.textContent ?? "")
            .split("Stub final answer.").length >= 3,
        undefined,
        { timeout: 60_000 },
      );
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      const editCard = page
        .locator('[data-testid="diff-card"]')
        .filter({ hasText: STUB_EDIT_PATH });
      await editCard.waitFor({ timeout: 20_000 });
      const editText = await editCard.textContent();
      assert.ok(editText.includes(`- ${STUB_EDIT_OLD}`), editText);
      assert.ok(editText.includes(`+ ${STUB_EDIT_NEW}`), editText);
      assert.equal(
        readFileSync(join(workDir, STUB_EDIT_PATH), "utf8"),
        `line one\n${STUB_EDIT_NEW}\nline three\n`,
      );
      await page.screenshot({
        path: join(assetsDir, "m3-real-diff.png"),
        fullPage: true,
      });

      // 改动页签列出两个文件
      await page.click('[data-testid="tab-changes"]');
      await waitText(page, '[data-testid="panel-changes"]', STUB_WRITE_PATH);
      await waitText(page, '[data-testid="panel-changes"]', STUB_EDIT_PATH);
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
