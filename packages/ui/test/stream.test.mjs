/*** packages/ui 执行流归约器单测 *****
 * 覆盖：流式文本累积、工具卡生命周期、agent_settled 结算与检查点标记、
 * diff 载荷与行级 diff、「改动」总账聚合、生命周期/异常事件显形、diff 标记。
 * 事件形态与 agent-host 落盘/实时流一致（见 apps/agent-host 测试中的真实事件）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDiffMark,
  applyHostEvent,
  applyHostEvents,
  computeLineDiff,
  diffPayload,
  initialStreamState,
  selectFileChanges,
} from "../dist/index.js";

function delta(text) {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  };
}

test("流式文本：增量拼接成完整回复，message_end 收尾", () => {
  let s = initialStreamState;
  s = applyHostEvent(s, { type: "user_prompt", message: "你好" });
  s = applyHostEvent(s, { type: "agent_start" });
  assert.equal(s.running, true);
  s = applyHostEvent(s, { type: "message_start", message: {} });
  s = applyHostEvent(s, delta("Stub says "));
  s = applyHostEvent(s, delta("hello."));
  const assistant = s.items.find((i) => i.kind === "assistant");
  assert.equal(assistant.text, "Stub says hello.");
  assert.equal(assistant.streaming, true);
  s = applyHostEvent(s, { type: "message_end", message: {} });
  assert.equal(s.items.find((i) => i.kind === "assistant").streaming, false);
  assert.equal(s.items[0].kind, "user");
  assert.equal(s.items[0].text, "你好");
});

test("只含工具调用的 assistant 消息不留空泡", () => {
  let s = initialStreamState;
  s = applyHostEvent(s, { type: "message_start", message: {} });
  s = applyHostEvent(s, delta("有文本"));
  s = applyHostEvent(s, { type: "message_end", message: {} });
  // 工具调用轮：message_start 后直接 message_end，无任何文本增量
  s = applyHostEvent(s, { type: "message_start", message: {} });
  s = applyHostEvent(s, {
    type: "tool_execution_start",
    toolCallId: "x1",
    toolName: "bash",
    args: { command: "true" },
  });
  s = applyHostEvent(s, { type: "message_end", message: {} });
  const assistants = s.items.filter((i) => i.kind === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "有文本");
});

test("工具卡生命周期：start 建卡（摘要=命令）→ end 落结果与成败", () => {
  let s = initialStreamState;
  s = applyHostEvent(s, {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "echo stub-tool-ok" },
  });
  let card = s.items.find((i) => i.kind === "tool");
  assert.equal(card.status, "running");
  assert.equal(card.target, "echo stub-tool-ok");
  s = applyHostEvent(s, {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "stub-tool-ok\n" }] },
    isError: false,
    durationMs: 12,
  });
  card = s.items.find((i) => i.kind === "tool");
  assert.equal(card.status, "ok");
  assert.match(card.output, /stub-tool-ok/);
  assert.equal(card.durationMs, 12);

  // 失败同样显形
  s = applyHostEvent(s, {
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "bash",
    args: { command: "false" },
  });
  s = applyHostEvent(s, {
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "bash",
    result: { content: [{ type: "text", text: "boom" }] },
    isError: true,
  });
  const failed = s.items.filter((i) => i.kind === "tool")[1];
  assert.equal(failed.status, "error");
});

test("agent_settled：只结算与计数；完成标记由落盘 lifecycle run_settled 产生", () => {
  let s = applyHostEvent(initialStreamState, { type: "agent_start" });
  s = applyHostEvent(s, { type: "agent_settled", aborted: false });
  assert.equal(s.running, false);
  assert.equal(s.settledRuns, 1);
  // agent_settled 本身不产标记（否则回放时与 lifecycle 记录双标）
  assert.equal(s.items.find((i) => i.kind === "marker"), undefined);
  s = applyHostEvent(s, { type: "lifecycle", event: "run_settled" });
  const marker = s.items.find((i) => i.kind === "marker");
  assert.ok(marker);
  assert.match(marker.label, /检查点/);
});

test("已停止：agent_settled + lifecycle run_stopped → 只有「已停止」标记，绝不标完成", () => {
  let s = applyHostEvent(initialStreamState, { type: "agent_start" });
  s = applyHostEvent(s, { type: "agent_settled", aborted: true });
  s = applyHostEvent(s, { type: "lifecycle", event: "run_stopped" });
  assert.equal(s.running, false);
  const markers = s.items.filter((i) => i.kind === "marker");
  assert.equal(markers.length, 1);
  assert.match(markers[0].label, /已停止/);
  assert.ok(!markers.some((m) => /完成/.test(m.label)));
});

test("完整轮次回放：用户→流式文本→工具→结算（与 agent-host 真实事件同形）", () => {
  const events = [
    { type: "lifecycle", event: "session_opened" },
    { type: "user_prompt", message: "请打个招呼并执行工具" },
    { type: "agent_start" },
    { type: "message_start", message: {} },
    delta("Stub says hello. "),
    { type: "message_end", message: {} },
    {
      type: "tool_execution_start",
      toolCallId: "call_stub_1",
      toolName: "bash",
      args: { command: "echo stub-tool-ok" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_stub_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "stub-tool-ok\n" }] },
      isError: false,
    },
    { type: "message_start", message: {} },
    delta("Stub final answer."),
    { type: "message_end", message: {} },
    { type: "agent_settled", aborted: false },
    { type: "lifecycle", event: "run_settled", eventsReceived: 9 },
  ];
  const s = applyHostEvents(initialStreamState, events);
  const texts = s.items
    .filter((i) => i.kind === "assistant")
    .map((i) => i.text)
    .join("");
  assert.match(texts, /Stub says hello\./);
  assert.match(texts, /Stub final answer\./);
  assert.equal(s.settledRuns, 1);
  assert.equal(s.running, false);
});

test("diff：edit 工具产出 diff 载荷；行级 diff 增删正确；标记可落", () => {
  let s = initialStreamState;
  s = applyHostEvent(s, {
    type: "tool_execution_start",
    toolCallId: "e1",
    toolName: "edit",
    args: { path: "/tmp/a.txt", oldText: "one\ntwo\n", newText: "one\nTWO\nthree\n" },
  });
  // 未完成时不产出 diff
  assert.equal(diffPayload(s.items.find((i) => i.kind === "tool")), null);
  s = applyHostEvent(s, {
    type: "tool_execution_end",
    toolCallId: "e1",
    toolName: "edit",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  });
  const payload = diffPayload(s.items.find((i) => i.kind === "tool"));
  assert.equal(payload.path, "/tmp/a.txt");
  const rows = computeLineDiff(payload.oldText, payload.newText);
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes("del"));
  assert.ok(kinds.includes("add"));

  const marked = applyDiffMark(s, "e1", "accepted");
  assert.equal(marked.diffMarks.e1, "accepted");
});

test("改动总账：edit/write 聚合，read 不计入", () => {
  let s = initialStreamState;
  for (const [id, name, path] of [
    ["t1", "edit", "/a.ts"],
    ["t2", "write", "/b.ts"],
    ["t3", "read", "/c.ts"],
    ["t4", "bash", "/d.ts"],
  ]) {
    s = applyHostEvent(s, {
      type: "tool_execution_start",
      toolCallId: id,
      toolName: name,
      args: name === "bash" ? { command: "ls" } : { path },
    });
  }
  const changes = selectFileChanges(s);
  assert.deepEqual(
    changes.map((c) => c.path),
    ["/a.ts", "/b.ts"],
  );
});

test("异常显形：run_error 成错误条目并停运行；未知事件忽略不崩", () => {
  let s = applyHostEvent(initialStreamState, { type: "agent_start" });
  s = applyHostEvent(s, { type: "run_error", message: "进程退出 code=1" });
  assert.equal(s.running, false);
  const err = s.items.find((i) => i.kind === "error");
  assert.match(err.message, /进程退出/);
  const s2 = applyHostEvent(s, { type: "some_future_event", data: 1 });
  assert.equal(s2.items.length, s.items.length);
});
