# 刷小课 · 最新交接入口

**当前版本：1.8.17**（2026-10-25）

请优先读：`MEMORY-1.8.17.md`（完整交接：智慧树适配首版、真实 DOM 诊断方式、mock 入口、坑）。

## 30 秒现状

- **超星/学习通**：已经真机验证通过（自动答题 → 自动提交 → 自动跳下一节 → 目录打勾的节直接跨过去）。关键件：`extension\pageSubmit.js`（跨 frame 找提交按钮与 `div.Alertcon2#confirmWin`）、`extension\engine.js` 的 `watchAutoSubmit`/`watchQuizIdle`（每个 frame 都跑 + `claimSubmit` 90 秒占位 + 子帧 `SXK_JUMP_REQUEST` 让顶层代跳）、`extension\cx.js` 的 `catalogCurrentCompleted()`/`skipPastCompleted()`。
- **智慧树**：1.8.17 新增 `extension\brush-zhs5.js`，manifest 新注 `studyvideoh5 / studyh5 / studywenda` 三个学习页域名（以前只注课程列表页 `onlineweb`，学习页压根没刷课脚本）。功能：同源 iframe 递归找 video → 静音 + 倍速 + 自动播放；弹题无害按钮自动关；播完点「下一集/下一节/下一章/下一课」；跨域 iframe 用 `postMessage('SXK_ZHS_NEXT')` 请顶层代点。**尚未真机验证**，首版自带 `zhs5-dom` 一次性结构诊断。
- 控制台 key 保存 bug（每 3 秒轮询把输入框冲掉）1.8.16 已修：聚焦/未保存时不覆盖 + 切走自动 `POST /api/settings`。
- 包：`dist\刷小课-1.8.17.zip`（148,657B，内置 key）、`dist\刷小课-1.8.17-无key.zip`（148,617B，舍友自己填）。都不含 `data.json`/`tools/`/`shots/`/`server.log`。
- mock 入口：`node tools\serve-test.js`（3011）→
  - 超星：`mock-old-work.html`、`mock-frame-submit.html`、`mock-old-study.html?mode=answered|idle`、`mock-old-frames.html`、`mock-old-nested.html`、`mock-video-done.html?skip=1`（含 `?nocat=1` 对照）
  - 智慧树：`mock-zhs5.html`（含同源 iframe + 假播放器）、`mock-zhs5-xframe.html`（跨域 iframe，走 localhost↔127.0.0.1）

## 下一位先做

1. **智慧树真机对齐**：让用户 reload 扩展 + F5 学习页，然后拉 `/api/state` 找这几条（tag 以 `zhs5` 开头）：
   - `[zhs5] loaded path=…` —— 确认脚本注进去了
   - `[zhs5-dom] docs=N videos=N :: id=… dur=… up=…` —— 真实播放器结构（若 `videos=0` 说明播放器在跨域 iframe 或 shadow DOM）
   - `[zhs5-dom] btns=…` —— 真实「下一集」按钮的选择器/文案
   - `[zhs5-dom] overlays=…` —— 弹题/提示框类名
   - `[zhs5-video] cur=… dur=… adv|STUCK` —— 到底有没有在播
2. 按诊断结果改 `extension\brush-zhs5.js` 的按钮文案/选择器；如果弹题是选择题、且平台要求答对才能继续，再考虑把 `SXK.solve()` 接进来。
3. 智慧树 `onlineweb.zhihuishu.com`（课程列表页）目前只有旧的 `brush-zhs.js`（点 `.el-icon-d-arrow-right` 之类），如果需要「从列表自动进下一章」再单独补。

## 红线

日常 Edge 默认配置；不要反复 `taskkill /f`；讲中文；视觉证据优先；**以前的功能不许改坏**（超星链路的 engine.js / cx.js / pageSubmit.js 不要顺手重构）；改中文文件用 Node/UTF-8，别用 PowerShell 默认编码；`pwsh -Command` 里别塞大段中文正则（会乱码），写成 `.js` 脚本文件再跑。
