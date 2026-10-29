import assert from "node:assert/strict";
import test from "node:test";
import {
  JUMP_DEFAULT_REPOS,
  buildEvidence,
  parseRepoList,
  parseRepoStatus,
  pickExcerptFiles,
  readRepoFile,
  repoChanges,
  repoStatus,
  safeRelPath,
  safeRepo,
} from "../lib/jump.js";

const HOST = "Ugreen-jump-base";

function fakeRun(reply) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    const script = args[args.length - 1];
    const value = typeof reply === "function" ? reply(script, args, options) : reply;
    if (value instanceof Error) throw value;
    return { stdout: String(value ?? ""), stderr: "" };
  };
  return { run, calls };
}

test("safeRepo / safeRelPath / parseRepoList：挡注入、挡越界、去重", () => {
  assert.equal(safeRepo("ha_agent"), "ha_agent");
  assert.equal(safeRepo("ug-system-cli"), "ug-system-cli");
  assert.equal(safeRepo("../etc"), null);
  assert.equal(safeRepo("a b"), null);
  assert.equal(safeRepo("x$(id)"), null);
  assert.equal(safeRepo(""), null);

  assert.equal(safeRelPath("config/domains/music/cli.toml"), "config/domains/music/cli.toml");
  assert.equal(safeRelPath("../secrets"), null);
  assert.equal(safeRelPath("/etc/passwd"), null);
  assert.equal(safeRelPath("~/x"), null);
  assert.equal(safeRelPath("a//b"), null);

  assert.deepEqual(parseRepoList("ha_agent, ugcli-lib,ha_agent,../bad, "), ["ha_agent", "ugcli-lib"]);
  assert.deepEqual(parseRepoList(""), JUMP_DEFAULT_REPOS);
});

test("parseRepoStatus：解析 git log -1 的竖线格式", () => {
  const status = parseRepoStatus("40b7c1f2aabbccddeeff|40b7c1f|2026-10-28T09:15:00+08:00|fix(music): 门控");
  assert.equal(status.sha, "40b7c1f2aabbccddeeff");
  assert.equal(status.short, "40b7c1f");
  assert.equal(status.date, "2026-10-28T01:15:00.000Z");
  assert.equal(status.subject, "fix(music): 门控");
  assert.equal(parseRepoStatus("").sha, null);
});

test("repoStatus：ssh 失败时返回 ok:false 而不是抛错", async () => {
  const fake = fakeRun(() => new Error("ssh: connect to host failed"));
  const result = await repoStatus(HOST, "ha_agent", { run: fake.run });
  assert.equal(result.ok, false);
  assert.match(result.error, /connect to host failed/);
  assert.equal((await repoStatus(HOST, "../bad", { run: fake.run })).ok, false);
});

test("repoStatus：正常输出解析成 HEAD 信息", async () => {
  const fake = fakeRun(
    "abcdef1234567|abcdef1|2026-10-28T10:00:00+08:00|feat: 新契约\n--dirty--\n3\n--branch--\nrelease_A35\n",
  );
  const result = await repoStatus(HOST, "ha_agent", { run: fake.run });
  assert.equal(result.ok, true);
  assert.equal(result.sha, "abcdef1234567");
  assert.equal(result.dirty, 3);
  assert.equal(result.branch, "release_A35");
  const script = fake.calls[0].args.at(-1);
  assert.match(script, /cd "\$HOME\/code\/ha_agent"/);
  assert.match(script, /git log -1/);
});

test("repoChanges：解析提交与文件列表，非法路径被丢弃", async () => {
  const fake = fakeRun(
    [
      "aaaaaaaaaaaaa|aaaaaaa|2026-10-27T10:00:00+08:00|fix: 甲",
      "bbbbbbbbbbbbb|bbbbbbb|2026-10-28T11:00:00+08:00|feat: 乙",
      "--files--",
      "M\tconfig/domains/music/cli.toml",
      "A\tcrates/new.rs",
      "D\told/file.rs",
      "M\t../../etc/passwd",
      "--stat--",
      " 3 files changed, 10 insertions(+)",
    ].join("\n"),
  );
  const changes = await repoChanges(HOST, "ha_agent", { sinceSha: "1111111" }, { run: fake.run });
  assert.equal(changes.ok, true);
  assert.equal(changes.commits.length, 2);
  assert.equal(changes.commits[1].subject, "feat: 乙");
  assert.deepEqual(changes.files.map((file) => file.path), ["config/domains/music/cli.toml", "crates/new.rs", "old/file.rs"]);
  assert.equal(changes.stat, "3 files changed, 10 insertions(+)");
  const script = fake.calls[0].args.at(-1);
  assert.match(script, /1111111\.\.HEAD/);
});

test("repoChanges：没有历史提交时用窗口范围，不被注入", async () => {
  const fake = fakeRun("--files--\n\n--stat--\n");
  await repoChanges(HOST, "ha_agent", { sinceSha: "not-a-sha; rm -rf ~" }, { run: fake.run });
  const script = fake.calls[0].args.at(-1);
  assert.match(script, /HEAD~10\.\.HEAD/);
  assert.doesNotMatch(script, /rm -rf/);
});

test("readRepoFile：缺失文件与非法路径都返回 ok:false", async () => {
  const missing = fakeRun("__MISSING__");
  const result = await readRepoFile(HOST, "ha_agent", "config/x.toml", {}, { run: missing.run });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing");

  const fake = fakeRun((script) => (script.includes("head -c") ? "hello" : ""));
  const ok = await readRepoFile(HOST, "ha_agent", "config/x.toml", {}, { run: fake.run });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "hello");

  const bad = await readRepoFile(HOST, "ha_agent", "../x", {}, { run: fake.run });
  assert.equal(bad.ok, false);
});

test("buildEvidence：写清仓库/commit/引用规则与改动清单", () => {
  const text = buildEvidence({
    repo: "ha_agent",
    status: { sha: "abcdef1234567", short: "abcdef1", branch: "release_A35", date: "2026-10-28T10:00:00Z", subject: "feat: 新契约", dirty: 2 },
    changes: {
      commits: [{ short: "abcdef1", date: "2026-10-28T10:00:00Z", subject: "feat: 新契约" }],
      files: [{ status: "M", path: "config/domains/music/cli.toml" }],
      stat: " 1 file changed",
    },
    excerpts: [{ path: "config/domains/music/cli.toml", text: "name = \"music\"" }],
    generatedAt: "2026-10-28T12:00:00.000Z",
  });
  assert.match(text, /type: jump-evidence/);
  assert.match(text, /repo: ha_agent/);
  assert.match(text, /commit: abcdef1234567/);
  assert.match(text, /引用时必须写 `ha_agent@abcdef1`/);
  assert.match(text, /config\/domains\/music\/cli\.toml/);
  assert.match(text, /name = "music"/);
  assert.match(text, /不要 ssh 到跳板机/);
});

test("pickExcerptFiles：只挑文本类、跳过删除文件、限量", () => {
  const files = [
    { status: "M", path: "a.toml" },
    { status: "D", path: "b.rs" },
    { status: "A", path: "c.png" },
    { status: "A", path: "d.py" },
    { status: "M", path: "e.md" },
  ];
  const picks = pickExcerptFiles(files, { limit: 2 });
  assert.deepEqual(picks.map((item) => item.path), ["a.toml", "d.py"]);
});
