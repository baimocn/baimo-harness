/**
 * 本地 OpenAI 兼容代理（第九块 · 第一单元）：宽容工具调用转换层。
 *
 * 位置：Pi --(openai-completions)--> 本代理 --> Ollama 上游。
 * Pi 只认响应里的原生 tool_calls；小模型把调用写成 JSON 文本时 tool_calls
 * 恒为空。本代理对 chat/completions 响应做一次确定性补救：某 choice 没有
 * 原生 tool_calls 时，用 lenient-parser 把 message.content 里的文本调用
 * 转成原生 tool_calls；已有原生调用的 choice 零介入。
 *
 * 显形原则：上游非 2xx 原样回传不介入；网络/超时错误回 502 JSON 并写明
 * 原因，绝不静默吞掉；发生转换时以响应头 x-baimo-lenient-converted 标明
 * 本响应转换的调用数，stats 同步累计，方便测试与排查。
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { ConfigError } from "./errors.js";
import { parseLenientToolCalls, type LenientToolDef } from "./lenient-parser.js";

/** 代理句柄：baseUrl 供写入 Pi 的 models.json（已含上游 path 部分）。 */
export interface LenientProxyHandle {
  baseUrl: string;
  port: number;
  upstreamBaseUrl: string;
  stats: { requests: number; conversions: number; convertedCalls: number };
  close(): Promise<void>;
}

/** 上游请求默认超时（ms）：本地大模型首字慢，给足 30 分钟。 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 1_800_000;

/** 转换响应头：值是本响应转换的工具调用数，仅当 > 0 时出现。 */
const CONVERTED_HEADER = "x-baimo-lenient-converted";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从请求体 tools 提取工具清单：OpenAI 形态与直接 {name,parameters} 形态都兼容。 */
function extractToolDefs(body: Record<string, unknown>): LenientToolDef[] {
  if (!Array.isArray(body.tools)) return [];
  const defs: LenientToolDef[] = [];
  for (const entry of body.tools) {
    if (!isPlainObject(entry)) continue;
    if (isPlainObject(entry.function) && typeof entry.function.name === "string") {
      defs.push({ name: entry.function.name, parameters: entry.function.parameters });
    } else if (typeof entry.name === "string") {
      defs.push({ name: entry.name, parameters: entry.parameters });
    }
  }
  return defs;
}

function sseChunk(
  meta: { id: string; created: number; model: string },
  index: number,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): string {
  const chunk: Record<string, unknown> = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index, delta, finish_reason: finishReason }],
  };
  if (usage !== undefined) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 把一份非流式 completion 合成为 SSE 文本（形态对齐桩服务器的 turnChunks：
 * role/content delta、每调用两段 tool_calls delta、末 chunk 带 finish_reason
 * 与 usage、最后 data: [DONE]）。
 */
function completionToSse(completion: Record<string, unknown>): string {
  const meta = {
    id: typeof completion.id === "string" ? completion.id : "chatcmpl-lenient",
    created:
      typeof completion.created === "number"
        ? completion.created
        : Math.floor(Date.now() / 1000),
    model: typeof completion.model === "string" ? completion.model : "unknown",
  };
  const usage = isPlainObject(completion.usage) ? completion.usage : undefined;
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  let out = "";
  for (let ci = 0; ci < choices.length; ci += 1) {
    const choice = choices[ci];
    if (!isPlainObject(choice) || !isPlainObject(choice.message)) continue;
    const index = typeof choice.index === "number" ? choice.index : ci;
    const message = choice.message;
    out += sseChunk(meta, index, { role: "assistant", content: "" }, null);
    if (typeof message.content === "string" && message.content.length > 0) {
      out += sseChunk(meta, index, { content: message.content }, null);
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (let ti = 0; ti < toolCalls.length; ti += 1) {
      const tc = toolCalls[ti];
      if (!isPlainObject(tc) || !isPlainObject(tc.function)) continue;
      const args =
        typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments ?? {});
      out += sseChunk(
        meta,
        index,
        {
          tool_calls: [
            {
              index: ti,
              id: typeof tc.id === "string" ? tc.id : `call_lenient_${ti + 1}`,
              type: "function",
              function: {
                name: typeof tc.function.name === "string" ? tc.function.name : "",
                arguments: "",
              },
            },
          ],
        },
        null,
      );
      out += sseChunk(
        meta,
        index,
        { tool_calls: [{ index: ti, function: { arguments: args } }] },
        null,
      );
    }
    const finishReason =
      typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : toolCalls.length > 0
          ? "tool_calls"
          : "stop";
    out += sseChunk(meta, index, {}, finishReason, usage);
  }
  out += "data: [DONE]\n\n";
  return out;
}

/**
 * 启动宽容工具调用代理：监听 127.0.0.1 随机端口。
 * upstreamBaseUrl 形如 http://127.0.0.1:11434/v1；返回的 baseUrl 是
 * 代理 origin + 上游 path 部分，Pi 请求代理的 /v1/chat/completions 会被
 * 转发到上游同 path。
 */
export async function startLenientToolCallProxy(opts: {
  upstreamBaseUrl: string;
  upstreamTimeoutMs?: number;
}): Promise<LenientProxyHandle> {
  let upstream: URL;
  try {
    upstream = new URL(opts.upstreamBaseUrl);
  } catch {
    throw new ConfigError(`upstreamBaseUrl 不是合法 URL: ${opts.upstreamBaseUrl}`, {
      upstreamBaseUrl: opts.upstreamBaseUrl,
    });
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new ConfigError(`upstreamBaseUrl 只支持 http/https: ${opts.upstreamBaseUrl}`, {
      upstreamBaseUrl: opts.upstreamBaseUrl,
    });
  }
  const timeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`upstreamTimeoutMs 必须是正数（毫秒）: ${opts.upstreamTimeoutMs}`, {
      upstreamTimeoutMs: opts.upstreamTimeoutMs,
    });
  }
  const upstreamBaseUrl = opts.upstreamBaseUrl.replace(/\/+$/, "");
  const upstreamOrigin = upstream.origin;

  const stats = { requests: 0, conversions: 0, convertedCalls: 0 };
  const sockets = new Set<Socket>();

  function sendJsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  }

  /**
   * 透明转发：方法、path、除 host 外的头与请求体原样带过去，响应流式回传。
   * body 已缓冲时传 body（chat 路径请求体解析失败的透传）；否则直接 pipe 请求流。
   */
  function passthrough(
    req: IncomingMessage,
    res: ServerResponse,
    body?: Buffer,
  ): void {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key === "host") continue;
      headers[key] = value;
    }
    if (body !== undefined) headers["content-length"] = String(body.length);
    const requestOptions = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port === "" ? undefined : Number(upstream.port),
      method: req.method,
      path: req.url,
      headers,
    };
    const onUpstreamResponse = (upRes: IncomingMessage): void => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    };
    const upReq =
      upstream.protocol === "https:"
        ? httpsRequest(requestOptions, onUpstreamResponse)
        : httpRequest(requestOptions, onUpstreamResponse);
    upReq.on("error", (err) => {
      if (!res.headersSent) {
        sendJsonError(res, 502, `宽容代理透传上游失败: ${err.message}`);
      } else {
        res.destroy();
      }
    });
    if (body !== undefined) {
      upReq.end(body);
    } else {
      req.pipe(upReq);
    }
  }

  /** chat/completions 主路径：强制非流式取上游响应，必要时做宽容转换。 */
  async function handleChatCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      if (!isPlainObject(parsed)) throw new Error("请求体不是 JSON 对象");
      body = parsed;
    } catch {
      // 请求体解析失败：透传原文到上游，不介入。
      passthrough(req, res, rawBody);
      return;
    }

    const wantStream = body.stream === true;
    const toolDefs = extractToolDefs(body);
    const forwardBody = { ...body, stream: false };

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key === "host" || key === "content-length") continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("content-type", "application/json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upRes: Response;
    let upText: string;
    try {
      upRes = await fetch(`${upstreamOrigin}${req.url ?? ""}`, {
        method: "POST",
        headers,
        body: JSON.stringify(forwardBody),
        signal: controller.signal,
      });
      upText = await upRes.text();
    } catch (err) {
      const reason = controller.signal.aborted
        ? `上游请求超时（${timeoutMs}ms）`
        : `上游请求失败: ${err instanceof Error ? err.message : String(err)}`;
      sendJsonError(res, 502, `宽容代理: ${reason}`);
      return;
    } finally {
      clearTimeout(timer);
    }

    // 上游非 2xx：状态码与响应体原样回给调用方，不介入。
    if (!upRes.ok) {
      const ct = upRes.headers.get("content-type");
      res.writeHead(upRes.status, ct ? { "content-type": ct } : {});
      res.end(upText);
      return;
    }

    let completion: unknown;
    try {
      completion = JSON.parse(upText);
    } catch {
      // 上游 2xx 但不是 JSON：无从介入，原样回传。
      const ct = upRes.headers.get("content-type");
      res.writeHead(upRes.status, ct ? { "content-type": ct } : {});
      res.end(upText);
      return;
    }
    if (!isPlainObject(completion)) {
      res.writeHead(upRes.status, { "content-type": "application/json" });
      res.end(upText);
      return;
    }

    // 逐 choice 补救：已有非空原生 tool_calls 的 choice 零介入。
    let convertedHere = 0;
    if (Array.isArray(completion.choices)) {
      let callSeq = 0;
      for (const choice of completion.choices) {
        if (!isPlainObject(choice) || !isPlainObject(choice.message)) continue;
        const message = choice.message;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) continue;
        if (typeof message.content !== "string" || message.content.length === 0) continue;
        const result = parseLenientToolCalls(message.content, toolDefs);
        if (result.convertedCount === 0) continue;
        message.tool_calls = result.calls.map((call) => {
          callSeq += 1;
          return {
            id: `call_lenient_${callSeq}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          };
        });
        message.content = result.remainingText;
        choice.finish_reason = "tool_calls";
        convertedHere += result.convertedCount;
      }
    }
    if (convertedHere > 0) {
      stats.conversions += 1;
      stats.convertedCalls += convertedHere;
    }
    const convertedHeaders: Record<string, string> =
      convertedHere > 0 ? { [CONVERTED_HEADER]: String(convertedHere) } : {};

    // 按调用方原始请求的 stream 标志回响应。
    if (wantStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...convertedHeaders,
      });
      res.end(completionToSse(completion));
    } else {
      res.writeHead(200, { "content-type": "application/json", ...convertedHeaders });
      res.end(JSON.stringify(completion));
    }
  }

  const server = createServer((req, res) => {
    stats.requests += 1;
    let pathname = req.url ?? "";
    try {
      pathname = new URL(req.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void handleChatCompletions(req, res, Buffer.concat(chunks)).catch((err: unknown) => {
          // 兜底显形：主路径未预期的失败回 500 JSON，绝不挂死连接。
          if (!res.headersSent) {
            sendJsonError(
              res,
              500,
              `宽容代理内部失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          } else {
            res.destroy();
          }
        });
      });
      req.on("error", () => {
        if (!res.headersSent) sendJsonError(res, 400, "宽容代理: 读取请求体失败");
      });
      return;
    }
    // 其他方法/path：透明转发。
    passthrough(req, res);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  return {
    baseUrl: `http://127.0.0.1:${port}${upstreamPath}`,
    port,
    upstreamBaseUrl,
    stats,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
