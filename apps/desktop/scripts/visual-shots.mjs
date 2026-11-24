/**
 * 视觉打磨 before/after 对照截图脚本（第八块工具，非回归套件成员）。
 *
 * 用法：xvfb-run -a node apps/desktop/scripts/visual-shots.mjs <before|after>
 *
 * 同一套驱动步骤在打磨前后各跑一遍，产出同名截图到
 * docs/test-runs/assets/2026-11-24-visual-polish/<phase>-NN-<scene>.png，
 * 保证对照可比：桩模型、临时数据目录、窗口尺寸均与桌面 E2E 同口径。
 * 场景：空状态 / 主执行流 / diff / 审批卡 / 计划 / 账本 / 检查点 /
 * 闲时队列 / 插件 / YOLO 顶栏 / 会话回放。
 */
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
import {
  createStubModelServer,
  STUB_EDIT_OLD,
  STUB_EDIT_PATH,
} from "../../agent-host/test/fixtures/stub-model-server.mjs";

const phase = process.argv[2];
if (phase !== "before" && phase !== "after") {
  console.error("用法: visual-shots.mjs <before|after>");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..");
const assetsDir = join(
  repoRoot,
  "docs/test-runs/assets/2026-11-24-visual-polish",
);
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

async function launchApp(env) {
  // VM 资源紧：前一实例退出与新实例启动交接偶发慢，失败重试一次。
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const configHome = makeTmp("baimo-vis-xdg-");
    let app = null;
    try {
      app = await _electron.launch({
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
      await page.waitForSelector('[data-testid="statusbar"]', {
        timeout: 60_000,
      });
      return { app, page, configHome };
    } catch (e) {
      lastErr = e;
      await app?.close().catch(() => undefined);
      rmSync(configHome, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(assetsDir, `${phase}-${name}.png`) });
  console.log(`shot ${phase}-${name}.png`);
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
  await waitText(page, '[data-testid="run-status"]', "空闲");
}

function seedPlugins(dataDir, withBroken) {
  const pluginsDir = join(dataDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  copyFileSync(EXAMPLE_PLUGIN, join(pluginsDir, "echo-plugin.mjs"));
  copyFileSync(EXAMPLE_SIDECAR, join(pluginsDir, "echo-plugin.plugin.json"));
  if (withBroken) {
    writeFileSync(
      join(pluginsDir, "broken-plugin.mjs"),
      "export default function (pi) { this is not valid js\n",
      "utf8",
    );
  }
}

const stub = await createStubModelServer();
const dataDir = makeTmp("baimo-vis-data-");
const workDir = makeTmp("baimo-vis-work-");
const homeDir = makeTmp("baimo-vis-home-");
// 与 stage2-diff E2E 同口径：edit 目标文件预先种进工作区
writeFileSync(
  join(workDir, STUB_EDIT_PATH),
  `line one\n${STUB_EDIT_OLD}\nline three\n`,
);
seedPlugins(dataDir, false);
const env = {
  BAIMO_DATA_DIR: dataDir,
  BAIMO_WORKSPACE_DIR: workDir,
  BAIMO_PI_HOME: homeDir,
  BAIMO_STUB_MODEL_URL: stub.url,
};

/* ---------- 第一次启动：主流程各场景 ---------- */
let launched = await launchApp(env);
try {
  const { page } = launched;
  await shot(page, "00-empty-state");

  await page.click('[data-testid="new-session"]');
  await page.waitForSelector('[data-testid="session-item"]', {
    timeout: 30_000,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="rpc-status"]')
        ?.getAttribute("data-state") === "on",
    undefined,
    { timeout: 30_000 },
  );

  // 主执行流：普通指令 → 流式回复 + bash 工具卡（展开）
  await sendAndSettle(page, "跑个命令看看");
  await page.click('[data-testid="tool-card-header"]');
  await shot(page, "01-main-stream");

  // diff：write 建文件、edit 改一行
  await sendAndSettle(page, "[[stub:write]] 请写文件");
  await sendAndSettle(page, "[[stub:edit]] 请改文件");
  const editCard = page
    .locator('[data-testid="diff-card"]')
    .filter({ hasText: STUB_EDIT_PATH });
  await editCard.waitFor({ timeout: 20_000 });
  await editCard.scrollIntoViewIfNeeded();
  await shot(page, "02-diff");

  // 审批卡：编辑模式下 write 被截停
  await page.click('[data-testid="mode-edit"]');
  await page.fill('[data-testid="composer-input"]', "[[stub:write]] 请写文件");
  await page.click('[data-testid="composer-send"]');
  await page.waitForSelector('[data-testid="approval-card"]', {
    timeout: 60_000,
  });
  await shot(page, "03-approval-card");
  await page.click('[data-testid="approval-deny"]');
  await waitText(page, '[data-testid="run-status"]', "空闲");
  await page.click('[data-testid="mode-build"]');

  // 计划：计划先行 → 待批准计划卡（中栏 + 右栏计划页签同屏）
  await page.click('[data-testid="tab-plan"]');
  await page.check('[data-testid="plan-required-toggle"]');
  await page.fill('[data-testid="composer-input"]', "[[stub:plan]] 完成一件事");
  await page.click('[data-testid="composer-send"]');
  await page.waitForSelector('[data-testid="plan-approve"]', {
    timeout: 60_000,
  });
  await shot(page, "04-plan");
  await page.click('[data-testid="plan-approve"]');
  await waitText(page, '[data-testid="run-status"]', "空闲");

  // 账本
  await page.click('[data-testid="tab-ledger"]');
  await page.waitForSelector('[data-testid="ledger-session-cost"]', {
    timeout: 15_000,
  });
  await shot(page, "05-ledger");

  // 检查点
  await page.click('[data-testid="tab-checkpoints"]');
  await page.waitForSelector('[data-testid="checkpoint-item"]', {
    timeout: 15_000,
  });
  await shot(page, "06-checkpoints");

  // 闲时队列：投递一条（队列默认未启用，保持排队中）
  await page.click('[data-testid="tab-idle"]');
  await page.fill(
    '[data-testid="idle-prompt-input"]',
    "把 README 补上安装章节",
  );
  await page.click('[data-testid="idle-enqueue"]');
  await page.waitForSelector('[data-testid="idle-item"]', {
    timeout: 15_000,
  });
  await shot(page, "07-idle-queue");

  // YOLO：顶栏红色警示条
  await page.click('[data-testid="mode-yolo"]');
  await page.waitForSelector('[data-testid="yolo-alert"]', {
    timeout: 15_000,
  });
  await shot(page, "09-yolo-topbar");
  await page.click('[data-testid="mode-build"]');
} finally {
  await launched.app.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(launched.configHome, { recursive: true, force: true });
}

/* ---------- 第二次启动：插件面板（示例 + 坏插件显形） ---------- */
const dataDirB = makeTmp("baimo-vis-dataB-");
seedPlugins(dataDirB, true);
launched = await launchApp({ ...env, BAIMO_DATA_DIR: dataDirB });
try {
  const { page } = launched;
  await page.click('[data-testid="tab-plugins"]');
  await page.waitForSelector(
    '[data-testid="plugin-item"][data-file-name="broken-plugin.mjs"]',
    { timeout: 15_000 },
  );
  await shot(page, "08-plugins");
} finally {
  await launched.app.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(launched.configHome, { recursive: true, force: true });
}

/* ---------- 第三次启动：会话回放 ---------- */
launched = await launchApp(env);
try {
  const { page } = launched;
  await page.waitForSelector('[data-testid="session-item"]', {
    timeout: 30_000,
  });
  await page.locator('[data-testid="session-item"]').first().click();
  await page.waitForSelector('[data-testid="replay-start"]', {
    timeout: 30_000,
  });
  await page.click('[data-testid="replay-start"]');
  await page.waitForSelector('[data-testid="replay-bar"]', {
    timeout: 15_000,
  });
  for (let i = 0; i < 3; i++) {
    await page.click('[data-testid="replay-step-forward"]');
  }
  await shot(page, "10-replay");
} finally {
  await launched.app.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(launched.configHome, { recursive: true, force: true });
}

await stub.close?.();
console.log(`visual-shots ${phase} done`);
process.exit(0);
