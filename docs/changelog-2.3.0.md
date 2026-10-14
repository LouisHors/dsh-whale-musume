## v2.3.0 (2026-10-14)

### 新增

- **工作中台词两档：话痨 / 安静**（[#24](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/24)）：工作态（思考 / 工具 / 成功 / 出错）台词此前每跳一次状态就弹一句，十几分钟的长任务能刷几十条。现在四种状态共用随机冷却窗口——**话痨 15–40 秒**、**安静 90–240 秒**，窗口之内只说一句；`thinking` / `tool` 台词按当前任务话题取词（复用主动闲聊的本地分类），`success` / `failure` 保留各自语料。切档立即生效，空闲问候与天气不受影响，默认话痨。设置入口：**DSH 设置 → 看板娘 → 陪伴表现 → 工作中台词**。

### 修复

- **右键菜单贴底被窗口边缘裁掉**（[#23](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/23)）：菜单高度此前写死 `innerHeight - 160`，而真实高度是 268px（开小游戏 8 项）/ 204px（关小游戏 6 项），贴右下角右键最多被裁掉 108px。现在挂载后量真实尺寸，下方放不下就翻到光标上方，最后统一钳进视口 8px 边距；量不到尺寸时按最坏的 268px 保守处理。

### 社区

- **合并 PR [#25](https://github.com/Sutera-Diffusus/dsh-whale-musume/pull/25)**（[@KS001-A3](https://github.com/KS001-A3)）：四处列表渲染补稳定 key（消除切换设置页签时的 React key 警告）；摸头成长改用累计计数 `addUsageStat("pat")`（修复「十连 / 百连」成就永不触发，键盘路径同样累计并补发任务信号）；`registerSettings` 兼容只以 ctx 属性暴露 slots 的宿主。

### 文档

- README 中英文新增**安装失败排查**章节（[#21](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/21) / [#22](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/22) / [#26](https://github.com/Sutera-Diffusus/dsh-whale-musume/issues/26)）：registry 与镜像、`git ls-remote` 网络自查（DSH 预检默认 5s 超时）、`allowBuilds` 提示为何对本插件是误报、Release 资产本地安装步骤、如何确认装上了、版本没更新时先卸载再装。

### 测试

- 单元 **143 → 158 全绿**：新增 `test/menu-placement.test.mjs`（7 项：贴底翻转、6/8 项高度不越界、极小视口钳制、量不到尺寸回落、源码不再写死常量）与 `test/work-speech.test.mjs`（8 项：两档窗口区间、四态共用冷却、切档立即生效、非法值回落话痨、话题取词、成功 / 出错保留语料、总开关优先、render 三处闸门防漏）。
