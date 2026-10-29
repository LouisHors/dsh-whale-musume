import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DONE_TTL_MS,
  MAX_DONE,
  activeDone,
  markBatchFailed,
  markBatchFinished,
  markBatchStarted,
  clockText,
  emptyLedger,
  inWindow,
  nextWindowStart,
  normalizeLedger,
  parseClock,
  parseDays,
  scheduleFrom,
  scheduleState,
  setPause,
  shouldRun,
  slotOf,
} from "../lib/robot-ledger.js";

test("slotOf: 没有槽位给干净默认值，坏账本归一化", () => {
  assert.deepEqual(slotOf(emptyLedger(), "/x"), { done: [], batches: 0, lastAt: "", errors: 0, pausedUntil: "" });
  assert.deepEqual(normalizeLedger(null), { roots: {} });
  assert.deepEqual(normalizeLedger({ roots: [] }), { roots: {} });
  assert.deepEqual(normalizeLedger({ roots: { "/x": { batches: 2 } } }).roots["/x"].batches, 2);
});

test("markBatchStarted: 批号 +1 且刷新 lastAt", () => {
  const ledger = emptyLedger();
  const now = new Date("2026-10-29T02:00:00.000Z");
  const slot = markBatchStarted(ledger, "/x", now);
  assert.equal(slot.batches, 1);
  assert.equal(slot.lastAt, "2026-10-29T02:00:00.000Z");
  assert.equal(markBatchStarted(ledger, "/x", now).batches, 2);
});

test("markBatchFinished: 去重追加 done，成功清零 errors 并清暂停", () => {
  const ledger = emptyLedger();
  const now = new Date("2026-10-29T03:00:00.000Z");
  markBatchFinished(ledger, "/x", { ids: ["a", "b"], ok: false, now });
  markBatchFinished(ledger, "/x", { ids: ["b", "c"], ok: false, now });
  assert.deepEqual(slotOf(ledger, "/x").done.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(slotOf(ledger, "/x").done[0].at, "2026-10-29T03:00:00.000Z");
  assert.equal(slotOf(ledger, "/x").errors, 2);
  assert.equal(slotOf(ledger, "/x").pausedUntil, "");

  markBatchFinished(ledger, "/x", { ids: ["d"], ok: true, now });
  assert.equal(slotOf(ledger, "/x").errors, 0);
  assert.equal(slotOf(ledger, "/x").pausedUntil, "");
});

test("markBatchFinished: 连续 3 次失败自动暂停 30 分钟", () => {
  const ledger = emptyLedger();
  const now = new Date("2026-10-29T03:00:00.000Z");
  for (let i = 0; i < 3; i += 1) markBatchFailed(ledger, "/x", { now });
  const slot = slotOf(ledger, "/x");
  assert.equal(slot.errors, 3);
  assert.equal(slot.pausedUntil, new Date(now.getTime() + 30 * 60_000).toISOString());
});

test("markBatchFinished: done 超过上限时截断，保留最近的", () => {
  const ledger = emptyLedger();
  markBatchFinished(ledger, "/x", { ids: Array.from({ length: MAX_DONE + 50 }, (_, i) => `p${i}`), ok: true });
  const done = slotOf(ledger, "/x").done;
  assert.equal(done.length, MAX_DONE);
  assert.equal(done.at(-1).id, `p${MAX_DONE + 49}`);
});

test("setPause: 清掉暂停时光标保持 lastAt", () => {
  const ledger = emptyLedger();
  markBatchStarted(ledger, "/x", new Date("2026-10-29T02:00:00.000Z"));
  setPause(ledger, "/x", "2026-10-29T04:00:00.000Z");
  assert.equal(slotOf(ledger, "/x").pausedUntil, "2026-10-29T04:00:00.000Z");
  setPause(ledger, "/x", "");
  assert.equal(slotOf(ledger, "/x").pausedUntil, "");
  assert.equal(slotOf(ledger, "/x").lastAt, "2026-10-29T02:00:00.000Z");
});

test("shouldRun: 开关/在跑/暂停/冷却四条闸门", () => {
  const now = Date.parse("2026-10-29T05:00:00.000Z");
  const base = { enabled: true, everyMinutes: 5, running: 0, now, slot: { lastAt: "2026-10-29T04:00:00.000Z", pausedUntil: "" } };
  assert.equal(shouldRun(base), true);
  assert.equal(shouldRun({ ...base, enabled: false }), false);
  assert.equal(shouldRun({ ...base, running: 1 }), false);
  assert.equal(shouldRun({ ...base, slot: { ...base.slot, pausedUntil: "2026-10-29T05:10:00.000Z" } }), false);
  assert.equal(shouldRun({ ...base, slot: { ...base.slot, lastAt: "2026-10-29T04:58:00.000Z" } }), false);
  assert.equal(shouldRun({ ...base, slot: { ...base.slot, lastAt: "2026-10-29T04:50:00.000Z" } }), true);
});

test("activeDone: 老格式字符串兼容，超过 14 天的条目过期", () => {
  const now = Date.parse("2026-10-29T00:00:00.000Z");
  const slot = {
    done: [
      "legacy-id",
      { id: "fresh", at: "2026-10-28T00:00:00.000Z" },
      { id: "old", at: "2026-09-01T00:00:00.000Z" },
    ],
  };
  const active = activeDone(slot, now);
  assert.deepEqual([...active].sort(), ["fresh", "legacy-id"]);
  assert.equal(active.has("old"), false);
  assert.equal(DONE_TTL_MS, 14 * 24 * 60 * 60 * 1000);
});

test("parseDays / parseClock / clockText：容错与边界", () => {
  assert.deepEqual(parseDays("1,2,3"), [1, 2, 3]);
  assert.deepEqual(parseDays("5 1 3"), [1, 3, 5]);
  assert.deepEqual(parseDays("0,6"), [0, 6]);
  assert.deepEqual(parseDays("1,1,9,-1,abc"), [1]);
  assert.deepEqual(parseDays(""), []);
  assert.deepEqual(parseDays(undefined), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays([3, 2]), [2, 3]);
  assert.deepEqual(parseDays([7, "x"]), []);

  assert.equal(parseClock("02:00"), 120);
  assert.equal(parseClock("0:05"), 5);
  assert.equal(parseClock("23:59"), 1439);
  assert.equal(parseClock("24:00", 999), 999);
  assert.equal(parseClock("", 42), 42);
  assert.equal(clockText(120), "02:00");
  assert.equal(clockText(5), "00:05");
  assert.equal(clockText(1439), "23:59");
  assert.equal(clockText(-10), "00:00");
});

test("inWindow：星期 + 时间段（端点排他），支持跨午夜与空集合", () => {
  const weekdayEarly = scheduleFrom({ days: "1,2,3,4,5", start: "02:00", end: "04:00" });
  // 2026-10-26 是周一
  assert.equal(inWindow(new Date(2026, 9, 26, 2, 30).getTime(), weekdayEarly), true);
  assert.equal(inWindow(new Date(2026, 9, 26, 1, 59).getTime(), weekdayEarly), false);
  assert.equal(inWindow(new Date(2026, 9, 26, 4, 0).getTime(), weekdayEarly), false);
  assert.equal(inWindow(new Date(2026, 9, 31, 3, 0).getTime(), weekdayEarly), false); // 周六
  assert.equal(inWindow(new Date(2026, 9, 26, 3, 0).getTime(), scheduleFrom({ days: "", start: "02:00", end: "04:00" })), false);
  assert.equal(inWindow(new Date(2026, 9, 26, 3, 0).getTime(), scheduleFrom({ days: [], start: "02:00", end: "04:00" })), false);

  const wrap = scheduleFrom({ days: "1,2", start: "23:00", end: "05:00" });
  assert.equal(inWindow(new Date(2026, 9, 26, 23, 30).getTime(), wrap), true);
  assert.equal(inWindow(new Date(2026, 9, 27, 1, 0).getTime(), wrap), true);
  assert.equal(inWindow(new Date(2026, 9, 26, 12, 0).getTime(), wrap), false);
  assert.equal(inWindow(new Date(2026, 9, 27, 6, 0).getTime(), wrap), false);

  const allDay = scheduleFrom({ days: "3", start: "09:00", end: "09:00" });
  assert.equal(inWindow(new Date(2026, 9, 28, 3, 0).getTime(), allDay), true);
  assert.equal(inWindow(new Date(2026, 9, 29, 3, 0).getTime(), allDay), false);
});

test("nextWindowStart / scheduleState：算出下一次开工时间", () => {
  const schedule = scheduleFrom({ days: "1,2,3,4,5", start: "02:00", end: "04:00" });
  const fridayNoon = new Date(2026, 9, 30, 12, 0).getTime();
  const next = nextWindowStart(fridayNoon, schedule);
  const expected = new Date(2026, 10, 2, 2, 0).getTime();
  assert.equal(next, expected);

  const state = scheduleState(fridayNoon, schedule);
  assert.equal(state.open, false);
  assert.equal(state.window, "02:00–04:00");
  assert.equal(state.daysText, "一 二 三 四 五");
  assert.equal(state.nextAt, new Date(expected).toISOString());

  const inside = scheduleState(new Date(2026, 9, 26, 3, 0).getTime(), schedule);
  assert.equal(inside.open, true);
  assert.equal(inside.nextAt, "");
});

test("shouldRun：时间段外不开批，窗口内按冷却与暂停判定", () => {
  const schedule = scheduleFrom({ days: "1,2,3,4,5", start: "02:00", end: "04:00" });
  const mondayNight = new Date(2026, 9, 26, 3, 0).getTime();
  const mondayNoon = new Date(2026, 9, 26, 12, 0).getTime();

  assert.equal(shouldRun({ slot: {}, enabled: true, schedule, now: mondayNoon }), false);
  assert.equal(shouldRun({ slot: {}, enabled: true, schedule, now: mondayNight }), true);
  assert.equal(
    shouldRun({ slot: { lastAt: new Date(mondayNight - 10 * 60_000).toISOString() }, enabled: true, schedule, everyMinutes: 30, now: mondayNight }),
    false,
  );
  assert.equal(
    shouldRun({ slot: { lastAt: new Date(mondayNight - 40 * 60_000).toISOString() }, enabled: true, schedule, everyMinutes: 30, now: mondayNight }),
    true,
  );
  assert.equal(
    shouldRun({ slot: { pausedUntil: new Date(mondayNight + 60_000).toISOString() }, enabled: true, schedule, now: mondayNight }),
    false,
  );
});
