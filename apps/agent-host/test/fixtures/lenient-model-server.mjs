/**
 * 模拟「小模型」的 OpenAI 兼容服务器（第九块 · 宽容工具调用测试 fixture）。
 *
 * 与桩服务器（stub-model-server.mjs）的区别：本服务器扮演不会发原生
 * tool_calls 的小模型（qwen2.5-coder 类）——工具调用一律写成 JSON 纯文本 /
 * ```json 围栏块塞进 message.content，finish_reason 也只是 "stop"。
 * 宽容代理解析转换后，Pi 才看得到原生 tool_calls 并真正执行。
 *
 * 只实现 POST /v1/chat/completions 的非流式 JSON 响应（代理打上游时强制
 * stream:false；若收到 stream:true 也直接回 JSON，调用方自行适配）。
 * 剧本判定与桩同法：看最后一条 user 消息里的标记 + 其后已出现的
 * assistant tool_calls / tool 结果序列推进。
 *
 * 标记一览：
 * - 缺省：首轮围栏 JSON 调 bash（带前后说明文字）；已有 tool 结果后收尾。
 * - [[lenient:plan]]：计划流程（submit_plan 裸 JSON → bash 围栏 →
 *   plan_progress 裸 JSON → write 围栏 → plan_progress → bash 围栏 →
 *   plan_progress → 收尾）；submit_plan 结果含「未获批准」则立即收尾。
 * - [[lenient:write-first]]：首轮围栏 JSON 直接 write，不先交计划。
 * - [[lenient:danger]]：首轮围栏 JSON 发危险 bash 命令。
 * - [[lenient:echo]]：首轮裸 JSON write，参数带「模式回声」包装（value 解包）。
 * - [[lenient:echo-bad]]：每轮都回模式回声缺 value 的裸 JSON write——永不转换。
 * - [[lenient:native]]：首轮回原生 tool_calls（供代理零介入断言）。
 */
import { createServer } from "node:http";

export const LENIENT_FINAL_TEXT = "Lenient final answer.";
/** 缺省剧本首轮命令。 */
export const LENIENT_DEFAULT_COMMAND = "echo lenient-ok";
/** [[lenient:plan]] 剧本：计划步骤与各步产物。 */
export const LENIENT_PLAN_STEPS = [
  { title: "第一步：查看现状", action: "bash" },
  { title: "第二步：写入文件", action: "write" },
  { title: "第三步：收尾检查", action: "bash" },
];
export const LENIENT_PLAN_STEP1_COMMAND = "echo lenient-step-1";
export const LENIENT_PLAN_STEP3_COMMAND = "echo lenient-step-3";
export const LENIENT_PLAN_PATH = "lenient-plan.txt";
export const LENIENT_PLAN_CONTENT = "lenient plan line\n";
/** [[lenient:write-first]] 剧本：不交计划直接写的文件。 */
export const LENIENT_WRITE_FIRST_PATH = "lenient-write-first.txt";
export const LENIENT_WRITE_FIRST_CONTENT = "should be blocked\n";
/** [[lenient:danger]] 剧本：危险命令（目标目录由测试预建，断言其未被删）。 */
export const LENIENT_DANGER_COMMAND = "rm -rf ./lenient-danger-target";
/** [[lenient:echo]] 剧本：模式回声解包后应落盘的文件与内容。 */
export const LENIENT_ECHO_PATH = "lenient-echo.txt";
export const LENIENT_ECHO_CONTENT = "echo content\n";
/** [[lenient:native]] 剧本：原生 tool_calls 的命令与随附文本。 */
export const LENIENT_NATIVE_COMMAND = "echo lenient-native";
export const LENIENT_NATIVE_TEXT = "Native call coming.";

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** 模式回声缺 value 的 write 调用全文（[[lenient:echo-bad]] 每轮都回它）。 */
export const LENIENT_ECHO_BAD_TEXT = JSON.stringify({
  name: "write",
  arguments: {
    path: { type: "string", description: "文件路径" },
    content: "echo bad content\n",
  },
});

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** 把一条调用渲染成 ```json 围栏块（小模型最常见的写法）。 */
function fencedCall(name, args) {
  return "```json\n" + JSON.stringify({ name, arguments: args }) + "\n```";
}

/** 把一条调用渲染成裸 JSON 全文（无围栏、无前后文）。 */
function bareCall(name, args) {
  return JSON.stringify({ name, arguments: args });
}

/** 计划剧本：按最后一条用户消息之后已出现的工具调用序列推进（与桩同法）。 */
function decidePlanTurn(messages, lastUserIdx) {
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
    // submit_plan 用裸 JSON 全文（无围栏）发出。
    return { kind: "text", content: bareCall("submit_plan", { steps: LENIENT_PLAN_STEPS }) };
  }
  if (seq === "submit_plan") {
    const submitResult = [...nameByCallId.entries()]
      .filter(([, n]) => n === "submit_plan")
      .map(([id]) => resultByCallId.get(id) ?? "")
      .join("");
    if (submitResult.includes("未获批准")) return { kind: "final" };
    return {
      kind: "text",
      content: fencedCall("bash", { command: LENIENT_PLAN_STEP1_COMMAND }),
    };
  }
  if (seq === "submit_plan,bash") {
    return {
      kind: "text",
      content: bareCall("plan_progress", { stepIndex: 0, status: "done" }),
    };
  }
  if (seq === "submit_plan,bash,plan_progress") {
    return {
      kind: "text",
      content: fencedCall("write", {
        path: LENIENT_PLAN_PATH,
        content: LENIENT_PLAN_CONTENT,
      }),
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write") {
    return {
      kind: "text",
      content: bareCall("plan_progress", { stepIndex: 1, status: "done" }),
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write,plan_progress") {
    return {
      kind: "text",
      content: fencedCall("bash", { command: LENIENT_PLAN_STEP3_COMMAND }),
    };
  }
  if (seq === "submit_plan,bash,plan_progress,write,plan_progress,bash") {
    return {
      kind: "text",
      content: bareCall("plan_progress", { stepIndex: 2, status: "done" }),
    };
  }
  return { kind: "final" };
}

/**
 * 剧本判定：以「最后一条用户消息」为准——它之后已有 tool 结果则收尾；
 * 否则按消息里的标记决定第一轮发什么（缺省围栏 bash）。
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
  if (userText.includes("[[lenient:plan]]")) {
    return decidePlanTurn(messages, lastUserIdx);
  }
  if (userText.includes("[[lenient:echo-bad]]")) {
    // 每轮都回同一段缺 value 的回声 JSON：永不转换、永不产生 tool 结果。
    return { kind: "text", content: LENIENT_ECHO_BAD_TEXT };
  }
  const hasResultAfter = messages
    .slice(lastUserIdx + 1)
    .some((m) => m && m.role === "tool");
  if (hasResultAfter) return { kind: "final" };
  if (userText.includes("[[lenient:write-first]]")) {
    return {
      kind: "text",
      content: fencedCall("write", {
        path: LENIENT_WRITE_FIRST_PATH,
        content: LENIENT_WRITE_FIRST_CONTENT,
      }),
    };
  }
  if (userText.includes("[[lenient:danger]]")) {
    return {
      kind: "text",
      content: fencedCall("bash", { command: LENIENT_DANGER_COMMAND }),
    };
  }
  if (userText.includes("[[lenient:echo]]")) {
    // 参数带模式回声包装：{type, description, value}，靠代理解包还原。
    return {
      kind: "text",
      content: bareCall("write", {
        path: { type: "string", description: "文件路径", value: LENIENT_ECHO_PATH },
        content: { type: "string", description: "文件内容", value: LENIENT_ECHO_CONTENT },
      }),
    };
  }
  if (userText.includes("[[lenient:native]]")) {
    return {
      kind: "native",
      name: "bash",
      args: { command: LENIENT_NATIVE_COMMAND },
      content: LENIENT_NATIVE_TEXT,
    };
  }
  // 缺省：带前后说明文字的围栏 JSON bash 调用。
  return {
    kind: "text",
    content:
      "我来执行命令。\n" +
      fencedCall("bash", { command: LENIENT_DEFAULT_COMMAND }),
  };
}

function completionJson(turn) {
  const base = {
    id: "chatcmpl-lenient",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "lenient-model",
    usage: USAGE,
  };
  if (turn.kind === "native") {
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.content,
            tool_calls: [
              {
                id: "call_lenient_native_1",
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
  const content = turn.kind === "final" ? LENIENT_FINAL_TEXT : turn.content;
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * 启动模拟小模型服务器（监听 127.0.0.1 随机端口）。
 * 返回 { url, port, requests, close }：requests 记录每个请求体，供断言轮次；
 * close 销毁全部 socket 后再关服务器（与桩服务器同法）。
 */
export async function createLenientModelServer() {
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
      // 只回非流式 JSON：代理打上游强制 stream:false；收到 stream:true 也照此回。
      const turn = decideTurn(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionJson(turn)));
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

/** 生成指向本 fixture 的 Pi models.json 内容（provider 名 lenient）。 */
export function lenientModelsJson(url) {
  return JSON.stringify(
    {
      providers: {
        lenient: {
          baseUrl: url,
          api: "openai-completions",
          apiKey: "lenient-key",
          models: [{ id: "lenient-model" }],
        },
      },
    },
    null,
    2,
  );
}
