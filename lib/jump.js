/**
 * 跳板机「只读取码」：从 Ugreen-jump-base 上取被测工程的提交与文件内容，
 * 写成知识库可读的证据文件（raw-sources/public/jump/<repo>/EVIDENCE.md）。
 *
 * 设计原则：
 * - 只读：只做 git log / git show / git grep / sed 一类动作，不写远端、不 scp 上传。
 * - 白名单：仓库名与文件路径都按严格字符集校验，远程命令不做字符串拼接注入。
 * - 可解释：证据文件里写明仓库、commit、改动文件清单与摘录，机器人只能引用这里的东西。
 *
 * 这个模块不依赖宿主，纯 Node，方便单测（run 可注入）。
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

export const JUMP_DEFAULT_HOST = "Ugreen-jump-base";
export const JUMP_DEFAULT_REPOS = ["ha_agent", "ug-system-cli", "ugcli-lib", "ugbase"];
export const JUMP_MAX_COMMITS = 10;
export const JUMP_MAX_FILES = 40;
export const JUMP_MAX_DIFF_CHARS = 12000;
export const JUMP_MAX_FILE_BYTES = 200000;
export const JUMP_SSH_TIMEOUT_MS = 30000;

const repoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const pathPattern = /^[A-Za-z0-9._\-/]{1,300}$/;
const shaPattern = /^[0-9a-f]{7,40}$/i;

const execFile = promisify(execFileCallback);

/** 仓库名只允许字母数字点划线与下划线，挡掉 $(…)、空格、斜杠。 */
export function safeRepo(repo) {
  return typeof repo === "string" && repoPattern.test(repo) ? repo : null;
}

/** 相对路径白名单：不允许 `..`、不以 `/` 开头、不许 `~`。 */
export function safeRelPath(file) {
  if (typeof file !== "string") return null;
  const clean = file.trim();
  if (clean === "" || clean.length > 300) return null;
  if (clean.startsWith("/") || clean.startsWith("~")) return null;
  if (clean.split("/").some((part) => part === ".." || part === "")) return null;
  return pathPattern.test(clean) ? clean : null;
}

/** 把 "whale-moe:jumpRepos" 这种逗号列表整理成仓库名数组。 */
export function parseRepoList(value, fallback = JUMP_DEFAULT_REPOS) {
  const text = Array.isArray(value) ? value.join(",") : value;
  const raw = typeof text === "string" && text.trim() !== "" ? text : fallback.join(",");
  const seen = new Set();
  const repos = [];
  for (const piece of raw.split(/[,，\s]+/)) {
    const repo = safeRepo(piece);
    if (repo && !seen.has(repo)) {
      seen.add(repo);
      repos.push(repo);
    }
  }
  return repos;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 默认的 ssh 执行器：BatchMode，超时自杀，避免挂住机器人心跳。 */
export async function sshRun(host, script, { timeoutMs = JUMP_SSH_TIMEOUT_MS, run } = {}) {
  const runner = run ?? (async (file, args, options) => {
    const { stdout, stderr } = await execFile(file, args, options);
    return { stdout: String(stdout), stderr: String(stderr) };
  });
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    host,
    script,
  ];
  return runner("/usr/bin/ssh", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
}

function remoteCd(repo) {
  return `cd "$HOME/code/${repo}"`;
}

function parseClock(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 解析 `git log -1 --format=%H|%h|%cd|%s` 那一行。 */
export function parseRepoStatus(text) {
  const [sha = "", short = "", date = "", subject = ""] = String(text ?? "").trim().split("|");
  return {
    sha: shaPattern.test(sha) ? sha : null,
    short: short || (sha ? sha.slice(0, 7) : ""),
    date: parseClock(date),
    subject: subject.trim(),
  };
}

/** 取仓库 HEAD、当前分支与脏文件数。仓库不存在/不是 git 仓 → {ok:false,error}。 */
export async function repoStatus(host, repo, options = {}) {
  const name = safeRepo(repo);
  if (!name) return { ok: false, error: "bad repo" };
  const script = [
    remoteCd(name),
    "git log -1 --format='%H|%h|%cd|%s' --date=iso-strict",
    "printf '\\n--dirty--\\n'",
    "git status --porcelain | wc -l | tr -d ' '",
    "printf '\\n--branch--\\n'",
    "git branch --show-current",
  ].join("; ");
  try {
    const { stdout } = await sshRun(host, script, options);
    const [logLine = "", rest = ""] = String(stdout).split("--dirty--");
    const [dirtyText = "", branchText = ""] = String(rest).split("--branch--");
    const status = parseRepoStatus(logLine);
    return {
      ok: true,
      repo: name,
      ...status,
      dirty: Math.max(0, Number(String(dirtyText).trim().split("\n").pop()) || 0),
      branch: String(branchText).trim().split("\n").pop() || "",
    };
  } catch (error) {
    return { ok: false, repo: name, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 列 ~/code 下看起来像 git 仓的目录。 */
export async function listRepos(host, options = {}) {
  try {
    const { stdout } = await sshRun(host, 'for d in "$HOME"/code/*/; do [ -d "$d/.git" ] && basename "$d"; done', options);
    return String(stdout).split("\n").map((line) => safeRepo(line.trim())).filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * 自 sinceSha 以来的提交与改动文件列表。
 * sinceSha 为空 → 取最近 maxCommits 条提交 + HEAD 的改动文件。
 */
export async function repoChanges(host, repo, { sinceSha, maxCommits = JUMP_MAX_COMMITS, maxFiles = JUMP_MAX_FILES } = {}, options = {}) {
  const name = safeRepo(repo);
  if (!name) return { ok: false, error: "bad repo" };
  const since = typeof sinceSha === "string" && shaPattern.test(sinceSha) ? sinceSha : null;
  const range = since ? `${since}..HEAD` : `HEAD~${Math.max(1, maxCommits)}..HEAD`;
  const script = [
    remoteCd(name),
    `git log --format='%H|%h|%cd|%s' --date=iso-strict ${shellQuote(range)}`,
    "printf '\\n--files--\\n'",
    `git diff --name-status ${shellQuote(range)} | head -n ${Math.max(1, maxFiles)}`,
    "printf '\\n--stat--\\n'",
    `git diff --stat ${shellQuote(range)} | tail -n 1`,
  ].join("; ");
  try {
    const { stdout } = await sshRun(host, script, options);
    const [logText = "", rest = ""] = String(stdout).split("--files--");
    const [filesText = "", statText = ""] = String(rest).split("--stat--");
    const commits = String(logText).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const status = parseRepoStatus(line);
      return { sha: status.sha, short: status.short, date: status.date, subject: status.subject };
    }).filter((item) => item.sha);
    const files = String(filesText).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [status = "", file = ""] = line.split(/\s+/);
      const rel = safeRelPath(file);
      return rel ? { status, path: rel } : null;
    }).filter(Boolean);
    return {
      ok: true,
      repo: name,
      since: since,
      commits,
      files,
      stat: String(statText).trim().split("\n").pop() || "",
    };
  } catch (error) {
    return { ok: false, repo: name, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 读一个文本文件（截断到 maxBytes），路径必须在仓库内。 */
export async function readRepoFile(host, repo, file, { maxBytes = JUMP_MAX_FILE_BYTES } = {}, options = {}) {
  const name = safeRepo(repo);
  const rel = safeRelPath(file);
  if (!name || !rel) return { ok: false, error: "bad repo or path" };
  const limit = Math.max(1, Math.min(maxBytes, JUMP_MAX_FILE_BYTES));
  const script = [
    remoteCd(name),
    `if [ -f ${shellQuote(rel)} ]; then head -c ${limit} -- ${shellQuote(rel)}; else printf '__MISSING__'; fi`,
  ].join("; ");
  try {
    const { stdout } = await sshRun(host, script, options);
    if (String(stdout).startsWith("__MISSING__")) return { ok: false, repo: name, path: rel, error: "missing" };
    return { ok: true, repo: name, path: rel, text: String(stdout).slice(0, limit) };
  } catch (error) {
    return { ok: false, repo: name, path: rel, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 在仓库里 grep（限制命中条数），给机器人找线索用。 */
export async function grepRepo(host, repo, pattern, { ref = null, maxHits = 40 } = {}, options = {}) {
  const name = safeRepo(repo);
  if (!name || typeof pattern !== "string" || pattern.length === 0 || pattern.length > 120) {
    return { ok: false, error: "bad pattern" };
  }
  const refArg = ref && /^[A-Za-z0-9._\-/]{1,120}$/.test(ref) ? shellQuote(ref) : "";
  const script = [
    remoteCd(name),
    `git grep -n --max-count ${Math.max(1, Math.min(maxHits, 200))} ${refArg} -e ${shellQuote(pattern)} 2>/dev/null || true`,
  ].join("; ");
  try {
    const { stdout } = await sshRun(host, script, options);
    return { ok: true, repo: name, hits: String(stdout).split("\n").filter(Boolean).slice(0, maxHits) };
  } catch (error) {
    return { ok: false, repo: name, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 证据文件正文（纯函数，便于测试）：别让机器人读到一坨没标注的报告。 */
export function buildEvidence({ repo, status, changes, excerpts = [], generatedAt = new Date().toISOString() }) {
  const lines = [
    "---",
    "type: jump-evidence",
    `repo: ${repo}`,
    `commit: ${status?.sha ?? "unknown"}`,
    `branch: ${status?.branch ?? "unknown"}`,
    `generated: ${generatedAt}`,
    "---",
    "",
    `# 跳板机代码证据：${repo}`,
    "",
    "> 本文件由 dsh-whale-musume 从跳板机 `Ugreen-jump-base` 只读抓取，**不是 wiki 正文**。",
    "> 引用时必须写 `" + `${repo}@${status?.sha ? status.sha.slice(0, 7) : "unknown"}` + "`，不能凭记忆补细节。",
    "",
    "## HEAD",
    "",
    `- 提交：\`${status?.sha ?? "unknown"}\`（${status?.short ?? ""}）`,
    `- 分支：${status?.branch || "unknown"}`,
    `- 时间：${status?.date ?? "unknown"}`,
    `- 标题：${status?.subject || "（空）"}`,
    `- 未提交改动：${status?.dirty ?? 0} 个文件`,
    "",
    "## 最近改动",
    "",
  ];
  if (!changes?.commits?.length) lines.push("（没有新提交）");
  for (const item of changes?.commits ?? []) {
    lines.push(`- \`${item.short}\` ${item.date ?? ""} ${item.subject}`);
  }
  lines.push("", "## 改动文件", "");
  const files = changes?.files ?? [];
  for (const file of files) lines.push(`- ${file.status} \`${file.path}\``);
  if (files.length === 0) lines.push("（列表为空）");
  if (changes?.stat) lines.push("", "```", changes.stat, "```");
  if (excerpts.length > 0) {
    lines.push("", "## 文件摘录");
    for (const item of excerpts) {
      lines.push("", `### \`${item.path}\``, "", "```", String(item.text ?? "").slice(0, JUMP_MAX_DIFF_CHARS), "```");
    }
  }
  lines.push("", "## 给知识库管理员的用法", "",
    "1. 只根据本文件与 `files/` 下的摘录核对事实，不要 ssh 到跳板机、不要臆测代码。",
    "2. 更新已有页面时优先改「事实已过时/与代码不符」的段落；引用写 `" + `${repo}@${status?.sha ? status.sha.slice(0, 7) : "unknown"}` + "`。",
    "3. 如果出现了新的子系统/新概念，按 schema/page-types.md 新建页面，并更新 wiki/index.md 与 wiki/log.md。",
    "4. 本文件本身不入 wiki 正文；页面写完后在 log.md 里注明读过 `raw-sources/public/jump/" + repo + "/EVIDENCE.md`。",
    "");
  return lines.join("\n");
}

/** 从改动文件里挑几个适合当摘录的文本文件（代码/配置），避免把大文件塞进证据。 */
export function pickExcerptFiles(files, { limit = 6, maxBytes = 12000 } = {}) {
  const allowed = /\.(md|toml|rs|py|json|yaml|yml|ts|go|sh|txt)$/i;
  return (files || [])
    .filter((file) => file && allowed.test(file.path || ""))
    .filter((file) => file.status !== "D")
    .slice(0, limit)
    .map((file) => ({ path: file.path, maxBytes }));
}
