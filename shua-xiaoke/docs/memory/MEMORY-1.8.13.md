# 刷小课 1.8.13 完整交接（2026-10-25）

目标：**学习页「练习/章节测验」能自动提交，提交完自动跳下一节继续刷课**。
本版只动扩展侧，后端除版本号外未改。

---

## 一、真机 DOM 契约（1.8.13 才拿到，之前全靠猜）

抓取方式：`probe\capture-edge.ps1 -ProcId 3348` 截 Edge 窗口（`PrintWindow` + PW_RENDERFULLCONTENT），
在截图里直接读 DevTools Elements 面板。证据图：`probe\edge-1.png`。

页面：`https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=950681239&courseId=249709761&clazzid=153142699&cpi=407986679&enc=...`

提交按钮（**在 `#iframe` 内**，注意是 `a` 不是 `button`，没有 id）：

```html
<a class="btnSubmit workBtnIndex" href="javascript:void(0);" role="button"
   onclick="btnBlueSubmit();"><span title="提交">提交</span></a>
```

层级：`lightCon.newTestCon > div.radiusBG > div.CeYan > div.ZY_sub.clearfix > a.btnSubmit.workBtnIndex > span`。

同层还有（关键）：

```html
<div class="mask" style="display:none"></div>
<div class="Alertcon2" id="confirmWin" style="width:338px;height:139px;display:none"
     role="alertdialog" aria-label="确认提交"> ... 确定 / 取消 ... </div>
<div class="Alertcon2" id="verifyCodeWin" ...></div>
<input type="hidden" id="answerwqbid" name="answerwqbid">
```

**这就是「点了提交但页面不动」的根因**：旧 `pageSubmit()` 只扫
`.maskDiv,.layui-layer,.dialog,.popup,.modal,[class*=mask|dialog|popup|layer]`，
而 `.Alertcon2#confirmWin` 一个都不匹配。

另一个坑：`#prevNextFocusNext`（右下「下一节」）在旧版学习页**只切任务标签、不改地址**，
真「下一节」必须走左侧目录（`span.posCatalog_name` / `getTeacherAjax(courseId,clazzid,chapterId)`）。
cx.js 里已有这套逻辑，engine 现在直接委托它。

---

## 二、自动提交链路（1.8.13 现状）

1. `brush.js` 顶层无条件启动：`watchAutoAnswer` / `watchAutoSubmit` / `watchQuizIdle`。
2. `watchAutoSubmit`（engine.js）：只顶层跑，6 秒一轮；`looksLikeWorkPage()` 且非 `isExamPage()`；
   所有题 `questionAnswered()` 后缓 4 秒复核，再发 `AUTO_SUBMIT_PAGE`；成功 3 秒后 `jumpNextOnce('auto-submit')`。
3. `watchQuizIdle`（engine.js）：识别到题后若 10 秒无新作答 → **强制提交（允许空题）** → 3 秒后跳节。
   1.8.11 卡在 `answerBusy` 门槛上，1.8.12 已删。
4. `AUTO_SUBMIT_PAGE`（sw2.js:200）用
   `chrome.scripting.executeScript({ target:{tabId,allFrames:true}, world:'MAIN', func: pageSubmit })`，
   收集所有 frame 的结果，优先取 `ok:true`。
5. `pageSubmit()` 在 **`extension\pageSubmit.js`**（单独文件，`sw2.js` 第 11 行 `importScripts('pageSubmit.js')`；
   mock 页直接 `<script src="/extension/pageSubmit.js">` 共用同一份 —— 别再复制两份）。

### pageSubmit.js 行为（重写版）

- 找按钮：先硬选择器 `a.btnSubmit,button.btnSubmit,.btnSubmit.workBtnIndex,.workBtnIndex,#submitBtn,#btnSubmit,#submitWork,input[type=submit][value*="提交"]`，
  找不到再按文字（`SUBMIT_TEXT` 白名单 + `NEVER` 黑名单排除「暂时保存/取消/上一节」），并排除题目内部（`IN_QUESTION`）。
  多个候选时取**最靠下**的那个（顶部常有分页小按钮）。
- 点击前：`window.confirm=()=>true`、`window.alert=()=>{}`，并补 `mouseover/mousedown/mouseup` 再 `click()`。
- 确认框：4.5 秒内每 250ms 扫 `DLG_SEL`（含 `#confirmWin`,`.Alertcon2`,`#popup_container`,`.layui-layer`,`.el-message-box`,`[role=alertdialog]` …），
  用 `looksLikeDialog()`（fixed/absolute 或 zIndex>100 或 >120x60）过滤，点 `YES_TEXT` 且非 `NO_TEXT` 的按钮。
- **跨 frame**：`collectDocs()` 会扫 self / top / parent / 同源 iframe 的 document，结果里带 `dialogFrame`。
  （模板可能把按钮放 iframe、把确认框挂顶层。）
- 返回：`{ok,href,title,frames,picked,by,click,dialog,dialogFrame,yes,waited,why,near?,hasIframe?,iframeReachable?}`。
  `why` 取值：`submitted-with-confirm` / `clicked-no-dialog` / `click-failed` / `navigating` / `no-button`。

---

## 三、跳节链路（1.8.13 现状）

`chaoxingJumpNext()`（engine.js）：

1. `settings.autoJump` 关 → 直接 false。
2. `window.SXKCX.jumpNext(true,'engine-next')` 成功 → 记 `chaoxing-jump:用 cx 目录逻辑跳下一节`。
3. **cx 返回 false 时直接 return false，不再回退点 `#prevNextFocusNext`**（那只切任务标签，会把状态点乱）。
4. 没有 CX 时才走简单点按（`#prevNextFocusNext` / `.popBottom .nextChapter` / 文字「下一节」，会进 iframe 找）。

`jumpNextOnce(tag)`：8 秒去重；跳失败 → `scheduleJumpRetry(tag)`：每 9 秒重试、最多 4 次、href 变了就停。
**原因**：cx 有 `GAP_JUMP_MS = 25000` 限流，而「提交完成」那一刻经常正好落在限流窗口里，
不重试就是「提交完卡在这一节不动」。

---

## 四、本版改的文件（全在 extension/ 与 tools/）

| 文件 | 改动 |
| --- | --- |
| `extension\pageSubmit.js`（新，10.6KB） | 提交执行器重写；跨 frame 找确认框；`#confirmWin` 支持 |
| `extension\sw2.js` | 删除内联 pageSubmit，改 `importScripts('pageSubmit.js')`（第 11 行） |
| `extension\engine.js` | ①`chaoxingJumpNext` 委托 cx + 不回退；②`scheduleJumpRetry`；③`looksLikeWorkPage` 加 `extractQuestions()` 兜底；④`optsIn` 加 radio/checkbox 反推行兜底；⑤诊断日志（首轮体检 / 提交结果 / quiz-idle 心跳 / jump-retry） |
| `tools\package.js` | `EXCLUDES` 增加 `shots`,`logs`（原来把 1.1MB 运行截图打进包，包体 1.2MB→206KB） |
| `tools\mock-old-*.html`（新增 5 个） | 真机结构 1:1 的浏览器回归页 |
| `tools\serve-test.js`（已有） | `node tools\serve-test.js` → `http://127.0.0.1:3011` 静态服务项目根目录 |

版本：`node tools\set_version.js 1.8.13` → manifest + server.js 都写 1.8.13；`node tools\package.js` → `dist\刷小课-1.8.13.zip`。

---

## 五、mock 回归（真浏览器，全 PASS）

起服务：`cd D:\answertole\shua-xiaoke; node tools\serve-test.js`（后台；日志 `probe\serve3011.log`）

| 页面 | 验证点 | 结果 |
| --- | --- | --- |
| `/tools/mock-old-work.html` | `pageSubmit()` 在真机同结构页：选中 `a.btnSubmit.workBtnIndex`、弹 `#confirmWin` 后点「确定」、**不误点「暂时保存」** | PASS（picked=`提交\|btnSubmit workBtnIndex`，dialog=`#confirmWin.Alertcon2`，waited≈264ms） |
| `/tools/mock-old-frames.html` | 按钮在 iframe、确认框在**顶层** | PASS（`dialogFrame=top`，顶层 `__topSubmitted=1`） |
| `/tools/mock-old-study.html?mode=answered` | 全部答完 → `AUTO_SUBMIT_PAGE` → 跳节 | PASS（约 15s） |
| `/tools/mock-old-study.html?mode=idle` | 留空题 → 10 秒兜底强制提交 → 跳节 | PASS（约 16s） |
| `/tools/mock-old-nested.html` | `studentstudy → #iframe → 内层 iframe` 嵌套结构 | PASS（体检日志 `iframe=ok:0` 但 `work=true`，正是嵌套兜底生效的证据） |

`mock-old-study*.html` 用 `window.chrome.runtime.sendMessage` stub 模拟后台，settings 全是 true。

---

## 六、真机当前状态与唯一未完成项

`probe\edge-1.png` 里那个 tab 上方有 Chrome **「已在调试程序中暂停」** 横幅：
用户自己在 DevTools 里点了断点/暂停，JS 全冻结 → 内容脚本定时器全停，
这就是 07:54:51 之后 `/api/state` 里**再也没有** `quiz-idle`/`auto-submit`/`auto-answer` 日志的原因（不是逻辑 bug）。
另外 `/api/state` 显示 07:56:49 扩展被重载过，之后没有新的 `chaoxing loaded` → 老 tab 的 content script 已孤立。

所以：**1.8.13 的真实页端到端还差用户做三步**
① 点 ▶ 恢复（或关掉 DevTools）→ ② `edge://extensions` 关再开「刷小课」（应显示 1.8.13）→ ③ 回页面 F5。

然后按顺序查 `/api/state`（node 取，web_fetch 访问不了 127.0.0.1）：

1. `chaoxing:loaded`（content script 活了）
2. `auto-submit:监控启动 submit=true answer=true`
3. `auto-submit:首轮体检 work= exam= 顶层题= iframe=...`
4. `auto-submit:全部 N 题已作答,准备提交` 或 `quiz-idle:已 10 秒无新作答,执行兜底`
5. `auto-submit:已触发提交:提交 | by=... dialog=... frame=... yes=... wait=...ms why=...`
6. `chaoxing-jump:用 cx 目录逻辑跳下一节` / `cx-jump:第 N 次推进:目录 ... → ...` / `jump-retry:第 N 次重试下一节 成功`

若第 5 步 never 出现 → 看第 3 步体检；若第 5 步出现但页面没动 → 看 `why/dialog/frame`。

---

## 七、坑（继续踩过的）

- `web_fetch` **不能**访问 `127.0.0.1`（hostname resolves to non-public IP）→ 查本地后端用 `node -e "fetch(...)"` 或 `Invoke-WebRequest`。
- 该机器 pwsh 实际是 **Windows PowerShell 5.1**：`node -e "...\"...\""` 的转义会被吞掉，报 `String is missing the terminator`。
  → 写 `.js` 脚本文件再 `node 它`，或用 `edit` 工具。`Select-String` 输出中文会变乱码，读中文代码用 `read` 工具。
- PowerShell 参数名 `$Pid` 是只读变量，会报「无法覆盖变量 Pid」→ 用 `$ProcId`。
- UIA 读不到 Edge 网页内容（`documents=0`，需要 `edge://accessibility` 勾上 Native/Web accessibility）；
  读网页真实 DOM 最省事的路就是**窗口截图 + 让扩展自己 dump**。
- CDP `127.0.0.1:9222` 是关的，`tools\cdp_eval.js` 那套用不了。
- 扩展更新后必须 `edge://extensions` 关再开 + 页面 F5，否则老 content script 继续跑。
- `pageSubmit` 两份副本的教训：mock 全绿但真机失败过一次（sw2 那份是旧的）。现在统一到 `extension\pageSubmit.js`，只此一份。

---

## 八、下一步可做（非阻塞）

1. 真机端到端验证（见第六节），把第 5 步日志贴进交接。
2. 若真机确认框在别的域名 frame（非同源），`collectDocs` 读不到 → 需要在每个 frame 各自轮询（当前 allFrames 已经会各跑一次，够用）。
3. 提交成功后页面可能弹「提交成功」遮挡层或停留原地，可加「提交后检测 `已提交/我的答案` 文案再跳」。
