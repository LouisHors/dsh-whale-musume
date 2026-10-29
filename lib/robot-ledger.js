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

/** 默认只在一个工作日凌晨的安全窗口里翻粮（周一至周五 02:00–04:00）。 */
export const DEFAULT_DAYS = [1, 2, 3, 4, 5];
export const DEFAULT_START = "02:00";
export const DEFAULT_END = "04:00";
export const DEFAULT_EVERY = 30;

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** 允许的星期：接受 [1,2] 或 "1,2,3"；0=周日。非法值丢弃，空输入回退默认。 */
export function parseDays(value, fallback = DEFAULT_DAYS) {
  if (value === undefined || value === null) return [...fallback];
  const text = Array.isArray(value) ? value.join(",") : String(value);
  if (text.trim() === "") return [];
  const days = [];
  for (const piece of text.split(/[,\s]+/)) {
    if (piece === "") continue;
    const day = Number(piece);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

/** "02:00" → 120 分钟；非法回退 fallback。 */
export function parseClock(value, fallback = 120) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/** 120 → "02:00"。 */
export function clockText(minutes) {
  const total = Math.max(0, Math.min(1439, Math.round(Number(minutes) || 0)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function scheduleFrom({ days, start, end } = {}) {
  return {
    days: parseDays(days),
    startMin: parseClock(start, parseClock(DEFAULT_START)),
    endMin: parseClock(end, parseClock(DEFAULT_END)),
  };
}

function dayMinutes(nowMs) {
  const date = new Date(nowMs);
  return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
}

/** 现在是否落在允许窗口里。起止相同视为「全天」；start > end 视为跨午夜。 */
export function inWindow(now = Date.now(), schedule = {}) {
  const days = Array.isArray(schedule.days) ? schedule.days : DEFAULT_DAYS;
  if (days.length === 0) return false;
  const start = Number.isFinite(schedule.startMin) ? schedule.startMin : 120;
  const end = Number.isFinite(schedule.endMin) ? schedule.endMin : 240;
  const { day, minutes } = dayMinutes(now);
  if (start === end) return days.includes(day);
  if (start < end) return days.includes(day) && minutes >= start && minutes < end;
  if (minutes >= start) return days.includes(day);
  if (minutes < end) return days.includes((day + 6) % 7);
  return false;
}

/** 下一次窗口开始的毫秒时间戳（找不到返回 0）。 */
export function nextWindowStart(now = Date.now(), schedule = {}) {
  const days = Array.isArray(schedule.days) ? schedule.days : DEFAULT_DAYS;
  if (days.length === 0) return 0;
  const start = Number.isFinite(schedule.startMin) ? schedule.startMin : 120;
  const base = new Date(now);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, Math.floor(start / 60), start % 60, 0, 0);
    if (!days.includes(candidate.getDay())) continue;
    if (candidate.getTime() > now) return candidate.getTime();
  }
  return 0;
}

/** 给前端/日志用的一眼状态。 */
export function scheduleState(now = Date.now(), schedule = {}) {
  const days = Array.isArray(schedule.days) ? schedule.days : DEFAULT_DAYS;
  const start = Number.isFinite(schedule.startMin) ? schedule.startMin : 120;
  const end = Number.isFinite(schedule.endMin) ? schedule.endMin : 240;
  const open = inWindow(now, schedule);
  const next = open ? 0 : nextWindowStart(now, schedule);
  return {
    days,
    daysText: days.map((day) => DAY_NAMES[day]).join(" "),
    start: clockText(start),
    end: clockText(end),
    window: `${clockText(start)}–${clockText(end)}`,
    open,
    nextAt: next > 0 ? new Date(next).toISOString() : "",
  };
}

/** 现在该不该开下一批：开关打开、在允许的星期/时间段内、没在跑、没被暂停、冷却结束。 */
export function shouldRun({ slot, enabled, everyMinutes = DEFAULT_EVERY, running = 0, now = Date.now(), schedule } = {}) {
  if (!enabled) return false;
  if (running > 0) return false;
  if (schedule && !inWindow(now, schedule)) return false;
  const paused = slot?.pausedUntil ? Date.parse(slot.pausedUntil) : 0;
  if (paused > now) return false;
  const last = slot?.lastAt ? Date.parse(slot.lastAt) : 0;
  const every = Math.max(1, Number(everyMinutes) || DEFAULT_EVERY);
  if (last > 0 && now - last < every * 60_000) return false;
  return true;
}
