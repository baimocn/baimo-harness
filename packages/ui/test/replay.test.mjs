/*** 阶段 3 · 模块 3：会话回放游标单测 *****
 * 核心断言：任意下标处游标给出的画面，与把同一前缀事件从头喂给
 * 实时归约器（applyHostEvents）的结果严格一致——回放与实时同口径，
 * 不是第二套渲染。事件形态与落盘归一化序列一致（用户指令、流式
 * 文本、工具卡、结算、lifecycle 标记）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReplayCursor,
  applyHostEvents,
  initialStreamState,
} from "../dist/index.js";

const EVENTS = [
  { type: "user_prompt", message: "做一件事" },
  { type: "agent_start" },
  { type: "message_start", message: { role: "assistant", content: [] } },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "你好" },
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "，开始。" },
  },
  { type: "message_end", message: { role: "assistant" } },
  {
    type: "tool_execution_start",
    toolCallId: "tc1",
    toolName: "bash",
    args: { command: "echo hi" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "tc1",
    result: { content: [{ type: "text", text: "hi\n" }] },
    isError: false,
  },
  { type: "message_start", message: { role: "assistant", content: [] } },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "完成。" },
  },
  { type: "message_end", message: { role: "assistant" } },
  { type: "agent_settled" },
  { type: "lifecycle", event: "run_settled" },
];

function foldPrefix(n) {
  return applyHostEvents(initialStreamState, EVENTS.slice(0, n));
}

test("游标：任意下标画面与从头折叠前缀严格一致", () => {
  const cursor = new ReplayCursor(EVENTS);
  assert.equal(cursor.total, EVENTS.length);
  assert.equal(cursor.index, 0);
  assert.ok(cursor.atStart);
  assert.deepEqual(cursor.state(), foldPrefix(0));

  // 逐步前进：每一步都对账
  for (let k = 1; k <= EVENTS.length; k++) {
    assert.equal(cursor.stepForward(), true);
    assert.equal(cursor.index, k);
    assert.deepEqual(cursor.state(), foldPrefix(k), `前进到 ${k} 应一致`);
  }
  assert.ok(cursor.atEnd);
  assert.equal(cursor.stepForward(), false, "结尾再前进应返回 false");

  // 逐步后退：每一步都对账
  for (let k = EVENTS.length - 1; k >= 0; k--) {
    assert.equal(cursor.stepBack(), true);
    assert.equal(cursor.index, k);
    assert.deepEqual(cursor.state(), foldPrefix(k), `后退到 ${k} 应一致`);
  }
  assert.equal(cursor.stepBack(), false, "开头再后退应返回 false");

  // 随机跳转（前进/后退混合）：每点都对账
  for (const target of [7, 2, 13, 0, 5, 13, 1]) {
    cursor.seek(target);
    assert.equal(cursor.index, target);
    assert.deepEqual(cursor.state(), foldPrefix(target), `跳到 ${target} 应一致`);
  }
  // 越界钳制
  cursor.seek(999);
  assert.equal(cursor.index, EVENTS.length);
  cursor.seek(-3);
  assert.equal(cursor.index, 0);
  cursor.seek(4);
  cursor.reset();
  assert.equal(cursor.index, 0);
  assert.deepEqual(cursor.state(), foldPrefix(0));
});

test("游标：关键节点内容正确（工具卡在中途出现、结尾才有完成标记）", () => {
  const cursor = new ReplayCursor(EVENTS);
  cursor.seek(7); // 工具刚开始、还没结束
  const midTool = cursor.state().items.find((i) => i.kind === "tool");
  assert.ok(midTool, "第 7 个事件后应有工具卡");
  assert.equal(midTool.status, "running");
  const textsMid = cursor
    .state()
    .items.filter((i) => i.kind === "assistant")
    .map((i) => i.text)
    .join("");
  assert.ok(!textsMid.includes("完成。"), "中途不应出现最终答复");

  cursor.seek(EVENTS.length);
  const final = cursor.state();
  const tool = final.items.find((i) => i.kind === "tool");
  assert.equal(tool.status, "ok");
  assert.ok(tool.output.includes("hi"));
  assert.ok(
    final.items.some((i) => i.kind === "assistant" && i.text.includes("完成。")),
    "结尾应有最终答复",
  );
  assert.ok(
    final.items.some((i) => i.kind === "marker"),
    "结尾应有 lifecycle 完成标记（与实时同口径）",
  );
  assert.equal(final.settledRuns, 1);
  assert.equal(final.running, false);
});

test("游标：空事件序列", () => {
  const cursor = new ReplayCursor([]);
  assert.equal(cursor.total, 0);
  assert.ok(cursor.atStart && cursor.atEnd);
  assert.equal(cursor.stepForward(), false);
  assert.deepEqual(cursor.state(), initialStreamState);
});
