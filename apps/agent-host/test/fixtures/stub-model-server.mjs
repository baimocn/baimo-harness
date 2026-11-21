/**
 * 本地 OpenAI 兼容桩模型服务器（测试 fixture）。
 *
 * 实现 POST /v1/chat/completions 的流式（SSE）与非流式响应：
 * - 第一轮（历史里没有 tool 结果）：先流式吐固定文本，再发一个 bash 工具调用。
 * - 第二轮（历史里已有 tool 结果）：流式吐最终文本并 stop。
 * hang 模式：收到请求后永不响应（模拟模型无响应，供 K-02 异常终止测试）。
 */
import { createServer } from "node:http";

const TEXT_TURN_1 = "Stub says hello. ";
const TEXT_FINAL = "Stub final answer.";
export const STUB_TOOL_COMMAND = "echo stub-tool-ok";

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

function turnChunks(hasToolResult) {
  if (hasToolResult) {
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
          function: { name: "bash", arguments: "" },
        },
      ],
    }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          function: { arguments: JSON.stringify({ command: STUB_TOOL_COMMAND }) },
        },
      ],
    }),
    sseChunk({}, "tool_calls", USAGE),
  ];
}

function completionJson(hasToolResult) {
  const base = {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "stub-model",
    usage: USAGE,
  };
  if (hasToolResult) {
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
                name: "bash",
                arguments: JSON.stringify({ command: STUB_TOOL_COMMAND }),
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
 */
export async function createStubModelServer({ hang = false } = {}) {
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
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasToolResult = messages.some((m) => m && m.role === "tool");
      if (parsed.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunks = turnChunks(hasToolResult);
        let i = 0;
        const timer = setInterval(() => {
          if (i < chunks.length) {
            res.write(chunks[i++]);
          } else {
            clearInterval(timer);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }, 5);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionJson(hasToolResult)));
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
