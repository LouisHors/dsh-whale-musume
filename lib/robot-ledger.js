/**
 * 粮仓机器人的「进度账本」纯函数。
 *
 * 放在单独文件里是为了能脱离宿主单测：这里只算数据，不碰会话、不读系统时间以外的东西。
 * 账本形状：{ roots: { "<仓库绝对路径>": { done: string[], batches: number, lastAt: ISO, errors: number, pausedUntil: ISO } } }
 */

/** 同一仓库最多记多少条「试过」的条目，防止账本无限长。 */
export const MAX_DONE = 1200;
/** 连续多少次开批/跑批失败后自动歇一会儿。 */
export const ERROR_STREAK_LIMIT = 3;
/** 自动歇多久。 */
export const PAUSE_MS = 30 * 60 * 1000;
/** 一批跑挂多久算僵死（超时后允许下一批，避免一行卡住整个机器人）。 */
export const STALE_MS = 45 * 60 * 1000;
/** 「试过」的记录保留多久：过期后允许同一页再试一次（否则一次失败/偷懒就永久跳过）。 */
export const DONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 空账本。 */
export function emptyLedger() {
  return { roots: {} };
}

/** 读出来的东西不一定是账本形状（手工改坏/半截文件），归一化一下。 */
export function normalizeLedger(value) {
  if (!value || typeof value !== "object" || !value.roots || typeof value.roots !== "object" || Array.isArray(value.roots)) return emptyLedger();
  return value;
}

/** 老账本里 done 是字符串数组，统一成 { id, at }，方便过期。 */
export function normalizeDone(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? { id: item, at: "" } : item))
    .filter((item) => item && typeof item.id === "string" && item.id !== "");
}

/** 某仓库的槽位（不存在就给一份干净默认值，不改账本本体再多写一次）。 */
export function slotOf(ledger, root) {
  const slot = ledger?.roots?.[root];
  if (!slot || typeof slot !== "object") return { done: [], batches: 0, lastAt: "", errors: 0, pausedUntil: "" };
  return { ...slot, done: normalizeDone(slot.done) };
}

/** 还在有效期内的「试过」条目 id 集合（给 pickRobotTask 用）。 */
export function activeDone(slot, now = Date.now(), maxAgeMs = DONE_TTL_MS) {
  const ids = new Set();
  for (const item of normalizeDone(slot?.done)) {
    const at = item.at ? Date.parse(item.at) : 0;
    if (at > 0 && now - at > maxAgeMs) continue;
    ids.add(item.id);
  }
  return ids;
}

/** 开一批时先占位：批号 +1，lastAt 现在（避免同一分钟连开两批）。 */
export function markBatchStarted(ledger, root, now = new Date()) {
  const slot = slotOf(ledger, root);
  const next = { ...slot, batches: (Number(slot.batches) || 0) + 1, lastAt: now.toISOString() };
  ledger.roots = { ...(ledger.roots || {}), [root]: next };
  return next;
}

/** 一批结束后记账：成功清零错误；失败累计，到阈值就暂停。 */
export function markBatchFinished(ledger, root, { ids = [], ok = true, now = new Date(), pauseMs = PAUSE_MS } = {}) {
  const slot = slotOf(ledger, root);
  const previous = normalizeDone(slot.done);
  const nowIso = now.toISOString();
  const fresh = ids.map((id) => ({ id, at: nowIso }));
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of fresh) merged.set(item.id, item);
  const nextDone = [...merged.values()].slice(-MAX_DONE);
  const errors = ok ? 0 : (Number(slot.errors) || 0) + 1;
  const pausedUntil = errors >= ERROR_STREAK_LIMIT ? new Date(now.getTime() + pauseMs).toISOString() : "";
  const next = { ...slot, done: nextDone, lastAt: now.toISOString(), errors, pausedUntil };
  ledger.roots = { ...(ledger.roots || {}), [root]: next };
  return next;
}

/** 开批失败（连会话都没开起来）。 */
export function markBatchFailed(ledger, root, { now = new Date(), pauseMs = PAUSE_MS } = {}) {
  return markBatchFinished(ledger, root, { ids: [], ok: false, now, pauseMs });
}

/** 暂停/恢复（用户在设置里或前端按钮触发）。 */
export function setPause(ledger, root, pausedUntil, now = new Date()) {
  const slot = slotOf(ledger, root);
  const next = { ...slot, pausedUntil: pausedUntil || "", lastAt: slot.lastAt || now.toISOString() };
  ledger.roots = { ...(ledger.roots || {}), [root]: next };
  return next;
}

/** 现在该不该开下一批：开关打开、没在跑、没被暂停、冷却结束。 */
export function shouldRun({ slot, enabled, everyMinutes = 5, running = 0, now = Date.now() } = {}) {
  if (!enabled) return false;
  if (running > 0) return false;
  const paused = slot?.pausedUntil ? Date.parse(slot.pausedUntil) : 0;
  if (paused > now) return false;
  const last = slot?.lastAt ? Date.parse(slot.lastAt) : 0;
  const every = Math.max(1, Number(everyMinutes) || 5);
  if (last > 0 && now - last < every * 60_000) return false;
  return true;
}
