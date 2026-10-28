import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_TTL,
  FAIL_BACKOFF,
  __testing,
  categoryCounts,
  clip,
  decodeEntities,
  filterByCategories,
  isAllowedOpenUrl,
  loadFeed,
  mergeSeen,
  parseFeed,
  pickPost,
  stripHtml,
  topicIdFromLink,
} from "../lib/linuxdo.js";

/** 故意混入：实体转义、缺分类、置顶、超长正文、非 /t/topic 形式的链接。 */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:discourse="http://www.discourse.org/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>LINUX DO - 最新话题</title>
    <link>https://linux.do/latest</link>
    <lastBuildDate>Wed, 28 Oct 2026 08:01:00 +0000</lastBuildDate>
    <item>
      <title>有懂的佬吗 &amp; 二手 iPhone 的 MDM 能不能绕过</title>
      <dc:creator><![CDATA[buddy]]></dc:creator>
      <category>开发调优</category>
      <description><![CDATA[
        <p>买了一台二手 iPhone 12，抹掉之后出现远程管理。</p>
        <p>要不要退掉？<a href="https://linux.do/t/topic/3086463">阅读完整话题</a></p>
        <p><small>2 个帖子 - 2 位参与者</small></p>
      ]]></description>
      <link>https://linux.do/t/topic/3086463</link>
      <pubDate>Wed, 28 Oct 2026 08:01:00 +0000</pubDate>
      <discourse:topicPinned>No</discourse:topicPinned>
      <guid isPermaLink="false">linux.do-topic-3086463</guid>
    </item>
    <item>
      <title>未分类的帖子</title>
      <dc:creator><![CDATA[someone]]></dc:creator>
      <description><![CDATA[<p>正文</p>]]></description>
      <link>https://linux.do/t/some-slug/3086462</link>
      <pubDate>Wed, 28 Oct 2026 07:30:00 +0000</pubDate>
      <discourse:topicPinned>Yes</discourse:topicPinned>
    </item>
    <item>
      <title>长标题 &lt;script&gt; alert(1) &lt;/script&gt;</title>
      <dc:creator><![CDATA[long]]></dc:creator>
      <category>搞七捻三</category>
      <description><![CDATA[${"很长的正文。".repeat(60)}]]></description>
      <link>https://linux.do/t/topic/3086461</link>
      <pubDate>Tue, 27 Oct 2026 22:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const step = (message) => {
  throw new Error(message);
};

test("parseFeed：字段、实体、HTML 清洗、话题 id、置顶与排序", () => {
  const items = parseFeed(FIXTURE);
  assert.equal(items.length, 3);

  const [first, second, third] = items;
  assert.equal(first.id, "3086463");
  assert.equal(first.title, "有懂的佬吗 & 二手 iPhone 的 MDM 能不能绕过");
  assert.equal(first.category, "开发调优");
  assert.equal(first.creator, "buddy");
  assert.equal(first.url, "https://linux.do/t/topic/3086463");
  assert.equal(first.meta, "2 个帖子 · 2 位参与者");
  assert.equal(first.createdAt, "2026-10-28T08:01:00.000Z");
  assert.equal(first.pinned, false);
  assert.ok(first.excerpt.startsWith("买了一台二手 iPhone 12"), first.excerpt);
  assert.ok(!/[<>]/.test(first.excerpt), "摘��里不该有 HTML 标签");

  assert.equal(second.id, "3086462", "/t/<slug>/<id> 也要能取到 id");
  assert.equal(second.category, "");
  assert.equal(second.pinned, true);

  assert.equal(third.id, "3086461");
  assert.ok(third.excerpt.length <= 201, "摘要应被裁剪");
  assert.ok(third.excerpt.endsWith("…"), third.excerpt);
  assert.equal(third.title, "长标题 <script> alert(1) </script>", "实体解码后是纯文本，由客户端用 textContent 渲染");

  const times = items.map((item) => item.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a)), "按发布时间倒序");
});

test("parseFeed：CF 挑战页 / 非 RSS 内容给出可读报错", () => {
  assert.throws(() => parseFeed("<html><title>Just a moment...</title></html>"), /不是 RSS（Cloudflare 拦截页）/);
  assert.throws(() => parseFeed(""), /不是 RSS/);
});

test("decodeEntities / stripHtml / clip / topicIdFromLink 的边界", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#39; &#x4e2d;"), "a & b <c> 'd' 中");
  assert.equal(decodeEntities("&unknown;"), "&unknown;", "未知实体原样保留");
  assert.equal(stripHtml("<p>一</p><p>二</p>"), "一\n二");
  assert.equal(stripHtml("<p>a<br>b</p>"), "a\nb");
  assert.equal(clip("短句"), "短句");
  assert.equal(clip("甲。乙丙丁", 2), "甲。…");
  assert.equal(topicIdFromLink("https://linux.do/t/topic/123?u=x"), "123");
  assert.equal(topicIdFromLink("https://linux.do/c/develop/4"), "");
});

test("categoryCounts / filterByCategories：空选择=不限，按中文排序稳定", () => {
  const items = parseFeed(FIXTURE);
  assert.deepEqual(categoryCounts(items), [
    { name: "搞七捻三", count: 1 },
    { name: "开发调优", count: 1 },
  ]);
  assert.equal(filterByCategories(items, []).length, 3);
  assert.equal(filterByCategories(items, undefined).length, 3);
  assert.deepEqual(
    filterByCategories(items, ["搞七捻三"]).map((item) => item.id),
    ["3086461"],
  );
  assert.equal(filterByCategories(items, ["不存在的版块"]).length, 0);
});

test("pickPost：只看选中分类、跳过已见、不重复；池子抽干返回 null", () => {
  const items = parseFeed(FIXTURE);
  const picked = pickPost(items, { categories: ["开发调优"], random: () => 0.99 });
  assert.equal(picked.id, "3086463");

  const again = pickPost(items, { categories: ["开发调优"], seen: ["3086463"], random });
  assert.equal(again, null, "唯一一条看过了就不再推");

  const first = pickPost(items, { seen: [], random: () => 0 });
  assert.equal(first.id, "3086463");
  const second = pickPost(items, { seen: [first.id], random: () => 0 });
  assert.equal(second.id, "3086462", "跳过已见后按剩余顺序取");

  const bounded = pickPost(items, { seen: [], random: () => 5 });
  assert.equal(bounded.id, "3086461", "random 越界时夹到最后一个");

  function random() {
    return 0;
  }
});

test("mergeSeen：去重保序、超上限丢最旧", () => {
  assert.deepEqual(mergeSeen(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(mergeSeen([], ["1", "2", "3"], 2), ["2", "3"]);
  assert.deepEqual(mergeSeen(undefined, undefined), []);
});

test("isAllowedOpenUrl：只放行 linux.do 的 https 链接", () => {
  assert.equal(isAllowedOpenUrl("https://linux.do/t/topic/1"), true);
  assert.equal(isAllowedOpenUrl("https://www.linux.do/t/topic/1"), true);
  assert.equal(isAllowedOpenUrl("http://linux.do/t/topic/1"), false, "只允许 https");
  assert.equal(isAllowedOpenUrl("https://linux.do.evil.com/t/1"), false);
  assert.equal(isAllowedOpenUrl("https://evil.com/?u=https://linux.do/"), false);
  assert.equal(isAllowedOpenUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedOpenUrl(""), false);
});

test("loadFeed：TTL 内吃缓存、force 穿透、失败退避并把旧条目留住", async () => {
  __testing.resetCacheForTest();
  const base = Date.now();
  let calls = 0;
  const okRun = async () => {
    calls += 1;
    return FIXTURE;
  };

  const first = await loadFeed({ now: base, run: okRun });
  assert.equal(calls, 1);
  assert.equal(first.items.length, 3);
  assert.equal(first.error, "");

  await loadFeed({ now: base + CACHE_TTL - 1, run: okRun });
  assert.equal(calls, 1, "TTL 内不该再打 CF");

  await loadFeed({ now: base + CACHE_TTL + 1, run: okRun });
  assert.equal(calls, 2, "过了 TTL 才刷新");

  await loadFeed({ force: true, now: base + CACHE_TTL + 2, run: okRun });
  assert.equal(calls, 3, "force 忽略 TTL");

  const fail = async () => {
    calls += 1;
    throw new Error("curl 失败：HTTP 429");
  };
  const failed = await loadFeed({ force: true, run: fail });
  assert.equal(failed.items.length, 3, "失败时保留上一次的条目");
  assert.match(failed.error, /429/);

  const before = calls;
  await loadFeed({ now: Date.now() + 1000, run: okRun });
  assert.equal(calls, before, "失败后 10 分钟退避期内不再请求");
  assert.ok(Date.parse((await loadFeed({ now: Date.now(), run: okRun })).nextAttemptAt) > 0);

  const retried = await loadFeed({ now: Date.now() + FAIL_BACKOFF + 1, run: okRun });
  assert.equal(calls, before + 1, "退避期过了会重试");
  assert.equal(retried.error, "");
  __testing.resetCacheForTest();
});

test("loadFeed：并发请求单飞，不重复抓取", async () => {
  __testing.resetCacheForTest();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = async () => {
    calls += 1;
    await gate;
    return FIXTURE;
  };
  const both = Promise.all([loadFeed({ force: true, run }), loadFeed({ force: true, run })]);
  release();
  const [a, b] = await both;
  assert.equal(calls, 1, "同一时刻只打一次 CF");
  assert.equal(a.items.length, b.items.length);
  __testing.resetCacheForTest();
});
