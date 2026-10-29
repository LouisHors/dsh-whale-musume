import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectLinks,
  DEFAULT_WIKI_ROOT,
  expandHome,
  parseDay,
  parseFrontmatter,
  planPrompt,
  resolveWikiRoot,
  scanWiki,
  latestMtimeMs,
  shouldAckWiki,
  summarizeForCard,
  wikiFingerprint,
} from "../lib/wiki.js";

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "whale-wiki-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

const NOW = Date.parse("2026-10-28T00:00:00Z");

test("resolveWikiRoot: 缺目录与不像 wiki 的目录都拒绝", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "whale-empty-"));
  try {
    assert.equal(resolveWikiRoot("~/nope-not-here").error, "missing");
    assert.equal(resolveWikiRoot(empty).error, "not-a-wiki");
    const ok = fixture({ "wiki/index.md": "# i", "AGENTS.md": "# a" });
    try {
      const resolved = resolveWikiRoot(ok);
      assert.equal(resolved.ok, true);
      assert.equal(resolved.root, ok);
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("expandHome 只展开 ~ 开头", () => {
  assert.equal(expandHome("~/a/b", "/home/u"), "/home/u/a/b");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/abs/path", "/home/u"), "/abs/path");
  assert.equal(expandHome("", "/home/u"), "");
  assert.equal(DEFAULT_WIKI_ROOT, "~/hors/my-code-wiki");
});

test("parseFrontmatter 读简单字段与数组，parseDay 认日期", () => {
  const fields = parseFrontmatter("---\ndate: 2026-08-07\ntype: entity\ntags: [a, b]\nupdated: '2026-08-11'\n---\n# x\n");
  assert.equal(fields.date, "2026-08-07");
  assert.equal(fields.updated, "2026-08-11");
  assert.deepEqual(fields.tags, ["a", "b"]);
  assert.deepEqual(parseFrontmatter("# no fm"), {});
  assert.equal(parseDay("2026-08-07"), Date.parse("2026-08-07T00:00:00Z"));
  assert.ok(Number.isNaN(parseDay("八月七日")));
});

test("collectLinks 认 wikilink 与相对 md 链接，跳过外链，处理表格转义", () => {
  const links = collectLinks("[[a/b|别名]] [[c\\|表格别名]] [t](./d/e.md) [x](https://x.y) [m](mailto:a@b)");
  assert.deepEqual(links.map((l) => l.target), ["a/b", "c", "d/e.md"]);
  assert.equal(links[0].kind, "wiki");
  assert.equal(links[2].kind, "path");
});

test("scanWiki 汇总待审/过时/待办/断链/index 滞后", async () => {
  const root = fixture({
    "wiki/index.md": "---\nupdated: 2026-08-20\n---\n# 索引\n",
    "wiki/entities/fresh.md": "---\nupdated: 2026-10-20\n---\n# Fresh\n[[missing-page]]\n",
    "wiki/entities/old.md": "---\nupdated: 2026-03-01\n---\n# Old\nTODO 补一个章节\n",
    "wiki/notes/keep.md": "---\nupdated: 2026-10-01\n---\n[[entities/fresh|Fresh]]\n",
    "inbox/a.md": "---\nstatus: pending-review\n---\n# 投递 A\n",
    "inbox/b.md": "---\nstatus: done\n---\n# 投递 B\n",
  });
  try {
    const summary = await scanWiki(root, {
      now: NOW,
      runGit: async () => ({ ok: true, date: "2026-08-07", subject: "docs: ingest", dirty: 3 }),
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.pages, 4);
    assert.equal(summary.inbox.pending, 1);
    assert.equal(summary.inbox.samples[0].path, "inbox/a.md");
    assert.equal(summary.stale.count, 2); // index(08-20) 与 old(03-01) 都超 45 天
    assert.equal(summary.stale.samples[0].path, "wiki/entities/old.md");
    assert.equal(summary.todos.items, 1);
    assert.equal(summary.todos.samples[0].path, "wiki/entities/old.md");
    assert.equal(summary.links.broken, 1);
    assert.equal(summary.links.samples[0].target, "missing-page");
    assert.equal(summary.index.lagDays, 61);
    assert.equal(summary.dirty, 3);
    assert.equal(summary.needsAttention, true);
    assert.ok(summary.plan.some((line) => line.includes("收件箱")));
    assert.ok(summary.plan.some((line) => line.includes("没提交")));

    const prompt = planPrompt(summary);
    assert.ok(prompt.includes(root));
    assert.ok(prompt.includes("ask_user_question"));
    assert.ok(prompt.includes("inbox/a.md"));
    assert.ok(prompt.includes("wiki/log.md"));

    const card = summarizeForCard(summary);
    assert.deepEqual(card.counts, { inbox: 1, stale: 2, todos: 1, broken: 1, indexLagDays: 61 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanWiki 干净仓库不报待办，git 失败也不抛", async () => {
  const root = fixture({
    "wiki/index.md": "---\nupdated: 2026-10-20\n---\n# i\n",
    "wiki/entities/a.md": "---\nupdated: 2026-10-21\n---\n# A\n[[entities/a]]\n",
  });
  try {
    const summary = await scanWiki(root, {
      now: NOW,
      runGit: async () => ({ ok: false, error: "not-a-repo", dirty: 0 }),
    });
    assert.equal(summary.needsAttention, false);
    assert.equal(summary.plan.length, 0);
    assert.equal(summary.gitError, "not-a-repo");
    assert.equal(summary.index.lagDays, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanWiki 支持把已处理投递排除出待审（原件保留版）", async () => {
  const root = fixture({
    "wiki/index.md": "---\nupdated: 2026-08-20\n---\n# 索引\n",
    "inbox/a.md": "---\nstatus: pending-review\n---\n# 投递 A\n",
    "inbox/b.md": "---\nstatus: pending-review\n---\n# 投递 B\n",
  });
  try {
    const options = { now: NOW, runGit: async () => ({ ok: true, date: "2026-08-07", subject: "docs: ingest", dirty: 0 }) };
    const before = await scanWiki(root, options);
    assert.equal(before.inbox.pending, 2);
    assert.equal(before.inbox.total, 2);
    assert.equal(before.inbox.reviewed, 0);
    assert.deepEqual(before.inbox.paths, ["inbox/a.md", "inbox/b.md"]);

    const after = await scanWiki(root, { ...options, reviewed: ["inbox/a.md"] });
    assert.equal(after.inbox.pending, 1);
    assert.equal(after.inbox.total, 2);
    assert.equal(after.inbox.reviewed, 1);
    assert.deepEqual(after.inbox.samples.map((item) => item.path), ["inbox/b.md"]);
    assert.ok(!after.plan.some((line) => line.includes("收件箱还有 2")));

    const allReviewed = await scanWiki(root, { ...options, reviewed: ["inbox/a.md", "b.md"] });
    assert.equal(allReviewed.inbox.pending, 0);
    assert.ok(!allReviewed.plan.some((line) => line.includes("收件箱")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wikiFingerprint: 清单不变指纹不变，清单一动就换指纹", async () => {
  const root = fixture({
    "AGENTS.md": "# agents",
    "wiki/index.md": "---\nupdated: 2026-09-01\n---\n# index",
    "wiki/a.md": "---\ndate: 2026-01-01\nupdated: 2026-01-01\n---\n# a",
    "inbox/in.md": "---\nstatus: pending-review\n---\n# inbox",
  });
  const options = { now: Date.parse("2026-10-29T00:00:00Z"), runGit: async () => ({ ok: false, error: "not-a-repo", dirty: 0 }) };
  try {
    const first = await scanWiki(root, options);
    const again = await scanWiki(root, options);
    assert.equal(wikiFingerprint(first), wikiFingerprint(again));
    assert.match(wikiFingerprint(first), /^\{/);

    // 新文件进 inbox → 待审数变 → 指纹变
    writeFileSync(path.join(root, "inbox/new.md"), "---\nstatus: pending-review\n---\n# new");
    const changed = await scanWiki(root, options);
    assert.equal(changed.inbox.pending, 1 + first.inbox.pending);
    assert.notEqual(wikiFingerprint(changed), wikiFingerprint(first));

    // 只有 git 状态变化也要算（落盘状态会脏）
    const dirty = { ...first, dirty: first.dirty + 1 };
    assert.notEqual(wikiFingerprint(dirty), wikiFingerprint(first));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("latestMtimeMs: 取知识库里最新的文件改动时间", () => {
  const root = fixture({
    "AGENTS.md": "# a",
    "wiki/index.md": "# i",
  });
  try {
    const now = Date.now();
    assert.ok(Math.abs(latestMtimeMs(root) - now) < 60_000, "刚写的文件应该接近当前时间");
    assert.equal(latestMtimeMs(path.join(root, "nope")), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldAckWiki: 工作目录命中就算；别的会话按时间窗 + 指纹判断", () => {
  const base = { fingerprint: "fp1", storedFingerprint: "fp0", startedAt: 1_000_000, now: 1_100_000 };
  // ① 会话就在知识库目录里 → 直接算
  assert.equal(shouldAckWiki({ ...base, sameCwd: true, latestMtime: 0 }), true);
  // ② 指纹没变（已经记过） → 不再重复记
  assert.equal(shouldAckWiki({ ...base, storedFingerprint: "fp1", latestMtime: 1_050_000 }), false);
  // ③ 指纹变了、这一轮里文件确实动过 → 算
  assert.equal(shouldAckWiki({ ...base, latestMtime: 1_050_000 }), true);
  // ④ 指纹变了，但文件改动远早于这一轮（比如只是被打字触发） → 不算
  assert.equal(shouldAckWiki({ ...base, latestMtime: 1_000_000 - 6 * 60 * 1000 }), false);
  // ⑤ 边界：开始前 5 分钟内改的也算
  assert.equal(shouldAckWiki({ ...base, latestMtime: 1_000_000 - 4 * 60 * 1000 }), true);
  // ⑥ 指纹为空（扫描失败） → 不算
  assert.equal(shouldAckWiki({ ...base, fingerprint: "", sameCwd: true }), false);
});
