import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DONE_TTL_MS,
  MAX_DONE,
  activeDone,
  markBatchFailed,
  markBatchFinished,
  markBatchStarted,
  normalizeLedger,
  setPause,
  shouldRun,
  slotOf,
  emptyLedger,
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
