# 桌面端 0.2.1-rc.2 部署差分

安装、回滚、卸载的命令形状仍以 [`desktop-0.2.0-rc.2-deploy.md`](desktop-0.2.0-rc.2-deploy.md) 为准（桌面端自带 CLI、`--profile desktop`、先 `remove` 再 `add`、养成数据在 `localStorage`）。本文只写 **0.2.1 相对那份手册已经变了的事实**。0.2.1 **没有**按那份手册重跑一遍实机安装。

插件版本：鲸鱼娘 **2.4.0**。宿主：DeepSeek Harness **0.2.1-rc.1 / 0.2.1-rc.2**（tag `dsh-v0.2.1-rc.2`）。

## 和 0.2.0-rc.2 手册不同的地方

1. **不要再假设 GUI 端口是 `19387`。** `apps/desktop-host/src/index.ts` 现在把 desktop profile 启成 `--host 127.0.0.1 --port 0`，端口由操作系统分配。鲸鱼娘不连接这个端口；排障时以桌面端自己报告的地址为准。
2. **版本门禁改看 `engines.dsh`。** 2.4.0 的范围是 `>=0.1.0-rc.6 <0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2`。跑在这个范围外的 DSH 上，`dsh plugin add` 会拒绝，而不是装上再碰运气。被拒绝时可以换宿主版本，或按上游说明对**精确的插件版本 + 运行时版本**做豁免（`dsh plugin allow-version`）。豁免有崩溃风险，不是本插件的推荐路径。
3. **装完仍要重启桌面端或至少刷新页面。** 表现层每个页面只引导一次。0.2.1 能热重载的更新会立刻生效，不能热重载时宿主会提示重启；鲸鱼娘的桌宠脚本属于后者。
4. **文档 origin 没变**，仍是 `dsh-app://app`。旧版 Web 的 `whale-moe:*` 不会跟过来。资源路由仍是 `/api/dsh-whale-musume/assets`，不走会被壳内 dist 截走的 `/assets/`。

## 本差分没有验证的内容

没有在 0.2.1 的 Electron 里执行上面的 `add` / `remove`，也没有记录控制台或网络面板。兼容结论见 [`desktop-0.2.1-rc.2-contract.md`](desktop-0.2.1-rc.2-contract.md)。
