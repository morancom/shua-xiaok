# answertole ——  刷小课

本仓库包含两个相互独立的项目：

| 目录 | 项目 | 一句话 |
|---|---|---|
| [`shua-xiaoke/`](shua-xiaoke) | **刷小课**（自研主体） | 刷课 + 自动做题 + 侧边栏 AI 对话的 Edge 扩展，数据全走本地后端，不经过原插件服务器 |


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

- 交接记忆：[HANDOFF.md](HANDOFF.md)（版本基线为历史快照，当前版本以 `shua-xiaoke/extension/manifest.json` 为准）
- 版本变更：[shua-xiaoke/CHANGELOG.md](shua-xiaoke/CHANGELOG.md)
