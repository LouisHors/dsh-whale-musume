# v2.4.0 · 适配 DeepSeek Harness 0.2.1-rc.2

发布时间：2026-10-19 · [完整改动](https://github.com/Sutera-Diffusus/dsh-whale-musume/compare/v2.3.0...v2.4.0)

---

## 这个版本做了什么

上游 DeepSeek Harness 从桌面端 `0.2.0-rc.2` 走到了 `0.2.1-rc.2`（2026-10-17 发布）。对照 tag `dsh-v0.2.1-rc.2` 的源码之后：

- **鲸鱼娘用到的 DOM 标记都还在**：`[data-tool]` + `data-state`（`preparing` / `running` / `ok` / `error` / `stopped`）、`[data-chat-running]`、`[data-terminal]`、`[data-composer-input]`、`[data-shortcut-modal="settings"]`、`body[data-ds-dark-theme]`、`settings.section`。表现层选择器没有增删。
- **安装门禁变了。** 从 `0.2.1-alpha.4` 起，第三方插件优先按顶层 `engines.dsh` 判断；没声明才回落到 `@deepseek-ai/dsh*` 的 peer。鲸鱼娘没有这些 peer，所以这次补上了范围，否则 0.2.1 会把「没写」理解成「任何版本都能装」。
- **新 slot 看过、没用。** `conversation.input.model.label` 是输入框模型名的扩展位，本插件不注册。输入区 `stats` 拆成 `activity` / `usage`、移除 `./invariant`，也都碰不到鲸鱼娘。
- **桌面端端口不再是写死的 `19387`。** 0.2.1 的 desktop host 用 `--port 0`，由系统分配。插件不读这个端口。

### 兼容性声明

| 宿主 | 2.4.0 的态度 |
|---|---|
| 旧版 Web `0.1.0-rc.6` 起的 `0.1.x` | 继续放行。矩阵里 `0.1.1-rc.2`、`0.1.2-rc.1` 仍是 `compatible`，两个 alpha 仍是 `unknown` |
| 桌面端 `0.2.0-rc.2` | `compatible`。这是隔离 profile 上实机验收过的版本 |
| `0.2.1-rc.1`、`0.2.1-rc.2` | `compatible`，依据是静态契约 + `npm test`。**没有**在真实 Electron 里复跑 |
| `0.2.0-rc.1`、`0.2.1-alpha.*`、`0.2.1` 正式版及更新的线 | `engines.dsh` 拒绝安装 |

`engines.dsh`：

```text
>=0.1.0-rc.6 <0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2
```

本地优先、无遥测、只读资源路由这些约束没有改。

装完请**重启桌面端**（或至少刷新页面）。热重载能换掉的插件会立刻生效；鲸鱼娘的桌宠脚本每个页面只引导一次，不刷新就还是旧的。

差分说明：[`docs/desktop-0.2.1-rc.2-contract.md`](desktop-0.2.1-rc.2-contract.md)、[`docs/desktop-0.2.1-rc.2-deploy.md`](desktop-0.2.1-rc.2-deploy.md)。0.2.0-rc.2 的安装命令仍见 [`docs/desktop-0.2.0-rc.2-deploy.md`](desktop-0.2.0-rc.2-deploy.md)，但不要把 `19387` 当成 0.2.1 的端口。

## 验证

- `npm test`（`node --test test/*test.mjs`）**163/163 通过**
- **没有**在 DeepSeek Harness Desktop 0.2.1-rc.2 里做安装验收

## English

v2.4.0 targets DeepSeek Harness **0.2.1-rc.2** (tagged 2026-10-17) while keeping the previously declared hosts.

The DOM markers this plugin reads are still present on that tag (`data-tool` + `data-state`, `data-chat-running`, `data-terminal`, `data-composer-input`, `data-shortcut-modal="settings"`, `body[data-ds-dark-theme]`, `settings.section`). No selector was added or removed. The new `conversation.input.model.label` slot is unused.

What did change for plugin authors is the install gate. Since 0.2.1-alpha.4, DSH prefers top-level `engines.dsh` and ignores DSH `peerDependencies` when that field is set. This package has no DSH peers, so leaving `engines.dsh` unset would allow every runtime. The declared range is:

```text
>=0.1.0-rc.6 <0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2
```

`0.2.0-rc.2` remains the desktop build that was installed and checked on an isolated profile. `0.2.1-rc.1` and `0.2.1-rc.2` are marked compatible from a static reading of tag `dsh-v0.2.1-rc.2` plus unit tests. **This release was not exercised inside the Electron desktop app.** Desktop 0.2.1 also binds the GUI with `--port 0` instead of a fixed `19387`; the pet does not use that port.

Restart the desktop app after installing. The mascot boots once per page, so a hot reload does not swap its presenter.

`npm test`: 163/163. Not run inside the Electron app.

MIT, local-first, no telemetry.
