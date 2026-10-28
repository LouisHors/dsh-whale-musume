// dsh-whale-musume —— 看板娘偏好/状态的宿主侧持久化(纯 Node,可单测)。
// 浏览器 localStorage 按「协议+主机+端口」分家,而桌面端每次启动换端口,
// 所以偏好与养成数据会随重启丢失。这里落到 <DSH_HOME>/plugin-data 下,
// 端口变化也不影响。
import fs from "node:fs";
import path from "node:path";

export const MAX_BYTES = 256 * 1024;
export const MAX_VALUE_CHARS = 20000;
const KEY_RE = /^whale-moe:[A-Za-z0-9_:.\-]{1,80}$/;

/** 只接受 whale-moe: 命名空间下的键,避免被当成任意写文件。 */
export function isValidKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

/** 过滤出一份合法、且总大小可控的偏好对象。 */
export function sanitizePrefs(raw, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES;
  const out = {};
  let dropped = 0;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { prefs: out, dropped };
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidKey(key)) {
      dropped += 1;
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_VALUE_CHARS) {
      dropped += 1;
      continue;
    }
    out[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > maxBytes) {
    return { prefs: {}, dropped: Object.keys(out).length };
  }
  return { prefs: out, dropped };
}

/** 读回上次保存的偏好;文件不存在/损坏都当成空。 */
export function readPrefsFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const body = JSON.parse(text);
    return sanitizePrefs(body?.prefs).prefs;
  } catch {
    return {};
  }
}

/** 合并写入(临时文件 + rename,避免写一半断电留下坏 JSON)。 */
export function mergePrefsFile(file, patch, options = {}) {
  const incoming = sanitizePrefs(patch, options).prefs;
  const existing = readPrefsFile(file);
  if (Object.keys(incoming).length === 0) return { prefs: existing, count: 0, written: false };
  const merged = { ...existing, ...incoming };
  const text = JSON.stringify({ savedAt: new Date().toISOString(), prefs: merged }, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > (options.maxBytes ?? MAX_BYTES) + 4096) {
    return { prefs: merged, count: Object.keys(incoming).length, written: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  return { prefs: merged, count: Object.keys(incoming).length, written: true };
}

/** 偏好文件路径:<DSH_HOME>/plugin-data/dsh-whale-musume/prefs.json。 */
export function prefsFilePath(home) {
  const base = typeof home === "string" && home !== "" ? home : process.env.DSH_HOME || `${process.env.HOME || "."}/.dsh`;
  return path.join(base, "plugin-data", "dsh-whale-musume", "prefs.json");
}
