// dsh-whale-musume —— 桌面状态通知(宿主半边)。
// 监听 session/event 总线的少量生命周期事件，折叠成前端可直接展示的小卡片：
//   - turn/end        → 某个会话这一轮跑完了（成功/出错）
//   - tool/call       → ask_user_question 抛出问题，等你回答
//   - approval/asked  → 工具要求批准
//   - 回答/批准后     → resolved，前端把对应卡片撤掉
// 纯内存、无落盘、不阻塞 session 总线：ingest 里任何解析失败都只丢这一条。
export const MAX_EVENTS = 40;
const MAX_TEXT = 140;
const MAX_TITLE = 40;

/** 截断到 max 个字符，尽量在自然位置收尾。 */
export function clip(value, max = MAX_TEXT) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** session 的稳定 id；取不到就当这条事件不属于任何会话。 */
function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id;
    return typeof id === "string" && id !== "" ? id : "";
  } catch {
    return "";
  }
}

/** 子代理/teammate 的会话是内部会话，不往主人脸上推完成通知。
 *  注意：只用 origin/delegationDepth 判定 —— 普通 fork 出来的会话也带
 *  parentSession，拿它当依据会把正常会话误判成内部会话。 */
function isInternalSession(session) {
  try {
    const header = session?.header;
    if (header === undefined || header === null) return false;
    if (header.origin === "subagent") return true;
    if (typeof header.delegationDepth === "number" && header.delegationDepth > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** 从 ask_user_question 的 arguments（JSON 字符串）里抠出第一条问题。 */
export function questionTextOf(rawArguments) {
  let args;
  try {
    args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
  } catch {
    return "";
  }
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions[0];
  if (first === undefined || first === null) return "";
  const header = typeof first.header === "string" ? first.header : "";
  const question = typeof first.question === "string" ? first.question : "";
  const body = question !== "" ? question : header;
  const extra = questions.length > 1 ? `（共 ${questions.length} 个问题）` : "";
  return clip(`${body}${extra}`, MAX_TEXT);
}

/** 把一轮耗时格式化成「1 分 24 秒」/「12 秒」。 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

export class NotificationHub {
  /**
   * @param {{max?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : MAX_EVENTS;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.seq = 0;
    this.events = [];
    /** @type {Map<string, string>} sessionId → 最新标题 */
    this.titles = new Map();
    /** @type {Map<string, number>} sessionId → 本轮开始时间 */
    this.turnStarted = new Map();
    /** @type {Map<string, Set<string>>} sessionId → 尚未作答的卡片 refId */
    this.pending = new Map();
  }

  /** 记下/忘掉一张等待中的卡片（问题、审批），用于作答后精确撤卡。 */
  track(sid, refId) {
    if (refId === "") return;
    const set = this.pending.get(sid) ?? new Set();
    set.add(refId);
    this.pending.set(sid, set);
  }

  untrack(sid, refId) {
    const set = this.pending.get(sid);
    if (set === undefined) return;
    set.delete(refId);
    if (set.size === 0) this.pending.delete(sid);
  }

  /** 一轮结束时把该会话所有等待中的卡片全部撤掉（问题/审批不会再悬空）。 */
  settle(sid) {
    const set = this.pending.get(sid);
    if (set === undefined) return null;
    this.pending.delete(sid);
    let last = null;
    for (const refId of set) last = this.push({ kind: "resolved", refId });
    return last;
  }

  /** 记录并返回一条事件；前端的 since 游标只增不减。 */
  push(item) {
    this.seq += 1;
    const event = { seq: this.seq, at: this.now(), ...item };
    this.events.push(event);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    return event;
  }

  /** 给前端拉取：since 之后的事件 + 当前游标。 */
  snapshot(since = 0) {
    const cursor = typeof since === "number" && Number.isFinite(since) ? since : 0;
    return {
      now: this.now(),
      lastSeq: this.seq,
      items: this.events.filter((event) => event.seq > cursor),
    };
  }

  /** 吃一条 session 事件；不认识/格式不对的直接忽略。 */
  ingest(session, event) {
    if (session === null || session === undefined) return null;
    if (event === null || typeof event !== "object") return null;
    const sid = sessionIdOf(session);
    if (sid === "") return null;
    const internal = isInternalSession(session);

    switch (event.type) {
      case "session/title": {
        const title = clip(event.data?.title, MAX_TITLE);
        if (title !== "") this.titles.set(sid, title);
        return null;
      }
      case "user/message": {
        const source = event.data?.source;
        if (source?.kind === "user-question-reply") {
          const refId = `question:${typeof source.callId === "string" ? source.callId : ""}`;
          this.untrack(sid, refId);
          return this.push({ kind: "resolved", refId });
        }
        // 没有正式标题前，用首条用户文本当兜底显示名
        if (!this.titles.has(sid)) {
          const fallback = clip(firstUserText(event.data), MAX_TITLE);
          if (fallback !== "") this.titles.set(sid, fallback);
        }
        return null;
      }
      case "turn/start": {
        this.turnStarted.set(sid, event.time ?? this.now());
        return null;
      }
      case "turn/end": {
        if (internal) return null;
        this.settle(sid);
        const startedAt = this.turnStarted.get(sid);
        this.turnStarted.delete(sid);
        const reason = event.data?.reason;
        const kind = reason?.kind;
        /* 用户主动取消/拒绝/中断的回合不值得提醒；max-tokens 说明被截断，要提示。 */
        if (kind === "canceled" || kind === "blocked" || kind === "aborted") return null;
        const endedAt = event.time ?? this.now();
        const durationMs = typeof startedAt === "number" ? Math.max(0, endedAt - startedAt) : undefined;
        const title = this.titles.get(sid) ?? "";
        if (kind === "error" || kind === "max-tokens") {
          const message = clip(reason?.error?.message, MAX_TEXT);
          const text = kind === "max-tokens" ? "输出到长度上限，被截断了" : (message === "" ? "这一轮出错了" : message);
          return this.push({ kind: "turn-error", sessionId: sid, title, text, durationMs });
        }
        if (kind !== "completed") return null;
        return this.push({ kind: "turn-done", sessionId: sid, title, durationMs });
      }
      case "tool/call": {
        if (event.data?.name !== "ask_user_question") return null;
        if (internal) return null;
        const text = questionTextOf(event.data?.arguments);
        const callId = typeof event.data?.callId === "string" ? event.data.callId : "";
        const refId = `question:${callId}`;
        this.track(sid, refId);
        return this.push({
          kind: "question-asked",
          sessionId: sid,
          title: this.titles.get(sid) ?? "",
          text: text === "" ? "我有个问题想问你" : text,
          refId,
        });
      }
      case "tool/result": {
        if (internal) return null;
        const callId = event.data?.message?.callId ?? event.data?.callId ?? "";
        if (typeof callId !== "string" || callId === "") return null;
        const refId = `question:${callId}`;
        const set = this.pending.get(sid);
        if (set === undefined || !set.has(refId)) return null;
        this.untrack(sid, refId);
        return this.push({ kind: "resolved", refId });
      }
      case "approval/asked": {
        if (internal) return null;
        const toolName = clip(event.data?.toolName, 30);
        const id = typeof event.data?.id === "string" ? event.data.id : "";
        const refId = `approval:${id}`;
        this.track(sid, refId);
        return this.push({
          kind: "approval-asked",
          sessionId: sid,
          title: this.titles.get(sid) ?? "",
          text: toolName === "" ? "有一步操作需要你批准" : `${toolName} 需要你批准`,
          refId,
        });
      }
      case "approval/decided": {
        const id = typeof event.data?.id === "string" ? event.data.id : "";
        const refId = `approval:${id}`;
        this.untrack(sid, refId);
        return this.push({ kind: "resolved", refId });
      }
      default:
        return null;
    }
  }
}

/** 从 user/message 的 message.content 里拼出纯文本，作为标题兜底。 */
function firstUserText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      return block.text;
    }
  }
  return "";
}
