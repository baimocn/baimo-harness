/*** 阶段 2 · 引导簇模块 1 桌面 E2E：计划面板（M-03） *****
 * 真实链路：界面开启「计划先行」→ 发任务 → agent 先提交计划（计划卡
 * 待批准、步骤可见）→ 批准 → 逐步执行至已完成、文件真实落盘；
 * 编辑 → 逐行改计划后定稿步数变化；拒绝 → 状态已拒绝且文件不写；
 * 暂停 → 执行中拦截、状态已暂停、文件未写，恢复后新一轮走完。
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

async function waitIdle(page, timeout = 90_000) {
  await waitText(page, '[data-testid="run-status"]', "空闲", timeout);
}

async function newSessionWithPlan(page) {
  await page.click('[data-testid="new-session"]');
  await page.waitForSelector('[data-testid="session-item"]', { timeout: 30_000 });
  await page.click('[data-testid="tab-plan"]');
  await page.check('[data-testid="plan-required-toggle"]');
}

async function send(page, message) {
  await page.fill('[data-testid="composer-input"]', message);
  await page.click('[data-testid="composer-send"]');
}

test(
  "计划面板：批准执行 / 编辑定稿 / 拒绝不执行",
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
      await newSessionWithPlan(page);

      /* ---------- 批准路径 ---------- */
      await send(page, "[[stub:plan]] 完成一件事");
      await page.waitForSelector('[data-testid="plan-card"]', { timeout: 30_000 });
      await waitText(page, '[data-testid="plan-status"]', "待批准");
      assert.equal(
        await page
          .locator('[data-testid="plan-card"] [data-testid="plan-step"]')
          .count(),
        3,
        "计划卡应列出 3 步",
      );
      await page.screenshot({
        path: join(assetsDir, "m1-plan-awaiting.png"),
        fullPage: true,
      });
      await page.click('[data-testid="plan-approve"]');
      await waitIdle(page);
      await waitText(page, '[data-testid="plan-status"]', "已完成");
      assert.equal(
        await page
          .locator(
            '[data-testid="plan-card"] [data-testid="plan-step"][data-status="done"]',
          )
          .count(),
        3,
        "三步应全部 done",
      );
      assert.equal(readFileSync(writePath, "utf8"), STUB_WRITE_CONTENT);
      await page.screenshot({
        path: join(assetsDir, "m1-plan-completed.png"),
        fullPage: true,
      });

      /* ---------- 编辑路径：删到 2 步再批准 ---------- */
      rmSync(writePath);
      await send(page, "[[stub:plan]] 第二件事");
      await page.waitForSelector('[data-testid="plan-approve"]', { timeout: 30_000 });
      await page.click('[data-testid="plan-edit"]');
      await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 30_000 });
      await page.fill(
        '[data-testid="plan-editor-input"]',
        "第一步：查看现状\n第二步：写入文件（改名）",
      );
      await page.screenshot({
        path: join(assetsDir, "m1-plan-editor.png"),
        fullPage: true,
      });
      await page.click('[data-testid="plan-editor-save"]');
      await page.waitForSelector('[data-testid="plan-approve"]', { timeout: 30_000 });
      assert.equal(
        await page
          .locator('[data-testid="plan-card"] [data-testid="plan-step"]')
          .count(),
        2,
        "编辑后计划应只剩 2 步",
      );
      await page.click('[data-testid="plan-approve"]');
      await waitIdle(page);
      await waitText(page, '[data-testid="plan-status"]', "已完成");
      assert.equal(readFileSync(writePath, "utf8"), STUB_WRITE_CONTENT);

      /* ---------- 拒绝路径 ---------- */
      rmSync(writePath);
      await send(page, "[[stub:plan]] 第三件事");
      await page.waitForSelector('[data-testid="plan-deny"]', { timeout: 30_000 });
      await page.click('[data-testid="plan-deny"]');
      await waitIdle(page);
      await waitText(page, '[data-testid="plan-status"]', "已拒绝");
      assert.ok(!existsSync(writePath), "拒绝后文件不得被写");

      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);

test(
  "计划暂停：执行中暂停 → 状态已暂停、文件未写；恢复后新一轮走完",
  { timeout: 300_000 },
  async () => {
    const stub = await createStubModelServer({ chunkDelayMs: 150 });
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
      await newSessionWithPlan(page);

      await send(page, "[[stub:plan]] 暂停测试");
      await page.waitForSelector('[data-testid="plan-approve"]', { timeout: 30_000 });
      await page.click('[data-testid="plan-approve"]');
      // 执行开始后立刻暂停（慢桩每轮约 0.8s，写文件在第 4 轮，来得及拦）
      await page.waitForSelector('[data-testid="plan-pause"]', { timeout: 30_000 });
      await page.click('[data-testid="plan-pause"]');
      await waitIdle(page);
      await waitText(page, '[data-testid="plan-status"]', "已暂停");
      assert.ok(!existsSync(writePath), "暂停后文件不得被写");
      await page.screenshot({
        path: join(assetsDir, "m1-plan-paused.png"),
        fullPage: true,
      });

      // 恢复 + 新一轮：重新提交计划并走完
      await page.click('[data-testid="plan-resume"]');
      await send(page, "[[stub:plan]] 继续完成");
      await page.waitForSelector('[data-testid="plan-approve"]', { timeout: 30_000 });
      await page.click('[data-testid="plan-approve"]');
      await waitIdle(page);
      await waitText(page, '[data-testid="plan-status"]', "已完成");
      assert.equal(readFileSync(writePath, "utf8"), STUB_WRITE_CONTENT);
      assert.deepEqual(pageErrors, []);
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
