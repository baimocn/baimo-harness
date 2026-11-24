/**
 * 宽容工具调用解析器（第九块 · 第一单元，纯函数、无 IO）。
 *
 * 背景：小本地模型（qwen2.5-coder 0.5B/3B 等）不发原生 tool_calls，而是把
 * 工具调用写成语义正确的 JSON 纯文本 / ```json 代码块 / <tool_call> 段输出。
 * 本模块把这类文本段确定性地转换成结构化调用，供 lenient-proxy 注入响应。
 *
 * 原则：只转「确信是调用」的段——工具名必须在清单内、参数必须过模式回声
 * 清洗与 schema 基本校验；任何一步拿不准就整段原样保留为文本，绝不猜、
 * 绝不静默改写。无任何转换时 remainingText 与输入逐字一致。
 *
 * 第九块验收实证补充（2026-11-24，3B 真跑）：模型在计划获批后会把后续
 * 多个调用写成「首尾相接的裸 JSON 对象」（每行一个、无围栏），故裸 JSON
 * 识别从「全文单对象」扩展为「全文仅由顶层 JSON 对象（可多个）或对象
 * 数组构成、对象外只有空白」——确定性口径不变：只要混入任何说明文字，
 * 裸对象一律不转（围栏块因有定界符不受此限）。
 */

/** 工具清单条目：name 精确匹配；parameters 为该工具的 JSON Schema（可缺省）。 */
export interface LenientToolDef {
  name: string;
  parameters?: unknown;
}

/** 一条转换成功的工具调用。 */
export interface LenientConvertedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 解析结果：convertedCount 恒等于 calls.length。 */
export interface LenientParseResult {
  calls: LenientConvertedCall[];
  remainingText: string;
  convertedCount: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 「模式回声」里可能出现的 schema 元键全集：参数值若是一个只含这些键、
 * 且带自有键 "value" 的普通对象，视为模型把 schema 抄进了值里，可解包。
 */
const ECHO_KEYS = new Set([
  "value",
  "type",
  "description",
  "required",
  "default",
  "example",
  "examples",
  "enum",
  "items",
  "properties",
  "format",
  "title",
  "$schema",
]);

/** 模式回声最多连解层数（解包后仍是回声对象且超过上限 → 不再解，交给类型校验拒绝）。 */
const MAX_ECHO_UNWRAP = 2;

/** 按 JSON Schema 的 type 声明做基本类型核对。 */
function matchesSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      // 未知 type 声明不拦（留给工具自身校验），避免误杀。
      return true;
  }
}

/** 取某个参数声明的期望类型列表（type 可为 string 或 string[]）；未声明返回 null。 */
function declaredTypes(propSchema: unknown): string[] | null {
  if (!isPlainObject(propSchema)) return null;
  const t = propSchema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t) && t.every((x) => typeof x === "string")) return t as string[];
  return null;
}

/**
 * 对单个参数值做模式回声清洗。
 * 返回 { ok: true, value } 或 { ok: false }（无法确信分离 → 拒绝整个候选）。
 * 期望类型为 object（含 object 的类型列表）时不清洗：对象值是合法形态，
 * 里面的 "value"/"type" 键可能就是业务数据。
 */
function cleanEchoValue(
  value: unknown,
  types: string[],
): { ok: true; value: unknown } | { ok: false } {
  if (types.includes("object")) return { ok: true, value };
  let current = value;
  let unwraps = 0;
  while (isPlainObject(current)) {
    if (hasOwn(current, "value")) {
      const keys = Object.keys(current);
      if (!keys.every((k) => ECHO_KEYS.has(k))) {
        // 带 value 但混有非模式键：不是纯回声，不解包；落到类型校验定夺。
        break;
      }
      if (unwraps >= MAX_ECHO_UNWRAP) break;
      current = current.value;
      unwraps += 1;
      continue;
    }
    if (hasOwn(current, "type") || hasOwn(current, "description")) {
      // 只有 schema 元信息、没有真值：无法确信分离，拒绝整个候选，绝不猜。
      return { ok: false };
    }
    break;
  }
  return { ok: true, value: current };
}

/**
 * 按工具 schema 清洗并校验参数。
 * 返回清洗后的参数对象；任一环节不合规返回 null（拒绝整个候选）。
 * schema 缺失或未声明的属性不拦（留给工具自身校验）。
 */
function cleanAndValidateArgs(
  rawArgs: Record<string, unknown>,
  parameters: unknown,
): Record<string, unknown> | null {
  const schema = isPlainObject(parameters) ? parameters : null;
  const properties =
    schema !== null && isPlainObject(schema.properties) ? schema.properties : {};
  const required: string[] =
    schema !== null && Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [];

  const cleaned: Record<string, unknown> = { ...rawArgs };

  // 模式回声清洗：只对 schema 声明了期望类型的参数做。
  for (const key of Object.keys(properties)) {
    if (!hasOwn(cleaned, key)) continue;
    const types = declaredTypes(properties[key]);
    if (types === null) continue;
    const result = cleanEchoValue(cleaned[key], types);
    if (!result.ok) return null;
    cleaned[key] = result.value;
  }

  // required 键必须齐全。
  for (const key of required) {
    if (!hasOwn(cleaned, key)) return null;
  }

  // 声明了 type 的参数做类型核对。
  for (const key of Object.keys(properties)) {
    if (!hasOwn(cleaned, key)) continue;
    const types = declaredTypes(properties[key]);
    if (types === null) continue;
    if (!types.some((t) => matchesSchemaType(cleaned[key], t))) return null;
  }

  return cleaned;
}

/**
 * 判定一段候选 JSON 文本是否是一条可转换的工具调用。
 * 可转返回结构化调用；不可转返回 null（该段原样保留为文本）。
 */
function evaluateCandidate(
  jsonText: string,
  toolsByName: ReadonlyMap<string, LenientToolDef>,
): LenientConvertedCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  // 取工具名：obj.name，或 obj.function（字符串），或 obj.function.name。
  let name: string | null = null;
  if (typeof parsed.name === "string") {
    name = parsed.name;
  } else if (typeof parsed.function === "string") {
    name = parsed.function;
  } else if (isPlainObject(parsed.function) && typeof parsed.function.name === "string") {
    name = parsed.function.name;
  }
  if (name === null) return null;

  const tool = toolsByName.get(name);
  if (tool === undefined) return null; // 工具名不在清单内：不转。

  // 取参数：arguments ?? args ?? parameters ?? function.arguments。
  let rawArgs: unknown =
    parsed.arguments ?? parsed.args ?? parsed.parameters;
  if (rawArgs === undefined && isPlainObject(parsed.function)) {
    rawArgs = parsed.function.arguments;
  }
  let argsObject: Record<string, unknown>;
  if (rawArgs === undefined) {
    argsObject = {};
  } else if (typeof rawArgs === "string") {
    let reparsed: unknown;
    try {
      reparsed = JSON.parse(rawArgs);
    } catch {
      return null;
    }
    if (!isPlainObject(reparsed)) return null;
    argsObject = reparsed;
  } else if (isPlainObject(rawArgs)) {
    argsObject = rawArgs;
  } else {
    return null;
  }

  const cleaned = cleanAndValidateArgs(argsObject, tool.parameters);
  if (cleaned === null) return null;
  return { name, arguments: cleaned };
}

/**
 * 扫描全文的顶层 JSON 对象跨度：要求全文除空白外只由一个个平衡的
 * {...} 对象首尾相接构成（字符串与转义感知，字符串内的大括号不计数）。
 * 满足时返回各对象在原文中的 [start, end) 跨度；混入任何非空白非对象
 * 内容、括号不平衡或一个对象都没有时返回 null。
 */
function scanTopLevelObjectSpans(
  text: string,
): Array<{ start: number; end: number }> | null {
  const spans: Array<{ start: number; end: number }> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = i;
    for (; j < n; j += 1) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    if (depth !== 0) return null;
    spans.push({ start: i, end: j });
    i = j;
  }
  return spans.length > 0 ? spans : null;
}

/**
 * 从一段 JSON 文本中提取全部候选调用：单个对象、对象数组、或首尾
 * 相接的多个对象。整段全有或全无——任一候选不可转则返回 null
 * （供围栏块 / <tool_call> 段使用，段内不做部分转换）。
 */
function evaluateJsonText(
  jsonText: string,
  toolsByName: ReadonlyMap<string, LenientToolDef>,
): LenientConvertedCall[] | null {
  const t = jsonText.trim();
  let parsed: unknown;
  let parseOk = true;
  try {
    parsed = JSON.parse(t);
  } catch {
    parseOk = false;
  }
  if (parseOk) {
    if (isPlainObject(parsed)) {
      const call = evaluateCandidate(t, toolsByName);
      return call !== null ? [call] : null;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return null;
      const out: LenientConvertedCall[] = [];
      for (const el of parsed) {
        if (!isPlainObject(el)) return null;
        const call = evaluateCandidate(JSON.stringify(el), toolsByName);
        if (call === null) return null;
        out.push(call);
      }
      return out;
    }
    return null;
  }
  const spans = scanTopLevelObjectSpans(t);
  if (spans === null) return null;
  const out: LenientConvertedCall[] = [];
  for (const span of spans) {
    const call = evaluateCandidate(t.slice(span.start, span.end), toolsByName);
    if (call === null) return null;
    out.push(call);
  }
  return out.length > 0 ? out : null;
}

/** 从围栏块的完整匹配里取出内部文本。 */
function fenceInner(fullMatch: string): string {
  const withoutOpen = fullMatch.replace(/^```(?:json)?[ \t]*\r?\n?/, "");
  return withoutOpen.replace(/```$/, "").trim();
}

/** 从 <tool_call> 段的完整匹配里取出内部文本（内部再套围栏时一并剥掉）。 */
function toolCallInner(fullMatch: string): string {
  const inner = fullMatch
    .replace(/^<tool_call>/, "")
    .replace(/<\/tool_call>$/, "")
    .trim();
  if (inner.startsWith("```")) return fenceInner(inner);
  return inner;
}

/**
 * 候选段扫描：```json / ``` 围栏块与 <tool_call>...</tool_call> 段，
 * 按出现顺序、互不重叠地匹配。
 */
const SEGMENT_RE =
  /```(?:json)?[ \t]*\r?\n?[\s\S]*?```|<tool_call>[\s\S]*?<\/tool_call>/g;

/** 由已转跨度拼解析结果：移除已转段落，折叠多余空行并 trim。 */
function buildResult(
  text: string,
  calls: LenientConvertedCall[],
  convertedSpans: Array<{ start: number; end: number }>,
): LenientParseResult {
  let remaining = "";
  let cursor = 0;
  for (const span of convertedSpans) {
    remaining += text.slice(cursor, span.start);
    cursor = span.end;
  }
  remaining += text.slice(cursor);
  remaining = remaining.replace(/\n{3,}/g, "\n\n").trim();
  return { calls, remainingText: remaining, convertedCount: calls.length };
}

/**
 * 把文本里的宽容工具调用转换成结构化调用。
 *
 * 候选段三类：围栏块、<tool_call> 段、裸 JSON。裸 JSON 的确定性口径：
 * 全文仅由顶层 JSON 对象（可多个首尾相接）或一个对象数组构成、对象
 * 外只有空白时才逐个判定；混入任何说明文字则裸对象一律不转（围栏块
 * 有定界符，不受此限）。围栏 / <tool_call> 段内可含单个对象、对象
 * 数组或首尾相接多对象，整段全有或全无；段与段之间、裸对象之间逐个
 * 独立判定：可转的转，不可转的原样留在文本里。
 */
export function parseLenientToolCalls(
  text: string,
  tools: readonly LenientToolDef[],
): LenientParseResult {
  const noConversion: LenientParseResult = {
    calls: [],
    remainingText: text,
    convertedCount: 0,
  };
  if (text.length === 0 || tools.length === 0) return noConversion;

  const toolsByName = new Map<string, LenientToolDef>();
  for (const tool of tools) {
    if (!toolsByName.has(tool.name)) toolsByName.set(tool.name, tool);
  }

  const trimmed = text.trim();

  // 裸 JSON（数组形态）：全文是一个 JSON 数组时整段判定，全有或全无。
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseOk = false;
    }
    if (parseOk) {
      if (!Array.isArray(parsed)) return noConversion;
      const calls = evaluateJsonText(trimmed, toolsByName);
      if (calls === null) return noConversion;
      return { calls, remainingText: "", convertedCount: calls.length };
    }
    // 解析失败则继续走围栏段扫描（畸形数组里也许另有围栏块）。
  }

  // 裸 JSON（对象形态）：全文仅由顶层对象首尾相接构成时逐个判定。
  // 命中此形态即为纯 JSON 文本：一个都转不了也直接返回不转，
  // 不再往对象内部扫围栏段（避免字符串值里的 ``` 被误扫）。
  const objectSpans = scanTopLevelObjectSpans(text);
  if (objectSpans !== null) {
    const calls: LenientConvertedCall[] = [];
    const convertedSpans: Array<{ start: number; end: number }> = [];
    for (const span of objectSpans) {
      const call = evaluateCandidate(
        text.slice(span.start, span.end),
        toolsByName,
      );
      if (call !== null) {
        calls.push(call);
        convertedSpans.push(span);
      }
    }
    if (calls.length === 0) return noConversion;
    return buildResult(text, calls, convertedSpans);
  }

  // 围栏块 / <tool_call> 段逐个独立判定（段内全有或全无）。
  const calls: LenientConvertedCall[] = [];
  const convertedSpans: Array<{ start: number; end: number }> = [];
  SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(text)) !== null) {
    const full = match[0];
    const inner = full.startsWith("```") ? fenceInner(full) : toolCallInner(full);
    const segmentCalls = evaluateJsonText(inner, toolsByName);
    if (segmentCalls !== null) {
      calls.push(...segmentCalls);
      convertedSpans.push({ start: match.index, end: match.index + full.length });
    }
  }
  if (calls.length === 0) return noConversion;

  return buildResult(text, calls, convertedSpans);
}
