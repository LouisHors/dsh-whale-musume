import test from "node:test";
import assert from "node:assert/strict";
import { loadCore } from "./load-core.mjs";

const core = loadCore();
const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);

function faceMap(state) {
  const map = new Map();
  state.cards.forEach((card, index) => {
    if (!map.has(card.face)) map.set(card.face, []);
    map.get(card.face).push(index);
  });
  return map;
}

function flipPair(state, face, at) {
  const [a, b] = faceMap(state).get(face);
  let out = core.memoryFlip(state, a, at);
  out = core.memoryFlip(out.state, b, at + 50);
  return out;
}

test("发牌：16 张、8 对、每个翻牌面恰好出现两次", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  assert.equal(state.cards.length, core.MEMORY.PAIRS * 2);
  assert.equal(state.cards.length, 16);
  const counts = new Map();
  for (const card of state.cards) counts.set(card.face, (counts.get(card.face) || 0) + 1);
  assert.equal(counts.size, 8);
  for (const count of counts.values()) assert.equal(count, 2);
  assert.equal(state.status, "playing");
  assert.equal(state.remainingMs, core.MEMORY.DURATION_MS);
});

test("发牌：候选池不足 8 个时回落到内置面池", () => {
  const state = core.memoryNewState(T0, () => 0.5, ["only-one"]);
  const faces = new Set(state.cards.map((c) => c.face));
  assert.equal(faces.size, 8);
  for (const face of faces) assert.ok(core.MEMORY_FACES.includes(face));
});

test("翻第一张：只记录 first，不判配对", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const out = core.memoryFlip(state, 0, T0 + 100);
  assert.equal(out.event, "first");
  assert.equal(out.state.first, 0);
  assert.equal(out.state.second, -1);
  assert.equal(out.state.moves, 0);
  assert.equal(out.state.cards[0].flipped, true);
  assert.equal(out.state.cards[0].matched, false);
});

test("配对成功：+100 基础分 + 连击加成，两张牌标记 matched", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const face = state.cards[0].face;
  const out = flipPair(state, face, T0 + 100);
  assert.equal(out.event, "match");
  assert.equal(out.matched, true);
  assert.equal(out.delta, core.MEMORY.MATCH_SCORE + core.MEMORY.COMBO_BONUS);
  assert.equal(out.state.matched, 1);
  assert.equal(out.state.combo, 1);
  assert.equal(out.state.first, -1);
  assert.equal(out.state.second, -1);
  const matched = out.state.cards.filter((c) => c.matched);
  assert.equal(matched.length, 2);
});

test("配对失败：扣 10 分、断连击、900ms 后自动翻回", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const map = faceMap(state);
  const faces = [...map.keys()];
  const a = map.get(faces[0])[0];
  const b = map.get(faces[1])[0];
  let out = core.memoryFlip(state, a, T0 + 100);
  out = core.memoryFlip(out.state, b, T0 + 200);
  assert.equal(out.event, "mismatch");
  assert.equal(out.delta, -core.MEMORY.MISMATCH_PENALTY);
  assert.equal(out.state.combo, 0);
  assert.equal(out.state.pendingHideAt, T0 + 200 + core.MEMORY.FLIP_BACK_MS);
  const before = core.memoryTick(out.state, T0 + 300);
  assert.equal(before.events.length, 0);
  assert.equal(before.state.cards[a].flipped, true);
  const after = core.memoryTick(out.state, T0 + 200 + core.MEMORY.FLIP_BACK_MS);
  assert.ok(after.events.some((e) => e.kind === "hide"));
  assert.equal(after.state.cards[a].flipped, false);
  assert.equal(after.state.cards[b].flipped, false);
  assert.equal(after.state.first, -1);
  assert.equal(after.state.second, -1);
});

test("翻回等待期：第三张点击被忽略，不会冲掉 first/second", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const map = faceMap(state);
  const faces = [...map.keys()];
  let out = core.memoryFlip(state, map.get(faces[0])[0], T0 + 100);
  out = core.memoryFlip(out.state, map.get(faces[1])[0], T0 + 200);
  const third = core.memoryFlip(out.state, map.get(faces[2])[0], T0 + 300);
  assert.equal(third.event, "ignored");
  assert.equal(third.state, out.state);
});

test("重复点同一张 / 点已配对的牌：忽略", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const first = core.memoryFlip(state, 0, T0 + 100);
  const again = core.memoryFlip(first.state, 0, T0 + 200);
  assert.equal(again.event, "ignored");
  const face = state.cards[0].face;
  const matched = flipPair(state, face, T0 + 100);
  const dead = core.memoryFlip(matched.state, faceMap(matched.state).get(face)[0], T0 + 300);
  assert.equal(dead.event, "ignored");
});

test("翻牌不修改原 state（纯函数）", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const snapshot = JSON.stringify(state);
  core.memoryFlip(state, 0, T0 + 100);
  assert.equal(JSON.stringify(state), snapshot);
});

test("集齐 8 对：立即结束并返回 win；时间奖励计入结算分", () => {
  let state = core.memoryNewState(T0, () => 0.5);
  const faces = [...faceMap(state).keys()];
  let last = null;
  faces.forEach((face, i) => {
    last = flipPair(state, face, T0 + 1000 + i * 1000);
    state = last.state;
  });
  assert.equal(last.event, "win");
  assert.equal(state.status, "ended");
  assert.equal(state.matched, 8);
  const result = core.memoryResult(state);
  assert.equal(result.grade, "win");
  assert.equal(result.matched, 8);
  assert.ok(result.score >= 8 * core.MEMORY.MATCH_SCORE);
  assert.ok(result.score > state.score, "胜利应加时间奖励");
});

test("计时结束：按已配对数量判 draw / lose", () => {
  let state = core.memoryNewState(T0, () => 0.5);
  const faces = [...faceMap(state).keys()];
  for (let i = 0; i < 5; i += 1) state = flipPair(state, faces[i], T0 + 1000 + i * 1000).state;
  const ended = core.memoryTick(state, T0 + core.MEMORY.DURATION_MS + 1);
  assert.equal(ended.state.status, "ended");
  assert.ok(ended.events.some((e) => e.kind === "timeout"));
  assert.equal(core.memoryResult(ended.state).grade, "draw");

  let low = core.memoryNewState(T0, () => 0.5);
  low = flipPair(low, faces[0], T0 + 1000).state;
  const lowEnd = core.memoryTick(low, T0 + core.MEMORY.DURATION_MS + 1).state;
  assert.equal(core.memoryResult(lowEnd).grade, "lose");
});

test("timeout 只触发一次", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const once = core.memoryTick(state, T0 + core.MEMORY.DURATION_MS + 1);
  assert.equal(once.state.status, "ended");
  const twice = core.memoryTick(once.state, T0 + core.MEMORY.DURATION_MS + 500);
  assert.equal(twice.state, once.state);
  assert.equal(twice.events.length, 0);
});

test("结算精度：moves 为 0 时不出现 NaN", () => {
  const state = core.memoryNewState(T0, () => 0.5);
  const result = core.memoryResult(state);
  assert.equal(result.accuracy, 0);
  assert.equal(result.moves, 0);
  assert.equal(result.grade, "lose");
});

test("翻翻乐成就：首玩 / 通关 / 零失误 / 六连", () => {
  assert.deepEqual(core.evaluateMemoryAchievements([], { plays: 1 }), ["memory-first"]);
  assert.deepEqual(core.evaluateMemoryAchievements(["memory-first"], { plays: 3, wins: 1 }), ["memory-clear"]);
  assert.deepEqual(core.evaluateMemoryAchievements(["memory-first", "memory-clear"], { plays: 3, wins: 1, perfect: 1 }), ["memory-perfect"]);
  assert.deepEqual(core.evaluateMemoryAchievements([], { plays: 2, wins: 1, perfect: 1, comboMax: 6 }), [
    "memory-first", "memory-clear", "memory-perfect", "memory-combo6"
  ]);
  assert.deepEqual(core.evaluateMemoryAchievements(["memory-first", "memory-clear", "memory-perfect", "memory-combo6"], { plays: 9, wins: 9, perfect: 9, comboMax: 8 }), []);
});

test("MEMORY 常量冻结，外部改不动", () => {
  assert.ok(Object.isFrozen(core.MEMORY));
  assert.ok(Object.isFrozen(core.MEMORY_FACES));
});
