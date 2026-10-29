/**
 * 知识库巡检：把 `~/hors/my-code-wiki` 这类 Obsidian 风格仓库里「该整理了」的信号
 * 算成一个结构化摘要，宿主侧只做确定性的机械检查，判断与整理交给大模型会话。
 *
 * 这里刻意不读正文做语义分析（那是模型的事），只统计：待审 inbox、过时页面、
 * TODO 标记、断链、index 滞后、git 状态。纯 Node，无宿主依赖，方便单测。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_WIKI_ROOT = "~/hors/my-code-wiki";
export const STALE_DAYS = 45;
/** 「这一轮里动过文件」的判定窗口：turn 开始后再往前看 5 分钟。 */
export const DEFAULT_ACK_WINDOW_MS = 5 * 60 * 1000;
const MAX_FILES = 4000;
const SKIP_DIRS = new Set([".git", ".qmd", ".remember", ".workbuddy", ".tmp", ".venv", ".pytest_cache", "node_modules", "raw-sources", "outputs"]);
const GIT_TIMEOUT_MS = 4000;

/** 把 `~/xxx` 展开成绝对路径；已经是绝对路径就原样返回。 */
export function expandHome(input, home = homedir()) {
  const value = String(input ?? "").trim();
  if (!value) return "";
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/** 校验并解析用户配置的仓库路径：必须是存在的目录，且看起来像一个 wiki 仓库。 */
export function resolveWikiRoot(input, home = homedir()) {
  const expanded = expandHome(input || DEFAULT_WIKI_ROOT, home);
  if (!expanded) return { ok: false, error: "no-root", root: "" };
  let stat;
  try {
    stat = statSync(expanded);
  } catch {
    return { ok: false, error: "missing", root: expanded };
  }
  if (!stat.isDirectory()) return { ok: false, error: "not-a-directory", root: expanded };
  const markers = ["wiki", "AGENTS.md", "schema"];
  if (!markers.some((name) => existsSync(path.join(expanded, name)))) {
    return { ok: false, error: "not-a-wiki", root: expanded };
  }
  return { ok: true, root: expanded };
}

/** 读一个文件最前面的 frontmatter（只认 `key: value` 这种一行一个的简单形式）。 */
export function parseFrontmatter(text) {
  const source = String(text || "");
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = source.slice(3, end);
  const fields = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[match[1]] = value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      fields[match[1]] = value;
    }
  }
  return fields;
}

/** 解析 "YYYY-MM-DD" 或完整时间戳，返回毫秒；解析不了返回 NaN。 */
export function parseDay(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return Number.NaN;
  const stamp = Date.parse(text.length <= 10 ? `${text}T00:00:00Z` : text);
  return Number.isFinite(stamp) ? stamp : Number.NaN;
}

function normalizeTarget(raw) {
  let value = String(raw || "").trim();
  // 表格里常写成 `[[target\|别名]]`，先还原转义再切别名
  value = value.replace(/\\/g, "");
  const pipe = value.indexOf("|");
  if (pipe >= 0) value = value.slice(0, pipe);
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  value = value.trim();
  if (value.startsWith("./")) value = value.slice(2);
  return value;
}

/** 从一段 markdown 里收集内部链接：`[[a/b|别名]]` 与 `[文字](a/b.md)`（外链忽略）。 */
export function collectLinks(text) {
  const source = String(text || "");
  const links = [];
  for (const match of source.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = normalizeTarget(match[1]);
    if (target) links.push({ kind: "wiki", target });
  }
  for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = match[1];
    if (/^(?:[a-z]+:|\/\/|#)/i.test(raw) || raw.startsWith("mailto:")) continue;
    const target = normalizeTarget(decodeURIComponent(raw));
    if (target) links.push({ kind: "path", target });
  }
  return links;
}

function listMarkdown(root) {
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), nextRel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(nextRel);
      }
    }
  };
  walk(root, "");
  return files.sort();
}

function existsAny(root, candidates) {
  return candidates.some((candidate) => existsSync(candidate));
}

function resolveLink(root, fromRel, link) {
  const fromDir = path.dirname(path.join(root, fromRel));
  const target = link.kind === "wiki" ? `${link.target}.md` : link.target;
  const candidates = [path.resolve(fromDir, target), path.join(root, "wiki", target), path.join(root, target)];
  if (link.kind === "wiki") candidates.push(path.join(root, "wiki", target, "index.md"));
  return existsAny(root, candidates);
}

async function gitSummary(root) {
  try {
    const [log, status] = await Promise.all([
      execFileAsync("git", ["-C", root, "log", "-1", "--format=%cs%x09%s"], { timeout: GIT_TIMEOUT_MS }),
      execFileAsync("git", ["-C", root, "status", "--porcelain"], { timeout: GIT_TIMEOUT_MS }),
    ]);
    const line = String(log.stdout || "").trim();
    const [date = "", subject = ""] = line.split("\t");
    const dirty = String(status.stdout || "").split("\n").filter((row) => row.trim()).length;
    return { ok: true, date, subject: subject.slice(0, 80), dirty };
  } catch (error) {
    return { ok: false, error: String(error?.code || error?.message || "git-failed").slice(0, 80), dirty: 0 };
  }
}

function firstHeading(text) {
  const match = /^#\s+(.+)$/m.exec(String(text || ""));
  return match ? match[1].trim().slice(0, 60) : "";
}

/**
 * 巡检一个 wiki 仓库。`runGit` 可注入，测试里不用真 git。
 * @returns 结构化摘要，见文件顶部注释。
 */
export async function scanWiki(root, options = {}) {
  const { now = Date.now(), staleDays = STALE_DAYS, runGit = gitSummary, maxSamples = 6, reviewed = [] } = options;
  const reviewedSet = reviewed instanceof Set ? reviewed : new Set(Array.from(reviewed ?? []));
  const files = listMarkdown(root);
  const wikiFiles = files.filter((rel) => rel.startsWith("wiki/"));
  const stale = [];
  const todoPages = [];
  const broken = [];
  let todoCount = 0;
  let newestUpdated = Number.NEGATIVE_INFINITY;

  for (const rel of wikiFiles) {
    let text = "";
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const fields = parseFrontmatter(text);
    const stamp = parseDay(fields.updated) || parseDay(fields.date);
    if (Number.isFinite(stamp)) newestUpdated = Math.max(newestUpdated, stamp);
    if (Number.isFinite(stamp) && now - stamp > staleDays * 86400000) {
      stale.push({ path: rel, updated: String(fields.updated || fields.date || "").slice(0, 10) });
    }
    const todoMatches = text.match(/\b(?:TODO|FIXME)\b|待补|待更新|待确认/g);
    if (todoMatches) {
      todoCount += todoMatches.length;
      todoPages.push({ path: rel, count: todoMatches.length });
    }
    for (const link of collectLinks(text)) {
      if (!resolveLink(root, rel, link)) broken.push({ from: rel, target: link.target });
    }
  }

  const inboxFiles = files.filter((rel) => rel.startsWith("inbox/") && !rel.toLowerCase().includes("readme"));
  const inboxAll = [];
  for (const rel of inboxFiles) {
    let text = "";
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const fields = parseFrontmatter(text);
    const status = String(fields.status || "").trim();
    if (status && status !== "pending-review" && status !== "pending") continue;
    // 跳板机投递的标题常是套话，项目名更好认：优先 project_id 末段。
    const project = /"project_id"\s*:\s*"([^"]+)"/.exec(text);
    const title = project && project[1]
      ? project[1].split("/").filter(Boolean).pop()
      : firstHeading(text) || path.basename(rel, ".md");
    inboxAll.push({ path: rel, title: String(title).slice(0, 60) });
  }
  // 用户或整理会话标记过「已处理」的投递不再计入待审（原件按 inbox 策略保留，删不了才要这份账）。
  const inbox = inboxAll.filter((item) => !reviewedSet.has(item.path) && !reviewedSet.has(path.basename(item.path)));

  const indexText = (() => {
    try {
      return readFileSync(path.join(root, "wiki/index.md"), "utf8");
    } catch {
      return "";
    }
  })();
  const indexUpdated = parseDay(parseFrontmatter(indexText).updated);
  const indexLagDays = Number.isFinite(indexUpdated) && Number.isFinite(newestUpdated) && newestUpdated > Number.NEGATIVE_INFINITY
    ? Math.max(0, Math.round((newestUpdated - indexUpdated) / 86400000))
    : Number.NaN;

  const git = await runGit(root);
  stale.sort((a, b) => String(a.updated).localeCompare(String(b.updated)));
  todoPages.sort((a, b) => b.count - a.count);
  broken.sort((a, b) => a.from.localeCompare(b.from));
  inbox.sort((a, b) => a.path.localeCompare(b.path));

  const plan = [];
  if (inbox.length) plan.push(`收件箱还有 ${inbox.length} 条投递没有审核入库`);
  if (stale.length) plan.push(`${stale.length} 个页面超过 ${staleDays} 天没更新`);
  if (todoCount) plan.push(`${todoPages.length} 个页面留着 ${todoCount} 处待办/待补标记`);
  if (broken.length) plan.push(`${broken.length} 处内部链接指向不存在的页面`);
  if (Number.isFinite(indexLagDays) && indexLagDays > 7) plan.push(`index.md 比最新更新滞后 ${indexLagDays} 天`);
  if (git.ok && git.dirty) plan.push(`工作区有 ${git.dirty} 个文件改动没提交`);

  return {
    ok: true,
    root,
    scannedAt: new Date(now).toISOString(),
    pages: wikiFiles.length,
    lastCommit: git.ok ? { date: git.date, subject: git.subject } : null,
    gitError: git.ok ? null : git.error,
    dirty: git.dirty,
    inbox: { pending: inbox.length, total: inboxAll.length, reviewed: inboxAll.length - inbox.length, samples: inbox.slice(0, maxSamples), paths: inbox.map((item) => item.path).slice(0, 400) },
    stale: { count: stale.length, days: staleDays, samples: stale.slice(0, maxSamples) },
    todos: { pages: todoPages.length, items: todoCount, samples: todoPages.slice(0, maxSamples) },
    links: { broken: broken.length, samples: broken.slice(0, maxSamples) },
    index: { updated: Number.isFinite(indexUpdated) ? new Date(indexUpdated).toISOString().slice(0, 10) : null, lagDays: Number.isFinite(indexLagDays) ? indexLagDays : null },
    plan,
    needsAttention: Boolean(inbox.length || stale.length || todoCount || broken.length),
  };
}

/** 把摘要压成给大模型看的短文本（控制 token，同时保留可执行的线索）。 */
export function planPrompt(summary) {
  const lines = [
    "请扮演「my-code-wiki 知识库管理员」，按仓库根目录 AGENTS.md 与 schema/workflows.md 的流程做一次维护。",
    "",
    `仓库：${summary?.root || ""}`,
    `页面数：${summary?.pages ?? 0}；最后一次提交：${summary?.lastCommit?.date || "未知"} ${summary?.lastCommit?.subject || ""}`.trim(),
  ];
  const attention = Array.isArray(summary?.plan) ? summary.plan : [];
  if (attention.length) {
    lines.push("", "巡检发现的待处理项：");
    for (const item of attention) lines.push(`- ${item}`);
  }
  const samples = [];
  for (const item of summary?.inbox?.samples || []) samples.push(`inbox: ${item.path}（${item.title}）`);
  for (const item of summary?.stale?.samples || []) samples.push(`过时: ${item.path}（updated ${item.updated}）`);
  for (const item of summary?.todos?.samples || []) samples.push(`待办: ${item.path}（${item.count} 处）`);
  for (const item of summary?.links?.samples || []) samples.push(`断链: ${item.from} → ${item.target}`);
  if (samples.length) {
    lines.push("", "样本（不是全部）：");
    for (const item of samples.slice(0, 12)) lines.push(`- ${item}`);
  }
  lines.push(
    "",
    "执行要求：",
    "1. 先给一段简短的维护方案（要点式，别超过 10 行），再动手。",
    "2. 任何「会改 3 个以上文件 / 删除或合并页面 / 改 frontmatter 语义 / 动 raw-sources」的决定，必须先用 ask_user_question 问我，拿到答复再继续。",
    "3. 一次只推进一类：先 inbox 入库，再处理过时页面与断链，最后补待办。每类做完在 wiki/log.md 追加一条 `## [YYYY-MM-DD] maint | 摘要`。",
    "4. 不要碰 raw-sources/、.git、.venv、node_modules；写文件前先读已有内容。",
    "5. 结束时用 3–6 行总结：改了哪些页面、还有哪些没做、需要我拍板什么。",
  );
  return lines.join("\n");
}

/**
 * 一轮结束后要不要把当前清单记成「已处理」。
 * - 会话就在知识库目录里跑：算；
 * - 清单指纹和已记账的一致：不用重复记；
 * - 在别的会话里跑：只有这一轮的时间窗内知识库文件真的动过才算。
 */
export function shouldAckWiki(input) {
  const sameCwd = input?.sameCwd === true;
  const fingerprint = typeof input?.fingerprint === "string" ? input.fingerprint : "";
  const stored = typeof input?.storedFingerprint === "string" ? input.storedFingerprint : "";
  if (fingerprint === "") return false;
  if (sameCwd) return true;
  if (stored !== "" && stored === fingerprint) return false;
  const windowMs = Number.isFinite(input?.windowMs) ? input.windowMs : DEFAULT_ACK_WINDOW_MS;
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const startedAt = Number.isFinite(input?.startedAt) && input.startedAt > 0 ? input.startedAt : now;
  const latestMtime = Number.isFinite(input?.latestMtime) ? input.latestMtime : 0;
  return latestMtime >= startedAt - windowMs;
}

/** 知识库里最近一次文件改动的时间戳（毫秒）；没有可读文件返回 0。 */
export function latestMtimeMs(root) {
  let newest = 0;
  const files = listMarkdown(root);
  for (const rel of files) {
    try {
      const stamp = statSync(path.join(root, rel)).mtimeMs;
      if (stamp > newest) newest = stamp;
    } catch {
      continue;
    }
  }
  return newest;
}

/** 给设置面板/卡片用的极简版本（不含样本正文）。 */
/**
 * 巡检指纹：只要这份清单没变，就不再重复弹「该整理了」。
 * 用户在任何会话里改完文件、或者新投递进来，指纹都会变。
 */
export function wikiFingerprint(summary) {
  if (!summary || summary.ok !== true) return "";
  const counts = summarizeForCard(summary).counts;
  const plan = Array.isArray(summary.plan) ? summary.plan : [];
  return JSON.stringify({ root: summary.root, counts, plan, dirty: summary.dirty ?? 0 });
}

export function summarizeForCard(summary) {
  if (!summary?.ok) return { ok: false, error: summary?.error || "scan-failed" };
  return {
    ok: true,
    root: summary.root,
    pages: summary.pages,
    lastCommit: summary.lastCommit,
    plan: summary.plan,
    needsAttention: summary.needsAttention,
    counts: {
      inbox: summary.inbox.pending,
      stale: summary.stale.count,
      todos: summary.todos.items,
      broken: summary.links.broken,
      indexLagDays: summary.index.lagDays,
    },
  };
}

export const __testing = { listMarkdown, collectLinks, normalizeTarget, resolveLink };
