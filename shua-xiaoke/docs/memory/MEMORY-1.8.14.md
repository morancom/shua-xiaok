# 刷小课 1.8.14 完整交接

> 承接 1.8.13。**1.8.13 的改动全部保留**，1.8.14 只解决一件事：
> 真机 `studentstudy` 学习页上「题目和提交按钮都在深层 iframe 里，而提交/兜底逻辑只在顶层跑」，
> 所以 1.8.13 在真机上永远走不到提交那一步。

## 1. 1.8.13 → 1.8.14 的根因（有真机日志）

用户 Edge 学习页（`mooc1.chaoxing.com/mycourse/studentstudy?chapterId=950681239&...`）实测日志：

```
16:17:07 auto-answer 已作答 8 题(共识别 29 题)      ← iframe 里答题正常
16:17:07 quiz-idle 未识别为作业页 顶层题=0 iframe=ok:0
16:18:41 quiz-idle 未识别为作业页 顶层题=0 iframe=ok:0
```

- 顶层 `looksLikeWorkPage()` = false（题目在更深一层 iframe 里，顶层既看不到 DOM 也跨不过去）。
- `watchAutoSubmit` / `watchQuizIdle` 第一行都是 `if (window.top !== window) return;` → 只有顶层在跑，
  而顶层看不见题目 → **提交和兜底从未启动**（1.8.12 时代则是 DevTools 断点冻结页面）。
- 答题不受影响，因为 `watchAutoAnswer` 没有 top-only 限制，每个 frame 各答自己那份。

## 2. 新架构：谁看得见题目，谁提交；跳节交给顶层

```
iframe(题目+提交按钮)                    top(studentstudy,左目录)
  watchAutoSubmit/watchQuizIdle 都跑
        │  全部答完 / 10 秒无新作答
        ▼
  claimSubmit(href)  ← chrome.storage.local 的 sxk_submit，90 秒占位，防多层重复提交
        ▼
  chrome.runtime.sendMessage({type:'AUTO_SUBMIT_PAGE'})
        ▼
  sw2.js: executeScript({allFrames:true, world:'MAIN', func:pageSubmit}) → 取第一个 ok
        ▼
  子 frame 收到 ok → chrome.runtime.sendMessage({type:'SXK_JUMP_REQUEST'})
        ▼
  sw2.js: chrome.tabs.sendMessage(tabId,{type:'SXK_JUMP_NEXT'},{frameId:0})
        ▼
  顶层 engine 的 listenRemoteJump() → jumpNextOnce('remote-jump')
        ▼
  chaoxingJumpNext() → window.SXKCX.jumpNext(true,'engine-next')（失败则每 9 秒重试，最多 4 次）
```

顶层自己能看见题目时（旧版作业页、同源嵌套 iframe）**仍走原来的本地路径**，不发跨 frame 请求。

### 2b. 兜底时钟改成「已答题数」（同一个坑的另一半）

`watchQuizIdle` 原来看 `lastAnswerAt`，但 `answerPass` 每 6 秒跑一轮，**即使一道都没答上**也会刷新它
（真机 29 题里很多是图片选项，AI 答不出来）→ 10 秒兜底永远不会触发，1.8.12/1.8.13 都卡在这里。
现在用「已答题数」当时钟：`idleDone` / `idleDoneAt`，数字 12 秒不变才兜底，日志会写
`已 N 秒没有新作答(3/29),执行兜底`。答不上题的页面也能继续往下刷。

## 3. 改动文件（1.8.14）

| 文件 | 改动 |
|---|---|
| `extension/engine.js` | `watchAutoSubmit` / `watchQuizIdle` 去掉 top-only 限制；新增 `claimSubmit(href)`、`frameTag()`、`requestJumpFromTop(tag)`、`listenRemoteJump()`；兜底时钟从 `lastAnswerAt` 改成「已答题数」`idleDone/idleDoneAt`（12 秒无变化才兜底）；所有相关日志带 `(top)` 或 `(fr:xxx)` 帧标签；首轮体检多打 `提取=N`；提交成功行改成 `已触发提交(fr:xxx):...` |
| `extension/sw2.js` | 新增 `case 'SXK_JUMP_REQUEST'`：把跳节请求转给顶层（`frameId:0`） |
| `tools/mock-frame-submit.html` + `tools/mock-frame-submit-if.html` | 新增真机同构 mock：题目/提交在 iframe、`#prevNextFocusNext` 在顶层、iframe 自带 chrome stub（含 `SXK_JUMP_REQUEST → 顶层点击`），answered/idle 双模式 |

1.8.13 已有的改动（仍有效）：`extension/pageSubmit.js`（新）、`sw2.js` 用 `importScripts` 去掉内联副本、`looksLikeWorkPage()` 加 `extractQuestions()` 兜底、`optsIn` 用 radio/checkbox 反推选项行、`jumpNextOnce` 失败重试、体检日志。

## 4. 真机 DOM 契约（不要凭记忆改选择器，先看这里）

- 提交按钮：`<a class="btnSubmit workBtnIndex" href="javascript:void(0);" role="button" onclick="btnBlueSubmit();"><span title="提交">提交</span></a>`
  层级 `lightCon.newTestCon > div.radiusBG > div.CeYan > div.ZY_sub.clearfix > a.btnSubmit.workBtnIndex > span`。
- 确认框：`<div class="Alertcon2" id="confirmWin" style="width:338px;height:139px;display:none" role="alertdialog" aria-label="确认提交">`，按钮是 `.blueBtn`（确定）/.grayBtn（取消）。
- 同屏还有：`div.mask`、`#verifyCodeWin`、`input#answerwqbid`。
- 「暂时保存」是 `a.btnSave`，**绝不能点**（pageSubmit 的 NEVER 正则已排除）。
- 学习页左侧目录：`div.posCatalog_select.posCatalog_active#cur<chapterId> > span.posCatalog_name[onclick="getTeacherAjax(courseId,clazzid,chapterId)"]`；
  `#prevNextFocusNext` 在 `studentstudy` 上只切**任务标签**，不是下一节。

## 5. mock 回归（本机实测，全部 PASS）

服务：`node tools\serve-test.js`（端口 3011，静态服务项目根目录）。

| 页面 | 验证点 | 结果 |
|---|---|---|
| `tools/mock-frame-submit.html`（answered） | 题目在 iframe → iframe 提交 → 顶层点下一节（**同时跑着答题器**） | PASS，26 秒内完成，`submitted=1 nextClicks=1`，日志含 `全部 2 题已作答,准备提交`、`已触发提交(fr:127.0.0.1)`、`已请顶层跳下一节:ok` |
| `tools/mock-frame-submit.html?mode=idle` | 空题 + 答题器每 6 秒空转（SOLVE 返回 null）→ 兜底仍要触发 | PASS，`已 14 秒没有新作答(0/2),执行兜底` → 提交 → 顶层跳 |
| `tools/mock-old-work.html` | 真机同构页直接 `pageSubmit()`，不误点暂时保存 | PASS |
| `tools/mock-old-study.html?mode=answered` | 顶层驱动（同源 iframe 可见） | PASS，15 秒 |
| `tools/mock-old-study.html?mode=idle` | 顶层兜底强制提交 | PASS，16 秒 |
| `tools/mock-old-frames.html` | 按钮在 iframe、确认框在顶层 | PASS，`dialogFrame=top` |
| `tools/mock-old-nested.html` | studentstudy → 工作模块 → 内层 iframe | PASS，15 秒 |

## 6. 真机状态与下一步

- 用户 Edge 已加载 `D:\answertole\shua-xiaoke\extension`（命令行 `--load-extension`，扩展 id `eppkdpgfdjlacngadipgocppigdkeani`）。
- 1.8.14 需要用户再 **重新加载扩展 + F5** 一次（content script 只在页面加载时注入）。
- 重载后判据见 `MEMORY.md`「下一位先做」第 3 条。
- 后端正在跑的进程仍是 15:54 启动的 1.8.12（只影响 `/api/health` 版本号；不重启不影响功能）。
- 测试服务 3011 若已退出，`Start-Process node tools\serve-test.js -WindowStyle Hidden` 重启即可。

## 7. 坑

- 该机器 PowerShell 是 **5.1**（不是 pwsh 7）：`node -e "...\"...\""` 的转义会被吞掉 → ParserError；写文件用 write/edit 工具，脚本落盘再 `node`。
- CDP 9222 关闭时 `tools\cdp_eval.js` 用不了；Edge 的 UIA 树读不到网页内容（需在 `edge://accessibility` 开 Native/Web accessibility）。
- 想截 Edge 窗口用 `probe\capture-edge.ps1 -ProcId <pid> -Out <png>`（参数名是 `-ProcId`，因为 PowerShell 的 `$PID` 只读）。
- DevTools 打开且带断点时页面顶部会出现「已在调试程序中暂停」，此时扩展全部停摆 —— 排查任何「日志突然不动」先看一眼这个。
- 不要 `taskkill /f` 狂杀 Edge：会丢超星登录态。

## 8. 相关路径

- 后端：`server\server.js`（3001），控制台 `http://127.0.0.1:3001/ui`，健康 `/api/health`，日志 `/api/state`、`/api/cxlog`。
- 扩展：`extension\{manifest.json, sw2.js, pageSubmit.js, engine.js, cx.js, brush.js, sidebar.js}`。
- 打包：`node tools\set_version.js X.Y.Z` → `node tools\package.js`（产出 `dist\刷小课-X.Y.Z.zip`，`EXCLUDES` 已排除 `shots/logs`）。
- 记忆：`MEMORY.md`（入口）、`MEMORY-1.8.13.md`（上一版完整交接）、本文。
