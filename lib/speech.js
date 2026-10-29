// dsh-whale-musume —— 语音播报（宿主半边）。
// 用 macOS 自带的 `say` 合成、`afconvert` 转成浏览器能播的 wav，缓存在插件数据目录。
// 不依赖任何在线服务，断网也能用；非 macOS 直接返回 unavailable，前端只显示开关。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** 超过这个长度的卡片只念前 220 字（念完一张卡通常 10 秒上下）。 */
export const MAX_SPEECH_CHARS = 220;
/** 语速允许范围（Apple 的 words-per-minute）。 */
export const RATE_MIN = 120;
export const RATE_MAX = 280;

/** 语气预设：Apple 的内联指令（[[pbas 0-100]] 音高、[[volm 0-1]] 音量）。 */
export const STYLE_PRESETS = {
  gentle: { label: "温柔", rate: 165, prefix: "[[pbas 46]]" },
  natural: { label: "平常", rate: 190, prefix: "" },
  lively: { label: "活泼", rate: 215, prefix: "[[pbas 58]]" },
  quiet: { label: "小声", rate: 180, prefix: "[[volm 0.45]]" },
  lazy: { label: "懒散", rate: 145, prefix: "[[pbas 43]]" },
};

/** 只允许 pbas / volm / rate 三种内联指令，并把数值夹进合法区间（防止注入奇怪参数）。 */
export function sanitizeStyle(prefix) {
  var text = typeof prefix === "string" ? prefix : "";
  var out = [];
  var re = /\[\[\s*(pbas|volm|rate)\s+(\d{1,3}(?:\.\d{1,3})?)\s*\]\]/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var name = match[1];
    var raw = Number(match[2]);
    var value = raw;
    if (name === "pbas") value = Math.min(100, Math.max(0, Math.round(raw)));
    else if (name === "volm") value = Math.min(1, Math.max(0, raw));
    else value = Math.min(400, Math.max(80, Math.round(raw)));
    out.push(`[[${name} ${value}]]`);
  }
  return out.join(" ");
}

/** 把卡片文字压成适合朗读的一段：去控制字符、压空白、截断。 */
export function sanitizeSpeechText(text, max = MAX_SPEECH_CHARS) {
  var value = String(text === undefined || text === null ? "" : text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > max) value = value.slice(0, max);
  return value;
}

export function clampRate(rate) {
  var value = Number(rate);
  if (!Number.isFinite(value)) return 190;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(value)));
}

/** 缓存键：文本 + 音色 + 语速 + 语气决定一份 wav。 */
export function speechCacheKey(text, voice, rate, style) {
  return createHash("sha1").update([text, voice, String(rate), style].join("\u0000")).digest("hex");
}

/** 解析 `say -v ?`：一行形如 `Tingting  zh_CN  # 你好！我叫婷婷。`。 */
export function parseVoices(output) {
  var voices = [];
  String(output || "")
    .split(/\r?\n/)
    .forEach(function (line) {
      var match = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9_]+)\s+/.exec(line);
      if (match === null) return;
      var name = match[1].trim();
      if (name === "") return;
      voices.push({ name: name, lang: match[2], zh: match[2].toLowerCase().indexOf("zh") === 0 });
    });
  return voices;
}

function run(file, args, timeout = 20000) {
  return new Promise(function (resolve, reject) {
    execFile(file, args, { timeout: timeout, maxBuffer: 4 * 1024 * 1024 }, function (error, stdout) {
      if (error) reject(error);
      else resolve(String(stdout || ""));
    });
  });
}

export function speechAvailable() {
  return process.platform === "darwin";
}

/** 列出系统音色；非 macOS 返回空数组。 */
export async function listVoices(runner = run) {
  if (!speechAvailable()) return [];
  try {
    return parseVoices(await runner("/usr/bin/say", ["-v", "?"]));
  } catch {
    return [];
  }
}

/**
 * 合成一句语音，返回缓存里的 wav 路径。
 * @param {{text:string, voice?:string, rate?:number, style?:string, dir:string, prefix?:string}} options
 */
export async function synthesize(options, runner = run) {
  if (!speechAvailable()) return { ok: false, error: "unsupported-platform" };
  var text = sanitizeSpeechText(options.text);
  if (text === "") return { ok: false, error: "empty-text" };
  var voice = typeof options.voice === "string" && options.voice !== "" ? options.voice : "Tingting";
  var preset = STYLE_PRESETS[options.style];
  var stylePrefix = sanitizeStyle(options.prefix !== undefined ? options.prefix : preset ? preset.prefix : "");
  var rate = clampRate(options.rate === undefined && preset ? preset.rate : options.rate);
  var dir = options.dir;
  mkdirSync(dir, { recursive: true });
  var key = speechCacheKey(text, voice, rate, stylePrefix);
  var target = path.join(dir, key + ".wav");
  if (existsSync(target) && statSync(target).size > 1024) return { ok: true, file: target, key: key, cached: true };
  var tag = process.pid + "-" + Date.now();
  var raw = path.join(dir, key + "." + tag + ".aiff");
  var tmp = path.join(dir, key + "." + tag + ".wav");
  try {
    var script = stylePrefix !== "" ? stylePrefix + " " + text : text;
    await runner("/usr/bin/say", ["-v", voice, "-r", String(rate), script, "-o", raw]);
    await runner("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@22050", raw, tmp]);
    renameSync(tmp, target);
    return { ok: true, file: target, key: key, cached: false };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 160) };
  } finally {
    for (var leftover of [raw, tmp]) {
      try {
        if (existsSync(leftover)) rmSync(leftover, { force: true });
      } catch {}
    }
  }
}
