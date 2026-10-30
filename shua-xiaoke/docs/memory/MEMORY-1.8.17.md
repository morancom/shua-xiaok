# 1.8.17 完整交接（智慧树学习页适配 · 首版）

> 上一版：`MEMORY-1.8.16.md`（控制台 key 保存 bug + 分享包）。本文只写 1.8.17 这一轮。
> 用户原话（m01089）：「继续完善现在已经打开的网站的自动刷课代码，以前的功能要保证不被改变」。

## 1. 为什么这一轮是「智慧树」

- 用户当前打开的站点已经不是超星，而是 `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=…`（课程《形势与政策》）。
- 盘点发现：`extension\manifest.json` 里智慧树只匹配了一个域名 —— `https://onlineweb.zhihuishu.com/*`（课程列表页），而**真正播放课程的学习页 `studyvideoh5.zhihuishu.com` 根本没有注入任何刷课脚本**。
- 侧边栏（`sidebar.js`，`<all_urls>`）在这个页面是活的（日志 `sidebar inject autoOpen=true host=studyvideoh5.zhihuishu.com`），所以用户看到侧边栏在、开关也能拨，但视频不会自己播/不会跳下一集。
- 旧 `extension\brush-zhs.js` 只有 381B：`SXK.watchVideos()` + 每 3 秒 `SXK.zhihuishuNext()`（点 `.el-icon-d-arrow-right` / `[class*=nextBtn]`），而且只在 onlineweb 注入。**保持原样不动**（onlineweb 的行为不变）。

## 2. 新增文件 `extension\brush-zhs5.js`

manifest 新增一条（`all_frames: true`，`document_end`）：

```json
{
  "matches": [
    "https://studyvideoh5.zhihuishu.com/*",
    "https://studyh5.zhihuishu.com/*",
    "https://studywenda.zhihuishu.com/*"
  ],
  "js": ["engine.js", "brush-zhs5.js"],
  "run_at": "document_end",
  "all_frames": true
}
```

脚本做的事（每 1.5 秒一轮 `tick`，每步独立 `try`，互不影响）：

1. **一次性结构诊断 `zhs5-dom`**（每个 href 只打一次，仅顶层）：
   - `docs=N videos=N :: id=… cls=… src=… dur=… cur=… paused=… rate=… up=div#a.b<div.c<…`（往上 4 层祖先，方便定位播放器容器）
   - `btns=…`：候选按钮的真选择器 + 文案，弹层内的追加 `@ovl`
   - `overlays=…`：可见的弹层类名（`[class*=dialog|pop|quiz|question|mask|modal]`）
   - `text=…`：页面文本前 240 字
2. **`ensurePlay()`**：扫「自己 + 同源 iframe（最多两层）」的 `<video>` → `muted=true`、`playbackRate=设置值`、`paused` 时 `play()`。
3. **`beat()`**：每 15 秒一条 `zhs5-video` 心跳：`cur/dur adv|STUCK paused ended rate muted rs err`。`adv` 表示时间在走，`STUCK` 表示数字没变 —— 一眼判断「真播」还是「卡住」。
4. **`dismissPopups()`**：只点 `继续学习|继续观看|我知道了|知道了|关闭|确定|开始学习|继续播放|播放`，且**必须**处在「像弹层」的祖先里（类名含 dialog/pop/mask/modal/quiz/question/tips）。提交/交卷/删除/放弃 一律不碰。
5. **`maybeNext()`**：`videoDone()`（任一 video `ended`，或 `duration>30 && currentTime>=duration-1.5`）→ 点文案匹配 `^(下一集|下一节|下一章|下一课)$` 的可见元素；同一分钟只点一次（`nextClickedFor` 去重）。
6. **跨域 iframe**：子帧播完 `window.top.postMessage({type:'SXK_ZHS_NEXT'})`；顶层监听并校验来源域名（只认 `*.zhihuishu.com` 与 `127.0.0.1|localhost` 测试 host）后才点下一集。

### 踩到的坑（重要）

`settings` 是 `engine.js` 里 `const SXK = (() => { let settings = … })()` 的**闭包私有变量**，新脚本直接写 `settings.autoVideo` 会抛 `ReferenceError`，而这个调用被 `try{}catch(e){}` 包着 → **静默失效**，外部表现就是「不静音、不倍速、不播放」。
修法：一律走 `SXK.getSettings()`（engine.js:1349 已经有 `getSettings`，且已导出）。

> 这个坑值得记住：本仓库所有 `brush-*.js` 都只能通过 `SXK.*` 公开接口拿设置，不能直接引用 `settings`。

## 3. 回归（DSH 内置 Chromium，`node tools\serve-test.js` 起 3011）

| mock | 覆盖点 | 结果 |
|---|---|---|
| `tools\mock-zhs5.html` | 真 `<video>`+受控 duration/currentTime/paused；同源 iframe 里的第二个 video；`.quiz-dialog` 里的「继续学习」；`下一集` 按钮 | **PASS**（`muted=true rate=2 paused=false`、`closed=1 nextClicks=1`、日志含 `zhs5-dom`/`zhs5-popup`/`zhs5-jump`） |
| `tools\mock-zhs5-xframe.html` | 顶层无播放器，播放器在**跨域** iframe（localhost ↔ 127.0.0.1） | **PASS**（`[zhs5-jump] top 收到子帧请求 from localhost` → `click span#next.next-btn="下一集"`） |
| `tools\mock-old-work.html` | 旧链路回归（`pageSubmit` 找 `a.btnSubmit.workBtnIndex` + `#confirmWin`） | **PASS**（`picked=提交\|btnSubmit workBtnIndex`、`dialog=#confirmWin.Alertcon2`、`why=submitted-with-confirm`） |

## 4. 版本与包

- `node tools\set_version.js 1.8.17` → `extension\manifest.json` + `server\server.js` 都是 1.8.17。
- `node tools\package.js` → `dist\刷小课-1.8.17.zip` **148,657B**（sha256 `57D5AA47…CC90A`）。
- `node tools\package.js --no-key` → `dist\刷小课-1.8.17-无key.zip` **148,617B**（sha256 `11D7BC78…93A82`）。
- `CHANGELOG.md` 顶部已插入 1.8.17 段（脚本 `tools\_changelog_1817.js`）。

## 5. 真机待做（下一位先做）

1. 让用户 `edge://extensions/?id=eppkdpgfdjlacngadipgocppigdkeani` 点「重新加载」→ 学习页 F5。
2. 拉 `/api/state`（可 `node tools\_probe_state.js`）看 `zhs5` 开头的日志：
   - `[zhs5] loaded path=…` → 脚本注入了
   - `[zhs5-dom] docs=? videos=?` → 真实播放器在不在同源 iframe / 有没有 video
   - `[zhs5-dom] btns=…` → 真实「下一集」按钮怎么写
   - `[zhs5-video] … adv|STUCK` → 到底播没播
3. 按结果改 `brush-zhs5.js`：
   - 若 `videos=0` 且 docs 里没有 iframe → 播放器可能在 **shadow DOM** 或跨域 iframe（跨域时看子帧自己打的 `[zhs5@host]` 日志）
   - 若「下一集」文案不是那四个词 → 按 `btns` 日志补
   - 若弹题必须答对才继续 → 接 `SXK.solve()`（engine.js 已有 `solve`）
4. 智慧树会检测倍速吗：`beat` 日志里 `cur` 的增速与 `rate` 对比即可判断进度是否按 2x 记；若平台只认 1x 进度，再考虑把播放倍速降到 1.5 并观察。

## 6. 坑记录（本轮）

- PowerShell 5.1 的 `pwsh -Command` 里塞大段中文/正则会被打乱（报「字符串缺少终止符」）→ 写成 UTF-8 的 `.js` 脚本文件再 `node` 跑。
- `dsh_browser_execute` 只接受**表达式**，要等页面状态就用 `new Promise(resolve => {…})`。
- mock 里要让 `<video>` 表现得「播完了」，用 `Object.defineProperty(v,'duration'|'currentTime'|'paused'|'ended', {get/set})` 覆盖只读属性，并自己实现 `play()`/`pause()`，比造真实视频文件省事。

## 7. 关键路径

- 引擎/公开接口：`extension\engine.js`（`SXK.getSettings()`、`SXK.log(task,status)`、`SXK.tuneVideo`、`SXK.watchVideos`、`SXK.solve`、`SXK.watchAutoSubmit`、`SXK.watchQuizIdle`）
- 智慧树：`extension\brush-zhs5.js`（新）、`extension\brush-zhs.js`（旧，onlineweb，未改）
- 超星：`extension\cx.js`、`extension\pageSubmit.js`、`extension\brush.js`（本轮均**未改**）
- mock：`tools\mock-zhs5.html`、`tools\mock-zhs5-if.html`、`tools\mock-zhs5-xframe.html`、`tools\mock-zhs5-xif.html`
- 探针：`tools\_probe_state.js`（打 settings + 最近日志 + cxlog）
