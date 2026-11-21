/*** 阶段 2 · 模块 3：真实 write/edit 工具实跑 —— agent-host E2E *****
 * 桩模型按标记发 write / edit 工具调用（fixture 剧本），Pi 真实执行：
 * 断言工具事件流里有对应 tool_execution、工具结果非错误，且工作区文件
 * 内容与桩的改动逐字一致——diff 卡的数据源就是这条事件流。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../dist/index.js";
import {
  createStubModelServer,
  stubModelsJson,
  STUB_EDIT_NEW,
  STUB_EDIT_OLD,
  STUB_EDIT_PATH,
  STUB_WRITE_CONTENT,
  STUB_WRITE_PATH,
} from "./fixtures/stub-model-server.mjs";

const PI_TEST_TIMEOUT = 180_000;

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeStubModels(dataDir, url) {
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), stubModelsJson(url), "utf8");
}

const STUB_ARGS = ["--provider", "stub", "--model", "stub-model"];
const STUB_REF = { provider: "stub", modelId: "stub-model" };

test(
  "真实 diff 数据源：write 建文件、edit 改文件，事件与落盘一致",
  { timeout: PI_TEST_TIMEOUT },
  async () => {
    const stub = await createStubModelServer();
    const dataDir = makeTmp("baimo-diff-data-");
    const workDir = makeTmp("baimo-diff-work-");
    writeStubModels(dataDir, stub.url);
    writeFileSync(
      join(workDir, STUB_EDIT_PATH),
      `line one\n${STUB_EDIT_OLD}\nline three\n`,
      "utf8",
    );
    const host = new AgentHost({ dataDir, env: { HOME: workDir } });
    try {
      await host.start();
      const s = await host.openSession({
        title: "diff 会话",
        workspaceDir: workDir,
        piArgs: STUB_ARGS,
        modelRef: STUB_REF,
      });
      const events = [];
      s.on("event", (rec) => events.push(rec));

      const out1 = await s.prompt("[[stub:write]] 请写文件", {
        timeoutMs: 90_000,
      });
      assert.equal(out1.disposition, "started");
      const writeStart = events.find(
        (e) => e.type === "tool_execution_start" && e.toolName === "write",
      );
      assert.ok(writeStart, "应有 write 工具执行事件");
      assert.equal(writeStart.args.path, STUB_WRITE_PATH);
      const writeEnd = events.find(
        (e) => e.type === "tool_execution_end" && e.toolName === "write",
      );
      assert.ok(writeEnd && writeEnd.isError !== true);
      assert.equal(
        readFileSync(join(workDir, STUB_WRITE_PATH), "utf8"),
        STUB_WRITE_CONTENT,
      );

      const out2 = await s.prompt("[[stub:edit]] 请改文件", {
        timeoutMs: 90_000,
      });
      assert.equal(out2.disposition, "started");
      const editStart = events.find(
        (e) => e.type === "tool_execution_start" && e.toolName === "edit",
      );
      assert.ok(editStart, "应有 edit 工具执行事件");
      assert.deepEqual(editStart.args.edits, [
        { oldText: STUB_EDIT_OLD, newText: STUB_EDIT_NEW },
      ]);
      assert.equal(
        readFileSync(join(workDir, STUB_EDIT_PATH), "utf8"),
        `line one\n${STUB_EDIT_NEW}\nline three\n`,
      );
      assert.ok(existsSync(join(workDir, STUB_WRITE_PATH)));
    } finally {
      await host.close().catch(() => undefined);
      await stub.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
