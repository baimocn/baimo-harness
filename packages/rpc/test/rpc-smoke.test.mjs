/*** RPC 冒烟测试（端到端） *****
 * 启动随附 Pi 的 RPC 模式 → 握手/状态查询 → 错误面 → 正常关闭，全程断言。
 * 不调用任何真实大模型：只用无需模型的协议命令（get_state、坏 JSON、未知命令）。
 * 子进程 env 按 docs/telemetry-audit.md §5 的关遥测策略注入，并用临时目录隔离配置与工作区。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PI_CLI = join(
  root,
  "runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);

const CMD_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 15_000;

/** 极小的 JSONL 客户端：只按 \n 分帧（协议要求，禁用 readline 以免被 U+2028/U+2029 误切）。 */
class RpcSession {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        this.waiters = this.waiters.filter((w) => !w.tryMatch(record));
      }
    });
  }

  waitFor(predicate, timeoutMs = CMD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("等待 RPC 响应超时")),
        timeoutMs,
      );
      this.waiters.push({
        tryMatch: (record) => {
          if (!predicate(record)) return false;
          clearTimeout(timer);
          resolve(record);
          return true;
        },
      });
    });
  }

  sendRaw(text) {
    this.child.stdin.write(text + "\n");
  }

  send(obj) {
    this.sendRaw(JSON.stringify(obj));
  }

  async command(obj) {
    const pending = this.waitFor(
      (r) => r.type === "response" && r.id === obj.id,
    );
    this.send(obj);
    return pending;
  }
}

let child;
let rpc;
let agentDir;
let workDir;
let exitPromise;

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "baimo-pi-agent-"));
  workDir = mkdtempSync(join(tmpdir(), "baimo-pi-work-"));
  child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--no-session"], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: workDir,
      // 关遥测策略（docs/telemetry-audit.md §5）
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  rpc = new RpcSession(child);
  exitPromise = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
});

after(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

test("RPC 握手：get_state 成功且会话空闲", async () => {
  const res = await rpc.command({ id: "smoke-state", type: "get_state" });
  assert.equal(res.command, "get_state");
  assert.equal(res.success, true);
  assert.equal(typeof res.data.sessionId, "string");
  assert.ok(res.data.sessionId.length > 0);
  assert.equal(res.data.isStreaming, false);
  assert.equal(res.data.isCompacting, false);
  assert.equal(res.data.messageCount, 0);
  assert.equal(res.data.pendingMessageCount, 0);
});

test("RPC 错误面：坏 JSON 与未知命令都显形为 success:false（K-01）", async () => {
  const parsePending = rpc.waitFor(
    (r) => r.type === "response" && r.command === "parse",
  );
  rpc.sendRaw("{not json");
  const parseRes = await parsePending;
  assert.equal(parseRes.success, false);
  assert.match(parseRes.error, /Failed to parse command/);

  const bad = await rpc.command({
    id: "smoke-bad",
    type: "definitely_not_a_command",
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Unknown command/);
});

test("RPC 关闭：关闭 stdin 后进程有序退出且退出码为 0", async () => {
  child.stdin.end();
  const { code, signal } = await Promise.race([
    exitPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("进程未按时退出")), EXIT_TIMEOUT_MS),
    ),
  ]);
  assert.equal(signal, null);
  assert.equal(code, 0);
});
