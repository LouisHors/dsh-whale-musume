/**
 * v2.5.0「鲸鱼翻翻乐」零浏览器 UI 验收：
 * 用 tools/dom-stub.mjs 真执行注入的 core + presenter（不是读源码猜），
 * 再走真实右键菜单 → 第三个小游戏 → 翻牌 → 通关 → 成就落盘。
 * 不启动浏览器、不起服务器、不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  createClientHostHarness,
  readRepoFile,
} from "../tools/dom-stub.mjs";

const CLIENT_SOURCE = readRepoFile("lib/client.js");
const SECTION_SLOT = "settings.section";
const HOST_DECLARED_SLOTS = { [SECTION_SLOT]: { kind: "list", scope: "root" } };

function click(node) {
  node.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
}

async function bootPresenter() {
  const env = createClientHostHarness({ declaredSlots: HOST_DECLARED_SLOTS });
  env.loadBundle(CLIENT_SOURCE);
  env.materialize("dsh-whale-musume");
  env.apply("dsh-whale-musume");
  await env.idle();
  const scripts = env.scripts();
  assert.equal(scripts.length, 2, "客户端应注入 core + presenter 两段脚本");
  vm.runInContext(scripts[0].textContent, env.context);
  vm.runInContext(scripts[1].textContent, env.context);
  await env.idle();
  env.runTimers(4);
  await env.idle();
  assert.equal(env.errors().length, 0, "presenter 启动不应报错：" + JSON.stringify(env.errors()));
  assert.equal(env.document.querySelectorAll("[data-dsh-whale-root]").length, 1);
  return env;
}

function openMenu(env) {
  const frame = env.document.querySelector("[data-dsh-whale-frame]");
  assert.ok(frame, "桌宠 frame 必须存在");
  frame.dispatchEvent({ type: "contextmenu", clientX: 520, clientY: 420, preventDefault() {}, stopPropagation() {} });
  const menu = env.document.querySelector("[data-dsh-whale-context]");
  assert.ok(menu, "右键菜单必须出现");
  return [...menu.children];
}

function openMemory(env) {
  const items = openMenu(env);
  const labels = items.map((item) => String(item.textContent));
  assert.ok(labels.includes("小游戏：鲸鱼翻翻乐"), "菜单缺少第三个游戏入口：" + labels.join(" / "));
  click(items.find((item) => String(item.textContent) === "小游戏：鲸鱼翻翻乐"));
  const panel = env.document.querySelector("[data-dsh-whale-memory]");
  assert.ok(panel, "点击后翻翻乐面板必须出现");
  return panel;
}

function cards(panel) {
  return [...panel.querySelectorAll("[data-dsh-whale-memory-card]")];
}

test("从右键菜单打开翻翻乐：16 张牌、60 秒、0/8 配对", async () => {
  const env = await bootPresenter();
  const panel = openMemory(env);
  assert.equal(cards(panel).length, 16);
  assert.equal(panel.querySelector("[data-dsh-whale-memory-time]").textContent, "60s");
  assert.equal(panel.querySelector("[data-dsh-whale-memory-pairs]").textContent, "配对 0/8");
  assert.equal(panel.querySelector("[data-dsh-whale-memory-score]").textContent, "得分 0");
  assert.equal(panel.querySelector("[data-dsh-whale-memory-moves]").textContent, "步数 0");
  assert.equal(env.sandbox.__dshWhaleMoeMemoryState().cards.length, 16);
});

test("翻开第一张：加载对应立绘；配对成功加 120 分并刷新计数", async () => {
  const env = await bootPresenter();
  const panel = openMemory(env);
  const state = env.sandbox.__dshWhaleMoeMemoryState();
  const face = state.cards[0].face;
  const pair = state.cards.map((card, index) => ({ card, index })).filter((entry) => entry.card.face === face).map((entry) => entry.index);
  assert.equal(pair.length, 2);

  const all = cards(panel);
  click(all[pair[0]]);
  assert.equal(all[pair[0]].classList.contains("dsh-whale-memory-flipped"), true);
  const img = all[pair[0]].querySelector("[data-dsh-whale-memory-face]");
  assert.ok(img.src.includes("dsh-whale-state-" + face + ".webp"), "翻开的牌应加载对应立绘：" + img.src);

  click(all[pair[1]]);
  assert.equal(all[pair[0]].classList.contains("dsh-whale-memory-matched"), true);
  assert.equal(all[pair[1]].classList.contains("dsh-whale-memory-matched"), true);
  assert.equal(panel.querySelector("[data-dsh-whale-memory-score]").textContent, "得分 120");
  assert.equal(panel.querySelector("[data-dsh-whale-memory-pairs]").textContent, "配对 1/8");
  assert.equal(panel.querySelector("[data-dsh-whale-memory-moves]").textContent, "步数 1");
});

test("通关 8 对：结算层、零失误判定、成就与游戏记录写入 localStorage", async () => {
  const env = await bootPresenter();
  const panel = openMemory(env);
  const state = env.sandbox.__dshWhaleMoeMemoryState();
  const faces = [...new Set(state.cards.map((card) => card.face))];
  const all = cards(panel);
  for (const face of faces) {
    const pair = state.cards.map((card, index) => ({ card, index })).filter((entry) => entry.card.face === face).map((entry) => entry.index);
    click(all[pair[0]]);
    click(all[pair[1]]);
  }
  const overlay = panel.querySelector("[data-dsh-whale-memory-overlay]");
  assert.ok(overlay, "通关后必须出现结算层");
  assert.match(overlay.textContent, /全部配对/);
  assert.match(overlay.textContent, /零失误/);

  const stats = JSON.parse(env.localStorage.getItem("whale-moe:gameStats"));
  assert.equal(stats.memory.plays, 1);
  assert.equal(stats.memory.wins, 1);
  assert.equal(stats.memory.perfect, 1);
  assert.ok(stats.memory.best > 0);
  assert.equal(stats.plays, 1, "翻翻乐应计入共享的小游戏局数");
  assert.equal(stats.playsToday, 1);

  const achievements = (env.localStorage.getItem("whale-moe:achievements") || "").split(",");
  for (const id of ["memory-first", "memory-clear", "memory-perfect", "memory-combo6"]) {
    assert.ok(achievements.includes(id), "缺少成就 " + id + "，实际：" + achievements.join(","));
  }
  assert.equal(env.sandbox.__dshWhaleMoeMemoryState().status, "ended");
  assert.equal(env.errors().length, 0);
});

test("键盘：方向键移动高亮、Enter 翻牌、Escape 关闭", async () => {
  const env = await bootPresenter();
  const panel = openMemory(env);
  const all = cards(panel);
  panel.dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {}, stopPropagation() {} });
  assert.equal(all[1].classList.contains("dsh-whale-cursor"), true, "方向键应把高亮移到第 2 张");
  panel.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {}, stopPropagation() {} });
  assert.equal(all[1].classList.contains("dsh-whale-memory-flipped"), true, "Enter 应翻开当前高亮的牌");
  panel.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(env.document.querySelector("[data-dsh-whale-memory]"), null, "Escape 应关闭面板");
  assert.equal(env.errors().length, 0);
});

test("从翻翻乐切回戳泡泡：旧面板同样被关掉", async () => {
  const env = await bootPresenter();
  openMemory(env);
  const items = openMenu(env);
  click(items.find((item) => String(item.textContent) === "小游戏：戳泡泡"));
  assert.equal(env.document.querySelector("[data-dsh-whale-memory]"), null, "翻翻乐面板应被关闭");
  assert.ok(env.document.querySelector("[data-dsh-whale-game]"), "戳泡泡面板应已打开");
  assert.equal(env.errors().length, 0);
});

test("打开翻翻乐会关掉正在开的戳泡泡，面板不叠加", async () => {
  const env = await bootPresenter();
  const items = openMenu(env);
  click(items.find((item) => String(item.textContent) === "小游戏：戳泡泡"));
  assert.ok(env.document.querySelector("[data-dsh-whale-game]"), "戳泡泡面板应已打开");
  const items2 = openMenu(env);
  click(items2.find((item) => String(item.textContent) === "小游戏：鲸鱼翻翻乐"));
  assert.equal(env.document.querySelector("[data-dsh-whale-game]"), null, "戳泡泡面板应被关闭");
  assert.ok(env.document.querySelector("[data-dsh-whale-memory]"), "翻翻乐面板应已打开");
  assert.equal(env.document.querySelectorAll("[data-dsh-whale-memory]").length, 1);
});
