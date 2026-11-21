/*** 阶段 2 · 模块 1 桌面 E2E：会话续接 + 停止 *****
 * 续接：跑完一轮 → 关应用 → 重启 → 历史会话点「继续会话」→ 恢复 live →
 * 发第二轮完成；且桩模型收到的第二轮首个请求带着第一轮 prompt
 * （上下文真续上，不是新会话冒充）。
 * 停止：hang 桩让运行挂住 → 运行中发送键变停止键 → 点停止 →
 * 流里出现「已停止」标记、回到空闲，落盘为 run_stopped 且无 run_settled。
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

function readLog(dataDir) {
  const index = JSON.parse(
    readFileSync(join(dataDir, "sessions/index.json"), "utf8"),
  );
  const sid = index.sessions[0].id;
  return readFileSync(join(dataDir, "sessions", sid, "events.jsonl"), "utf8");
}

test(
  "续接：重启后点「继续会话」，第二轮带第一轮上下文跑通",
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
    let first = null;
    let second = null;
    try {
      first = await launchApp(env);
      await first.page.click('[data-testid="new-session"]');
      await first.page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      await first.page.fill('[data-testid="composer-input"]', "第一轮问题");
      await first.page.click('[data-testid="composer-send"]');
      await waitText(first.page, '[data-testid="stream"]', "Stub final answer.");
      await waitText(first.page, '[data-testid="run-status"]', "空闲", 30_000);
      assert.deepEqual(first.pageErrors, []);
      await closeQuietly(first);
      first = null;

      const requestsBeforeResume = stub.requests.length;

      second = await launchApp(env);
      await second.page.waitForSelector('[data-testid="session-item"]', {
        timeout: 30_000,
      });
      await second.page.click('[data-testid="session-item"]');
      await second.page.waitForSelector('[data-testid="readonly-banner"]');
      // 续接：点「继续会话」→ 横幅消失、RPC 恢复连接
      await second.page.click('[data-testid="resume-session"]');
      await second.page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="readonly-banner"]') &&
          document
            .querySelector('[data-testid="rpc-status"]')
            ?.getAttribute("data-state") === "on",
        undefined,
        { timeout: 30_000 },
      );
      // 第二轮：流里应出现第二次 final answer
      await second.page.fill('[data-testid="composer-input"]', "第二轮问题");
      await second.page.click('[data-testid="composer-send"]');
      await second.page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="stream"]')?.textContent ?? "")
            .split("Stub final answer.").length >= 3,
        undefined,
        { timeout: 60_000 },
      );
      await waitText(second.page, '[data-testid="run-status"]', "空闲", 30_000);
      await second.page.screenshot({
        path: join(assetsDir, "m1-resume-second-run.png"),
        fullPage: true,
      });
      assert.deepEqual(second.pageErrors, []);
      await closeQuietly(second);
      second = null;

      // 上下文证据：续接后首个模型请求带第一轮 prompt
      assert.ok(stub.requests.length > requestsBeforeResume);
      const resumedReq = JSON.stringify(
        stub.requests[requestsBeforeResume].messages ?? [],
      );
      assert.ok(
        resumedReq.includes("第一轮问题"),
        "续接后的请求必须带第一轮上下文",
      );
      const log = readLog(dataDir);
      assert.match(log, /session_resumed/);
      assert.equal((log.match(/run_settled/g) ?? []).length, 2);
    } finally {
      await closeQuietly(first);
      await closeQuietly(second);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);

test(
  "停止：运行中点停止键 → 已停止收尾且落盘一致",
  { timeout: 180_000 },
  async () => {
    const stub = await createStubModelServer({ hang: true });
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
      await page.fill('[data-testid="composer-input"]', "会挂住的问题");
      await page.click('[data-testid="composer-send"]');
      // 运行中：发送键变停止键
      await page.waitForSelector('[data-testid="composer-stop"]', {
        timeout: 30_000,
      });
      await waitText(page, '[data-testid="run-status"]', "运行中", 15_000);
      await page.click('[data-testid="composer-stop"]');
      // 已停止收尾：流里出现「已停止」标记，回到空闲，发送键恢复
      await waitText(page, '[data-testid="stream"]', "已停止", 30_000);
      await waitText(page, '[data-testid="run-status"]', "空闲", 30_000);
      await page.waitForSelector('[data-testid="composer-send"]', {
        timeout: 15_000,
      });
      await page.screenshot({
        path: join(assetsDir, "m1-abort-stopped.png"),
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
      await closeQuietly(launched);
      launched = null;

      const log = readLog(dataDir);
      assert.match(log, /run_stopped/);
      assert.ok(!/run_settled/.test(log), "已停止的运行不许落盘为完成");
    } finally {
      await closeQuietly(launched);
      await stub.close();
      cleanup(dataDir, workDir, homeDir);
    }
  },
);
