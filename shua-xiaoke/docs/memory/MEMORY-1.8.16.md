# 1.8.16 完整交接（控制台 key 保存 bug + 分享包）

> 上一版：`MEMORY-1.8.15.md`（目录死锁）。本文只写 1.8.16 这一轮。

## 1. 用户报的两件事（m00831）

原话：「打包方便我发给舍友直接使用，哦那个控制台接入ai有点问题我最开始是输入key后切出去复制网址一切就又变成默认的了看看问题出在哪」

拆成两个任务：
- A. 出一个能直接发给舍友用的包。
- B. 修控制台里「填完 API Key 切出去再回来又变回默认」的 bug。

## 2. B 的根因（一句话）

`server\app.js` 每 3 秒 `setInterval(load, 3000)` → `load()` → `render()`，而 `render()` **无条件**执行：

```js
$('#setUpstreamUrl').value = s.upstreamUrl || '';
$('#setUpstreamKey').value = s.upstreamKey || '';
$('#setModel').value = s.model || '';
```

`s` 是服务端 `/api/state` 里的旧设置（`server\data.json` 里一直是默认 key `sk-28aa…`）。
于是：用户刚粘贴进密钥框 → 3 秒内被服务端旧值覆盖 → 「切出去复制个网址，回来又变回默认」。**根本没机会点保存**。

后端其实没毛病：`server\server.js:379-385` 的 `POST /api/settings` 会 `Object.assign(state.settings, body)` + `saveState()` 落盘。问题 100% 在前端渲染。

## 3. B 的修法（`server\app.js` + `server\index.html`，只改这两处）

1. **脏值保护**：新增 `UPSTREAM_FIELDS = [['setUpstreamUrl','upstreamUrl'], ['setUpstreamKey','upstreamKey'], ['setModel','model']]`、`const upstreamDirty = new Set()`、`fillUpstreamInputs(s)` —— 输入框是 `document.activeElement` 或有未保存改动时**跳过**，其余情况才同步；`render()` 里原来的三行赋值换成 `fillUpstreamInputs(s)`。
2. **标记未保存**：三个 input 的 `input` 事件 → `upstreamDirty.add(id)` + 提示「有改动未保存(切走会自动保存;点右边按钮立即保存)」。
3. **切走自动保存**：`flushUpstreamOnLeave()` 用 `fetch('/api/settings', { method:'POST', keepalive:true, body: upstreamBody() })`；挂在 `visibilitychange`(hidden)、`window.blur`、`pagehide` 上。`saveUpstream('manual'|'auto')` 是按钮和内部共用的保存函数，成功后 `upstreamDirty.clear()` + 提示「已保存 HH:MM:SS · 当前:真实模型/演示模式」。
4. **可看清 key**：`server\index.html` 的保存行加了 `<span id="upstreamHint">` 和 `<button id="upstreamEye">👁</button>`（切换 `#setUpstreamKey` 的 `type` password/text）。
5. **倍速滑块同理**：`const rateEl = $('#setRate'); if (rateEl && rateEl !== document.activeElement) rateEl.value = s.playbackRate;`（拖动时不被轮询打断）。

### 验证（真机后端 + DSH 内置 Chromium，`http://127.0.0.1:3001/ui`）
- 输入 `sk-probe-9f8e7d6c5b4a` → 等 5 秒（轮询 ~1.7 轮）→ 值仍在（修前 3 秒内必被冲回 `sk-28aa…`）。
- 触发 `window.dispatchEvent(new Event('blur'))` → 2 秒后 `server\data.json` 的 `upstreamKey` 变成 `sk-probe-…`（已落盘）。
- 刷新页面 → 输入框仍是 `sk-probe-…`（说明走 `/api/state` 回读也正确）。
- 测完已把设置恢复成原值（`sk-28aa7f2bb17c47b2ab38403daf15e6db`）。
- 控制台元素自检：`#upstreamHint` 文案正确、`👁` 在 `text`/`password` 间切换、滑块 `2 → 2x`。

## 4. A：分享包怎么出的

`tools\package.js` 改动：
- `EXCLUDES` 增加 `server.log`（运行日志）；原有 `data.json`（含发送者自己的 key/解题记录/诊断日志）本来就不进包。
- **不再复制 `tools/`**（全是开发期探针/打包脚本/mock 页，发给舍友只会造成困惑）。
- README 补两条：「包里已预置一个可用的 DeepSeek key，解压就能用真实 AI」「输入框改了不会丢：切走标签页会自动保存，点 👁 能看清 key」；文件说明去掉 `tools/`，补 `pageSubmit.js`。

产物（2026-10-25 最终重建，两个包都 141KB / 32 条目）：
- `dist\刷小课-1.8.16.zip`：**144,656B**，sha256 `7BF8FBFCC64555781C954D0C134A6C478B065107F2ED004FD0A1A137F3E177CC`，内置默认 key（35 字符），README 第四节＝「接自己的真实模型(可选)」。
- `dist\刷小课-1.8.16-无key.zip`：**144,616B**，sha256 `31852B2445DBCF0FB45EF01FC0C6B403B8CC89402C1BA3343FEE87B076777CE3`，默认 key＝`""`（0 字符），README 第四节＝「填自己的模型 key(首次必做)」。
- 两者条目里**都**没有 `data.json` / `shots/` / `server.log` / `tools/`。
- 包内 `server\app.js` 已验证包含 `fillUpstreamInputs` + `rateEl !== document.activeElement`；包内 README 已含「自动交卷要打开『自动提交』开关」的提示。
- 校验入口：`node tools\_verify_zips.js`（输出 size/entries/sha256/hasDataJson/hasTools/defaultKey/readmeSec4）。

## 4b. 无 key 版（`--no-key`）

`node tools\package.js --no-key` 在暂存阶段把 `STAGE\server\server.js` 的
`UPSTREAM_KEY = process.env.UPSTREAM_KEY || '<key>';` 替换成 `''`（正则 `/(const UPSTREAM_KEY = process\.env\.UPSTREAM_KEY \|\| ')[^']*(';)/`，匹配不到直接 throw），
并把 README 第四节标题/正文换成「填自己的模型 key(首次必做)」＋「本包没有内置 key」。

顺带修掉一个打包坑：原来每次出包都 `fs.rmSync(DIST)` 整目录清空，先出的包会被后一次删掉 → 改成只删暂存目录 `STAGE`。

独立运行验证：解压到临时目录，`PORT=3012 node server\server.js` →
`/api/health` = `{"ok":true,"name":"刷小课","version":"1.8.16","upstream":false,...}`；
`/api/state` 的 `upstreamKey` 长度 0；`/ui` 200 / 6502B。测完 kill 进程、删临时目录。

> 给舍友发哪个：发**无 key 版**（不消耗你的额度，对方自己填 key）；只有你自己用才用带 key 的那个。

## 5. 版本与文档

- `node tools\set_version.js 1.8.16` → `extension\manifest.json` 和 `server\server.js` 都写 1.8.16（扩展代码这轮没改）。
- `CHANGELOG.md` 补了 1.8.13 / 1.8.14 / 1.8.15 / 1.8.16 四段（本轮之前一直停在 1.8.12「当前版本」，是欠账）。
- 本文 + `MEMORY.md`（30 秒入口）已更新。

## 6. 还没做的

- ~~1.8.15 的真机验证~~ **已完成**：用户 2026-10-25 回报「重载 + F5 之后跑通了」，目录打勾死锁修复生效，能继续往后刷。
- 用户可能想换自己的 key：可以在控制台填（切走自动保存）；若想连自己那份包也不带默认 key，用 `--no-key` 出包。
- 若舍友反馈「只跳节不交卷」：让他把控制台「自动提交」开关打开（默认关，防误交）——README 第三节已写。

## 7. 坑（本轮新增）

- 读中文/大文件改内容：`read` 工具有「必须先读才能 edit」的门槛，而 `CHANGELOG.md` 52KB 全读很浪费 → 用 Node 脚本按 UTF-8 读改写（`tools\_changelog_1816.js`），别用 PowerShell 默认编码。
- `dsh_browser_execute` 的脚本是**表达式**，不能写 `a(); b;` 这种语句序列，要包成 `(() => { ... })()`。
- `Compress-Archive` 打包后要想确认包内文件对不对，用 `[System.IO.Compression.ZipFile]::OpenRead` 逐条列（`Get-ChildItem` 看不到 zip 里）。
- **pwsh `-Command` 里塞大段中文 + 正则会被编码打乱**（报 `字符串缺少终止符` / 乱码 ParserError）→ 把逻辑写成 UTF-8 的 `.js` 脚本文件再 `node` 跑（本轮 `tools\_verify_zips.js` 就是这么来的）。
