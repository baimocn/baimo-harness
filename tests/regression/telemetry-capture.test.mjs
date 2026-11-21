/*** 回归基线：K-04 抓包遥测审计（纳入 test:regression） *****
 * 以子进程方式跑 tests/capture/telemetry-capture.mjs（无 DISPLAY
 * 时自动套 xvfb-run），断言：完整应用跑一轮真实任务期间，应用
 * 进程树（Electron + Pi 子进程）除本地桩模型端点外零对外连接；
 * 且 Pi→桩端点的连接被真实抓到（敏感度自证，不许以「没抓到」
 * 冒充「零外发」）。证据 JSON 每次运行刷新到
 * docs/test-runs/assets/2026-11-21-stage3/capture-evidence.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(repoRoot, "tests/capture/telemetry-capture.mjs");

test(
  "K-04 抓包：应用进程树除桩端点外零对外连接（敏感度自证）",
  { timeout: 600_000 },
  () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "baimo-capture-ev-"));
    const evidencePath = join(evidenceDir, "capture-evidence.json");
    try {
      const env = { ...process.env, BAIMO_CAPTURE_EVIDENCE: evidencePath };
      const args = [script];
      let cmd = process.execPath;
      if (process.platform === "linux" && !process.env.DISPLAY) {
        cmd = "xvfb-run";
        args.unshift("-a", process.execPath);
      }
      const r = spawnSync(cmd, args, {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 540_000,
      });
      assert.ok(
        existsSync(evidencePath),
        `抓包应产出证据文件。stdout 尾: ${(r.stdout ?? "").slice(-500)} stderr 尾: ${(r.stderr ?? "").slice(-500)}`,
      );
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      assert.equal(evidence.driveError, null, "驱动应用跑任务不应失败");
      assert.ok(
        evidence.piToStubObservations > 0,
        "敏感度自证：必须真实抓到 Pi→桩端点连接",
      );
      assert.deepEqual(
        evidence.nonLoopbackAppTree,
        [],
        "应用进程树不得有任何非环回远端连接",
      );
      assert.equal(evidence.verdict, "pass");
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  },
);
