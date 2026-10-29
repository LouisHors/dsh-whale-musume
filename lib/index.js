// dsh-whale-musume —— 鲸鱼娘桌宠插件(宿主半边,零侵入)。
// 职责:
//  1. 把包内 assets 目录以只读静态路由提供给浏览器
//     (CSS / JS / generated/*.webp / peek-calibration.json),供 client.js 注入鲸鱼娘;
//  2. 提供「摸鱼推送」用的 linux.do 最新话题源(带缓存与退避),以及受白名单
//     约束的外部打开接口。前端只认本机 webServer,不直接跨域打 linux.do;
//  3. 订阅 session/event,把「回复完成 / 出错 / 等你回答 / 等你批准」折叠成
//     状态小卡片,经 /api/dsh-whale-musume/notify/events 增量推给前端。
// 不修改任何内置包文件。
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { categoryCounts, isAllowedOpenUrl, loadFeed } from "./linuxdo.js";
import { NotificationHub } from "./notifications.js";
import { mergePrefsFile, prefsFilePath, readPrefsFile } from "./prefs-store.js";
import { DEFAULT_WIKI_ROOT, latestMtimeMs, planPrompt, resolveWikiRoot, scanWiki, summarizeForCard, wikiFingerprint } from "./wiki.js";
import { STYLE_PRESETS, listVoices, speechAvailable, synthesize } from "./speech.js";

/** Cordis 插件名(loader 诊断用)。 */
export const name = "dsh-whale-musume";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "..", "assets");
/** 偏好/养成数据落盘位置：端口换掉也不会丢。 */
const PREFS_FILE = prefsFilePath();
/** 语音播报的 wav 缓存目录（与偏好同级，重启不丢）。 */
const SPEECH_DIR = path.join(path.dirname(PREFS_FILE), "speech");

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** 把请求参数 f 解析为 assets 目录内的安全路径;越界返回 null。 */
function safeResolve(rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + path.sep)) return null;
  return target;
}

/** assets 目录的 mtime/大小指纹；前端据此判断要不要热重载表现层。 */
function assetsRevision() {
  const parts = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      try {
        const stat = statSync(full);
        parts.push(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      } catch {
        /* 文件在两次 stat 之间被替换时忽略 */
      }
    }
  };
  walk(ASSETS_DIR, "");
  parts.sort();
  return parts.join("|");
}

/** 统一 JSON 响应；前端按 ok 字段分支，不依赖 HTTP 状态码。 */
function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 读 JSON 请求体（上限 512KB，超了直接拒绝，不把内存写爆）。 */
function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** 打开中的整理会话句柄，插件卸载时统一释放。 */
const maintainers = new Set();

/**
 * 跑完一轮就判断「这次是不是真的动过知识库」，动过就把当前清单记成已处理：
 *  1. 会话的工作目录就是这个知识库（最常见：侧栏里单开一个会话 / 「让鲸鱼娘整理」）；
 *  2. 或者在别的会话里让 AI 改了知识库的文件——用「这一轮的时间窗 + 文件 mtime + 指纹变化」判断。
 * 两种都覆盖，卡片才不会在用户刚整理完之后继续按旧清单弹。
 */
async function markWikiHandledFromTurn(ctx, session, startedAt) {
  const cwd = session?.header?.cwd;
  const preferred = (() => {
    try {
      return readPrefsFile(PREFS_FILE)["whale-moe:wikiRoot"];
    } catch {
      return undefined;
    }
  })();
  const resolved = resolveWikiRoot(typeof preferred === "string" && preferred !== "" ? preferred : DEFAULT_WIKI_ROOT);
  if (!resolved.ok) return null;

  const sameCwd = typeof cwd === "string" && cwd !== "" && path.resolve(cwd) === resolved.root;
  return (async () => {
    const summary = await scanWikiCached(resolved.root, { force: true });
    if (!summary.ok) return;
    if (sameCwd) {
      ackWiki(summary);
      ctx.logger?.debug?.(`dsh-whale-musume: 知识库会话跑完，已把当前清单记为已处理（${resolved.root}）`);
      return;
    }
    // 不在知识库目录里跑的会话：只有「这一轮里文件确实变了、而且这份清单还没被记过」才记账
    const stored = readWikiAck()[resolved.root];
    const fingerprint = wikiFingerprint(summary);
    if (stored !== undefined && stored.fingerprint === fingerprint) return;
    const since = (typeof startedAt === "number" && startedAt > 0 ? startedAt : Date.now()) - 5 * 60 * 1000;
    if (latestMtimeMs(resolved.root) < since) return;
    ackWiki(summary);
    ctx.logger?.debug?.(`dsh-whale-musume: 这一轮改过知识库文件，已把当前清单记为已处理（${resolved.root}）`);
  })();
}

/**
 * 让「知识库管理员」在 DSH 里开一个可见会话去整理。会话模型自己会读写文件，
 * 需要用户拍板时用 ask_user_question，宿主侧会把它折叠成「等你回答」卡片。
 * 具体开会话的方式随宿主版本不同，由 agents 服务决定；失败时把原因透传给前端。
 */

async function spawnMaintainer(ctx, summary) {
  // 注意：路由 handler 拿到的是 webServer 作用域下的 ctx，在那里取 agents 建出来的会话会随
  // 请求作用域销毁，所以这里统一用插件自己的宿主 ctx。
  const agents = ctx.get ? ctx.get("agents") : undefined;
  if (!agents || typeof agents.create !== "function") {
    return { ok: false, error: "当前宿主没有 agents 服务，无法自动开整理会话" };
  }
  const presets = ctx.get ? ctx.get("agentPresets") : undefined;
  const defaultModel = ctx.get ? ctx.get("agentDefaultModel") : undefined;
  if (!presets || typeof presets.mount !== "function") {
    return { ok: false, error: "当前宿主没有 agentPresets 服务，整理会话拿不到工具" };
  }
  const resolved = typeof presets.resolve === "function" ? await presets.resolve(undefined) : undefined;
  const presetId = resolved?.id ?? (typeof presets.defaultId === "string" ? presets.defaultId : "standard");
  const selection = defaultModel?.currentSelection?.() ?? undefined;
  const handle = await agents.create({
    sessionId: randomUUID(),
    meta: { cwd: summary.root, agentPreset: presetId },
    agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, presetId);
    },
  });
  const text = [
    planPrompt(summary),
    "",
    "边界：只改这个仓库里的文件（wiki/、inbox/、schema/），不要碰 raw-sources/ 与仓库外的东西；",
    "不要删除页面或大改结构，除非先 ask_user_question 让我拍板；一次只处理一类问题，单次改动别超过 10 个文件；",
    "做完把这次整理写进 wiki/log.md，并更新 wiki/index.md 与相关 MOC/概览页。",
    "需要我决策时直接用 ask_user_question 问我，我会在小卡片里看到；一次问完——把所有要拍板的点放进同一个 `ask_user_question` 调用（它支持多个问题），别一批一批连续追问。",
    "处理 inbox 时：入库或判定无需入库后，把该文件 frontmatter 的 status 改成 reviewed（原件保留、不删除），并在 wiki/log.md 记一句，不要留 pending-review 悬空。",
  ].join("\n");
  // 整理会话会真的改文件：显式切到保守权限（只写工作区 + 需要批准），不跟随桌面默认的 danger-full-access。
  try {
    const permissions = ctx.get ? ctx.get("permissionPresets") : undefined;
    if (permissions && typeof permissions.set === "function") permissions.set(handle.agent.session, "workspace-write");
  } catch {}

  try {
    const title = ctx.get ? ctx.get("sessionTitle") : undefined;
    if (title && typeof title.rename === "function") await title.rename(handle.agent.session, "鲸鱼娘 · 知识库整理");
  } catch {}

  handle.agent.followup({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
  maintainers.add(handle);
  return { ok: true, sessionId: handle.agent.id };
}

/** 知识库巡检结果缓存：同一仓库 2 分钟内复用，前端轮询不至于每次都扫 1600 篇。 */
const WIKI_CACHE_TTL = 2 * 60 * 1000;
/** 「这个清单我已经处理过了」的记忆文件：清单指纹不变就不再弹卡。 */
const WIKI_ACK_FILE = path.join(path.dirname(PREFS_FILE), "wiki-ack.json");
const wikiCache = new Map();

/** 「已处理投递」账本：inbox 原件按策略保留，只能靠这份文件记住哪些看过了。 */
function reviewedFilePath() {
  return path.join(path.dirname(prefsFilePath()), "wiki-reviewed.json");
}

function readReviewedMap() {
  try {
    const parsed = JSON.parse(readFileSync(reviewedFilePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}


function readWikiAck() {
  try {
    const data = JSON.parse(readFileSync(WIKI_ACK_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeWikiAck(root, fingerprint) {
  const all = readWikiAck();
  all[root] = { fingerprint, at: new Date().toISOString() };
  mkdirSync(path.dirname(WIKI_ACK_FILE), { recursive: true });
  const tmp = `${WIKI_ACK_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  renameSync(tmp, WIKI_ACK_FILE);
}

/** 当前巡检结果是否已经被「处理过」：指纹一致就认为这张卡不用再弹。 */
function wikiAckState(summary) {
  const fingerprint = wikiFingerprint(summary);
  if (fingerprint === "") return { fingerprint, ack: false };
  const cached = readWikiAck()[summary.root];
  return { fingerprint, ack: Boolean(cached && cached.fingerprint === fingerprint) };
}

/** 把某次巡检记成已处理（用户整理完、或在任何会话里改过知识库后调用）。 */
function ackWiki(summary) {
  const fingerprint = wikiFingerprint(summary);
  if (fingerprint === "") return "";
  writeWikiAck(summary.root, fingerprint);
  return fingerprint;
}

function readReviewed(root) {
  const all = readReviewedMap();
  return Array.isArray(all[root]) ? all[root] : [];
}

function markReviewed(root, files) {
  const all = readReviewedMap();
  const list = new Set(Array.isArray(all[root]) ? all[root] : []);
  for (const file of files) {
    const key = String(file);
    if (key) list.add(key);
  }
  all[root] = [...list].sort();
  const file = reviewedFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  renameSync(tmp, file);
  wikiCache.delete(root);
  return all[root].length;
}

/** 扫描（带短缓存）。root 参数来自前端设置，默认 ~/hors/my-code-wiki。 */
async function scanWikiCached(requestedRoot, { force = false } = {}) {
  const resolved = resolveWikiRoot(requestedRoot || DEFAULT_WIKI_ROOT);
  if (!resolved.ok) return { ok: false, error: resolved.error, root: resolved.root };
  const cached = wikiCache.get(resolved.root);
  if (!force && cached && Date.now() - cached.at < WIKI_CACHE_TTL) return cached.summary;
  const summary = await scanWiki(resolved.root, { reviewed: readReviewed(resolved.root) });
  wikiCache.set(resolved.root, { at: Date.now(), summary });
  return summary;
}

/** 把当前待审投递记成「已处理」，或只标记指定文件。 */
async function reviewInbox(requestedRoot, body) {
  const resolved = resolveWikiRoot(requestedRoot || DEFAULT_WIKI_ROOT);
  if (!resolved.ok) return { ok: false, error: resolved.error, root: resolved.root };
  let targets = Array.isArray(body?.files) ? body.files.map(String) : [];
  if (body?.all === true) {
    const current = await scanWiki(resolved.root, { reviewed: readReviewed(resolved.root) });
    targets = current.inbox?.paths ?? [];
  }
  if (targets.length === 0) return { ok: true, marked: 0, summary: await scanWikiCached(resolved.root, { force: true }) };
  const marked = markReviewed(resolved.root, targets);
  return { ok: true, marked: targets.length, ledger: marked, summary: await scanWikiCached(resolved.root, { force: true }) };
}

/** 用系统默认浏览器打开链接（只允许 linux.do，白名单在调用处校验）。 */
function openExternal(url) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    execFile(command, args, { timeout: 10000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function apply(ctx) {
  // 状态通知：只订阅 session 总线，不碰会话内容本身；任何解析失败都只丢该条事件
  const hub = new NotificationHub();
  ctx.effect(() => () => {
    for (const handle of maintainers) {
      try {
        handle.dispose?.();
      } catch {}
    }
    maintainers.clear();
  }, "dsh-whale-musume: 知识库整理会话");

  ctx.on("agent/error", (payload) => {
    try {
      hub.push({ kind: "turn-error", text: String(payload?.error?.message ?? "整理会话出错了"), sessionId: payload?.agentId });
    } catch {}
  });
  ctx.on("session/event", (session, event) => {
    try {
      hub.ingest(session, event);
    } catch (error) {
      ctx.logger?.debug?.(`dsh-whale-musume: 通知事件忽略 ${String(event?.type)}: ${String(error?.message ?? error)}`);
    }
    if (event?.type === "turn/end") {
      const reason = event?.data?.reason?.kind;
      if (reason === "completed") {
        const startedAt = hub.turnStartedAt(session?.id);
        const done = markWikiHandledFromTurn(ctx, session, startedAt);
        if (done !== null) done.catch((error) => ctx.logger?.debug?.(`dsh-whale-musume: 知识库收尾失败: ${String(error?.message ?? error)}`));
      }
    }
  });

  // 必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    const dispose = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/assets",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          // f 的值可能带形如 ?v=3 的版本尾巴(表现层拼 URL 时追加),剥掉再解析
          const rel = (url.searchParams.get("f") ?? "").split("?")[0];
          const file = safeResolve(rel);
          if (file === null || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const extension = path.extname(file).toLowerCase();
          const type = MIME[extension] ?? "application/octet-stream";
          // 代码类资源必须每次回源（热重载后要读到最新脚本）；图片/样式底图可以缓存。
          const cache = extension === ".webp" || extension === ".png" || extension === ".svg"
            ? "public, max-age=3600"
            : "no-store";
          res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": cache,
          });
          createReadStream(file).pipe(res);
        } catch (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => dispose, "dsh-whale-musume: 静态资源路由");

    // 摸鱼推送：linux.do 最新话题(宿主代取，缓存 5 分钟；失败退避 10 分钟)
    const disposeFeed = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/linuxdo/feed",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const force = url.searchParams.get("refresh") === "1";
          const feed = await loadFeed({ force });
          sendJson(res, {
            ok: !feed.error || feed.items.length > 0,
            fetchedAt: feed.fetchedAt,
            nextAttemptAt: feed.nextAttemptAt,
            via: feed.via,
            error: feed.error,
            items: feed.items.slice(0, 60),
            categories: categoryCounts(feed.items),
          });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error), items: [], categories: [] }, 500);
        }
      },
    });
    wctx.effect(() => disposeFeed, "dsh-whale-musume: 摸鱼推送信源路由");

    // 只让 linux.do 的 https 链接走系统浏览器，避免变成任意 URL 打开器
    const disposeOpen = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/linuxdo/open",
      handler: async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const target = url.searchParams.get("url") ?? "";
        if (!isAllowedOpenUrl(target)) {
          sendJson(res, { ok: false, error: "只允许打开 linux.do 的 https 链接" }, 400);
          return;
        }
        try {
          await openExternal(target);
          sendJson(res, { ok: true });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeOpen, "dsh-whale-musume: 外部打开路由");

    // 状态卡：前端每几秒带 since 游标拉一次增量
    const disposeNotify = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/notify/events",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const since = Number(url.searchParams.get("since") ?? "0");
          sendJson(res, { ok: true, ...hub.snapshot(since) });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeNotify, "dsh-whale-musume: 状态通知路由");

    // 偏好/养成数据：localStorage 按端口分家，桌面端每次重启换端口就会丢，这里落盘。
    const disposePrefs = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/prefs",
      handler: async (req, res) => {
        try {
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const result = mergePrefsFile(PREFS_FILE, body?.prefs);
            sendJson(res, { ok: result.written, count: result.count });
            return;
          }
          sendJson(res, { ok: true, prefs: readPrefsFile(PREFS_FILE) });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 400);
        }
      },
    });
    wctx.effect(() => disposePrefs, "dsh-whale-musume: 偏好持久化路由");

    // 资源热重载信标：前端每 2 秒对一次 assets 的 mtime 指纹，
    // 变了就自己拆掉旧表现层、重新拉一遍资源（不需要重启宿主）。
    const disposeRev = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/assets-rev",
      handler: async (_req, res) => {
        try {
          sendJson(res, { ok: true, rev: assetsRevision() });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeRev, "dsh-whale-musume: 资源版本路由");

    // 知识库巡检：机械统计待审/过时/待办/断链/git 状态，判断与整理交给模型。
    const disposeWikiScan = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/wiki/scan",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const force = url.searchParams.get("refresh") === "1";
          const summary = await scanWikiCached(url.searchParams.get("root") ?? "", { force });
          if (!summary.ok) {
            sendJson(res, { ok: false, error: summary.error, root: summary.root }, 400);
            return;
          }
          const state = wikiAckState(summary);
          sendJson(res, {
            ok: true,
            card: summarizeForCard(summary),
            summary,
            fingerprint: state.fingerprint,
            ack: state.ack,
          });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeWikiScan, "dsh-whale-musume: 知识库巡检路由");

    // 给「找个模型会话整理」用的完整提示词（也可让用户手动复制）。
    const disposeWikiPrompt = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/wiki/prompt",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const summary = await scanWikiCached(url.searchParams.get("root") ?? "", { force: url.searchParams.get("refresh") === "1" });
          if (!summary.ok) {
            sendJson(res, { ok: false, error: summary.error, root: summary.root }, 400);
            return;
          }
          sendJson(res, { ok: true, root: summary.root, prompt: planPrompt(summary) });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeWikiPrompt, "dsh-whale-musume: 知识库提示词路由");

    // 在 Finder 里打开知识库根目录（只允许 home 下带 wiki/index.md 的仓库）。
    const disposeWikiOpen = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/wiki/open",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const resolved = resolveWikiRoot(url.searchParams.get("root") || DEFAULT_WIKI_ROOT);
          const home = homedir();
          const insideHome = resolved.root === home || resolved.root.startsWith(home + path.sep);
          if (!resolved.ok || !insideHome || !existsSync(path.join(resolved.root, "wiki", "index.md"))) {
            sendJson(res, { ok: false, error: "知识库路径不合法" }, 400);
            return;
          }
          await new Promise((resolve, reject) => {
            const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
            execFile(command, [resolved.root], { timeout: 10000 }, (error) => (error ? reject(error) : resolve()));
          });
          sendJson(res, { ok: true, root: resolved.root });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeWikiOpen, "dsh-whale-musume: 知识库目录打开路由");

    // 让鲸鱼娘开一个会话去整理知识库（会话里的提问会走 notify/events 变成「等你回答」卡）。
    const disposeWikiMaintain = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/wiki/maintain",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const summary = await scanWikiCached(url.searchParams.get("root") ?? "", { force: true });
          if (!summary.ok) {
            sendJson(res, { ok: false, error: summary.error, root: summary.root }, 400);
            return;
          }
          const result = await spawnMaintainer(ctx, summary);
          sendJson(res, result, result.ok ? 200 : 501);
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeWikiMaintain, "dsh-whale-musume: 知识库整理会话路由");

    // 记「这些投递已经看过了」：inbox 原件按策略保留，只能靠账本让卡片不再重复计数。
    const disposeWikiReview = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/wiki/review",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const body = req.method === "POST" ? await readJsonBody(req, 256 * 1024) : {};
          const result = await reviewInbox(url.searchParams.get("root") ?? "", body);
          sendJson(res, result, result.ok ? 200 : 400);
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeWikiReview, "dsh-whale-musume: 知识库投递审阅路由");

    // 语音播报：列出系统音色（macOS `say -v ?`），一次拿全，前端缓存。
    const disposeSpeechVoices = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/speech/voices",
      handler: async (req, res) => {
        try {
          const voices = (await listVoices()).sort((a, b) => (a.zh === b.zh ? a.name.localeCompare(b.name) : a.zh ? -1 : 1));
          sendJson(res, {
            ok: true,
            available: speechAvailable(),
            platform: process.platform,
            voices,
            styles: Object.entries(STYLE_PRESETS).map(([id, preset]) => ({ id, label: preset.label, rate: preset.rate, prefix: preset.prefix })),
          });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeSpeechVoices, "dsh-whale-musume: 语音音色路由");

    // 合成一句：把 wav 落到缓存目录，返回可播放的地址（前端 <audio> 直接播）。
    const disposeSpeech = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/speech",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            sendJson(res, { ok: false, error: "method-not-allowed" }, 405);
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          const result = await synthesize({
            text: body?.text,
            voice: body?.voice,
            rate: body?.rate,
            style: body?.style,
            prefix: body?.prefix,
            dir: SPEECH_DIR,
          });
          if (!result.ok) {
            sendJson(res, result, result.error === "unsupported-platform" ? 501 : 400);
            return;
          }
          sendJson(res, { ok: true, url: "/api/dsh-whale-musume/speech/audio?f=" + result.key + ".wav", cached: result.cached === true });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeSpeech, "dsh-whale-musume: 语音合成路由");

    // 播 wav：只认 40 位 sha1 文件名，防目录穿越。
    const disposeSpeechAudio = webServer.register({
      kind: "exact",
      path: "/api/dsh-whale-musume/speech/audio",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const file = String(url.searchParams.get("f") || "");
          if (!/^[a-f0-9]{40}\.wav$/.test(file)) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("invalid file");
            return;
          }
          const full = path.join(SPEECH_DIR, file);
          if (!existsSync(full)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": statSync(full).size,
            "Cache-Control": "public, max-age=86400",
          });
          createReadStream(full).pipe(res);
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    });
    wctx.effect(() => disposeSpeechAudio, "dsh-whale-musume: 语音播放路由");

  });

  ctx.logger?.info?.(
    "dsh-whale-musume: 已挂载(资源路由 /api/dsh-whale-musume/assets，摸鱼源 /api/dsh-whale-musume/linuxdo/feed，状态通知 /api/dsh-whale-musume/notify/events，偏好 /api/dsh-whale-musume/prefs，知识库 /api/dsh-whale-musume/wiki/scan、/wiki/review，语音 /api/dsh-whale-musume/speech)",
  );
}
