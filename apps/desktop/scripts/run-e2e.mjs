/**
 * 桌面 E2E 运行器：无 DISPLAY 时自动套 xvfb-run（Linux VM 无头环境），
 * 有显示环境则直跑。退出码透传。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const testGlob = "apps/desktop/test/*.test.mjs";
const nodeArgs = ["--test", testGlob];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT") {
    return null;
  }
  return r.status ?? 1;
}

let status;
if (process.platform === "linux" && !process.env.DISPLAY) {
  status = run("xvfb-run", ["-a", process.execPath, ...nodeArgs]);
  if (status === null) {
    console.error("无 DISPLAY 且 xvfb-run 不可用，直跑（大概率失败）");
    status = run(process.execPath, nodeArgs);
  }
} else {
  status = run(process.execPath, nodeArgs);
}
process.exit(status ?? 1);
