// dsh-whale-musume —— 鲸鱼娘桌宠插件(宿主半边,零侵入)。
// 职责:
//  1. 把包内 assets 目录以只读静态路由提供给浏览器
//     (CSS / JS / generated/*.webp / peek-calibration.json),供 client.js 注入鲸鱼娘;
//  2. 提供「摸鱼推送」用的 linux.do 最新话题源(带缓存与退避),以及受白名单
//     约束的外部打开接口。前端只认本机 webServer,不直接跨域打 linux.do;
//  3. 订阅 session/event,把「回复完成 / 出错 / 等你回答 / 等你批准」折叠成
//     状态小卡片,经 /api/dsh-whale-musume/notify/events 增量推给前端。
// 不修改任何内置包文件。
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { categoryCounts, isAllowedOpenUrl, loadFeed } from "./linuxdo.js";
import { NotificationHub } from "./notifications.js";
import { mergePrefsFile, prefsFilePath, readPrefsFile } from "./prefs-store.js";

/** Cordis 插件名(loader 诊断用)。 */
export const name = "dsh-whale-musume";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "..", "assets");
/** 偏好/养成数据落盘位置：端口换掉也不会丢。 */
const PREFS_FILE = prefsFilePath();

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
  ctx.on("session/event", (session, event) => {
    try {
      hub.ingest(session, event);
    } catch (error) {
      ctx.logger?.debug?.(`dsh-whale-musume: 通知事件忽略 ${String(event?.type)}: ${String(error?.message ?? error)}`);
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
  });

  ctx.logger?.info?.(
    "dsh-whale-musume: 已挂载(资源路由 /api/dsh-whale-musume/assets，摸鱼源 /api/dsh-whale-musume/linuxdo/feed，状态通知 /api/dsh-whale-musume/notify/events，偏好 /api/dsh-whale-musume/prefs)",
  );
}
