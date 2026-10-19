# DSH 0.2.1-rc.2 契约差分（鲸鱼娘）

> 对照区间：`dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.2`（[compare](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.0-rc.2...dsh-v0.2.1-rc.2)）
> 审计对象：tag `dsh-v0.2.1-rc.2`（commit `687f282e8625c6b8d11ff58211a90524be2e4317`，发布于 2026-10-17）
> 审计方式：**只读上游源码**。没有安装、没有启动 DeepSeek Harness Desktop，也没有对 0.2.1 跑 CDP。
> 0.2.0-rc.2 的逐条实测仍以 [`desktop-0.2.0-rc.2-contract.md`](desktop-0.2.0-rc.2-contract.md) 与 [`desktop-0.2.0-rc.2-acceptance.md`](desktop-0.2.0-rc.2-acceptance.md) 为准，本文不改写那份验收。

## 0. 结论

鲸鱼娘在 0.2.1-rc.2 上**不需要改 DOM 选择器、slot 注册或资源路由**。需要改的是安装期版本声明：补上顶层 `engines.dsh`，并在 `dsh.compatibility.dshReleases` 里把 `0.2.1-rc.1` / `0.2.1-rc.2` 标为 `compatible`（静态契约意义，不是实机验收）。

`0.2.1-rc.2` 相对 `0.2.1-rc.1` 的发布说明只有 DeepSeek-V4.1-Flash-1017 与 Search/Fetch API，没有插件装入或会话 DOM 的条目。本文的源码行号取自 rc.2；rc.1 与 rc.2 对本插件是同一套契约。

## 1. 安装门禁：`engines.dsh`

证据：`packages/boot/app-boot/src/plugin-compatibility.ts`（`unmetRequirements`）、`docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md`、`docs/user/develop/basic/publish.zh.md`。

| 事实 | 对鲸鱼娘的含义 |
|---|---|
| 清单里有 `engines.dsh` 时，**只看这一条**，`peerDependencies` 被忽略 | 范围必须自己覆盖全部要支持的版本 |
| 没有 `engines.dsh` 时，才检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer | 本包没有这些 peer。不声明 `engines.dsh` 等于任何版本都放行 |
| `engines` 不是对象，或 `engines.dsh` 不是字符串 | 清单格式错误，安装直接拒绝 |
| 比较使用 `semver.satisfies(runtime, range, { includePrerelease: true })` | 预发布号参与比较；`workspace:` 写进 `engines.dsh` 算不满足 |
| `dsh.compatibility.dshReleases` | 0.2.1 的安装器**不读**这个字段。它仍是给人和其他目录看的矩阵，不能代替 `engines.dsh` |

本包声明：

```json
"engines": {
  "dsh": ">=0.1.0-rc.6 <0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2"
}
```

用 semver 7.8.5、`includePrerelease: true` 核对过的边界：

| 版本 | 结果 | 原因 |
|---|---|---|
| `0.1.0-rc.6` … `0.1.x`（含 `0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.7-rc.2`） | 放行 | README 既有「旧版 Web `0.1.0-rc.6` 起」 |
| `0.1.2-alpha.4` / `0.1.2-alpha.5` | 放行，矩阵仍是 `unknown` | 安装门禁不表达「未知」；矩阵继续表示「没单独验收」 |
| `0.2.0-rc.2` | 放行 | 隔离 profile 实测过的桌面端 |
| `0.2.0-rc.1`、`0.2.1-alpha.*`、`0.2.1` 正式版、`0.3.0` | 拒绝 | 没有按本插件的契约核对过 |
| `0.2.1-rc.1`、`0.2.1-rc.2` | 放行 | 本文的静态核对 |

## 2. 客户端装入（相对 0.2.0-rc.2：没变）

| 契约 | 0.2.1-rc.2 | 证据 |
|---|---|---|
| `dsh.client.platform === "web"` | 仍是跳过条件 | `packages/client/modules/src/client/manifest.ts` `parseDshClient` |
| `exports["./client"]` + `window.__ModuleLoader__.load({id, factory})` | 仍是唯一注册入口 | `packages/client/modules/src/index.ts` 注入的 queue facade；`packages/client/modules/src/client/system.ts` |
| `settings.section` 列表项必须带 `id`，同名再声明会抛 | 仍有效 | `packages/client/ui-slots/tests/core.client.spec.ts`；`packages/client/ui-settings-general/src/client/index.ts` |
| `webServer.register({ kind: "exact", path, handler })` | 仍有效；重复路径抛错 | `packages/host/webserver/src/index.ts` |
| 桌面端文档 origin `dsh-app://app` | 仍有效 | `apps/desktop/src/ipc.ts` `SCHEME`；`apps/desktop/src/main.ts` `protocol.handle` |
| `/assets/**` 由壳内 dist 应答，其余反代到 webServer | 仍有效 | `apps/desktop/src/main.ts`：`pathname.startsWith("/assets/")` 走 `serveWebDocument`，其余 `forwardWebRequest` |
| 反代要求 `Origin: dsh-app://app` | 仍有效 | `apps/desktop/src/web-document.ts` `forwardWebRequest` |

资源路由仍是 `/api/dsh-whale-musume/assets`，不落在 `/assets/` 下。

桌面端监听端口变了，但插件不读端口：`apps/desktop-host/src/index.ts` 的启动参数是 `--host 127.0.0.1 --port 0`（交给操作系统分配）。0.2.0-rc.2 手册里的 `19387` 只属于那个构建，**不能**写成 0.2.1 的默认端口。

## 3. DOM / slot（相对 0.2.0-rc.2：鲸鱼娘用到的都还在）

| 标记 | 0.2.1-rc.2 | 证据 |
|---|---|---|
| `[data-tool]` + `data-state` | 状态仍是 `preparing \| running \| ok \| error \| stopped` | `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts` `ToolRowState`；`ToolRow.tsx` 把 `data-tool` / `data-state` 写在同一元素 |
| `[data-chat-running]` | 仍只在会话运行时挂载 | `packages/client/ui-chat/src/client/chat/RunningStatus.tsx` |
| `[data-terminal]` + `[data-running]` | 仍在 | `packages/client/ui-primitives/src/TerminalBlock.tsx` |
| `[data-composer-input]` contenteditable | 仍在 | `packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx` |
| `[data-slot="conversation.chat.node"]` | slot 出口仍包一层 `data-slot=<key>` | `packages/client/ui-renderer/src/client/scoped-slots.tsx` |
| `[data-shortcut-modal="settings"]` | 设置面板根仍是这个属性，且 `role="dialog"` | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` |
| `body[data-ds-dark-theme]`（暗色为空串）与 `html[data-ds-theme-source]` | 仍在 | `packages/client/ui-layout/src/client/theme-presenter.ts` |

因此 `assets/dsh-whale-moe.js` 的信号银行、设置页判据、输入框查找、主题识别都保持原样（选择器只增不减，这次零增删）。`lib/client.js` 继续注册 `settings.section` / `id: "mascot"`。

### 看过、但本插件不消费的新扩展位

- `conversation.input.model.label`（0.2.1-alpha.5）：输入框模型名的 single slot。`packages/client/ui-model-selection/src/client/slots.ts`。鲸鱼娘不注册它。
- 输入区统计从整行 `stats` 拆成 `activity` 与 `usage`（0.2.1-alpha.1）。鲸鱼娘没有覆盖那一行。
- 运行时 `./invariant` 导出被移除。鲸鱼娘不引用它。

## 4. 热重载

0.2.1 的发布说明：启用热重载时，可替换的插件更新会直接生效；不能热重载则提示重启。

鲸鱼娘的客户端引导有页面级旗标 `window.__dshWhaleMusumeBooted`：factory 再次执行时不会重注表现层，避免第二个 `MutationObserver`。所以**换包之后仍要刷新页面或重启桌面端**，桌宠才会换成新脚本。这和 0.2.0-rc.2 的引导方式相同，不是 0.2.1 的回归。宿主若判断这次更新不能热重载，会自己提示重启。

宿主半边的资源路由在 `ctx.effect` 里持有 `webServer.register` 的 disposer。重复注册同一 exact 路径会抛错；正常的 fiber 拆卸会先 dispose。没有在 0.2.1 上实机观察过这条路径。

## 5. 明确没做的事

- 没有在 DeepSeek Harness Desktop 0.2.1-rc.2 里安装本插件。
- 没有把 `0.2.1-rc.2` 写成「零控制台错误 / 零外部请求」的实机结论。那句话只属于 0.2.0-rc.2 的验收报告。
- 没有改动遥测。默认仍是本地注入 + 只读资源路由。
