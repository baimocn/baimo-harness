/**
 * 空闲 RSS 实测（第八块，D-07 内存红线：空闲总 RSS ≤500MB、壳层 ≤300MB）。
 *
 * 用法：xvfb-run -a node apps/desktop/scripts/measure-rss.mjs
 * 两种空闲态各采样 3 次取中位：
 *  A. 应用刚启动、无会话（仅 Electron 进程树）；
 *  B. 建一个会话并跑完一轮后静置（agent-host + Pi 子进程常驻、无任务运行）——
 *     这是用户日常的「空闲」工作态，总 RSS 按进程树全量合计（含 Pi）。
 * Xvfb 是测试环境开销，不在产品进程树内，不计。
 */
import { _electron } from "playwright-core";
import electronPath from "electron";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStubModelServer } from "../../agent-host/test/fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 读 /proc 建进程树，返回 rootPid 后代（含自身）的 [{pid, comm, rssKB}]。 */
function treeProcesses(rootPid) {
  const ppidOf = new Map();
  const commOf = new Map();
  const rssOf = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ppidOf.set(pid, Number(rest[1]));
      commOf.set(pid, comm);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/VmRSS:\s*(\d+)\s*kB/);
      let pss = 0;
      try {
        const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
        const pm = rollup.match(/Pss:\s*(\d+)\s*kB/);
        pss = pm ? Number(pm[1]) : 0;
      } catch {
        /* smaps 不可读时 PSS 记 0 */
      }
      rssOf.set(pid, { rss: m ? Number(m[1]) : 0, pss });
    } catch {
      /* 进程刚退出，跳过 */
    }
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (rssOf.has(pid)) {
      const v = rssOf.get(pid);
      out.push({ pid, comm: commOf.get(pid) ?? "?", rssKB: v.rss, pssKB: v.pss });
    }
    for (const [child, ppid] of ppidOf) {
      if (ppid === pid) queue.push(child);
    }
  }
  return out;
}

function summarize(samples) {
  const totals = samples.map((s) => s.reduce((a, p) => a + p.rssKB, 0));
  totals.sort((a, b) => a - b);
  const medianKB = totals[Math.floor(totals.length / 2)];
  const pssTotals = samples.map((s) => s.reduce((a, p) => a + p.pssKB, 0));
  pssTotals.sort((a, b) => a - b);
  const pssMedianKB = pssTotals[Math.floor(pssTotals.length / 2)];
  const byComm = new Map();
  for (const p of samples[samples.length - 1]) {
    byComm.set(p.comm, (byComm.get(p.comm) ?? 0) + p.rssKB);
  }
  return {
    medianMB: (medianKB / 1024).toFixed(1),
    pssMedianMB: (pssMedianKB / 1024).toFixed(1),
    totalsMB: totals.map((t) => (t / 1024).toFixed(1)),
    byCommMB: [...byComm.entries()]
      .map(([comm, kb]) => `${comm} ${(kb / 1024).toFixed(1)}MB`)
      .join(" · "),
    procCount: samples[samples.length - 1].length,
  };
}

const stub = await createStubModelServer();
const configHome = makeTmp("baimo-rss-xdg-");
const app = await _electron.launch({
  executablePath: electronPath,
  args: ["--no-sandbox", desktopRoot],
  env: {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: "1",
    XDG_CONFIG_HOME: configHome,
    BAIMO_DATA_DIR: makeTmp("baimo-rss-data-"),
    BAIMO_WORKSPACE_DIR: makeTmp("baimo-rss-work-"),
    BAIMO_PI_HOME: makeTmp("baimo-rss-home-"),
    BAIMO_STUB_MODEL_URL: stub.url,
  },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="statusbar"]', { timeout: 60_000 });
  const rootPid = app.process().pid;

  // A：启动后静置 8s，采样 3 次（间隔 3s）
  await page.waitForTimeout(8000);
  const samplesA = [];
  for (let i = 0; i < 3; i++) {
    samplesA.push(treeProcesses(rootPid));
    await page.waitForTimeout(3000);
  }
  const a = summarize(samplesA);
  console.log(`[A 无会话空闲] 进程 ${a.procCount} 个 · 总 RSS 中位 ${a.medianMB} MB（采样 ${a.totalsMB.join("/")}）· PSS 中位 ${a.pssMedianMB} MB`);
  console.log(`    构成（末次采样）: ${a.byCommMB}`);

  // B：建会话跑一轮，结算后静置 8s 再采样
  await page.click('[data-testid="new-session"]');
  await page.waitForSelector('[data-testid="session-item"]', { timeout: 30_000 });
  await page.fill('[data-testid="composer-input"]', "跑个命令看看");
  await page.click('[data-testid="composer-send"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="run-status"]')
        ?.textContent?.includes("空闲"),
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(8000);
  const samplesB = [];
  for (let i = 0; i < 3; i++) {
    samplesB.push(treeProcesses(rootPid));
    await page.waitForTimeout(3000);
  }
  const b = summarize(samplesB);
  console.log(`[B 会话常驻空闲] 进程 ${b.procCount} 个 · 总 RSS 中位 ${b.medianMB} MB（采样 ${b.totalsMB.join("/")}）· PSS 中位 ${b.pssMedianMB} MB`);
  console.log(`    构成（末次采样）: ${b.byCommMB}`);
  console.log(
    `红线对照：总 RSS ≤500MB → A ${a.medianMB}MB / B ${b.medianMB}MB；` +
      `（壳层口径见测试记录说明）`,
  );
} finally {
  await app.close().catch(() => undefined);
  rmSync(configHome, { recursive: true, force: true });
  await stub.close?.();
}
process.exit(0);
