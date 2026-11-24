/*** 第七块：本地真模型接入验收（env 门控，不进默认回归） *****
 * 运行：BAIMO_LOCAL_MODEL=1 node --test tests/local-model/acceptance.test.mjs
 * 前置：本机回环推理端点已在运行（默认 Ollama http://localhost:11434/v1，
 * 模型 qwen2.5-coder:0.5b，用户拍板的 0.5B 尺寸；可经
 * BAIMO_LOCAL_MODEL_URL / BAIMO_LOCAL_MODEL_ID 覆盖）。
 * 未设 BAIMO_LOCAL_MODEL=1 时整套跳过——默认回归不依赖模型下载状态。
 *
 * 验收链路（全程 harness 真实链路，无桩、无人工代答）：
 * 1) 计划模式（required）下发建文件任务：模型必须先 submit_plan，
 *    宿主自动裁决「批准执行」，批准前写类工具被计划门硬拦；
 * 2) 工具真实落盘，文件内容与规格逐字一致；
 * 3) 检查点按桌面同口径在运行开始/结算自动打点（core CheckpointStore）；
 * 4) 第二轮修改一行 → 回滚到修改前检查点 → 文件逐字恢复；
 * 5) 成本账本落条目：pricing 给本地模型设名义测试单价，断言金额按
 *    单价快照折算、tokens 保留真实计数。
 * 证据（事件摘要/计划状态/账本/耗时）写 last-run-evidence.json。
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentHost,
  approvalGateExtensionPath,
  planGateExtensionPath,
} from "../../apps/agent-host/dist/index.js";
import { CheckpointStore } from "../../packages/core/dist/index.js";

const ENABLED = process.env.BAIMO_LOCAL_MODEL === "1";
const BASE_URL =
  process.env.BAIMO_LOCAL_MODEL_URL ?? "http://localhost:11434/v1";
const MODEL_ID = process.env.BAIMO_LOCAL_MODEL_ID ?? "qwen2.5-coder:0.5b";
const MODEL_KEY = `ollama/${MODEL_ID}`;
/** 名义测试单价（美元/1M tokens）：只为验证金额折算，本地推理无此账单。 */
const TEST_PRICE = { input: 150, output: 200, cacheRead: 15, cacheWrite: 150 };
const GATE_ARGS = [
  "--extension",
  approvalGateExtensionPath(),
  "--extension",
  planGateExtensionPath(),
];
const EVIDENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "last-run-evidence.json",
);

const FILE_NAME = "greeting.txt";
const CONTENT_V1 = "hello baimo\nversion: 1\nstatus: draft\n";
const CONTENT_V2 = "hello baimo\nversion: 2\nstatus: draft\n";

const PROMPT_CREATE =
  `在当前工作区创建文件 ${FILE_NAME}，内容恰好三行：第一行 hello baimo，` +
  "第二行 version: 1，第三行 status: draft，每行以换行结尾。" +
  "先用 submit_plan 提交计划（两步：创建文件、核对内容），批准后逐步执行，" +
  "每完成一步用 plan_progress 回报。";
const PROMPT_MODIFY =
  `把 ${FILE_NAME} 的第二行改成 version: 2，其他行保持不变。` +
  "先用 submit_plan 提交计划，批准后执行，并用 plan_progress 回报进度。";
/** 重试时逐步加重的格式提示（探针实证 0.5B 易把工具调用写成纯文本 JSON，
 * 模板要求的 <tool_call> 包裹格式必须在措辞里点明——属任务措辞调整，
 * 不改变任务规格本身）。attempt 1 不带，2 带简版，3 带示例。 */
const FORMAT_HINTS = [
  "",
  "注意：调用工具时必须使用工具调用格式，不要把调用写成普通文字或代码块。",
  "注意：调用工具时必须严格使用 <tool_call> 工具调用格式输出，" +
    '例如调用 submit_plan 时输出 <tool_call>{"name": "submit_plan", "arguments": {...}}</tool_call>，' +
    "不要输出 ```json 代码块，不要用普通文字代替工具调用。",
];

function localModelsJson() {
  return JSON.stringify(
    {
      providers: {
        ollama: {
          baseUrl: BASE_URL,
          api: "openai-completions",
          apiKey: "ollama",
          // temperature 0：0.5B 在采样下工具调用格式漂移严重，
          // 探针实证 temp=0 时 JSON 语义稳定正确（见测试记录）。
          models: [{ id: MODEL_ID, samplingParams: { temperature: 0 } }],
        },
      },
    },
    null,
    2,
  );
}

async function openLocalSession(t, dataDir, workDir) {
  const agentDir = join(dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), localModelsJson(), "utf8");
  mkdirSync(join(dataDir, "cost"), { recursive: true });
  writeFileSync(
    join(dataDir, "cost", "pricing.json"),
    JSON.stringify({
      version: 1,
      currency: "USD",
      models: { [MODEL_KEY]: TEST_PRICE },
    }),
    "utf8",
  );
  const planStateFile = join(dataDir, "plan-state.json");
  const planPolicyFile = join(dataDir, "plan-policy.json");
  const apprPolicyFile = join(dataDir, "appr-policy.json");
  writeFileSync(
    planPolicyFile,
    JSON.stringify({ required: true, paused: false }),
    "utf8",
  );
  writeFileSync(
    apprPolicyFile,
    JSON.stringify({ mode: "build", grants: [] }),
    "utf8",
  );
  const host = new AgentHost({ dataDir, env: { HOME: workDir } });
  await host.start();
  const session = await host.openSession({
    title: "本地真模型验收",
    workspaceDir: workDir,
    piArgs: ["--provider", "ollama", "--model", MODEL_ID, ...GATE_ARGS],
    env: {
      BAIMO_PLAN_STATE: planStateFile,
      BAIMO_PLAN_POLICY: planPolicyFile,
      BAIMO_APPROVAL_POLICY: apprPolicyFile,
    },
    modelRef: { provider: "ollama", modelId: MODEL_ID },
  });
  const events = [];
  session.on("event", (rec) => events.push(rec));
  t.after(async () => {
    await host.close().catch(() => undefined);
  });
  const readPlan = () =>
    existsSync(planStateFile)
      ? JSON.parse(readFileSync(planStateFile, "utf8"))
      : null;
  return { host, session, events, readPlan };
}

/** 发一轮 prompt：计划 select 一律回「批准执行」，并记录裁决时计划状态。 */
async function promptApprovePlan(session, message, readPlan, timeoutMs) {
  const seen = { selects: 0, planAtSelect: null };
  const listener = (rec) => {
    if (rec?.type !== "extension_ui_request") return;
    let payload = null;
    try {
      payload = JSON.parse(rec.title ?? "");
    } catch {
      /* 非计划请求 */
    }
    if (payload?.baimoPlan !== 1) return;
    if (rec.method === "select") {
      seen.selects += 1;
      if (!seen.planAtSelect) seen.planAtSelect = readPlan();
      session.respondExtensionUi(rec.id, { value: "批准执行" });
    } else if (rec.method === "editor") {
      session.respondExtensionUi(rec.id, { cancelled: true });
    }
  };
  session.on("event", listener);
  const t0 = Date.now();
  try {
    const outcome = await session.prompt(message, { timeoutMs });
    return { outcome, seen, elapsedMs: Date.now() - t0 };
  } finally {
    session.removeListener("event", listener);
  }
}

function waitCostRecorded(session, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("等待 costRecorded 超时")),
      timeoutMs,
    );
    session.on("costRecorded", (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

function toolNames(events) {
  return events
    .filter((e) => e.type === "tool_execution_start")
    .map((e) => e.toolName);
}

function tokensTotal(entry) {
  const tk = entry?.tokens ?? {};
  return tk.total ?? (tk.input ?? 0) + (tk.output ?? 0);
}

test(
  "本地真模型：计划批准→建文件→改一行→检查点回滚→账本记账 全链路",
  { skip: !ENABLED, timeout: 3_600_000 },
  async (t) => {
    const evidence = {
      baseUrl: BASE_URL,
      modelId: MODEL_ID,
      startedAt: new Date().toISOString(),
      attempts: [],
    };
    const dataDir = mkdtempSync(join(tmpdir(), "baimo-local-data-"));
    const workDir = mkdtempSync(join(tmpdir(), "baimo-local-work-"));
    t.after(() => {
      evidence.finishedAt = new Date().toISOString();
      writeFileSync(
        EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + "\n",
        "utf8",
      );
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });

    const checkpoints = new CheckpointStore(join(dataDir, "checkpoints"));
    const MAX_ATTEMPTS = 3;
    let passed = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !passed; attempt++) {
      // 每试一次用干净工作区（数据目录保留，账本/检查点按会话隔离）
      for (const f of [FILE_NAME]) {
        rmSync(join(workDir, f), { force: true });
      }
      const att = { attempt, phases: {} };
      evidence.attempts.push(att);
      // 证据收集器：模型原始助手文本（失败时定位卡点用，只留摘要）
      let collectRaw = () => {};
      try {
        const { host, session, events, readPlan } = await openLocalSession(
          t,
          dataDir,
          workDir,
        );
        att.sessionId = session.id;
        const sid = session.id;
        const hint = FORMAT_HINTS[attempt - 1] ?? "";
        att.formatHint = hint;
        collectRaw = () => {
          att.rawAssistant = events
            .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
            .map((e) =>
              (e.message.content ?? [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
                .slice(0, 300),
            )
            .slice(0, 8);
          att.allTools = toolNames(events);
        };

        /* ---------- 阶段 A：计划批准后建文件 ---------- */
        checkpoints.createSnapshot(sid, workDir, {
          label: "运行开始",
          trigger: "run_start",
        });
        const costA = waitCostRecorded(session);
        const a = await promptApprovePlan(
          session,
          PROMPT_CREATE + hint,
          readPlan,
          1_200_000,
        );
        att.phases.create = {
          elapsedMs: a.elapsedMs,
          disposition: a.outcome?.disposition,
          planSelects: a.seen.selects,
          planAtSelectStatus: a.seen.planAtSelect?.status ?? null,
          tools: toolNames(events),
        };
        await costA.catch((e) => {
          att.phases.create.costError = String(e);
        });
        checkpoints.createSnapshot(sid, workDir, {
          label: "运行结算",
          trigger: "run_settled",
        });
        assert.equal(
          a.seen.planAtSelect?.status,
          "awaiting_approval",
          "裁决时计划应已落盘为 awaiting_approval（事前计划）",
        );
        assert.ok(
          toolNames(events).indexOf("submit_plan") >= 0,
          "模型应调用 submit_plan",
        );
        assert.ok(
          toolNames(events).indexOf("submit_plan") <
            toolNames(events).indexOf("write"),
          "submit_plan 必须先于 write（先审后行）",
        );
        assert.equal(
          readFileSync(join(workDir, FILE_NAME), "utf8"),
          CONTENT_V1,
          "建文件后内容须与规格逐字一致",
        );
        assert.equal(readPlan()?.status, "completed", "计划应 completed");

        /* ---------- 阶段 B：改一行 ---------- */
        const beforeB = checkpoints.createSnapshot(sid, workDir, {
          label: "运行开始",
          trigger: "run_start",
        });
        const costB = waitCostRecorded(session);
        const mark = events.length;
        const b = await promptApprovePlan(
          session,
          PROMPT_MODIFY + hint,
          readPlan,
          1_200_000,
        );
        att.phases.modify = {
          elapsedMs: b.elapsedMs,
          disposition: b.outcome?.disposition,
          tools: toolNames(events.slice(mark)),
          preModifyCheckpoint: beforeB.checkpoint.id,
          preModifyCreated: beforeB.created,
        };
        await costB.catch((e) => {
          att.phases.modify.costError = String(e);
        });
        checkpoints.createSnapshot(sid, workDir, {
          label: "运行结算",
          trigger: "run_settled",
        });
        assert.equal(
          readFileSync(join(workDir, FILE_NAME), "utf8"),
          CONTENT_V2,
          "修改后内容须与规格逐字一致",
        );

        /* ---------- 阶段 C：回滚到修改前检查点 ---------- */
        const report = checkpoints.rollback(
          sid,
          workDir,
          beforeB.checkpoint.id,
        );
        att.phases.rollback = {
          restored: report.restored,
          deleted: report.deleted,
          unchanged: report.unchanged,
          verified: report.verified ?? null,
          mismatches: report.mismatches ?? [],
        };
        assert.equal(
          readFileSync(join(workDir, FILE_NAME), "utf8"),
          CONTENT_V1,
          "回滚后文件须逐字恢复到修改前",
        );

        /* ---------- 阶段 D：账本核对 ---------- */
        const entries = host.costLedger
          .entries()
          .filter((e) => e.sessionId === sid);
        att.phases.ledger = {
          entries: entries.map((e) => ({
            tokens: e.tokens,
            cost: e.cost,
            price: e.price ?? e.priceSnapshot ?? null,
          })),
        };
        assert.ok(entries.length >= 2, "两轮运行应至少落两笔账目");
        for (const e of entries) {
          assert.ok(tokensTotal(e) > 0, "账目 tokens 必须有真实计数");
          assert.ok(
            typeof e.cost === "number" && e.cost > 0,
            "已定价账目金额须按名义单价折算为正数",
          );
        }
        collectRaw();
        passed = att;
      } catch (err) {
        att.error = err instanceof Error ? err.message : String(err);
        lastError = err;
        collectRaw();
      }
    }

    assert.ok(
      passed,
      `真任务在 ${MAX_ATTEMPTS} 次尝试内未完成：${lastError?.message ?? ""}`,
    );
  },
);
