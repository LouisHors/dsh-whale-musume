# v2.5.0 · 翻翻乐 + 跨端迁移

发布时间：2026-10-21 · [完整改动](https://github.com/Sutera-Diffusus/dsh-whale-musume/compare/v2.4.0...v2.5.0)

---

## 这个版本做了什么

v2.4.0 只是把安装门禁和 DSH `0.2.1-rc.2` 对齐，没有新功能。这次补上两件一直有人问的事：**再给一个能玩的东西**，以及**换设备时别把养成数据弄丢**。

### 1. 第三个小游戏「鲸鱼翻翻乐」

| 项目 | 规则 |
|---|---|
| 棋盘 | 4×4，16 张牌，8 对 |
| 牌面 | 复用现有 16 个姿势：咖啡、吃饭、伸懒腰、睡衣、洗澡、做饭、钓鱼、打游戏、画画、野餐、墨镜、得意、听歌、kyun、比心、wink —— **没有新增立绘** |
| 时长 | 60 秒；配对 8 对立即通关，5 对及以上及格 |
| 计分 | 配对 +100；连续配对第 1/2/3/4 次额外 +20/+40/+60/+80（封顶 +80）；翻错 −10 且断连击；通关按剩余秒数 ×5 加时间奖励 |
| 操作 | 鼠标点牌；键盘方向键移动高亮、Enter / Space 翻牌、Escape 关闭 |
| 互斥 | 与戳泡泡、接点心互斥；开新局先关旧局，任何时刻最多一个游戏面板 |
| 奖励 | 与另外两个游戏共享每日 3 局养成奖励上限；首玩 / 通关 / 零失误 / 六连各一个成就 |

入口：**右键 → 小游戏：鲸鱼翻翻乐**。翻回等待期（900ms）内点第三张会被忽略，不会把已翻开的两张冲掉；页面隐藏时暂停，回来继续。

### 2. 养成数据跨端迁移

桌面端的主窗口 origin 是 `dsh-app://app`，旧版 Web 是 `http://127.0.0.1:<端口>`。两边 `localStorage` 不互通，所以换端之后等级、好感度、成就都会从零开始。现在设置面板多了「跨端迁移」：

- **导出存档**：下载 JSON，包含心情 / 好感度 / 饱食度 / 等级 / 签到 / 成就 / 任务 / 游戏记录 / 成长日记 / 称呼。
- **复制迁移码**：只带核心进度（数值 / 成就 / 日记 / 称呼），格式 `WM1-<8 位校验>-<base64url>`，适合粘贴到聊天窗口。
- **导入**：选 JSON 或粘贴迁移码，确认后覆盖同名数据；桌宠立即重读，不需要刷新页面。
- **不迁移**：悬浮位置、天气城市、天气经纬度 —— 这些是设备相关数据，带过去只会添乱。
- 坏码不会改存档：校验和不对、JSON 结构不对、版本比当前新、没有可识别字段，都会在面板里给出具体错误并原样保留现有数据。

### 3. 成就 39 → 45

新增 6 项：翻翻乐首玩 / 通关 / 零失误 / 六连，以及「百日之约」（陪伴 100 天）、「一年之约」（陪伴 365 天）。

---

## 验证

- `npm test`（`node --test test/*test.mjs`）**203/203 通过**，新增 40 项：
  - 翻翻乐纯逻辑 14 项（发牌唯一性、配对/翻错、翻回计时、超时、结算、成就）；
  - 迁移存档 11 项（字段过滤、数值钳制、坏 JSON、未来版本、迁移码往返与篡改）；
  - 零浏览器 UI 9 项：用 `tools/dom-stub.mjs` 真执行注入的 core + presenter，走真实右键菜单开第三游戏、点牌配对、通关 8 对、写成就、键盘翻牌、Escape 关闭；设置面板粘贴迁移码导入与坏码拒绝；
  - 接线自检 6 项（成就总数、面池立绘存在、presenter/client/CSS 接线、版本号）。
- **没有**在真实 Electron 桌面端或浏览器里做视觉验收。翻翻乐面板的布局与动效是按现有游戏面板的 token/结构写的，但最终观感需要你亲眼看一下；如果你愿意，我可以再按资源纪律申请一次单实例浏览器截图验收。

---

## 升级

```powershell
# 桌面端：先 remove 再 add（add 不覆盖已安装版本）
$env:ELECTRON_RUN_AS_NODE = "1"
& "$Desktop\DeepSeek Harness.exe" --expose-internals $Cli plugin --profile desktop remove dsh-whale-musume
& "$Desktop\DeepSeek Harness.exe" --expose-internals $Cli plugin --profile desktop add github:Sutera-Diffusus/dsh-whale-musume
```

装完**重启桌面端应用**（不是刷新页面）。养成数据仍在宿主 origin 的 `localStorage` 里，重装不丢；要换端就用「跨端迁移」。

也可以直接用本页资产 `dsh-whale-musume-plugin-v2.5.0.zip` 按本地路径安装。

## 兼容性

`engines.dsh` 与 v2.4.0 完全一致，没有放宽也没有收紧：

```text
>=0.1.0-rc.6 <0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2
```

旧版 Web（`0.1.0-rc.6` 起）与已实测的桌面端 `0.2.0-rc.2` 继续放行；`0.2.1-rc.1` / `0.2.1-rc.2` 仍是静态契约 + 单测级别的 `compatible`。

## English

v2.5.0 adds two features on top of the v2.4.0 compatibility release:

- **Whale Memory**, a third mini-game: 4×4 / 8 pairs / 60 seconds, reusing 16 existing artworks. Match +100, combo bonuses up to +80, mismatch −10 and breaks the combo, clear bonus 5 × seconds left. Mouse and keyboard (arrows / Enter / Escape). Mutually exclusive with the other two games; shares the three daily reward-bearing rounds.
- **Cross-device migration** in Settings → Mascot: export a JSON save, copy a `WM1-…` migration code (core progress only), or import either. It carries mood / affection / satiety / level / sign-in / achievements / quests / game records / journal / names, and deliberately excludes the floating position and weather coordinates. Import reloads the mascot in place (no page refresh); a bad or truncated code fails with a specific error and leaves the existing save untouched.
- Six new achievements (four memory, plus 100-day and 365-day companionship), 45 total.

`npm test`: **203/203**. No live Electron or browser visual acceptance was performed in this release; the panel follows the existing game-panel tokens and structure, but the final look should be eyeballed once.

MIT, local-first, no telemetry. The migration file never leaves your machine.
