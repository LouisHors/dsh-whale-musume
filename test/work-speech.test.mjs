import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* issue #24：工作态台词两档（话痨 / 安静）+ 随机冷却窗口。
   直接从 assets/dsh-whale-moe.js 里切出这一段真实实现来跑，避免测试与实现漂移。 */
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(rootDir, "assets", "dsh-whale-moe.js"), "utf8");

function extractRegion(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract region ${startMarker}`);
  return source.slice(start, end);
}

const region = extractRegion("  /* ---------- work speech scheduler", "  /* ---------- idle chat scheduler");

function build({ prefText = () => "chatty", chat = true, topic = "general", contextLine = "", workLine = "work-line", failureStreak = 0 } = {}) {
  const factory = new Function(
    "readPrefText",
    "readPref",
    "latestTaskTopic",
    "core",
    "say",
    "memory",
    "recentLines",
    `${region}\nreturn { workSpeechAllowed, workSpeechMode, workSpeechWindow, pickWorkSpeechLine, workSpeech, WORK_SPEECH_WINDOWS };`
  );
  const calls = { context: [], work: [] };
  const api = factory(
    prefText,
    () => chat,
    () => topic,
    { pickDialogueAvoidRecent: (bank, key) => { calls.context.push([bank, key]); return contextLine; } },
    (bank, event) => { calls.work.push([bank, event]); return workLine; },
    { failureStreak },
    []
  );
  return { ...api, calls };
}

test("话痨档窗口落在 15-40 秒，安静档落在 90-240 秒", () => {
  const chatty = build();
  assert.deepEqual(chatty.WORK_SPEECH_WINDOWS.chatty, [15000, 40000]);
  assert.deepEqual(chatty.WORK_SPEECH_WINDOWS.quiet, [90000, 240000]);

  const low = build();
  low.workSpeechAllowed(1_000_000, "chatty", () => 0);
  assert.equal(low.workSpeech.nextAt - 1_000_000, 15000);

  const high = build();
  high.workSpeechAllowed(1_000_000, "chatty", () => 0.999999);
  const span = high.workSpeech.nextAt - 1_000_000;
  assert.ok(span >= 15000 && span <= 40000, `span out of range: ${span}`);

  const quiet = build();
  quiet.workSpeechAllowed(1_000_000, "quiet", () => 0.5);
  const quietSpan = quiet.workSpeech.nextAt - 1_000_000;
  assert.ok(quietSpan >= 90000 && quietSpan <= 240000, `quiet span out of range: ${quietSpan}`);
});

test("窗口内只允许说一句：同一时刻连问四次只有第一次通过（同一次状态跳变不会弹两条）", () => {
  const api = build();
  const now = 5_000_000;
  const answers = ["thinking", "tool", "success", "failure"].map((state) => api.workSpeechAllowed(now, "chatty", () => 0.5) && state);
  assert.equal(answers.filter(Boolean).length, 1, "四态共用一个冷却窗口");
  assert.equal(api.workSpeechAllowed(now + 14999, "chatty", () => 0.5), false, "窗口未到仍被挡住");
  assert.equal(api.workSpeechAllowed(api.workSpeech.nextAt, "chatty", () => 0.5), true, "窗口到点后放行");
});

test("切档立即生效：安静档等待中切回话痨不需要干等", () => {
  const api = build({ prefText: () => "quiet" });
  assert.equal(api.workSpeechMode(), "quiet");
  api.workSpeechAllowed(1000, api.workSpeechMode(), () => 0.5);
  assert.equal(api.workSpeechAllowed(2000, api.workSpeechMode(), () => 0.5), false);

  const api2 = build();
  api2.workSpeechAllowed(1000, "quiet", () => 0.5);
  assert.equal(api2.workSpeechAllowed(2000, "chatty", () => 0.5), true, "换档清掉旧窗口");
  assert.equal(api2.workSpeech.mode, "chatty");
});

test("偏好缺失或非法值回落到话痨档", () => {
  assert.equal(build({ prefText: () => "chatty" }).workSpeechMode(), "chatty");
  assert.equal(build({ prefText: () => "quiet" }).workSpeechMode(), "quiet");
  assert.equal(build({ prefText: () => "nonsense" }).workSpeechMode(), "chatty");
  assert.equal(build({ prefText: () => "" }).workSpeechMode(), "chatty");
});

test("工作态取词：thinking/tool 按当前任务话题取，general 时回落原语料", () => {
  const topicLine = build({ topic: "deploy", contextLine: "部署好了" });
  assert.equal(topicLine.pickWorkSpeechLine("thinking"), "部署好了");
  assert.deepEqual(topicLine.calls.context, [["context", "deploy"]]);
  assert.deepEqual(topicLine.calls.work, []);

  const general = build({ topic: "general", contextLine: "不该被用" });
  assert.equal(general.pickWorkSpeechLine("tool"), "work-line");
  assert.deepEqual(general.calls.work, [["work", "tool"]]);
  assert.deepEqual(general.calls.context, [], "general 不查话题语料");
});

test("成功 / 出错保留各自语料（带信息量，不被话题化）", () => {
  const api = build({ topic: "deploy", contextLine: "不该被用" });
  api.pickWorkSpeechLine("success");
  api.pickWorkSpeechLine("failure");
  assert.deepEqual(api.calls.work, [["work", "success"], ["work", "failure"]]);
  assert.deepEqual(api.calls.context, []);

  const gentle = build({ failureStreak: 3 });
  gentle.pickWorkSpeechLine("failure");
  assert.deepEqual(gentle.calls.work, [["work", "gentle"]]);
});

test("总开关「台词气泡」优先级最高：关掉后任何工作态都不取词", () => {
  const api = build({ chat: false, topic: "deploy", contextLine: "话题台词" });
  assert.equal(api.pickWorkSpeechLine("thinking"), "");
  assert.equal(api.pickWorkSpeechLine("success"), "");
  assert.deepEqual(api.calls.context, []);
  assert.deepEqual(api.calls.work, []);
});

test("render 里三处工作态台词全部经过冷却闸门（防止有人再加一条漏网的）", () => {
  const gated = source.split("workSpeechAllowed(Date.now(), workSpeechMode())").length - 1;
  assert.equal(gated, 3, "failure / success / thinking+tool 三处都要过闸门");
  const ungated = /if \(view === "workbench"\) \{\s*\n\s*var [a-z]Line = say\("work"/.test(source);
  assert.equal(ungated, false, "不允许再出现不过闸门的 say(\"work\", ...)");
});
