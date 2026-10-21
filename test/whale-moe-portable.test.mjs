import test from "node:test";
import assert from "node:assert/strict";
import { loadCore } from "./load-core.mjs";

const core = loadCore();
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const SINCE = NOW - 10 * 86400000;

function sampleRaw() {
  return {
    mood: "82",
    affinity: "1200",
    satiety: "44",
    level: "3",
    lastSignin: "2026-10-20",
    signinStreak: "4",
    achievements: "first-pat,first-pat,nope,thanks",
    companionSince: String(SINCE),
    badge: "bond-lv5",
    title: "  主人\u0007  ",
    selfName: "鲸鱼娘",
    quests: JSON.stringify({ date: "2026-10-21", slots: [{ id: "signin-1", progress: 1, claimed: false }] }),
    weekSignin: JSON.stringify({ week: "2026-10-19", days: [1, 0, 0] }),
    gameStats: JSON.stringify({ plays: 9, wins: 4 }),
    usageStats: JSON.stringify({ tools: 12, pat: 30 }),
    journal: JSON.stringify([{ at: 1, kind: "achievement", text: "解锁成就：初次摸头" }]),
    floatX: "640",
    floatY: "360",
    weatherLat: "31.2"
  };
}

test("导出：只收养成字段，剔除设备位置与天气坐标", () => {
  const payload = core.portableBuild(sampleRaw(), { appVersion: "2.5.0" }, NOW);
  assert.equal(payload.schema, core.PORTABLE.SCHEMA);
  assert.equal(payload.version, 1);
  assert.equal(payload.appVersion, "2.5.0");
  assert.equal(payload.exportedAt, new Date(NOW).toISOString());
  assert.equal(payload.data.floatX, undefined);
  assert.equal(payload.data.floatY, undefined);
  assert.equal(payload.data.weatherLat, undefined);
  assert.equal(payload.data.achievements, "first-pat,thanks");
  assert.equal(payload.data.title, "主人");
  assert.equal(payload.data.affinity, "1200");
});

test("导入：合法存档解析成功，摘要数字正确", () => {
  const payload = core.portableBuild(sampleRaw(), { appVersion: "2.5.0" }, NOW);
  const parsed = core.portableParse(JSON.stringify(payload), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.summary.level, 3);
  assert.equal(parsed.summary.affinity, 1200);
  assert.equal(parsed.summary.achievements, 2);
  assert.equal(parsed.summary.companionDays, 10);
  assert.equal(parsed.summary.journal, 1);
  assert.equal(parsed.payload.data.lastSignin, "2026-10-20");
});

test("导入：数值越界钳制，非法 level 回落到 1", () => {
  const payload = core.portableBuild({
    affinity: "999999", mood: "-10", satiety: "300", level: "0", signinStreak: "-2"
  }, null, NOW);
  const parsed = core.portableParse(JSON.stringify(payload), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.data.affinity, "10000");
  assert.equal(parsed.payload.data.mood, "0");
  assert.equal(parsed.payload.data.satiety, "100");
  assert.equal(parsed.payload.data.level, "1");
  assert.equal(parsed.payload.data.signinStreak, "0");
});

test("导入：未知成就被过滤，重复成就去重", () => {
  const payload = core.portableBuild({ achievements: "thanks,hack,thanks,first-pat" }, null, NOW);
  const parsed = core.portableParse(JSON.stringify(payload), NOW);
  assert.equal(parsed.payload.data.achievements, "thanks,first-pat");
});

test("导入：非法 JSON 字段丢弃，但其它字段仍可用", () => {
  const payload = core.portableBuild({
    mood: "50",
    quests: JSON.stringify({ slots: [1, 2, 3, 4] }),
    journal: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81])
  }, null, NOW);
  const parsed = core.portableParse(JSON.stringify(payload), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.data.mood, "50");
  assert.equal(parsed.payload.data.quests, undefined);
  assert.equal(parsed.payload.data.journal, undefined);
});

test("导入：拒绝空内容 / 坏 JSON / 非本插件存档 / 未来版本", () => {
  assert.equal(core.portableParse("", NOW).ok, false);
  assert.equal(core.portableParse("   ", NOW).ok, false);
  assert.equal(core.portableParse("{oops", NOW).ok, false);
  assert.equal(core.portableParse(JSON.stringify({ schema: "x", data: {} }), NOW).ok, false);
  const future = core.portableBuild({ mood: "1" }, null, NOW);
  future.version = 99;
  const parsed = core.portableParse(JSON.stringify(future), NOW);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /版本不兼容/);
});

test("导入：没有可识别数据时明确报错", () => {
  const parsed = core.portableParse(JSON.stringify({ schema: core.PORTABLE.SCHEMA, version: 1, data: { floatX: "1" } }), NOW);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /没有可识别/);
});

test("迁移码：核心字段往返一致", () => {
  const payload = core.portableBuild(sampleRaw(), { appVersion: "2.5.0" }, NOW);
  const code = core.portableCode(payload);
  assert.match(code, /^WM1-[0-9a-f]{8}-[A-Za-z0-9_-]+$/);
  const parsed = core.portableFromCode(code, NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.data.affinity, "1200");
  assert.equal(parsed.payload.data.selfName, "鲸鱼娘", "纯 JS base64 必须能往返中文");
  assert.equal(parsed.payload.data.achievements, "first-pat,thanks");
  assert.equal(parsed.payload.data.quests, undefined, "迁移码只带核心进度");
  assert.equal(parsed.payload.data.gameStats, undefined);
});

test("迁移码：允许换行/空格，校验失败可识别", () => {
  const payload = core.portableBuild(sampleRaw(), null, NOW);
  const code = core.portableCode(payload);
  const withSpace = code.slice(0, 12) + "\n " + code.slice(12);
  assert.equal(core.portableFromCode(withSpace, NOW).ok, true);
  const tampered = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  const parsed = core.portableFromCode(tampered, NOW);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /校验失败/);
  assert.equal(core.portableFromCode("nope", NOW).ok, false);
  assert.equal(core.portableFromCode("WM1-zzz-abc", NOW).ok, false);
});

test("迁移码：非法版本/非法 JSON 不通过", () => {
  const payload = core.portableBuild({ mood: "60" }, null, NOW);
  const json = JSON.stringify(core.portableCore(payload));
  const encoded = Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // 校验和是内部实现，这里直接构造同前缀 + 错误正文，必须被 JSON 解析或 schema 拦下
  const bad = "WM1-00000000-" + encoded;
  assert.equal(core.portableFromCode(bad, NOW).ok, false);
});

test("导入后写回：所有值都是字符串，可直接进 localStorage", () => {
  const payload = core.portableBuild(sampleRaw(), null, NOW);
  const parsed = core.portableParse(JSON.stringify(payload), NOW);
  for (const [key, value] of Object.entries(parsed.payload.data)) {
    assert.equal(typeof value, "string", key + " 必须是字符串");
  }
});
