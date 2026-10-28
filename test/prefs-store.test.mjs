// dsh-whale-musume —— 偏好持久化的宿主侧单测（纯 Node，不碰真实 ~/.dsh）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_VALUE_CHARS,
  isValidKey,
  mergePrefsFile,
  prefsFilePath,
  readPrefsFile,
  sanitizePrefs,
} from "../lib/prefs-store.js";

function tempFile(name = "prefs.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-prefs-"));
  return { dir, file: path.join(dir, name) };
}

test("只接受 whale-moe: 命名空间与字符串值，其余丢弃", () => {
  const { prefs, dropped } = sanitizePrefs({
    "whale-moe:linuxdo": "1",
    "whale-moe:journal": "x".repeat(MAX_VALUE_CHARS + 1),
    "evil:key": "1",
    "whale-moe:number": 3,
    "whale-moe:ok": "",
  });
  assert.deepEqual(prefs, { "whale-moe:linuxdo": "1", "whale-moe:ok": "" });
  assert.equal(dropped, 3);
  assert.equal(isValidKey("whale-moe:a_b.c-1"), true);
  assert.equal(isValidKey("whale-moe:"), false);
  assert.equal(isValidKey(":x"), false);
});

test("mergePrefsFile 合并写入后可读回，且保留未提交的旧键", () => {
  const { file } = tempFile();
  const first = mergePrefsFile(file, { "whale-moe:pet": "1", "whale-moe:title": "鲸" });
  assert.equal(first.written, true);
  const second = mergePrefsFile(file, { "whale-moe:title": "鲸鱼娘" });
  assert.equal(second.count, 1);
  assert.deepEqual(readPrefsFile(file), { "whale-moe:pet": "1", "whale-moe:title": "鲸鱼娘" });
});

test("文件不存在或损坏都当空，不抛异常", () => {
  const { dir } = tempFile();
  assert.deepEqual(readPrefsFile(path.join(dir, "missing.json")), {});
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.deepEqual(readPrefsFile(broken), {});
});

test("超量提交被整体拒绝，不破坏已有数据", () => {
  const { file } = tempFile();
  mergePrefsFile(file, { "whale-moe:pet": "1" });
  const huge = { "whale-moe:huge": "x".repeat(MAX_VALUE_CHARS) };
  const result = mergePrefsFile(file, huge, { maxBytes: 100 });
  assert.equal(result.written, false);
  assert.equal(result.count, 0);
  assert.deepEqual(readPrefsFile(file), { "whale-moe:pet": "1" });
});

test("prefsFilePath 跟随 DSH_HOME", () => {
  assert.equal(
    prefsFilePath("/tmp/dsh-home-x"),
    path.join("/tmp/dsh-home-x", "plugin-data", "dsh-whale-musume", "prefs.json"),
  );
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = "/tmp/dsh-home-env";
  try {
    assert.equal(
      prefsFilePath(),
      path.join("/tmp/dsh-home-env", "plugin-data", "dsh-whale-musume", "prefs.json"),
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
