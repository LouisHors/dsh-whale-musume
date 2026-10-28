/* dsh-whale-musume 扩展层：摸鱼推送（linux.do 最新话题）+ 状态小卡片。
 *
 * 与表现层（dsh-whale-moe.js）解耦：
 *  - 只读 localStorage 的 whale-moe:* 偏好，监听 whale-moe-prefs-change；
 *  - 只追加自己的 DOM（[data-dsh-whale-alerts]），不碰桌宠根节点；
 *  - 所有网络请求都走宿主路由 /api/dsh-whale-musume/*，不在页面里跨域。
 */
(function () {
  "use strict";
  if (window.__dshWhaleExtras) return;

  var API = "/api/dsh-whale-musume/";
  var PREFS_EVENT = "whale-moe-prefs-change";
  var CARD_WIDTH = 292;
  var MAX_CARDS = 3;
  var SEEN_KEY = "whale-moe:linuxdoSeen";
  var SEEN_CAP = 400;

  function readPref(key, fallback) {
    try {
      var value = window.localStorage.getItem("whale-moe:" + key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      window.localStorage.setItem("whale-moe:" + key, value);
    } catch (error) {
      /* 隐私模式下可能写不进去，不影响当前会话 */
    }
  }

  function loadSeen() {
    try {
      var raw = window.localStorage.getItem(SEEN_KEY);
      var parsed = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === "string"; }) : [];
    } catch (error) {
      return [];
    }
  }

  var prefs = {
    linuxdo: readPref("linuxdo", "0") !== "0",
    cats: readPref("linuxdoCats", "").split(",").map(function (name) { return name.trim(); }).filter(Boolean),
    every: Math.max(30, Number(readPref("linuxdoEvery", "120")) || 120),
    busyOnly: readPref("linuxdoBusy", "1") !== "0",
    status: readPref("statusToast", "1") !== "0",
    statusDone: readPref("statusToastDone", "1") !== "0",
    statusAsk: readPref("statusToastAsk", "1") !== "0",
  };

  var state = {
    seen: loadSeen(),
    feed: null,
    feedAt: 0,
    feedBusy: false,
    lastPushAt: 0,
    currentFeedId: "",
    lastSeq: -1,
    statusBusy: false,
    cards: [],
    layer: null,
  };

  /* ---------------- 小卡片 ---------------- */

  function ensureLayer() {
    if (state.layer !== null && document.body.contains(state.layer)) return state.layer;
    var layer = document.createElement("div");
    layer.setAttribute("data-dsh-whale-alerts", "stack");
    document.body.appendChild(layer);
    state.layer = layer;
    return layer;
  }

  function ensureStyle() {
    if (document.querySelector('style[data-dsh-whale-alerts="css"]')) return;
    var style = document.createElement("style");
    style.setAttribute("data-dsh-whale-alerts", "css");
    style.textContent = [
      '[data-dsh-whale-alerts="stack"]{position:fixed;z-index:2147483000;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-end;gap:8px;pointer-events:none;width:292px;transition:left 240ms ease,bottom 240ms ease}',
      '[data-dsh-whale-alert]{pointer-events:auto;width:100%;box-sizing:border-box;background:rgba(18,20,29,.94);color:#e9eefb;border:1px solid rgba(122,170,255,.26);border-radius:14px;box-shadow:0 12px 32px rgba(4,8,18,.36);padding:10px 12px 9px;font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transform-origin:bottom right;animation:dsh-whale-alert-in 220ms cubic-bezier(.2,.9,.3,1.2)}',
      '@keyframes dsh-whale-alert-in{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}',
      '[data-dsh-whale-alert].dswe-out{animation:dsh-whale-alert-out 180ms ease forwards}',
      '@keyframes dsh-whale-alert-out{to{opacity:0;transform:translateY(6px) scale(.97)}}',
      '[data-dsh-whale-alert] .dswe-head{display:flex;align-items:center;gap:6px;min-height:18px}',
      '[data-dsh-whale-alert] .dswe-ico{font-size:13px;line-height:1}',
      '[data-dsh-whale-alert] .dswe-badge{font-size:10px;line-height:16px;padding:0 7px;border-radius:999px;background:rgba(122,170,255,.18);color:#a8c6ff;border:1px solid rgba(122,170,255,.28);white-space:nowrap;max-width:132px;overflow:hidden;text-overflow:ellipsis}',
      '[data-dsh-whale-alert] .dswe-close{margin-left:auto;border:0;background:transparent;color:rgba(233,238,251,.55);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;border-radius:6px}',
      '[data-dsh-whale-alert] .dswe-close:hover{color:#fff;background:rgba(255,255,255,.08)}',
      '[data-dsh-whale-alert] .dswe-title{font-size:12.5px;font-weight:600;line-height:1.5;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '[data-dsh-whale-alert] .dswe-body{color:rgba(233,238,251,.72);font-size:11.5px;line-height:1.55;margin-top:2px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '[data-dsh-whale-alert] .dswe-foot{display:flex;align-items:center;gap:8px;margin-top:7px}',
      '[data-dsh-whale-alert] .dswe-meta{color:rgba(233,238,251,.45);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '[data-dsh-whale-alert] .dswe-acts{margin-left:auto;display:flex;gap:6px;flex-shrink:0}',
      '[data-dsh-whale-alert] .dswe-act{pointer-events:auto;border:1px solid rgba(122,170,255,.35);background:rgba(122,170,255,.14);color:#cfe0ff;font-size:11px;line-height:18px;padding:1px 9px;border-radius:999px;cursor:pointer;white-space:nowrap}',
      '[data-dsh-whale-alert] .dswe-act:hover{background:rgba(122,170,255,.26)}',
      '[data-dsh-whale-alert] .dswe-act[data-primary="1"]{background:rgba(122,170,255,.9);border-color:transparent;color:#0d1526}',
      '[data-dsh-whale-alert] .dswe-act[data-primary="1"]:hover{background:#a9c9ff}',
    ].join("\n");
    document.head.appendChild(style);
  }

  function place() {
    var layer = ensureLayer();
    var pet = document.querySelector("[data-dsh-whale-root]");
    var viewportWidth = window.innerWidth;
    var viewportHeight = window.innerHeight;
    var left = viewportWidth - CARD_WIDTH - 18;
    var bottom = 24;
    if (pet !== null) {
      var rect = pet.getBoundingClientRect();
      if (Number.isFinite(rect.left) && rect.width > 0) {
        var gap = 14;
        if (rect.left > CARD_WIDTH + gap) left = rect.left - CARD_WIDTH - gap;
        else left = Math.min(viewportWidth - CARD_WIDTH - 16, rect.right + gap);
        bottom = Math.max(16, viewportHeight - rect.bottom);
      }
    }
    left = Math.max(12, Math.min(left, viewportWidth - CARD_WIDTH - 12));
    layer.style.left = Math.round(left) + "px";
    layer.style.bottom = Math.round(bottom) + "px";
    layer.style.width = CARD_WIDTH + "px";
  }

  function removeCard(card) {
    if (card === null || card === undefined) return;
    var index = state.cards.indexOf(card);
    if (index >= 0) state.cards.splice(index, 1);
    if (card.dsweTimer) clearTimeout(card.dsweTimer);
    if (!document.body.contains(card)) return;
    card.classList.add("dswe-out");
    setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 190);
  }

  function removeCardByKey(key) {
    for (var index = state.cards.length - 1; index >= 0; index -= 1) {
      if (state.cards[index].dsweKey === key) removeCard(state.cards[index]);
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * 显示一张卡片。key 相同的卡片会原地更新（用于「换一个」和 resolved 撤销）。
   * @param {{key?:string, icon?:string, badge?:string, title?:string, body?:string,
   *          meta?:string, actions?:Array<{label:string, primary?:boolean, onClick:Function}>,
   *          kind?:string, ttl?:number, refId?:string}} options
   */
  function showCard(options) {
    ensureStyle();
    var layer = ensureLayer();
    var key = options.key || "";
    if (key !== "") {
      for (var index = 0; index < state.cards.length; index += 1) {
        if (state.cards[index].dsweKey === key) {
          removeCard(state.cards[index]);
          break;
        }
      }
    }
    var card = el("div");
    card.setAttribute("data-dsh-whale-alert", options.kind || "notice");
    card.dsweKey = key;
    card.dsweRefId = options.refId || "";

    var head = el("div", "dswe-head");
    if (options.icon) head.appendChild(el("span", "dswe-ico", options.icon));
    if (options.badge) head.appendChild(el("span", "dswe-badge", options.badge));
    var close = el("button", "dswe-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      removeCard(card);
    });
    head.appendChild(close);
    card.appendChild(head);

    if (options.title) card.appendChild(el("div", "dswe-title", options.title));
    if (options.body) card.appendChild(el("div", "dswe-body", options.body));

    var foot = el("div", "dswe-foot");
    if (options.meta) foot.appendChild(el("span", "dswe-meta", options.meta));
    var actions = options.actions || [];
    if (actions.length > 0) {
      var actBox = el("div", "dswe-acts");
      actions.forEach(function (action) {
        var button = el("button", "dswe-act", action.label);
        button.type = "button";
        if (action.primary) button.setAttribute("data-primary", "1");
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          try {
            action.onClick();
          } catch (error) {
            console.warn("[dsh-whale-musume] 卡片动作失败:", error);
          }
        });
        actBox.appendChild(button);
      });
      foot.appendChild(actBox);
    }
    if (foot.childNodes.length > 0) card.appendChild(foot);

    /* 卡片自身不触发桌宠拖拽/点击穿透 */
    ["pointerdown", "mousedown", "click"].forEach(function (type) {
      card.addEventListener(type, function (event) {
        event.stopPropagation();
      });
    });

    layer.appendChild(card);
    state.cards.push(card);
    while (state.cards.length > MAX_CARDS) removeCard(state.cards[0]);
    place();

    if (typeof options.ttl === "number" && options.ttl > 0) {
      card.dsweTimer = setTimeout(function () {
        removeCard(card);
      }, options.ttl);
    }
    return card;
  }

  /* ---------------- 状态小卡片（宿主 session 事件） ---------------- */

  function formatDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + " 秒";
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return rest === 0 ? minutes + " 分钟" : minutes + " 分 " + rest + " 秒";
  }

  function sessionLabel(item) {
    var title = typeof item.title === "string" ? item.title.trim() : "";
    return title === "" ? "一个会话" : "「" + title + "」";
  }

  function handleStatusEvent(item) {
    if (item.kind === "resolved") {
      removeCardByKey(item.refId || "");
      return;
    }
    if (item.kind === "turn-done" && prefs.statusDone) {
      var duration = formatDuration(item.durationMs);
      showCard({
        kind: "status",
        key: "done:" + item.sessionId + ":" + item.seq,
        icon: "✅",
        badge: "完成了",
        title: sessionLabel(item) + " 回复好了",
        body: duration === "" ? "" : "这一轮用时 " + duration,
        meta: "DSH · 会话",
        ttl: 20000,
        actions: [{ label: "知道啦", primary: true, onClick: function () {} }],
      });
      return;
    }
    if (item.kind === "turn-error" && prefs.statusDone) {
      showCard({
        kind: "status",
        key: "error:" + item.sessionId + ":" + item.seq,
        icon: "⚠️",
        badge: "出错了",
        title: sessionLabel(item) + " 这一轮出错了",
        body: item.text || "",
        meta: "DSH · 会话",
        ttl: 26000,
        actions: [{ label: "知道啦", primary: true, onClick: function () {} }],
      });
      return;
    }
    if (item.kind === "question-asked" && prefs.statusAsk) {
      showCard({
        kind: "status",
        key: item.refId || "question:" + item.seq,
        refId: item.refId || "",
        icon: "❓",
        badge: "等你回答",
        title: sessionLabel(item) + " 有个问题",
        body: item.text || "",
        meta: "DSH · 会话",
        actions: [{ label: "这就去", primary: true, onClick: function () {} }],
      });
      return;
    }
    if (item.kind === "approval-asked" && prefs.statusAsk) {
      showCard({
        kind: "status",
        key: item.refId || "approval:" + item.seq,
        refId: item.refId || "",
        icon: "🔐",
        badge: "需要批准",
        title: sessionLabel(item) + " 在等你批准",
        body: item.text || "",
        meta: "DSH · 会话",
        actions: [{ label: "这就去", primary: true, onClick: function () {} }],
      });
    }
  }

  async function pollStatus() {
    if (!prefs.status || state.statusBusy || document.hidden) return;
    state.statusBusy = true;
    try {
      var response = await fetch(API + "notify/events?since=" + Math.max(0, state.lastSeq), { cache: "no-store" });
      var body = await response.json();
      if (!body || body.ok !== true) return;
      if (state.lastSeq < 0) {
        /* 首次只对齐游标，不把历史事件一次性糊到脸上 */
        state.lastSeq = body.lastSeq;
        return;
      }
      var items = Array.isArray(body.items) ? body.items : [];
      items.forEach(function (item) {
        if (typeof item.seq === "number" && item.seq > state.lastSeq) state.lastSeq = item.seq;
        handleStatusEvent(item);
      });
    } catch (error) {
      /* 宿主未就绪/刷新中：静默重试 */
    } finally {
      state.statusBusy = false;
    }
  }

  /* ---------------- 摸鱼推送（linux.do） ---------------- */

  function isBusy() {
    try {
      if (document.querySelector("[data-chat-running]")) return true;
      if (document.querySelector("[data-approval-key]")) return true;
      if (document.querySelector("[data-question-key]")) return true;
      if (document.querySelector('[data-slot="conversation.chat.node"] [data-state="running"]')) return true;
      if (document.querySelector("[data-composer-input]") !== null && document.querySelector("[data-chat-running]")) return true;
    } catch (error) {
      /* DOM 变化中查不到就当不忙 */
    }
    return false;
  }

  function markSeen(id) {
    if (typeof id !== "string" || id === "") return;
    if (state.seen.indexOf(id) >= 0) return;
    state.seen.push(id);
    if (state.seen.length > SEEN_CAP) state.seen = state.seen.slice(state.seen.length - SEEN_CAP);
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen));
    } catch (error) {
      /* 隐私模式下写不进去：本次会话内仍然去重 */
    }
  }

  function topicUrl(item) {
    if (item && typeof item.link === "string" && item.link !== "") return item.link;
    if (item && typeof item.id === "string" && item.id !== "") return "https://linux.do/t/topic/" + item.id;
    return "";
  }

  function timeAgo(value) {
    if (typeof value !== "string" || value === "") return "";
    var time = Date.parse(value);
    if (!isFinite(time)) return "";
    var diff = Date.now() - time;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.round(diff / 60000) + " 分钟前";
    if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + " 小时前";
    return Math.round(diff / 86400000) + " 天前";
  }

  async function loadFeed(force) {
    var response = await fetch(API + "linuxdo/feed" + (force ? "?refresh=1" : ""), { cache: "no-store" });
    var body = await response.json();
    state.feed = body;
    state.feedAt = Date.now();
    return body;
  }

  function pickFromFeed(feed, options) {
    var items = feed && Array.isArray(feed.items) ? feed.items : [];
    var exclude = options && options.exclude ? options.exclude : [];
    var categories = prefs.cats.length > 0 ? prefs.cats : null;
    var pool = items.filter(function (item) {
      if (item === null || typeof item !== "object") return false;
      if (typeof item.id !== "string" || item.id === "") return false;
      if (categories !== null) {
        var category = typeof item.category === "string" ? item.category : "";
        if (categories.indexOf(category) < 0) return false;
      }
      if (exclude.indexOf(item.id) >= 0) return false;
      if (options && options.skipSeen !== false && state.seen.indexOf(item.id) >= 0) return false;
      return true;
    });
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function showFeedCard(item) {
    var category = typeof item.category === "string" && item.category !== "" ? item.category : "linux.do";
    var title = typeof item.title === "string" ? item.title : "";
    var excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
    var url = topicUrl(item);
    showCard({
      kind: "feed",
      key: "feed",
      icon: "🐳",
      badge: category,
      title: title,
      body: excerpt,
      meta: timeAgo(item.publishedAt) + (item.author ? " · " + item.author : ""),
      actions: [
        {
          label: "换一个",
          onClick: function () {
            nextFeedCard(item.id);
          },
        },
        {
          label: "去逛逛",
          primary: true,
          onClick: function () {
            if (url === "") return;
            removeCardByKey("feed");
            fetch(API + "linuxdo/open?url=" + encodeURIComponent(url), { cache: "no-store" }).catch(function (error) {
              console.warn("[dsh-whale-musume] 打开话题失败:", error);
            });
          },
        },
      ],
    });
  }

  async function nextFeedCard(excludeId) {
    var exclude = typeof excludeId === "string" && excludeId !== "" ? [excludeId] : [];
    try {
      var feed = state.feed;
      if (feed === null || Date.now() - state.feedAt > 5 * 60 * 1000) feed = await loadFeed(false);
      var item = pickFromFeed(feed, { exclude: exclude });
      if (item === null) {
        feed = await loadFeed(true);
        item = pickFromFeed(feed, { exclude: exclude });
      }
      if (item === null) {
        showCard({ kind: "feed", key: "feed", icon: "🐳", badge: "linux.do", title: "这个话题池被我看完了", body: "等我再去抓一批新的，或者去设置里放宽版块。", meta: "", ttl: 8000 });
        return;
      }
      state.currentFeedId = item.id;
      markSeen(item.id);
      state.lastPushAt = Date.now();
      showFeedCard(item);
    } catch (error) {
      showCard({ kind: "feed", key: "feed", icon: "🐳", badge: "linux.do", title: "没抓到新话题", body: String((error && error.message) || error), meta: "", ttl: 8000 });
    }
  }

  async function tickFeed() {
    if (!prefs.linuxdo || document.hidden) return;
    if (prefs.busyOnly && !isBusy()) return;
    if (Date.now() - state.lastPushAt < prefs.every * 1000) return;
    if (state.feedBusy) return;
    for (var index = 0; index < state.cards.length; index += 1) {
      if (state.cards[index].dsweKey === "feed") return;
    }
    state.feedBusy = true;
    try {
      await nextFeedCard("");
    } finally {
      /* 不管成功失败都从「现在」重新计时，避免失败时每 5 秒重试一次 */
      state.lastPushAt = Date.now();
      state.feedBusy = false;
    }
  }

  /* ---------------- 偏好同步 / 启动 ---------------- */

  function applyPrefs() {
    prefs.linuxdo = readPref("linuxdo", "0") !== "0";
    prefs.cats = readPref("linuxdoCats", "").split(",").map(function (name) { return name.trim(); }).filter(Boolean);
    prefs.every = Math.max(30, Number(readPref("linuxdoEvery", "120")) || 120);
    prefs.busyOnly = readPref("linuxdoBusy", "1") !== "0";
    prefs.status = readPref("statusToast", "1") !== "0";
    prefs.statusDone = readPref("statusToastDone", "1") !== "0";
    prefs.statusAsk = readPref("statusToastAsk", "1") !== "0";
  }

  window.addEventListener(PREFS_EVENT, function (event) {
    var key = event && event.detail ? event.detail.key : "";
    applyPrefs();
    if (key === "linuxdo" && prefs.linuxdo) state.lastPushAt = 0;
    if (key === "statusToast" && prefs.status) state.lastSeq = -1;
  });

  var started = false;
  function start() {
    if (started) return;
    started = true;
    ensureStyle();
    ensureLayer();
    place();
    setInterval(function () {
      if (state.cards.length > 0) place();
    }, 1200);
    setInterval(tickFeed, 5000);
    setInterval(pollStatus, 4000);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    var pet = document.querySelector("[data-dsh-whale-root]");
    if (pet !== null && typeof MutationObserver === "function") {
      try {
        new MutationObserver(place).observe(pet, { attributes: true, attributeFilter: ["style", "class"] });
      } catch (error) {
        /* ignore */
      }
    }
  }

  window.__dshWhaleExtras = {
    prefs: prefs,
    state: state,
    place: place,
    showCard: showCard,
    removeCard: removeCard,
    previewFeed: function () {
      return nextFeedCard("");
    },
    refreshStatus: function () {
      state.lastSeq = -1;
      return pollStatus();
    },
    simulate: function (kind) {
      if (kind === "done") {
        handleStatusEvent({ kind: "turn-done", seq: 0, sessionId: "demo", title: "重构 runner", durationMs: 84000 });
      } else if (kind === "question") {
        handleStatusEvent({ kind: "question-asked", seq: 0, sessionId: "demo", title: "重构 runner", text: "要现在发布吗？", refId: "question:demo" });
      } else if (kind === "feed") {
        showFeedCard({ id: "demo", title: "有没有人用 DSH 写桌面小挂件？聊聊你们的玩法", category: "开发调优", excerpt: "最近在折腾一个桌宠插件，发现 0.2 的 slot 机制挺好玩，想看看大家都在做什么。", link: "https://linux.do/t/topic/1", publishedAt: new Date(Date.now() - 6 * 60000).toISOString(), author: "alice" });
      }
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
