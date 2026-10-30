# answertole —— 大学搜题酱逆向 & 刷小课

本仓库包含两个相互独立的项目：

| 目录 | 项目 | 一句话 |
|---|---|---|
| [`shua-xiaoke/`](shua-xiaoke) | **刷小课**（自研主体） | 刷课 + 自动做题 + 侧边栏 AI 对话的 Edge 扩展，数据全走本地后端，不经过原插件服务器 |
| [`reverse/`](reverse) | **大学搜题酱逆向**（研究资料） | 对 Edge 扩展「大学搜题酱插件」v1.17.6 的完整逆向：中文报告、API 清单、可浏览模块切分 |

## 目录结构

```
answertole/
├─ shua-xiaoke/        项目 B：刷小课（自研）
│  ├─ extension/       扩展本体（Edge 直接加载）
│  ├─ server/          零依赖 Node 后端 + 可视化控制台（:3001）
│  ├─ tools/           打包 / 版本 / CDP 自检 / mock 页面
│  ├─ docs/memory/     逐版本开发记忆（含每版根因分析）
│  ├─ CHANGELOG.md     逐版本变更记录
│  └─ *.bat            Windows 一键启动脚本（GBK 编码）


## 快速开始（刷小课）

1. 安装 [Node.js](https://nodejs.org/) LTS
2. 双击 `shua-xiaoke/一键启动并加载扩展.bat`（起后端 + 带扩展启动 Edge）；
   或双击 `启动.bat` 只起后端，再到 `edge://extensions` 开发者模式手动加载 `shua-xiaoke/extension/`
3. 打开控制台：http://127.0.0.1:3001/ui

详见 [shua-xiaoke/README.md](shua-xiaoke/README.md)。

## 逆向资料

入口：[reverse/README.md](reverse/README.md) —— 总报告、六册分卷、API 全表都在那里索引。

## 上传 GitHub 前注意

- `.gitignore` 已排除：浏览器配置（含登录态）、后端运行数据（含 API key）、第三方解包源码、打包产物。
- `shua-xiaoke/server/server.js` 顶部默认值与 `server/data.json` 里有**明文 API key**，公开仓库前请清空。
- 第三方解包代码（`reverse/ext-*`）有版权与体积问题，默认不入库；需要时可从商店 CRX 自行解包并用 `reverse/tools/` 重新生成。

## 历史文档

- 交接记忆：[HANDOFF.md](HANDOFF.md)（版本基线为历史快照，当前版本以 `shua-xiaoke/extension/manifest.json` 为准）
- 版本变更：[shua-xiaoke/CHANGELOG.md](shua-xiaoke/CHANGELOG.md)
