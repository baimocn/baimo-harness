/**
 * 桌面壳构建：main/preload/renderer 三件套。
 * - main：esbuild 打包为 ESM，electron 与 agent-host 保持外部（agent-host 的
 *   随附 Pi 路径按其自身 dist 位置解析，禁止打包改位）。
 * - preload：沙箱要求 CommonJS，单独出 preload.cjs。
 * - renderer：esbuild 打包 React 应用（含 ui 组件库 dist 与样式）。
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(appDir, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });

await esbuild.build({
  entryPoints: [join(appDir, "src/main/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron", "@baimo-harness/agent-host", "@baimo-harness/core"],
  outfile: join(dist, "main.js"),
  logLevel: "warning",
});

await esbuild.build({
  entryPoints: [join(appDir, "src/preload/preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outfile: join(dist, "preload.cjs"),
  logLevel: "warning",
});

await esbuild.build({
  entryPoints: [join(appDir, "src/renderer/main.tsx")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  /* Fontsource 字体文件随包发出（本地文件，运行时不联网） */
  loader: { ".woff2": "file", ".woff": "file" },
  outfile: join(dist, "renderer/main.js"),
  logLevel: "warning",
});

copyFileSync(
  join(appDir, "src/renderer/index.html"),
  join(dist, "renderer/index.html"),
);
console.log("desktop build ok:", dist);
