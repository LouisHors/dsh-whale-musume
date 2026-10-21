/**
 * v2.5.0「跨端迁移」设置面板端到端验收（零浏览器）：
 * 真物化 MascotPortableCard → 粘贴迁移码 → 点导入 → 断言 localStorage 与广播事件。
 * 迁移码/校验逻辑由 core 单测覆盖，这里只验证 UI 到落盘这一层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  createClientHostHarness,
  createSlotsService,
  readRepoFile,
  renderElementTree,
} from "../tools/dom-stub.mjs";
import { loadCore } from "./load-core.mjs";

const CLIENT_SOURCE = readRepoFile("lib/client.js");
const SECTION_SLOT = "settings.section";
const HOST_DECLARED_SLOTS = { [SECTION_SLOT]: { kind: "list", scope: "root" } };
const core = loadCore();
const NOW = Date.now();

function stringsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((item) => stringsOf(item, out)); return out; }
  if (typeof node === "object" && node.props) stringsOf(node.props.children, out);
  return out;
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findNode(item, predicate); if (hit) return hit; }
    return null;
  }
  if (predicate(node)) return node;
  return findNode(node.props ? node.props.children : null, predicate);
}

async function bootSettings() {
  const env = createClientHostHarness({ declaredSlots: HOST_DECLARED_SLOTS });
  env.loadBundle(CLIENT_SOURCE);
  env.materialize("dsh-whale-musume");
  env.apply("dsh-whale-musume");
  await env.idle();
  const scripts = env.scripts();
  assert.equal(scripts.length, 2);
  vm.runInContext(scripts[0].textContent, env.context);
  await env.idle();
  assert.ok(env.sandbox.DshWhaleMoeCore, "core 必须挂到 window.DshWhaleMoeCore，迁移面板才能用");
  const section = env.slots.entries().find((entry) => entry.name === SECTION_SLOT);
  assert.ok(section, "settings.section 未注册");
  return { env, Component: section.component };
}

function renderPanel(env, Component) {
  return renderElementTree(env.reactSeed.jsxRuntime.jsx(Component, {}), env.reactSeed);
}

function pasteCodeInput(tree) {
  return findNode(tree, (node) => node.type === "textarea" && node.props["aria-label"] === "粘贴迁移码");
}

function importButton(tree) {
  return findNode(tree, (node) => node.type === "button" && stringsOf(node.props.children).join("") === "导入迁移码");
}

test("设置面板粘贴迁移码并导入：等级/好感/成就写入 localStorage，并广播 save-import", async () => {
  const { env, Component } = await bootSettings();
  const payload = core.portableBuild({
    level: "6",
    affinity: "2600",
    mood: "88",
    achievements: "first-pat,thanks",
    companionSince: String(NOW - 12 * 86400000),
    journal: JSON.stringify([{ at: NOW, kind: "achievement", text: "解锁成就：初次摸头" }])
  }, { appVersion: "2.5.0" }, NOW);
  const code = core.portableCode(payload);

  let tree = renderPanel(env, Component);
  const input = pasteCodeInput(tree);
  assert.ok(input, "缺少粘贴迁移码的 textarea");
  input.props.onChange({ target: { value: code } });

  const events = [];
  env.sandbox.addEventListener("whale-moe-prefs-change", (event) => events.push(event.detail && event.detail.key));

  tree = renderPanel(env, Component);
  const button = importButton(tree);
  assert.ok(button, "缺少「导入迁移码」按钮");
  button.props.onClick();

  assert.equal(env.localStorage.getItem("whale-moe:level"), "6");
  assert.equal(env.localStorage.getItem("whale-moe:affinity"), "2600");
  assert.equal(env.localStorage.getItem("whale-moe:achievements"), "first-pat,thanks");
  assert.ok(env.localStorage.getItem("whale-moe:journal").includes("初次摸头"));
  assert.deepEqual(events, ["save-import"], "导入后必须广播 save-import 让桌宠热重载");
});

test("设置面板粘贴坏迁移码：报错且不覆盖现有数据", async () => {
  const { env, Component } = await bootSettings();
  env.localStorage.setItem("whale-moe:level", "3");
  let tree = renderPanel(env, Component);
  const input = pasteCodeInput(tree);
  input.props.onChange({ target: { value: "WM1-deadbeef-not-a-real-payload" } });

  tree = renderPanel(env, Component);
  const button = importButton(tree);
  assert.ok(button);
  button.props.onClick();

  assert.equal(env.localStorage.getItem("whale-moe:level"), "3", "坏迁移码不得改动现有存档");
  tree = renderPanel(env, Component);
  const status = findNode(tree, (node) => node.type === "div" && stringsOf(node.props.children).join("").includes("校验失败"));
  assert.ok(status, "应显示校验失败提示");
});

test("导出按钮在无 Blob 环境里给出明确失败提示，不抛未捕获错误", async () => {
  const { env, Component } = await bootSettings();
  let tree = renderPanel(env, Component);
  const exportButton = findNode(tree, (node) => node.type === "button" && stringsOf(node.props.children).join("") === "导出存档");
  assert.ok(exportButton, "缺少导出按钮");
  assert.doesNotThrow(() => exportButton.props.onClick());
  tree = renderPanel(env, Component);
  const status = findNode(tree, (node) => node.type === "div" && stringsOf(node.props.children).join("").includes("导出失败"));
  assert.ok(status, "无 Blob 环境应显示导出失败提示");
  assert.equal(env.errors().length, 0);
});
