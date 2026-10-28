/* dsh-whale-musume 扩展层：摸鱼推送（linux.do 最新话题）+ 状态小卡片。
 *
 * 与表现层（dsh-whale-moe.js）解耦：
 *  - 只读 localStorage 的 whale-moe:* 偏好，监听 whale-moe-prefs-change；
 *  - 只追加自己的 DOM（[data-dsh-whale-alerts]），不碰桌宠根节点；
 *  - 所有网络请求都走宿主路由 /api/dsh-whale-musume/*，不在页面里跨域。
 */
(function () {
  "use strict";
  /* 热重载：新版本脚本被重新注入时，先把上一轮实例拆干净（定时器、
     监听器、卡片层），再重新 start()，否则会叠两套轮询。 */
  if (window.__dshWhaleExtras && typeof window.__dshWhaleExtras.destroy === "function") {
    try {
      window.__dshWhaleExtras.destroy();
    } catch (error) {
      /* ignore */
    }
  }

  var API = "/api/dsh-whale-musume/";
  var PREFS_EVENT = "whale-moe-prefs-change";
  var CARD_WIDTH = 292;
  var MAX_CARDS = 4;
  /* 说话卡（碎碎念 / 状态台词 / 诊断提示）统一走一条队列：
     正在读的那张绝不会被新来的话直接顶掉，后来的排队等它读完。 */
  var SPEECH_MAX_QUEUE = 4;
  var SPEECH_MIN_MS = 9000;
  var SPEECH_MAX_MS = 26000;
  var speechQueue = [];
  var speechActive = null;
  var SEEN_KEY = "whale-moe:linuxdoSeen";
  var SEEN_CAP = 400;
  var timers = [];
  var petObserver = null;

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
    busyOnly: readPref("linuxdoBusy", "0") !== "0",
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
      '[data-dsh-whale-alert="speech"]{background:rgba(18,20,29,.86);border-style:dashed;padding:9px 12px 8px}',
      '[data-dsh-whale-alert="speech"] .dswe-body{color:#e9eefb;font-size:12px;line-height:1.6;font-style:italic;display:block;overflow:visible;-webkit-line-clamp:unset}',
      '[data-dsh-whale-alert="speech"] .dswe-head{min-height:16px}',
      '[data-dsh-whale-alert="speech"] .dswe-ico{opacity:.8}',
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
    /* 正在读的说话卡被手动关掉/提前收走时，立刻让队里的下一句顶上，
       不留下 1 秒多的空白。 */
    if (speechActive !== null && speechActive.card === card) {
      if (speechActive.timer) clearTimeout(speechActive.timer);
      speechActive = null;
      setTimeout(playNextSpeech, 220);
    }
    var index = state.cards.indexOf(card);
    if (index >= 0) state.cards.splice(index, 1);
    if (card.dsweTimer) clearTimeout(card.dsweTimer);
    if (!document.body.contains(card)) return;
    card.classList.add("dswe-out");
    setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 190);
  }

  /** 兜底回收：即使某个 ttl 定时器在重入/替换中被清掉，也不会留下永久卡片。 */
  function sweepCards(now) {
    var nowTs = typeof now === "number" ? now : Date.now();
    var alive = [];
    state.cards.forEach(function (card) {
      if (typeof card.dsweExpireAt === "number" && card.dsweExpireAt <= nowTs) removeCard(card);
      else alive.push(card);
    });
    state.cards = alive;
    if (speechActive !== null && !document.body.contains(speechActive.card)) {
      if (speechActive.timer) clearTimeout(speechActive.timer);
      speechActive = null;
      playNextSpeech();
    }
  }

  /** 一轮结束后，把该会话还挂着的提问/审批卡一起收走。 */
  function dropSessionPending(sessionId) {
    if (!sessionId) return;
    state.cards.slice().forEach(function (card) {
      if (card.dsweSession !== sessionId) return;
      var kind = card.getAttribute("data-dsh-whale-alert");
      if (kind !== "status") return;
      var text = card.textContent || "";
      if (text.indexOf("等你回答") < 0 && text.indexOf("需要批准") < 0 && text.indexOf("需要你") < 0) return;
      removeCard(card);
    });
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
    card.dsweSession = options.sessionId || "";

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
      card.dsweExpireAt = Date.now() + options.ttl;
      card.dsweTimer = setTimeout(function () {
        removeCard(card);
      }, options.ttl);
    }
    return card;
  }

  /* ---------------- 说话卡（唯一的「气泡」） ---------------- */

  function clipText(value, max) {
    var text = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  function pickOne(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** 按字数估阅读时长：短句 9 秒起步，长句最多 26 秒，别让人看不完就换。 */
  function speechDuration(text) {
    var count = String(text === undefined || text === null ? "" : text).length;
    return Math.max(SPEECH_MIN_MS, Math.min(SPEECH_MAX_MS, 2600 + count * 190));
  }

  function attachOpen(card, url) {
    if (card === null || typeof url !== "string" || url === "") return;
    card.setAttribute("title", "点我打开这条话题");
    card.style.cursor = "pointer";
    card.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".dswe-close")) return;
      fetch(API + "linuxdo/open?url=" + encodeURIComponent(url), { cache: "no-store" }).catch(function (error) {
        console.warn("[dsh-whale-musume] 打开话题失败:", error);
      });
    });
  }

  function playSpeechJob(job) {
    var card = showCard({
      kind: "speech",
      key: "speech",
      icon: job.icon || "🐳",
      badge: job.badge || "",
      title: job.title || "",
      body: job.body || job.line || "",
      ttl: job.ttl,
    });
    if (card === null) {
      speechActive = null;
      playNextSpeech();
      return;
    }
    attachOpen(card, job.url);
    speechActive = { card: card, text: job.line || job.body || "", until: Date.now() + job.ttl, timer: 0 };
    speechActive.timer = setTimeout(function () {
      if (speechActive === null || speechActive.card !== card) return;
      speechActive = null;
      playNextSpeech();
    }, job.ttl + 240);
  }

  function playNextSpeech() {
    if (speechActive !== null) return;
    var job = speechQueue.shift();
    if (job === undefined) return;
    playSpeechJob(job);
  }

  /** 把一条话排进队列；high 优先于 ambient（状态台词不能被摸鱼碎碎念压住太久）。 */
  function enqueueJob(job) {
    if (speechActive !== null && speechActive.text === job.line) return null;
    var last = speechQueue.length > 0 ? speechQueue[speechQueue.length - 1].line : "";
    if (last === job.line) return null;
    if (speechActive === null) {
      playSpeechJob(job);
      return speechActive !== null ? speechActive.card : null;
    }
    if (job.priority === "high") {
      var at = 0;
      for (var index = 0; index < speechQueue.length; index += 1) {
        if (speechQueue[index].priority === "high") at = index + 1;
      }
      speechQueue.splice(at, 0, job);
    } else {
      speechQueue.push(job);
    }
    while (speechQueue.length > SPEECH_MAX_QUEUE) {
      var drop = -1;
      for (var scan = speechQueue.length - 1; scan >= 0; scan -= 1) {
        if (speechQueue[scan].priority !== "high") { drop = scan; break; }
      }
      speechQueue.splice(drop >= 0 ? drop : 0, 1);
    }
    return null;
  }

  /**
   * 说一句话：排队展示，自动消失，不占状态位。
   * @param {string} text
   * @param {{ttl?:number, url?:string, source?:string, priority?:string}} [options]
   */
  function showSpeech(text, options) {
    var opts = options || {};
    var line = clipText(text, 120);
    if (line === "") return null;
    var explicitTtl = typeof opts.ttl === "number" && opts.ttl > 0 ? opts.ttl : 0;
    return enqueueJob({
      line: line,
      body: line,
      url: typeof opts.url === "string" ? opts.url : "",
      ttl: explicitTtl > 0 ? Math.max(explicitTtl, speechDuration(line)) : speechDuration(line),
      priority: opts.priority || (opts.source === "mascot" ? "high" : "ambient"),
    });
  }

  /** 诊断/提示类的小卡片也排队，避免把正在读的碎碎念顶掉。 */
  function showSpeechCard(options) {
    var opts = options || {};
    var body = opts.body || "";
    var title = opts.title || "";
    var line = clipText(body !== "" ? body : title, 120);
    return enqueueJob({
      line: line,
      body: body,
      title: title,
      icon: opts.icon || "🐳",
      badge: opts.badge || "",
      ttl: typeof opts.ttl === "number" && opts.ttl > 0 ? opts.ttl : speechDuration(line),
      priority: "ambient",
    });
  }

  /* ---------------- 碎碎念：把摸鱼池里的帖子嚼成一句人话 ---------------- */

  var MURMUR_OPENERS = [
    "我刚瞄到「{cat}」里有个帖子，",
    "诶，「{cat}」那边有人在聊，",
    "「{cat}」又有人发帖了，",
    "刚刷到「{cat}」的一条，",
  ];
  var MURMUR_REACTIONS = [
    "有点好奇。",
    "想围观一下。",
    "感觉能摸会儿鱼了。",
    "这个话题我能聊两句。",
    "有点意思。",
    "看看大家都在折腾啥。",
  ];

  function firstClause(value, max) {
    var text = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    if (text === "" || text.length <= max) return text;
    var head = text.slice(0, max);
    var cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"), head.lastIndexOf("，"));
    if (cut >= Math.floor(max * 0.35)) return head.slice(0, cut + 1);
    return head.replace(/[\sA-Za-z0-9.]+$/, "") + "…";
  }

  function murmurFor(item) {
    if (item === null || typeof item !== "object") return "";
    var category = typeof item.category === "string" && item.category !== "" ? item.category : "linux.do";
    var title = clipText(item.title, 34);
    var excerpt = firstClause(item.excerpt, 26);
    if (title === "" && excerpt === "") return "";
    var gist = excerpt !== "" ? "《" + title + "》，说" + excerpt : "《" + title + "》";
    return pickOne(MURMUR_OPENERS).replace("{cat}", category) + gist + pickOne(MURMUR_REACTIONS);
  }

  function speakMurmur(item) {
    var line = murmurFor(item);
    if (line === "") return null;
    return showSpeech(line, { url: topicUrl(item) });
  }

  /* 表现层 idleChatTick 通过它取碎碎念（同步、走已缓存 feed）。 */
  function murmurProvider() {
    var feed = state.feed;
    if (feed === null) {
      if (!state.feedBusy) loadFeed(false).catch(function () {});
      return "";
    }
    if (!Array.isArray(feed.items) || feed.items.length === 0) return "";
    var item = pickFromFeed(feed, { skipSeen: true });
    if (item === null) item = pickFromFeed(feed, { skipSeen: false });
    if (item === null) return "";
    markSeen(item.id);
    return murmurFor(item);
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
    /* 卡片上的确认按钮只做「收起卡片」：客户端没有公开的「切到某个会话」API，
       所以「知道啦 / 知道了」不负责导航，关掉卡片后用户自己在侧边栏点会话。 */
    var dismissKey = "";
    function dismissAction(label) {
      return {
        label: label,
        primary: true,
        onClick: function () {
          removeCardByKey(dismissKey);
        },
      };
    }

    if (item.kind === "turn-done") {
      dropSessionPending(item.sessionId);
    }
    if (item.kind === "turn-error") {
      dropSessionPending(item.sessionId);
    }
    if (item.kind === "turn-done" && prefs.statusDone) {
      var duration = formatDuration(item.durationMs);
      dismissKey = "done:" + item.sessionId + ":" + item.seq;
      showCard({
        kind: "status",
        key: dismissKey,
        icon: "✅",
        badge: "完成了",
        title: sessionLabel(item) + " 回复好了",
        body: duration === "" ? "" : "这一轮用时 " + duration,
        meta: "DSH · 会话",
        sessionId: item.sessionId,
        ttl: 20000,
        actions: [dismissAction("知道啦")],
      });
      return;
    }
    if (item.kind === "turn-error" && prefs.statusDone) {
      dismissKey = "error:" + item.sessionId + ":" + item.seq;
      showCard({
        kind: "status",
        key: dismissKey,
        icon: "⚠️",
        badge: "出错了",
        title: sessionLabel(item) + " 这一轮出错了",
        body: item.text || "",
        meta: "DSH · 会话",
        sessionId: item.sessionId,
        ttl: 26000,
        actions: [dismissAction("知道啦")],
      });
      return;
    }
    if (item.kind === "question-asked" && prefs.statusAsk) {
      dismissKey = item.refId || "question:" + item.seq;
      showCard({
        kind: "status",
        key: dismissKey,
        refId: item.refId || "",
        icon: "❓",
        badge: "等你回答",
        title: sessionLabel(item) + " 有个问题",
        sessionId: item.sessionId,
        body: item.text || "",
        meta: "DSH · 会话",
        actions: [dismissAction("知道了")],
      });
      return;
    }
    if (item.kind === "approval-asked" && prefs.statusAsk) {
      dismissKey = item.refId || "approval:" + item.seq;
      showCard({
        kind: "status",
        key: dismissKey,
        refId: item.refId || "",
        icon: "🔐",
        badge: "需要批准",
        title: sessionLabel(item) + " 在等你批准",
        body: item.text || "",
        meta: "DSH · 会话",
        actions: [dismissAction("知道了")],
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
    return speakMurmur(item);
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
        showSpeechCard({ icon: "🐳", badge: "linux.do", title: "这个话题池被我看完了", body: "等我再去抓一批新的，或者去设置里放宽版块。" });
        return;
      }
      state.currentFeedId = item.id;
      markSeen(item.id);
      state.lastPushAt = Date.now();
      showFeedCard(item);
    } catch (error) {
      showSpeechCard({ icon: "🐳", badge: "linux.do", title: "没抓到新话题", body: String((error && error.message) || error) });
    }
  }

  async function tickMurmur() {
    if (!prefs.linuxdo || document.hidden) return;
    var busy = isBusy();
    if (prefs.busyOnly && !busy) return;
    /* 忙的时候按设定间隔；空闲时也念叨，但放宽到 3 倍间隔（至少 4 分钟），不打扰发呆。 */
    var interval = busy ? prefs.every * 1000 : Math.max(prefs.every * 3000, 240000);
    if (Date.now() - state.lastPushAt < interval) return;
    if (state.feedBusy) return;
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
    prefs.busyOnly = readPref("linuxdoBusy", "0") !== "0";
    prefs.status = readPref("statusToast", "1") !== "0";
    prefs.statusDone = readPref("statusToastDone", "1") !== "0";
    prefs.statusAsk = readPref("statusToastAsk", "1") !== "0";
  }

  function onPrefs(event) {
    var key = event && event.detail ? event.detail.key : "";
    applyPrefs();
    if (key === "linuxdo" && prefs.linuxdo) state.lastPushAt = 0;
    if (key === "statusToast" && prefs.status) state.lastSeq = -1;
  }
  window.addEventListener(PREFS_EVENT, onPrefs);

  /* 拆掉本实例：定时器、监听器、观察者、DOM。由下一轮脚本或 client.js 调用。 */
  function destroy() {
    for (var i = 0; i < timers.length; i += 1) window.clearInterval(timers[i]);
    timers = [];
    if (petObserver !== null) {
      try {
        petObserver.disconnect();
      } catch (error) {
        /* ignore */
      }
      petObserver = null;
    }
    window.removeEventListener(PREFS_EVENT, onPrefs);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    var layer = document.querySelector('[data-dsh-whale-alerts="stack"]');
    if (layer !== null) layer.remove();
    var style = document.querySelector('style[data-dsh-whale-alerts="css"]');
    if (style !== null) style.remove();
    if (speechActive !== null && speechActive.timer) clearTimeout(speechActive.timer);
    speechActive = null;
    speechQueue = [];
    state.cards = [];
    state.layer = null;
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    ensureStyle();
    ensureLayer();
    place();
    timers.push(setInterval(function () {
      if (state.cards.length > 0) place();
    }, 1200));
    timers.push(setInterval(sweepCards, 1200));
    timers.push(setInterval(tickMurmur, 5000));
    timers.push(setInterval(pollStatus, 4000));
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    var pet = document.querySelector("[data-dsh-whale-root]");
    if (pet !== null && typeof MutationObserver === "function") {
      try {
        petObserver = new MutationObserver(place);
        petObserver.observe(pet, { attributes: true, attributeFilter: ["style", "class"] });
      } catch (error) {
        /* ignore */
      }
    }
  }

  window.__dshWhaleSpeech = showSpeech;
  window.__dshWhaleMurmurProvider = murmurProvider;

  window.__dshWhaleExtras = {
    destroy: destroy,
    prefs: prefs,
    state: state,
    place: place,
    showCard: showCard,
    speech: showSpeech,
    speechCard: showSpeechCard,
    speechQueue: function () { return { active: speechActive !== null, pending: speechQueue.length }; },
    murmur: speakMurmur,
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
