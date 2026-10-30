# 刷小课 1.8.15 · 完整交接

> 2026-10-25。上一版 1.8.14（跨 frame 提交 + 顶层代跳 + 兜底时钟）。
> 1.8.15 只改 `extension/cx.js`，修掉「目录已打勾但播放器没播过」导致的**整门课停死**，并加了「跨过已完成节」。

## 1. 真机症状（用户 16:33 反馈「界面又卡住了，不会往后刷章节」）

```
16:32:20 cx-jump  目录当前节已完成(icon_Completed),推进下一节      ← 每 2 秒一条
16:32:24 cx-jump  拦下跳节(目录已完成):还有 1 个视频任务没完成     ← 每 ~20 秒一条
…重复 100+ 条，页面不动
```

页面是 `studentstudy?chapterId=939425612`（**1.1.7 联结词全功能集**），左侧目录里 1.1.7 带 ✓，
右侧播放器**从没播过**（大播放按钮、0 进度）。截图证据：`D:\answertole\probe\edge-3.png`。

重要收获：**1.8.14 的跨 frame 提交是有效的** —— 1.1.6 章节测验2 已经从 `1` 变成 ✓，插件成功提交并跳到了 1.1.7。

## 2. 根因（三步死锁）

1. `taskFinished(t)`（`cx.js` 内）对视频任务点的判定是「能读到 `<video>` 就以播放器为准，
   `duration=0` 一律不算完成，忽略容器上的 `.ans-job-finished`」（2026-10-24 为修「第二个视频没播就跳下一节」而写）。
   → 本页 `video.duration=0`、`currentTime=0` → `fin=false`。
2. `jumpNext()` 的安全网（`cx.js` 内 `if (!force)` 段）发现 `pend=1` 个未完成视频 → **`return false`**。
3. tick 里「目录已完成」快路径是 `jumpNext(...); return;` —— **拦下也照样 return**，
   于是永远走不到下面的视频驱动代码 → 视频永远不播 → `fin` 永远是 false → 死锁。

即：目录勾（服务端进度）与播放器（本地状态）互相矛盾，安全网站在播放器一边，而重播又永远不发生。

## 3. 1.8.15 的三处改动（全在 `extension\cx.js`）

### 3.1 目录勾 = 服务端权威进度（视频也认）

新增（放在 `catalogNext` 之前）：

```js
function catalogCurrentCompleted() {
  if (window.top !== window) return false;                  // 子 frame 没有左侧目录
  try {
    if (Date.now() - catDoneCache.at < 1200) return catDoneCache.val;
    const cur = catalogCurrent(catalogItems());
    const val = !!(cur && (cur.querySelector('.icon_Completed') || /已完成/.test(String(cur.innerText || ''))));
    catDoneCache = { at: Date.now(), val };
    return val;
  } catch (e) { return false; }
}
```

`taskFinished(t)` 的**第一行**（`try {` 之后）加：

```js
if (catalogCurrentCompleted()) {
  const href = String(location.href || '');
  if (catSkipSaid !== href) { catSkipSaid = href; log('cx-video', '本章播放器没播过但目录已打勾,按服务端进度算完成,不再重播'); }
  return true;
}
```

理由：文档任务点早就在用同一条规则（注释「目录里当前节已经打勾…以目录的官方完成标记为准可以直接推进」）；
`.icon_Completed` 来自超星服务端，不是页面预挂的假标记（那才是 2026-10-24 的坑）。

### 3.2 拦下后不再 return（防止再次互锁）

```js
if (catCur && catCur.querySelector('.icon_Completed')) {
  if (Date.now() - lastCatDoneLog > 15000) { lastCatDoneLog = Date.now(); log('cx-jump', '目录当前节已完成(icon_Completed),推进下一节'); }
  if (skipPastCompleted(catItems, catCur)) return;
  if (jumpNext(false, '目录已完成')) return;
  // 被 25 秒限流/安全网拦下 → 继续往下走，视频/文档照样被驱动
}
```

日志节流：原来这条每 2 秒一条把后端日志刷爆（92 条/100 秒），现在 15 秒一条。

### 3.3 跨过连续已完成的节

```js
function skipPastCompleted(items, cur) {
  if (window.top !== window) return false;
  if (cfg().autoSkipDone === false) return false;
  if (Date.now() - lastJumpAt < GAP_JUMP_MS) return false;      // 25 秒限流
  const i = items ? items.indexOf(cur) : -1;
  if (i < 0) return false;
  let skipped = 0, target = null;
  for (let j = i + 1; j < items.length; j++) {
    const el = items[j];
    const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!/^\d+(\.\d+){1,3}\s/.test(t)) continue;                       // 章标题不算
    if (el.querySelector('.icon_Completed')) { skipped += 1; continue; } // 已完成 → 跳过
    target = el; break;
  }
  if (!target || !skipped) return false;    // 紧挨着的那节没打勾 → 走普通跳节
  const cid = catalogChapterId(target);
  if (!cid) return false;
  lastJumpAt = now; jumpCount += 1;
  log('cx-jump', `目录里 ${skipped} 节已完成,直接跳到 ${catalogText(target)}`);
  rec('jump', { n: jumpCount, by: 'skip-done', skip: skipped, to: catalogText(target), cid });
  if (!goCatalog(target)) clickCatalog(target);
  return true;
}
```

顺序必须是「先 skip 再 jumpNext」：真机有 1 个任务标签时 `jumpNext` 会走标签分支并直接 `return true`，跨节就轮不到了。

新增模块级变量：`let lastCatDoneLog = 0; let catDoneCache = { at: 0, val: false }; let catSkipSaid = '';`

## 4. 新增 mock（`node tools\serve-test.js` → 3011）

| 文件 | 场景 | 断言 |
|---|---|---|
| `tools\mock-video-done.html` | 目录当前节 ✓ + 视频任务 `duration=0`（没播过） | `taskFinished=true` → 点「下一节」（`__nextClicks=1`）|
| `tools\mock-video-done.html?skip=1` | 1.1.8 也 ✓ | 直接 `location` 跳到 1.1.9 的 chapterId `939425625`（`SKIP-PASS`）|
| `tools\mock-video-done.html?nocat=1` | 去掉目录勾（对照组）| **不跳**，转去驱动视频（证明解锁的正是目录勾）|
| `tools\mock-video-done-study.html` | 学习页主 iframe，内含 `/ananas/modules/video/index.html` 任务 iframe | — |
| `tools\ananas\modules\video\index.html` | 只有 `<video id="vjs_container_html5_api">` 无 src | 让 `MODULE_RE` 认出 video 任务、`duration=NaN` |

实测输出（DSH 内置 Chromium）：

```
PASS  fin=true   logs: cx-video 本章播放器没播过但目录已打勾,按服务端进度算完成,不再重播
                        cx-jump 目录当前节已完成(icon_Completed),推进下一节
                        cx-jump 第 1 次点下一节(触发:目录已完成)
SKIP-PASS  url -> ?chapterId=939425625&skip=1
nocat: taskFinished=false + cx-video 播放中 0/0s（不跳，符合预期）
```

1.8.14 的 mock（`mock-frame-submit.html` / `mock-old-work` / `mock-old-study` / `mock-old-frames` / `mock-old-nested`）未受影响，仍应全 PASS。

## 5. 版本与包

- `node tools\set_version.js 1.8.15` → `extension\manifest.json` 与 `server\server.js` 都是 1.8.15
- `node tools\package.js` → `dist\刷小课-1.8.15.zip` **223,448B**
- `dist\刷小课\extension\{cx.js,engine.js,pageSubmit.js,sw2.js}` 与项目文件 SHA256 全 MATCH
- 旧包备份：`D:\answertole\probe\刷小课-1.8.14.zip.bak`

## 6. 真机状态（交接时）

- Edge pid 29208（旧 3348 已退出，用户是用 `一键启动并加载扩展.bat` 重启的），窗口标题「学生学习页面 和另外 1 个页面」。
- 页面：`studentstudy?chapterId=939425612`（1.1.7），目录 1.1.1~1.1.8/1.1.10 都是 ✓，1.1.4/1.1.9/1.2.1/2.1.1 还是橙色数字（未完成）。
- 后端 `node server\server.js` 在跑，`/api/state` 只保留最近 100 条；`/api/cxlog` 在 PowerShell 里取值会报「处于非交互模式」，改用 node fetch 或浏览器访问。

## 7. 坑（新增）

- **`catalogCurrent()` 的三段式匹配**：先看 class 是否有 `active|cur|current|on`；再看 item 的 `innerHTML` 是否含 URL 里的 `chapterId`；最后用 `.chapter_title` 文本匹配。
  mock 里若只写 `posCatalog_active` 而地址没有 `chapterId`，`catalogCurrent` 会返回 null（`posCatalog_active` 这个 token 不匹配 `(^|\s)active(\s|$)`）——写 mock 时务必把 chapterId 放进 URL 或 item 的 innerHTML。
- 目录项点击必须点 `span.posCatalog_name`（带 `onclick="getTeacherAjax(courseId,clazzid,chapterId)"`），点外层 div 无效。
- 真机「目录已完成」判定是 `cur.querySelector('.icon_Completed')`；如果哪天超星改结构，日志会只剩 `目录当前节已完成` 反复出现而没有跳节。
- PowerShell 5.1：`Get-Process -Id $Pid` 的 `$Pid` 会被当成只读 `$PID` → 脚本参数用 `-ProcId`；`node -e "…\"…\""` 转义会被吞，改文件用 edit/write。
- `/api/cxlog` 用 `Invoke-WebRequest` 读时可能报「Windows PowerShell 处于非交互模式」，改用 node fetch 或直接在浏览器打开。

## 8. 下一位先做

1. 用户重载扩展（`edge://extensions/?id=eppkdpgfdjlacngadipgocppigdkeani`，版本应显示 1.8.15）+ F5。
2. 拉 `/api/state`，应看到：
   `cx-video 本章播放器没播过但目录已打勾…` → `cx-jump 目录里 1 节已完成,直接跳到 1.1.9 推理理论`
   → 到 1.1.9（没打勾）后 `cx-video 播放中 …` → 播完 `本章视频全完成` → 继续往后。
3. 若 1.1.9 的视频不自动播：看 `cx-video` / `cx-dbg` 的 `paused/rate/vis`；再不行就看 `pickVideoTask` 的 `rec('pick')` 日志。
