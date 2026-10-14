# v2.3.0 · 工作中台词两档 + 右键菜单不再被裁

发布时间：2026-10-14 · [完整改动](https://github.com/Sutera-Diffusus/dsh-whale-musume/compare/v2.2.1...v2.3.0)

---

## 这个版本做了什么

### 1. 工作中台词改两档：话痨 / 安静（社区需求 [#24](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/24)）

长任务里她此前**每跳一次状态就弹一句**——十几分钟下来几十条，而且内容全来自固定语料，和正在做的事无关。

现在 `thinking / tool / success / failure` 四种工作态共用一个随机冷却窗口，窗口之内只说一句：

| 档位 | 工作态冷却窗口 | 观感 |
|---|---|---|
| **话痨**（默认） | 15–40 秒 | 比原来安静很多，但仍然活泼 |
| **安静** | 90–240 秒 | 长任务里基本只在关键节点出声 |

- **话题取词**：`thinking` / `tool` 台词按当前任务话题取（复用主动闲聊的本地分类：deploy / bug / data / code / write / research），`general` 时回落原语料。
- **成功 / 出错保留各自语料** —— 这两句带信息量，不该被话题化掉。
- **切档立即生效**，从「安静」切回「话痨」不会干等旧窗口。
- **空闲时的问候 / 天气 / 闲聊完全不受影响**；「台词气泡」总开关优先级不变（关掉一句都不说）。
- 入口：**DSH 设置 → 看板娘 → 陪伴表现 → 工作中台词**（bundle 与 dist 补丁两条面板路径同源）。

### 2. 右键菜单贴底不再被窗口边缘裁掉（社区报告 [#23](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/23)）

菜单高度此前写死 `innerHeight - 160`，而真实高度是 **268px**（开小游戏 8 项）/ **204px**（关小游戏 6 项）—— 贴右下角右键时底部最多被裁掉 108px，「回到原位」「打开看板娘设置」「关闭菜单」三项直接不可见。

修法：菜单先挂载，用 `getBoundingClientRect()` **量真实尺寸**；下方放不下就翻到光标上方；上方也不够就底部对齐视口；最后统一钳进 8px 边距。不再用任何新常量去猜高度。

### 3. 合并社区 PR [#25](https://github.com/Sutera-Diffusus/dsh-whale-musume/pull/25)（[@KS001-A3](https://github.com/KS001-A3)）

- 四处列表渲染补稳定 `key` —— 切换设置页签不再刷 React key 警告
- 摸头成长改用**累计计数** —— 修复「十连 / 百连」成就永不触发；键盘路径同样累计并补发任务信号
- `registerSettings` 兼容只以 ctx 属性暴露 `slots` 的宿主

### 4. 安装失败排查写进 README

针对插件市场安装失败的反馈（[#21](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/21) / [#22](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/22) / [#26](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/26)）：registry 与镜像、`git ls-remote` 网络自查、**那句 `allowBuilds` 提示为什么对本插件是误报**、Release 资产本地安装步骤、怎么确认装上了、版本没更新时先卸载再装。

---

## 升级

```powershell
# 桌面端（$Desktop / $Cli 见 docs/desktop-0.2.0-rc.2-deploy.md）
$env:ELECTRON_RUN_AS_NODE = "1"
& "$Desktop\DeepSeek Harness.exe" --expose-internals $Cli plugin --profile desktop remove dsh-whale-musume
& "$Desktop\DeepSeek Harness.exe" --expose-internals $Cli plugin --profile desktop add github:Sutera-Diffusus/dsh-whale-musume
```

`add` 对已安装实例不覆盖版本，所以**先 `remove` 再 `add`**；装完**重启桌面端应用**（不是刷新页面）。养成数据（`whale-moe:*`）在宿主 origin 的 `localStorage` 里，重装后还在。

也可以直接用本页资产 `dsh-whale-musume-plugin-v2.3.0.zip` 按本地路径安装（不碰 registry、不做 git 预检）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$Desktop\DeepSeek Harness.exe" --expose-internals $Cli plugin --profile desktop add "<解压路径>\dsh-whale-musume"
```

## 验证

- 单元测试 **158/158 通过**（`npm test`，`node --test`，无需浏览器与服务器）
- 新增回归测试 15 项：菜单定位 7 项 + 工作态台词 8 项
- 打包自检：zip 顶层单一目录、含 `package.json` / `cordis.patch.yml` / `lib/client.js`，不泄漏 `test|tools|docs|.github|scripts`
