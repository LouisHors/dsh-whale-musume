// dsh-whale-musume —— 状态通知折叠器单测（纯 Node，无宿主依赖）。
import assert from "node:assert/strict";
import test from "node:test";
import { NotificationHub, clip, formatDuration, questionTextOf } from "../lib/notifications.js";

/** 造一个只有 id/header 的假会话，模拟 cordis 总线传进来的 session。 */
function fakeSession(id, header = { id }) {
  return { id, header };
}

test("turn/end(completed) 折叠成完成通知，带标题与耗时", () => {
  const hub = new NotificationHub({ now: () => 1_000 });
  hub.ingest(fakeSession("s1"), { type: "session/title", data: { title: "重构 runner" } });
  hub.ingest(fakeSession("s1"), { type: "turn/start", data: { turn: 1 }, time: 1_000 });
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } }, time: 86_000 });
  const items = hub.snapshot(0).items;
  assert.equal(items.length, 1);
  assert.deepEqual(
    { kind: items[0].kind, sessionId: items[0].sessionId, title: items[0].title, durationMs: items[0].durationMs },
    { kind: "turn-done", sessionId: "s1", title: "重构 runner", durationMs: 85_000 },
  );
});

test("取消、拒绝与中断的回合不打扰用户，截断要提示", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 1, reason: { kind: "canceled" } } });
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 2, reason: { kind: "blocked" } } });
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 3, reason: { kind: "aborted" } } });
  assert.equal(hub.snapshot(0).items.length, 0);

  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 4, reason: { kind: "max-tokens" } } });
  assert.equal(hub.snapshot(0).items[0].kind, "turn-error");
  assert.equal(hub.snapshot(0).items[0].text, "输出到长度上限，被截断了");
});

test("出错的回合带出错原因", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "连接超时" } } } });
  const [item] = hub.snapshot(0).items;
  assert.equal(item.kind, "turn-error");
  assert.equal(item.text, "连接超时");
});

test("子代理会话的完成事件不打扰主人，但普通 fork 会话照常提醒", () => {
  const hub = new NotificationHub();
  const child = { id: "child", header: { id: "child", origin: "subagent", parentSession: "s1", delegationDepth: 1 } };
  hub.ingest(child, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  assert.equal(hub.snapshot(0).items.length, 0);

  /* fork 出来的普通会话也带 parentSession，不能因此被当成内部会话 */
  hub.ingest({ id: "fork", header: { id: "fork", parentSession: "s1" } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  assert.equal(hub.snapshot(0).items.length, 1);
  assert.equal(hub.snapshot(0).items[0].sessionId, "fork");
});

test("ask_user_question 折叠成待回答卡片，并记住 refId", () => {
  const hub = new NotificationHub();
  const args = JSON.stringify({ questions: [{ id: "q1", header: "Confirm", question: "要现在发布吗？", options: [] }] });
  hub.ingest(fakeSession("s1"), { type: "tool/call", data: { turn: 1, step: 1, callId: "call-9", name: "ask_user_question", arguments: args } });
  const [item] = hub.snapshot(0).items;
  assert.equal(item.kind, "question-asked");
  assert.equal(item.text, "要现在发布吗？");
  assert.equal(item.refId, "question:call-9");
});

test("普通工具调用不产生通知", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), { type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{}" } });
  assert.equal(hub.snapshot(0).items.length, 0);
});

test("审批请求与答复折叠成 asked + resolved", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), { type: "approval/asked", data: { id: "ap-1", toolName: "bash" } });
  hub.ingest(fakeSession("s1"), { type: "approval/decided", data: { id: "ap-1" } });
  const kinds = hub.snapshot(0).items.map((item) => item.kind);
  assert.deepEqual(kinds, ["approval-asked", "resolved"]);
  assert.equal(hub.snapshot(0).items[1].refId, "approval:ap-1");
});

test("回答提问后发 resolved，前端据此撤卡", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), {
    type: "user/message",
    data: { source: { kind: "user-question-reply", callId: "call-9" }, message: { content: [] } },
  });
  assert.deepEqual(hub.snapshot(0).items[0], { seq: 1, at: hub.now(), kind: "resolved", refId: "question:call-9" });
});

test("没有正式标题时用首条用户消息兜底，session/title 会覆盖它", () => {
  const hub = new NotificationHub();
  hub.ingest(fakeSession("s1"), { type: "user/message", data: { message: { content: [{ type: "text", text: "帮我看下这个报错" }] } } });
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  assert.equal(hub.snapshot(0).items[0].title, "帮我看下这个报错");

  hub.ingest(fakeSession("s1"), { type: "session/title", data: { title: "排查构建失败" } });
  hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  assert.equal(hub.snapshot(0).items.at(-1).title, "排查构建失败");
});

test("环形缓冲封顶，since 游标只返回增量", () => {
  const hub = new NotificationHub({ max: 3 });
  for (let turn = 1; turn <= 5; turn += 1) {
    hub.ingest(fakeSession("s1"), { type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
  const all = hub.snapshot(0);
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.items.map((item) => item.seq), [3, 4, 5]);
  assert.equal(all.lastSeq, 5);
  assert.deepEqual(hub.snapshot(4).items.map((item) => item.seq), [5]);
});

test("坏数据不抛异常", () => {
  const hub = new NotificationHub();
  assert.equal(hub.ingest(null, { type: "turn/end" }), null);
  assert.equal(hub.ingest({}, { type: "turn/end" }), null);
  assert.equal(hub.ingest(fakeSession("s1"), { type: "tool/call", data: { name: "ask_user_question", arguments: "not json" } })?.text, "我有个问题想问你");
  assert.equal(hub.ingest(fakeSession("s1"), { type: "unknown/type" }), null);
});

test("clip / formatDuration / questionTextOf 的边界", () => {
  assert.equal(clip("  a \n b  ", 10), "a b");
  assert.equal(clip("0123456789", 5), "0123…");
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(84_000), "1 分 24 秒");
  assert.equal(formatDuration(120_000), "2 分钟");
  assert.equal(formatDuration(Number.NaN), "");

  assert.equal(questionTextOf("not json"), "");
  assert.equal(questionTextOf(JSON.stringify({ questions: [] })), "");
  assert.equal(questionTextOf(JSON.stringify({ questions: [{ header: "标题" }] })), "标题");
  assert.equal(
    questionTextOf(JSON.stringify({ questions: [{ question: "选哪个？" }, { question: "为什么？" }] })),
    "选哪个？（共 2 个问题）",
  );
});
