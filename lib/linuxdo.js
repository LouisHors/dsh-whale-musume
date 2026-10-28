// linux.do 摸鱼源：抓最新话题 RSS、拆分类、做去重筛选。
// 只在宿主侧跑（node 内置模块，不引第三方依赖）。
//
// 为什么不直接用 fetch：linux.do 挂在 Cloudflare 后面，Node 内置 fetch 的
// TLS 指纹会被判定成机器人（一律 403 "Just a moment..."），而系统 curl 的
// HTTP/2 握手能过。所以主路径用 curl 子进程，fetch 只作兜底。
import { execFile } from "node:child_process";

export const FEED_URL = "https://linux.do/latest.rss";
/** 与浏览器的 UA 不一致时 CF 更爱拦；固定成常见桌面 Chrome。 */
export const FEED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** 正常缓存 5 分钟；失败后 10 分钟内不再打 CF，避免把自己刷成 429。 */
export const CACHE_TTL = 5 * 60 * 1000;
export const FAIL_BACKOFF = 10 * 60 * 1000;
/** 「已见过」环形缓冲上限，防止 localStorage 无限长。 */
export const SEEN_CAP = 400;

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 解析 XML 文本里的字符实体（RSS 标题里很常见）。 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return ENTITY_MAP[String(body).toLowerCase()] ?? whole;
  });
}

/** RSS 的 description 是 HTML 片段：压成适合气泡的一行纯文本。 */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\s+|\s+$/g, "");
}

/** 把长摘要压到 n 个字以内，尽量在标点处收尾。 */
export function clip(text, n = 150) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const stop = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"), head.lastIndexOf("\n"));
  if (stop >= n * 0.6) return head.slice(0, stop + 1) + "…";
  return head.replace(/[,，、\s]+$/, "") + "…";
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}

function cdata(text) {
  const raw = String(text).trim();
  const m = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : text;
}

/** 从 <link> 里取话题 id；linux.do 话题链接形如 /t/<slug>/<id> 或 /t/topic/<id>。 */
export function topicIdFromLink(link) {
  const m = String(link ?? "").match(/\/t\/(?:[^/?#]+\/)?(\d+)/);
  return m ? m[1] : "";
}

/** 从 description 的尾注里取「N 个帖子 · M 位参与者」，没有就返回空串。 */
export function replyMetaFromDescription(html) {
  const text = stripHtml(html);
  const m = text.match(/([\d,]+)\s*个帖子\s*-\s*([\d,]+)\s*位参与者/);
  return m ? `${m[1]} 个帖子 · ${m[2]} 位参与者` : "";
}

/**
 * 解析 RSS。返回按 pubDate 倒序的条目数组；字段缺失时给空串而不是 undefined，
 * 方便客户端直接渲染。解析失败抛错（调用方负责兜底）。
 */
export function parseFeed(xml) {
  const text = String(xml ?? "");
  if (!/<rss[\s>]/.test(text)) {
    const hint = /Just a moment|cf-mitigated|challenge/i.test(text) ? "（Cloudflare 拦截页）" : "";
    throw new Error(`linux.do 返回的不是 RSS${hint}`);
  }
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const block = m[1];
    const link = stripHtml(tag(block, "link"));
    const id = topicIdFromLink(link) || stripHtml(tag(block, "guid")).replace(/^.*topic-/, "");
    if (!id) continue;
    const pub = Date.parse(tag(block, "pubDate"));
    items.push({
      id,
      title: stripHtml(cdata(tag(block, "title"))).replace(/\s+/g, " ").trim(),
      category: stripHtml(cdata(tag(block, "category"))).trim(),
      creator: stripHtml(cdata(tag(block, "dc:creator"))).trim(),
      url: link,
      excerpt: clip(stripHtml(cdata(tag(block, "description"))), 200),
      meta: replyMetaFromDescription(cdata(tag(block, "description"))),
      createdAt: Number.isFinite(pub) ? new Date(pub).toISOString() : "",
      pinned: /<discourse:topicPinned>Yes<\/discourse:topicPinned>/.test(block),
    });
  }
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return items;
}

/** 分类 -> 条数，按条数降序；用于设置面板里的分类候选。 */
export function categoryCounts(items) {
  const counts = new Map();
  for (const item of items ?? []) {
    const name = String(item?.category ?? "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
    .map(([name, count]) => ({ name, count }));
}

/** 选中分类为空 = 不限分类。 */
export function filterByCategories(items, selected) {
  const wanted = new Set((selected ?? []).map((s) => String(s).trim()).filter(Boolean));
  if (wanted.size === 0) return [...(items ?? [])];
  return (items ?? []).filter((item) => wanted.has(String(item?.category ?? "").trim()));
}

/**
 * 随机挑一条没见过的。random 可注入（测试用固定值，主流程不传）。
 * 全见过了就返回 null —— 调用方继续等下一轮刷新，别重复推。
 */
export function pickPost(items, { categories, seen, random = Math.random } = {}) {
  const seenSet = new Set((seen ?? []).map(String));
  const pool = filterByCategories(items, categories).filter((item) => !seenSet.has(String(item.id)));
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

/** 把新 id 追加进已见列表，超出上限时丢最旧的（保留顺序）。 */
export function mergeSeen(seen, ids, cap = SEEN_CAP) {
  const list = (seen ?? []).map(String);
  for (const id of ids ?? []) {
    const key = String(id);
    const at = list.indexOf(key);
    if (at !== -1) list.splice(at, 1);
    list.push(key);
  }
  return list.length > cap ? list.slice(list.length - cap) : list;
}

/** 只允许打开 linux.do 的话题链接，避免把 open 变成任意命令入口。 */
export function isAllowedOpenUrl(url) {
  try {
    const u = new URL(String(url ?? ""));
    return u.protocol === "https:" && (u.hostname === "linux.do" || u.hostname.endsWith(".linux.do"));
  } catch {
    return false;
  }
}

/** 用系统 curl 抓 RSS（走用户代理环境变量里的 http_proxy/https_proxy）。 */
export function fetchViaCurl(url = FEED_URL) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/curl",
      ["-sS", "--compressed", "--max-time", "20", "-A", FEED_UA, "-H", "accept: application/rss+xml,application/xml;q=0.9,*/*;q=0.8", url],
      { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`curl 失败：${error.message}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** 兜底：Node 自带 fetch（可能被 CF 拦，拦了就让调用方看到原因）。 */
export async function fetchViaFetch(url = FEED_URL) {
  const response = await fetch(url, {
    headers: { "user-agent": FEED_UA, accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`linux.do HTTP ${response.status}`);
  return text;
}

/** 进程内缓存状态：items 与上次成功时间、下次最早可再试时间。 */
let cache = { items: [], at: 0, via: "", error: "", nextAttemptAt: 0 };
let inflight = null;

function resetCacheForTest() {
  cache = { items: [], at: 0, via: "", error: "", nextAttemptAt: 0 };
  inflight = null;
}

/**
 * 取信源。默认 5 分钟内直接吃缓存；失败后 10 分钟内不再尝试（返回旧条目 + error）。
 * refresh=true 忽略时间窗口，但仍做单飞，避免连点设置面板把 CF 点爆。
 */
export async function loadFeed({ force = false, now = Date.now(), run = null } = {}) {
  const fresh = cache.items.length > 0 && now - cache.at < CACHE_TTL;
  if (!force && fresh) return snapshot();
  if (!force && now < cache.nextAttemptAt) return snapshot();
  if (inflight) return inflight;
  inflight = (async () => {
    const runner = typeof run === "function" ? run : fetchViaCurl;
    try {
      const xml = await runner(FEED_URL);
      const items = parseFeed(xml);
      cache = { items, at: Date.now(), via: typeof run === "function" ? "injected" : "curl", error: "", nextAttemptAt: 0 };
    } catch (error) {
      cache = {
        items: cache.items,
        at: cache.items.length > 0 ? cache.at : 0,
        via: cache.via,
        error: String(error?.message ?? error),
        nextAttemptAt: Date.now() + FAIL_BACKOFF,
      };
    }
    return snapshot();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function snapshot() {
  return {
    items: cache.items,
    fetchedAt: cache.at ? new Date(cache.at).toISOString() : "",
    via: cache.via,
    error: cache.error,
    nextAttemptAt: cache.nextAttemptAt ? new Date(cache.nextAttemptAt).toISOString() : "",
  };
}

/** 当前缓存快照（不触发抓取）。 */
export function currentFeed() {
  return snapshot();
}

export const __testing = { resetCacheForTest };
