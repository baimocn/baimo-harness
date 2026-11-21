/*** 阶段 3 · 模块 2：插件目录（M-15）—— agent-host E2E *****
 * 实证口径（探针先行，Pi 1.6.0）：
 * - 示例插件注册的 plugin_echo 是 Pi 本体没有的工具：装上 → 调用
 *   成功、结果带 PLUGIN-ECHO 标记且回喂模型；不装 → 同一调用得到
 *   「Tool plugin_echo not found」错误结果（天然对照组）；
 * - 坏插件两层显形：语法错误/元数据损坏在 PluginService.list() 就
 *   带「文件名 + 原因」；工厂抛错在会话启动时让 Pi 退出码 1 拒绝
 *   启动，stderr 点名 Failed to load extension "<路径>"，宿主原样透传；
 * - 启停落盘注册表，enabledExtensionPaths 只含已启用插件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
import { AgentHost } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
  STUB_PLUGIN_ECHO_RESULT,
} from "./fixtures/stub-model-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PLUGIN = join(here, "..", "plugins-examples", "echo-plugin.mjs");
const EXAMPLE_SIDECAR = join(
  here,
  "..",
  "plugins-examples",
  "echo-plugin.plugin.json",
);
const PI_TEST_TIMEOUT = 240_000;

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedPlugins(dataDir, { withEcho = true } = {}) {
  const dir = join(dataDir, "plugins");
  mkdirSync(dir, { recursive: true });
  if (withEcho) {
    copyFileSync(EXAMPLE_PLUGIN, join(dir, "echo-plugin.mjs"));
    copyFileSync(EXAMPLE_SIDECAR, join(dir, "echo-plugin.plugin.json"));
  }
  return dir;
}

test(
  "PluginService：扫描/sidecar/语法校验/启停落盘，坏插件带名带因显形",
  { timeout: 60_000 },
  async (t) => {
    const stub = await createStubModelServer({});
    const dataDir = makeTmp("baimo-plugins-data-");
    const workDir = makeTmp("baimo-plugins-work-");
    const agentDir = join(dataDir, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
    const dir = seedPlugins(dataDir);
    // 语法坏插件 + 元数据坏插件
    writeFileSync(
      join(dir, "syntax-bad.mjs"),
      "export default function (pi) { this is not valid js\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "meta-bad.mjs"),
      "export default function (pi) {}\n",
      "utf8",
    );
    writeFileSync(join(dir, "meta-bad.plugin.json"), "{ nope", "utf8");

    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    await host.start();
    t.after(async () => {
      await host.close().catch(() => undefined);
      await stub.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });

    const list = host.plugins.list();
    assert.equal(list.length, 3);
    const echo = list.find((p) => p.fileName === "echo-plugin.mjs");
    assert.equal(echo.name, "回声示例插件", "展示名应取自 sidecar");
    assert.equal(echo.version, "1.0.0");
    assert.ok(echo.description?.includes("plugin_echo"));
    assert.equal(echo.enabled, true);
    assert.equal(echo.error, undefined);

    const syntaxBad = list.find((p) => p.fileName === "syntax-bad.mjs");
    assert.ok(syntaxBad.error?.includes("syntax-bad.mjs"), "语法错误应点名文件");
    assert.ok(syntaxBad.error?.includes("语法校验失败"));

    const metaBad = list.find((p) => p.fileName === "meta-bad.mjs");
    assert.ok(metaBad.error?.includes("meta-bad.plugin.json"), "元数据损坏应点名 sidecar");

    // 启停落盘：停用后路径清单不含它，新服务实例读到的仍是停用
    host.plugins.setEnabled("echo-plugin.mjs", false);
    assert.deepEqual(
      host.plugins.enabledExtensionPaths().filter((p) => p.includes("echo-plugin")),
      [],
    );
    const host2 = new AgentHost({ dataDir, env: { HOME: workDir } });
    assert.equal(
      host2.plugins.list().find((p) => p.fileName === "echo-plugin.mjs").enabled,
      false,
      "停用状态应落盘跨实例可见",
    );
    assert.throws(() => host.plugins.setEnabled("nope.mjs", true), /插件不存在/);
  },
);

async function openPluginSession(t, { withPlugin }) {
  const stub = await createStubModelServer({});
  const dataDir = makeTmp("baimo-plugins-data-");
  const workDir = makeTmp("baimo-plugins-work-");
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
  seedPlugins(dataDir, { withEcho: withPlugin });
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  t.after(async () => {
    await host.close().catch(() => undefined);
    await stub.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const piArgs = ["--provider", "stub", "--model", "stub-model"];
  for (const p of host.plugins.enabledExtensionPaths()) {
    piArgs.push("--extension", p);
  }
  const session = await host.openSession({
    title: "插件会话",
    workspaceDir: workDir,
    piArgs,
    modelRef: { provider: "stub", modelId: "stub-model" },
  });
  const toolEnds = [];
  session.on("event", (r) => {
    if (r.type === "tool_execution_end") toolEnds.push(r);
  });
  return { stub, host, session, toolEnds };
}

test(
  "装插件：plugin_echo 真实执行且结果回喂模型；不装：未知工具错误（对照）",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const withP = await openPluginSession(t, { withPlugin: true });
    const outcome = await withP.session.prompt("[[stub:plugin-echo]] 调用插件", {
      timeoutMs: 120_000,
    });
    assert.equal(outcome.disposition, "started");
    const echoEnd = withP.toolEnds.find((e) => e.toolName === "plugin_echo");
    assert.ok(echoEnd, "应有 plugin_echo 的工具执行记录");
    assert.equal(echoEnd.isError, false);
    assert.ok(
      JSON.stringify(echoEnd.result).includes(STUB_PLUGIN_ECHO_RESULT),
      "工具结果应带插件标记",
    );
    // 结果回喂模型：桩的第二个请求里带着工具结果
    assert.ok(
      JSON.stringify(withP.stub.requests[1]?.messages ?? []).includes(
        STUB_PLUGIN_ECHO_RESULT,
      ),
      "插件结果应回喂模型（第二轮请求可见）",
    );

    const without = await openPluginSession(t, { withPlugin: false });
    await without.session.prompt("[[stub:plugin-echo]] 调用插件", {
      timeoutMs: 120_000,
    });
    const missEnd = without.toolEnds.find((e) => e.toolName === "plugin_echo");
    assert.ok(missEnd, "无插件时同一调用也应有执行记录");
    assert.equal(missEnd.isError, true);
    assert.ok(
      JSON.stringify(missEnd.result).includes("Tool plugin_echo not found"),
      "无插件时应为未知工具错误——证明能力来自插件而非本体",
    );
  },
);

test(
  "坏插件（工厂抛错）：会话启动被拒，报错点名插件文件与原因",
  { timeout: PI_TEST_TIMEOUT },
  async (t) => {
    const stub = await createStubModelServer({});
    const dataDir = makeTmp("baimo-plugins-data-");
    const workDir = makeTmp("baimo-plugins-work-");
    const agentDir = join(dataDir, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), stubModelsJson(stub.url), "utf8");
    const dir = seedPlugins(dataDir, { withEcho: false });
    writeFileSync(
      join(dir, "throw-bad.mjs"),
      "export default function (pi) { throw new Error('工厂爆炸 boom'); }\n",
      "utf8",
    );
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    await host.start();
    t.after(async () => {
      await host.close().catch(() => undefined);
      await stub.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });
    const piArgs = ["--provider", "stub", "--model", "stub-model"];
    for (const p of host.plugins.enabledExtensionPaths()) {
      piArgs.push("--extension", p);
    }
    await assert.rejects(
      host.openSession({
        title: "坏插件会话",
        workspaceDir: workDir,
        piArgs,
        modelRef: { provider: "stub", modelId: "stub-model" },
      }),
      (err) => {
        const text = `${err.message} ${err.stderrTail ?? ""}`;
        assert.ok(
          text.includes("Failed to load extension"),
          `报错应含加载失败字样，实际: ${text.slice(0, 200)}`,
        );
        assert.ok(text.includes("throw-bad.mjs"), "报错应点名插件文件");
        assert.ok(text.includes("工厂爆炸"), "报错应含插件抛出的原因");
        return true;
      },
    );
  },
);
