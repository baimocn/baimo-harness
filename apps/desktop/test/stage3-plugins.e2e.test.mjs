/*** 阶段 3 · 模块 2 桌面 E2E：插件目录（M-15） *****
 * 真实链路：数据目录预置示例插件 + 语法坏插件 → 插件面板里示例
 * 插件带名带版本呈现、坏插件红字点名显形；新建会话后模型调用
 * plugin_echo 真实成功（结果带 PLUGIN-ECHO 标记并回喂模型）；
 * 在面板停用示例插件后再建会话，同一调用变未知工具错误——
 * 启停对新建会话生效，进行中会话不变（口径与面板文案一致）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import electronPath from "electron";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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
const assetsDir = join(repoRoot, "docs/test-runs/assets/2026-11-21-stage3");
mkdirSync(assetsDir, { recursive: true });
const EXAMPLE_PLUGIN = join(
  repoRoot,
  "apps/agent-host/plugins-examples/echo-plugin.mjs",
);
const EXAMPLE_SIDECAR = join(
  repoRoot,
  "apps/agent-host/plugins-examples/echo-plugin.plugin.json",
);

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
    // 全套件并行启动多个 Electron 时 1.5 核 CPU 争抢严重，首屏等待放宽；
    // 失败必须关掉应用，否则泄漏的进程会把整个套件挂死（实测教训）。
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

test(
  "插件目录：面板显形坏插件；启用时工具生效，停用后新会话里失效",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer({});
    const dataDir = makeTmp("baimo-desk-data-");
    const workDir = makeTmp("baimo-desk-work-");
    const homeDir = makeTmp("baimo-desk-home-");
    // 预置插件目录：示例插件 + 语法坏插件
    const pluginsDir = join(dataDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    copyFileSync(EXAMPLE_PLUGIN, join(pluginsDir, "echo-plugin.mjs"));
    copyFileSync(EXAMPLE_SIDECAR, join(pluginsDir, "echo-plugin.plugin.json"));
    writeFileSync(
      join(pluginsDir, "broken-plugin.mjs"),
      "export default function (pi) { this is not valid js\n",
      "utf8",
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

      // 插件面板：示例插件带名带版本；坏插件红字点名
      await page.click('[data-testid="tab-plugins"]');
      await page.waitForSelector(
        '[data-testid="plugin-item"][data-file-name="echo-plugin.mjs"]',
        { timeout: 15_000 },
      );
      const echoItem = page.locator(
        '[data-testid="plugin-item"][data-file-name="echo-plugin.mjs"]',
      );
      assert.ok((await echoItem.textContent()).includes("回声示例插件"));
      assert.equal(await echoItem.getAttribute("data-enabled"), "true");
      const brokenItem = page.locator(
        '[data-testid="plugin-item"][data-file-name="broken-plugin.mjs"]',
      );
      const brokenError = await brokenItem
        .locator('[data-testid="plugin-error"]')
        .textContent();
      assert.ok(
        brokenError.includes("broken-plugin.mjs"),
        `坏插件错误应点名文件，实际: ${brokenError}`,
      );
      await page.screenshot({
        path: join(assetsDir, "m2-plugins-panel.png"),
        fullPage: true,
      });

      // 注意：broken-plugin 处于启用状态会让新会话启动失败——先在面板停用它，
      // 这正是面板显形的用途；停用后建会话验证示例插件生效。
      await brokenItem.locator('[data-testid="plugin-toggle"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(
              '[data-testid="plugin-item"][data-file-name="broken-plugin.mjs"]',
            )
            ?.getAttribute("data-enabled") === "false",
        { timeout: 15_000 },
      );

      await page.click('[data-testid="new-session"]');
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      await page.fill(
        '[data-testid="composer-input"]',
        "[[stub:plugin-echo]] 测插件",
      );
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 90_000);
      const card = page.locator(
        '[data-testid="tool-card"][data-tool="plugin_echo"]',
      );
      await card.waitFor({ timeout: 15_000 });
      await card.locator('[data-testid="tool-card-header"]').click();
      const output = await card
        .locator('[data-testid="tool-card-output"]')
        .textContent();
      assert.ok(
        output.includes("PLUGIN-ECHO: HELLO PLUGIN"),
        `插件工具输出应带标记，实际: ${output}`,
      );
      assert.ok(
        JSON.stringify(stub.requests).includes("PLUGIN-ECHO"),
        "插件结果应回喂模型",
      );
      await page.screenshot({
        path: join(assetsDir, "m2-plugin-tool.png"),
        fullPage: true,
      });

      // 停用示例插件 → 新会话里同一调用变未知工具错误
      await page.click('[data-testid="tab-plugins"]');
      await echoItem.locator('[data-testid="plugin-toggle"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(
              '[data-testid="plugin-item"][data-file-name="echo-plugin.mjs"]',
            )
            ?.getAttribute("data-enabled") === "false",
        { timeout: 15_000 },
      );
      await page.click('[data-testid="new-session"]');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="session-item"]').length >= 2,
        { timeout: 30_000 },
      );
      const before = stub.requests.length;
      await page.fill(
        '[data-testid="composer-input"]',
        "[[stub:plugin-echo]] 再测插件",
      );
      await page.click('[data-testid="composer-send"]');
      await waitText(page, '[data-testid="run-status"]', "空闲", 90_000);
      const newReqs = JSON.stringify(stub.requests.slice(before));
      assert.ok(
        newReqs.includes("Tool plugin_echo not found"),
        "停用后新会话里 plugin_echo 应为未知工具",
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
