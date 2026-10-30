# 刷小课（v1.8.17）

刷课 + 自动做题 + 侧边栏 AI 对话的 Edge 扩展。支持超星/学习通；
数据全走本地后端（零依赖 Node），不经过任何第三方服务器，可打包免费分享。

## 快速开始

| 用途 | 操作 |
|---|---|
| 起后端 + 带扩展启动 Edge | 双击 `一键启动并加载扩展.bat` |
| 只起后端 + 控制台 | 双击 `启动.bat` |
| 停后端 | 双击 `停止.bat` |
| 手动加载扩展 | `edge://extensions` → 开发者模式 → 加载解压缩的扩展 → 选本目录 `extension/` |

- 控制台：http://127.0.0.1:3001/ui
- 健康检查：http://127.0.0.1:3001/api/health
- 自检页：http://127.0.0.1:3001/mock/chaoxing （模拟题型）、http://127.0.0.1:3001/mock/course?n=3 （模拟课程页，3 个视频）

前置要求：[Node.js](https://nodejs.org/) LTS。bat 脚本为 GBK 编码（兼容中文 Windows 的 cmd）。

## 目录结构

```
shua-xiaoke/
├─ extension/      扩展本体（MV3，service worker = sw2.js）
│  ├─ cx.js        超星课程页驱动（最大最复杂：视频/弹题/风控熔断）
│  ├─ engine.js    通用引擎：设置/日志/applyAnswer/自动做题/视频工具
│  ├─ brush*.js    各平台入口（超星、智慧树、U校园）
│  ├─ sidebar.*    侧边栏（Shadow DOM + 浮球 + 右侧 400px 抽屉）
│  └─ sw2.js       后台：消息路由 + 心跳 + SSE 转发 + 诊断日志
├─ server/         零依赖 Node 后端（:3001，别名 :3000/:3002）
│  ├─ server.js    全部路由 /api/* + /ui + /mock/*
│  ├─ index.html   可视化控制台
│  └─ data.json    持久化（gitignore，运行后自动生成）
├─ tools/          package.js 打包 / set_version.js 改版本 / probe_*.js CDP 自检 / mock-*.html
├─ docs/memory/    逐版本开发记忆（含每版根因分析，接手排障先看这里）
├─ dist/           分发包（gitignore，`node tools/package.js` 生成）
└─ CHANGELOG.md    逐版本变更记录
```

## 配置 AI 模型

后端默认连 `https://api.deepseek.com/v1/chat/completions`（model `deepseek-flash`）。
key 位置：`server/data.json`（控制台可改，首次运行自动生成）或 `server/server.js` 顶部默认值。
分发给别人时用 `node tools/package.js --no-key` 出无 key 包，让对方自己填。

## 注意事项

- 大改后台代码后需改 `manifest.json` 里的 service worker 文件名（Edge 按脚本 URL 缓存 SW，文件名不变不重载），历史原因现用 `sw2.js`。
- 刷超星启用了「温和模式」：播放节流 + 风控熔断 + 冷却，避免 pause/play 高频抖动触发超星风控白屏。详见 CHANGELOG 与 `docs/memory/`。
- 详细交接与排障命令：仓库根目录 [../HANDOFF.md](../HANDOFF.md)（版本基线为历史快照，当前版本以 `extension/manifest.json` 为准）。
