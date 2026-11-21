/*** K-04 抓包遥测审计：运行时外发连接核查 *****
 * 方法：在完整桌面应用跑一轮真实任务（本地桩模型）的同时，以
 * 100ms 间隔轮询 `ss -tanpH` / `ss -uanpH` 全量套接字表，并用
 * `ps` 维护「应用进程树」（Electron 主进程及其全部后代，含 Pi
 * 子进程）的 pid 集合；凡进程树内进程的连接，逐条记录
 * (proto, state, local, remote, pid)。
 *
 * 判定口径：
 * - 应用进程树的连接里，远端为非环回地址（不是 127.0.0.1 / ::1）
 *   且远端端口非 0 → 记为对外连接企图，审计不通过；
 * - 敏感度自证：Pi 子进程到桩模型端点（环回、桩端口）的连接必须
 *   被抓到至少 1 条——抓不到说明抓包口径失效，审计同样不通过，
 *   不许拿「什么都没抓到」冒充「零外发」。
 *
 * 已知局限（报告中明示）：轮询式抓包可能漏掉存活 <100ms 的短连接；
 * 本结论与静态代码审计（docs/telemetry-audit.md：RPC 模式无遥测
 * 代码路径）互为印证，单靠任一侧都不下结论。
 *
 * 用法：node tests/capture/telemetry-capture.mjs（需 DISPLAY 或
 * xvfb-run 包裹）。证据 JSON 写 BAIMO_CAPTURE_EVIDENCE 指定路径，
 * 缺省 docs/test-runs/assets/2026-11-21-stage3/capture-evidence.json。
 * 退出码：0 = 通过；1 = 不通过或抓包失效。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { createStubModelServer } from "../../apps/agent-host/test/fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const desktopRoot = join(repoRoot, "apps/desktop");
const evidencePath =
  process.env.BAIMO_CAPTURE_EVIDENCE ??
  join(
    repoRoot,
    "docs/test-runs/assets/2026-11-21-stage3/capture-evidence.json",
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 解析一条 ss 输出行 → { proto, state, local, remote, pid }（pid 可为 null）。 */
function parseSsLine(line, proto) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const pidMatch = line.match(/pid=(\d+)/);
  return {
    proto,
    state: parts[0],
    local: parts[3] ?? "",
    remote: parts[4] ?? "",
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function snapshotSockets() {
  const out = [];
  for (const [args, proto] of [
    [["-tanpH"], "tcp"],
    [["-uanpH"], "udp"],
  ]) {
    let text = "";
    try {
      text = execFileSync("ss", args, { encoding: "utf8", timeout: 10_000 });
    } catch {
      continue; // ss 本身失败不冒充无连接：由轮询次数与敏感度自证兜底
    }
    for (const line of text.split("\n")) {
      const rec = parseSsLine(line, proto);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** 当前进程表：pid → { ppid, args }。 */
function snapshotProcesses() {
  const map = new Map();
  let text = "";
  try {
    text = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
  }
  return map;
}

/** rootPid 的全部后代 pid（含自身）。 */
function descendantsOf(procs, rootPid) {
  const result = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, info] of procs) {
      if (!result.has(pid) && result.has(info.ppid)) {
        result.add(pid);
        grew = true;
      }
    }
  }
  return result;
}

/**
 * 进程的 comm（内核进程名）。Pi 的 bundle 会把进程名改成 "pi"
 * （ps 的 args 只剩 "pi"，命令行匹配不到 pi-coding-agent），
 * 故 Pi 识别以 comm 为准、args 匹配为辅。
 */
function readComm(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

function splitAddr(addr) {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { host: addr, port: 0 };
  return {
    host: addr.slice(0, idx).replace(/^\[|\]$/g, ""),
    port: Number(addr.slice(idx + 1)) || 0,
  };
}

function isLoopback(host) {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "*" ||
    host.startsWith("127.")
  );
}

async function main() {
  const stub = await createStubModelServer({});
  const dataDir = makeTmp("baimo-capture-data-");
  const workDir = makeTmp("baimo-capture-work-");
  const homeDir = makeTmp("baimo-capture-home-");
  const configHome = makeTmp("baimo-capture-xdg-");

  const records = [];
  let polls = 0;
  let appPid = null;
  let polling = true;

  const app = await _electron.launch({
    executablePath: electronPath,
    args: ["--no-sandbox", desktopRoot],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      XDG_CONFIG_HOME: configHome,
      BAIMO_DATA_DIR: dataDir,
      BAIMO_WORKSPACE_DIR: workDir,
      BAIMO_PI_HOME: homeDir,
      BAIMO_STUB_MODEL_URL: stub.url,
    },
  });
  appPid = app.process().pid;

  // 轮询循环：与界面驱动并发
  const pollLoop = (async () => {
    while (polling) {
      const procs = snapshotProcesses();
      const tree = descendantsOf(procs, appPid);
      const piPids = new Set(
        [...tree].filter(
          (pid) =>
            readComm(pid) === "pi" ||
            (procs.get(pid)?.args ?? "").includes("pi-coding-agent"),
        ),
      );
      const sockets = snapshotSockets();
      polls += 1;
      for (const s of sockets) {
        if (s.pid !== null && tree.has(s.pid)) {
          records.push({ ...s, pi: piPids.has(s.pid), ts: Date.now() });
        }
      }
      await sleep(100);
    }
  })();

  let driveError = null;
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="statusbar"]', { timeout: 90_000 });
    await page.click('[data-testid="new-session"]');
    await page.waitForSelector('[data-testid="session-item"]', { timeout: 60_000 });
    await page.fill('[data-testid="composer-input"]', "抓包审计：跑一轮工具调用");
    await page.click('[data-testid="composer-send"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="stream"]')
          ?.textContent?.includes("Stub final answer."),
      { timeout: 120_000 },
    );
    // 结算后再观察 2 秒（收尾阶段的外发也要覆盖）
    await sleep(2000);
  } catch (err) {
    driveError = err instanceof Error ? err.message : String(err);
  } finally {
    polling = false;
    await pollLoop.catch(() => undefined);
    await app.close().catch(() => undefined);
    await stub.close();
  }

  // 归约：唯一端点集合（proto/state/remote/pid 角色）
  const key = (r) => `${r.proto}|${r.state}|${r.local}|${r.remote}|${r.pi ? "pi" : "app"}`;
  const unique = new Map();
  for (const r of records) {
    const k = key(r);
    if (!unique.has(k)) unique.set(k, { ...r, count: 0 });
    unique.get(k).count += 1;
  }
  const endpoints = [...unique.values()].map(
    ({ proto, state, local, remote, pi, count }) => ({
      proto,
      state,
      local,
      remote,
      owner: pi ? "pi" : "electron-tree",
      observations: count,
    }),
  );
  const nonLoopback = endpoints.filter((e) => {
    const { host, port } = splitAddr(e.remote);
    return port !== 0 && !isLoopback(host);
  });
  const piToStub = endpoints.filter((e) => {
    const { host, port } = splitAddr(e.remote);
    return e.owner === "pi" && isLoopback(host) && port === stub.port;
  });
  const piToStubCount = records.filter((r) => {
    const { host, port } = splitAddr(r.remote);
    return r.pi && isLoopback(host) && port === stub.port;
  }).length;

  const evidence = {
    auditedAt: new Date().toISOString(),
    method:
      "ss -tanpH/-uanpH 100ms 轮询 + ps 进程树归属（Electron 主进程全部后代，Pi 子进程单独标记）",
    appRootPid: appPid,
    stubEndpoint: `127.0.0.1:${stub.port}`,
    polls,
    rawObservations: records.length,
    driveError,
    endpoints,
    piToStubObservations: piToStubCount,
    nonLoopbackAppTree: nonLoopback,
    verdict:
      driveError === null && nonLoopback.length === 0 && piToStubCount > 0
        ? "pass"
        : "fail",
    limitations:
      "轮询式抓包可能漏掉存活 <100ms 的短连接；结论与静态代码审计（RPC 模式无遥测代码路径）互为印证。",
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.verdict !== "pass") {
    console.error("K-04 抓包审计不通过，见证据文件:", evidencePath);
    process.exit(1);
  }
  console.log("K-04 抓包审计通过，证据:", evidencePath);
}

main().catch((err) => {
  console.error("抓包审计执行失败:", err);
  process.exit(1);
});
