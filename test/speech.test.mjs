import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_SPEECH_CHARS,
  STYLE_PRESETS,
  clampRate,
  parseVoices,
  sanitizeSpeechText,
  sanitizeStyle,
  speechCacheKey,
  synthesize,
} from "../lib/speech.js";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "whale-speech-"));
}

test("sanitizeSpeechText：去控制字符、压空白、按长度截断", () => {
  assert.equal(sanitizeSpeechText("  你好\n\n  世界\u0007  "), "你好 世界");
  assert.equal(sanitizeSpeechText(""), "");
  assert.equal(sanitizeSpeechText(null), "");
  const long = "字".repeat(MAX_SPEECH_CHARS + 30);
  assert.equal(sanitizeSpeechText(long).length, MAX_SPEECH_CHARS);
});

test("sanitizeStyle：只保留 pbas / volm / rate 三种内联指令", () => {
  assert.equal(sanitizeStyle("[[pbas 46]] [[volm 0.6]]"), "[[pbas 46]] [[volm 0.6]]");
  assert.equal(sanitizeStyle("[[evil 1]] [[rate 200]]"), "[[rate 200]]");
  assert.equal(sanitizeStyle("<script>"), "");
  assert.equal(sanitizeStyle(undefined), "");
});

test("clampRate：落在 120–280 之间，坏值回落到 190", () => {
  assert.equal(clampRate(100), 120);
  assert.equal(clampRate(400), 280);
  assert.equal(clampRate("200"), 200);
  assert.equal(clampRate("abc"), 190);
  assert.equal(clampRate(undefined), 190);
});

test("speechCacheKey：同输入同 key，换音色/语速/语气会变", () => {
  const base = speechCacheKey("你好", "Tingting", 190, "");
  assert.equal(base, speechCacheKey("你好", "Tingting", 190, ""));
  assert.notEqual(base, speechCacheKey("你好", "Meijia", 190, ""));
  assert.notEqual(base, speechCacheKey("你好", "Tingting", 210, ""));
  assert.notEqual(base, speechCacheKey("你好", "Tingting", 190, "[[pbas 46]]"));
  assert.match(base, /^[a-f0-9]{40}$/);
});

test("parseVoices：解析 say -v ? 的输出并标出中文音色", () => {
  const output = [
    "Tingting            zh_CN    # 你好！我叫婷婷。",
    "Meijia              zh_TW    # 你好，我叫美佳。",
    "Samantha            en_US    # Hello!",
    "not a voice line",
  ].join("\n");
  const voices = parseVoices(output);
  assert.deepEqual(voices.map((voice) => voice.name), ["Tingting", "Meijia", "Samantha"]);
  assert.deepEqual(voices.map((voice) => voice.zh), [true, true, false]);
  assert.equal(voices[1].lang, "zh_TW");
});

test("synthesize：走 say + afconvert，缓存命中不再重复合成", async () => {
  const dir = tempDir();
  const calls = [];
  const runner = async (file, args) => {
    calls.push([path.basename(file), ...args]);
    if (path.basename(file) === "afconvert") writeFileSync(args[args.length - 1], Buffer.alloc(2048, 7));
    return "";
  };
  try {
    const first = await synthesize({ text: "知识库该整理了", voice: "Tingting", style: "gentle", dir }, runner);
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.ok(statSize(first.file) > 1024);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 4), ["say", "-v", "Tingting", "-r"]);
    assert.equal(calls[0][4], "165");
    assert.match(calls[0][5], /^\[\[pbas 46\]\] 知识库该整理了$/);
    assert.deepEqual(calls[1].slice(0, 4), ["afconvert", "-f", "WAVE", "-d"]);

    const second = await synthesize({ text: "知识库该整理了", voice: "Tingting", style: "gentle", dir }, runner);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls.length, 2, "命中缓存后不应再调用外部命令");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesize：空文本直接拒绝，不调用外部命令", async () => {
  const dir = tempDir();
  let calls = 0;
  try {
    const result = await synthesize({ text: "   ", dir }, async () => { calls += 1; return ""; });
    assert.equal(result.ok, false);
    assert.equal(result.error, "empty-text");
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STYLE_PRESETS：五个预设都带中文标签与合法指令", () => {
  const ids = Object.keys(STYLE_PRESETS);
  assert.deepEqual(ids, ["gentle", "natural", "lively", "quiet", "lazy"]);
  for (const id of ids) {
    assert.ok(STYLE_PRESETS[id].label.length > 0);
    assert.equal(sanitizeStyle(STYLE_PRESETS[id].prefix), STYLE_PRESETS[id].prefix);
  }
});

function statSize(file) {
  return readFileSync(file).length;
}
