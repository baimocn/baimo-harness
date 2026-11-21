/**
 * 本地 OpenAI 兼容桩模型服务器（测试 fixture）。
 *
 * 实现 POST /v1/chat/completions 的流式（SSE）与非流式响应：
 * - 第一轮（最后一条用户消息之后还没有 tool 结果）：先流式吐固定文本，再发一个工具调用。
 * - 第二轮（该消息之后已有 tool 结果）：流式吐最终文本并 stop。
 * - 用户消息含 [[stub:write]] / [[stub:edit]] 时，第一轮改发 write / edit
 *   工具调用（模块 3 真实 diff 与模块 4 审批 E2E 的剧本开关）。
 * hang 模式：收到请求后永不响应（模拟模型无响应，供 K-02 异常终止测试）。
 */
import { createServer } from "node:http";

const TEXT_TURN_1 = "Stub says hello. ";
const TEXT_FINAL = "Stub final answer.";
export const STUB_TOOL_COMMAND = "echo stub-tool-ok";
/** [[stub:write]] 剧本：写这个文件（相对工作区路径）。 */
export const STUB_WRITE_PATH = "stub-write.txt";
export const STUB_WRITE_CONTENT = "stub line alpha\nstub line beta\n";
/** [[stub:edit]] 剧本：把 stub-edit.txt 里的 STUB_EDIT_OLD 换成 STUB_EDIT_NEW。 */
export const STUB_EDIT_PATH = "stub-edit.txt";
export const STUB_EDIT_OLD = "line two";
export const STUB_EDIT_NEW = "line TWO";
/** [[stub:bash-danger]] 剧本：发一条危险命令（模块 4 构建模式危险清单 E2E）。 */
export const STUB_DANGER_COMMAND = "rm -rf ./stub-danger-target";
/**
 * [[stub:plan]] / [[stub:plan-fail]] 剧本（阶段 2 引导簇 · 计划面板 E2E）：
 * 模拟一个守计划流程的模型——先 submit_plan 交计划，批准后逐步执行
 * （bash → plan_progress → write → plan_progress → bash → plan_progress），
 * 最后收尾文本；plan-fail 变体在第二步回报 failed 后直接收尾。
 * submit_plan 的结果含「未获批准」时立即收尾（模拟模型服从拒绝）。
 */
export const STUB_PLAN_STEPS = [
  { title: "第一步：查看现状", action: "bash" },
  { title: "第二步：写入文件", action: "write" },
  { title: "第三步：收尾检查", action: "bash" },
];
export const STUB_PLAN_STEP1_COMMAND = "echo stub-step-1";
export const STUB_PLAN_STEP3_COMMAND = "echo stub-step-3";

function sseChunk(delta, finishReason = null, usage = undefined) {
  const chunk = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** 计划剧本：按最后一条用户消息之后已出现的工具调用序列推进。 */
function decidePlanTurn(messages, lastUserIdx, failVariant) {
  const after = messages.slice(lastUserIdx + 1);
  const callNames = [];
  const resultByCallId = new Map();
  const nameByCallId = new Map();
  for (const m of after) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        callNames.push(tc.function?.name ?? "");
        if (tc.id) nameByCallId.set(tc.id, tc.function?.name ?? "");
      }
    }
    if (m?.role === "tool" && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, extractText(m.content));
    }
  }
  const seq = callNames.join(",");
  if (seq === "") {
    return {
      final: false,
      name: "submit_plan",
      args: { steps: STUB_PLAN_STEPS },
    };
  }
  if (seq === "submit_plan") {
    const submitResult = [...nameByCallId.entries()]
      .filter(([, n]) => n === "submit_plan")
      .map(([id]) => resultByCallId.get(id) ?? "")
      .join("");
    if (submitResult.includes("未获批准")) return { final: true };
    return {
      final: false,
      name: "bash",
      args: { command: STUB_PLAN_STEP1_COMMAND },
    };
  }
  if (seq === "submit_plan,bash") {
    return {
      final: false,
      name: "plan_progress",
      args: { stepIndex: 0, status: "done" },
    };
  }
  if (seq === "submit_plan,bash,plan_progress") {
    return {
      final: false,
      name: "write",
      args: { path: STUB_WRITE_PATH, content: STUB_WRITE_CONTENT },
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write") {
    return {
      final: false,
      name: "plan_progress",
      args: { stepIndex: 1, status: failVariant ? "failed" : "done" },
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write,plan_progress") {
    if (failVariant) return { final: true };
    return {
      final: false,
      name: "bash",
      args: { command: STUB_PLAN_STEP3_COMMAND },
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write,plan_progress,bash") {
    return {
      final: false,
      name: "plan_progress",
      args: { stepIndex: 2, status: "done" },
    };
  }
  return { final: true };
}

/**
 * 剧本判定：以「最后一条用户消息」为准——它之后已有 tool 结果则收尾；
 * 否则按消息里的标记决定第一轮发哪个工具（缺省 bash）。
 */
function decideTurn(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const userText =
    lastUserIdx >= 0 ? extractText(messages[lastUserIdx].content) : "";
  if (userText.includes("[[stub:plan-fail]]")) {
    return decidePlanTurn(messages, lastUserIdx, true);
  }
  if (userText.includes("[[stub:plan]]")) {
    return decidePlanTurn(messages, lastUserIdx, false);
  }
  const hasResultAfter = messages
    .slice(lastUserIdx + 1)
    .some((m) => m && m.role === "tool");
  if (hasResultAfter) return { final: true };
  if (userText.includes("[[stub:write]]")) {
    return {
      final: false,
      name: "write",
      args: { path: STUB_WRITE_PATH, content: STUB_WRITE_CONTENT },
    };
  }
  if (userText.includes("[[stub:edit]]")) {
    return {
      final: false,
      name: "edit",
      args: {
        path: STUB_EDIT_PATH,
        edits: [{ oldText: STUB_EDIT_OLD, newText: STUB_EDIT_NEW }],
      },
    };
  }
  if (userText.includes("[[stub:bash-danger]]")) {
    return {
      final: false,
      name: "bash",
      args: { command: STUB_DANGER_COMMAND },
    };
  }
  const genericBash = userText.match(/\[\[stub:bash:([^\]]+)\]\]/);
  if (genericBash) {
    return {
      final: false,
      name: "bash",
      args: { command: genericBash[1] },
    };
  }
  return {
    final: false,
    name: "bash",
    args: { command: STUB_TOOL_COMMAND },
  };
}

function turnChunks(turn) {
  if (turn.final) {
    return [
      sseChunk({ role: "assistant", content: "" }),
      sseChunk({ content: TEXT_FINAL }),
      sseChunk({}, "stop", USAGE),
    ];
  }
  return [
    sseChunk({ role: "assistant", content: "" }),
    sseChunk({ content: TEXT_TURN_1 }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_stub_1",
          type: "function",
          function: { name: turn.name, arguments: "" },
        },
      ],
    }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          function: { arguments: JSON.stringify(turn.args) },
        },
      ],
    }),
    sseChunk({}, "tool_calls", USAGE),
  ];
}

function completionJson(turn) {
  const base = {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "stub-model",
    usage: USAGE,
  };
  if (turn.final) {
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: TEXT_FINAL },
          finish_reason: "stop",
        },
      ],
    };
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: TEXT_TURN_1,
          tool_calls: [
            {
              id: "call_stub_1",
              type: "function",
              function: {
                name: turn.name,
                arguments: JSON.stringify(turn.args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * 启动桩服务器（监听 127.0.0.1 随机端口）。
 * 返回 { url, requests, close }：requests 记录每个请求体，供测试断言轮次。
 * chunkDelayMs：每个 SSE 分片之间的间隔（缺省 5ms 与旧行为一致）；
 * steering/计划类测试需要把一轮拉长，才来得及在运行中插入指令。
 */
export async function createStubModelServer({ hang = false, chunkDelayMs = 5 } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* 记录原文即可 */
      }
      requests.push(parsed);
      if (hang) return; // 永不响应：挂住连接，等测试杀进程收尾。
      const turn = decideTurn(parsed);
      if (parsed.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunks = turnChunks(turn);
        let i = 0;
        const timer = setInterval(() => {
          if (i < chunks.length) {
            res.write(chunks[i++]);
          } else {
            clearInterval(timer);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }, chunkDelayMs);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionJson(turn)));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 生成指向桩服务器的 Pi models.json 内容。 */
export function stubModelsJson(url) {
  return JSON.stringify(
    {
      providers: {
        stub: {
          baseUrl: url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-model" }],
        },
      },
    },
    null,
    2,
  );
}
