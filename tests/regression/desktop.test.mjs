/*** 回归基线：桌面壳 MVP 的结构性不变量 *****
 * 守住本块成果不被后续改动破坏：三件套构建产物、preload 白名单边界、
 * 主进程安全开关、根脚本串联。界面行为本身由 apps/desktop 的无头 E2E 守。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

test("桌面壳构建产物齐全（main/preload/renderer 三件套）", () => {
  for (const f of [
    "apps/desktop/dist/main.js",
    "apps/desktop/dist/preload.cjs",
    "apps/desktop/dist/renderer/index.html",
    "apps/desktop/dist/renderer/main.js",
  ]) {
    assert.ok(existsSync(join(root, f)), `缺少构建产物 ${f}（先跑 npm run build）`);
  }
  const pkg = readJson("apps/desktop/package.json");
  assert.equal(pkg.main, "dist/main.js");
});

test("preload 只暴露白名单桥，不透传 ipcRenderer", () => {
  const preload = read("apps/desktop/src/preload/preload.ts");
  assert.match(preload, /exposeInMainWorld\("baimo", api\)/);
  assert.ok(
    !/exposeInMainWorld\("ipcRenderer"/.test(preload),
    "禁止把 ipcRenderer 本体暴露给渲染层",
  );
  const main = read("apps/desktop/src/main/main.ts");
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test("主进程关掉 Chromium 自带外发（拼写词典/组件更新/域名可靠性，K-04 红线）", () => {
  const main = read("apps/desktop/src/main/main.ts");
  assert.match(main, /spellcheck: false/);
  assert.match(main, /setSpellCheckerEnabled\(false\)/);
  assert.match(main, /setSpellCheckerLanguages\(\[\]\)/);
  assert.match(main, /appendSwitch\("disable-component-update"\)/);
  assert.match(main, /appendSwitch\("disable-domain-reliability"\)/);
  assert.match(main, /appendSwitch\("disable-background-networking"\)/);
});

test("根脚本串联 ui 单测与桌面 E2E", () => {
  const pkg = readJson("package.json");
  assert.match(pkg.scripts["test:e2e"], /packages\/ui\/test/);
  assert.match(pkg.scripts["test:e2e"], /run-e2e\.mjs/);
  assert.match(pkg.scripts["test:regression"], /run-e2e\.mjs/);
  assert.match(pkg.scripts.build, /@baimo-harness\/desktop/);
});
