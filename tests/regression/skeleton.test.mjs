/*** 回归基线：项目骨架与红线文档完整性 *****
 * 后续每个功能落地时往 tests/regression/ 里加用例；本文件守住阶段 0 前置的成果不被破坏：
 * 目录骨架、随附 Pi 版本钉死、测试脚本入口、遥测审计文档。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("骨架目录齐全", () => {
  for (const dir of [
    "apps/desktop",
    "apps/agent-host",
    "packages/ui",
    "packages/rpc",
    "packages/core",
    "runtime",
    "docs",
  ]) {
    assert.ok(existsSync(join(root, dir)), `缺少目录 ${dir}`);
  }
});

test("workspace 包命名统一且可解析", () => {
  for (const p of [
    "apps/desktop/package.json",
    "apps/agent-host/package.json",
    "packages/ui/package.json",
    "packages/rpc/package.json",
    "packages/core/package.json",
  ]) {
    const pkg = readJson(p);
    assert.ok(
      pkg.name.startsWith("@baimo-harness/"),
      `${p} 命名异常: ${pkg.name}`,
    );
  }
});

test("随附 Pi 版本与 runtime 钉死版本一致", () => {
  const runtimePkg = readJson("runtime/package.json");
  const pinned = runtimePkg.dependencies["@earendil-works/pi-coding-agent"];
  const installed = readJson(
    "runtime/node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  assert.equal(installed.version, pinned);
});

test("根 package.json 保留测试脚本入口", () => {
  const pkg = readJson("package.json");
  assert.ok(pkg.scripts["test:e2e"], "缺少 test:e2e");
  assert.ok(pkg.scripts["test:regression"], "缺少 test:regression");
});

test("遥测审计文档在位且记录了关闭方法（K-04）", () => {
  const doc = readFileSync(join(root, "docs/telemetry-audit.md"), "utf8");
  assert.match(doc, /PI_TELEMETRY=0/);
  assert.match(doc, /enableInstallTelemetry/);
});
