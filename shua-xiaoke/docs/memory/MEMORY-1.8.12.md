# 刷小课 · 记忆交接（截至 1.8.12，2026-10-25）

> 给下一个 agent：先读完这一份再动手。项目在 `D:\answertole\shua-xiaoke`，工作目录 `D:\answertole`。
> 更早的环境细节在 `MEMORY-1.8.10.md`；1.8.11 的 10 秒兜底说明在 `MEMORY-1.8.11.md`；这一份覆盖 1.8.12 的最新状态。

## 0. 一句话现状

- 自动答题：mooc2 新版选择题、旧版选择题、判断题、填空题（UEditor）都已适配；mock 全过，真实页大部分题能写回。
- 自动提交：`watchAutoSubmit` + `pageSubmit` 已实现，两个 mock 单测过；**真实 29 题章节测验还没端到端提交过**。
- 学习页跳节：任务标签、目录 `chapterId` 直跳、10 秒文档兜底都已进包；**真实页面是否生效仍待用户重载 1.8.12 后验证**。
- 当前最关键的未验证点：用户 1.1.6 章节测验页日志里一直没有 `quiz-idle`，1.8.12 已去掉挡住兜底的 `answerBusy` 门槛，等重载后看启动日志。

## 1. 用户目标与红线

- 原始目标：修好「刷小课」自动答题；先搞懂网站真实元素操作逻辑，再改扩展；其他模块不要动（m00001）。
- 后续追加：
  - 学习页不能继续下一节（m00402、m01560）。
  - 填空题写不了（m01168）。
  - 把自动提交落实（m01675）。
  - 题目完成后 10 秒没动静直接下一节，允许空题（m02134）。
  - 真机仍不跳，要求看日志报告（m02237）。
- 红线：
  - 必须用用户日常 Edge + 默认配置，不临时 profile 干活。
  - 不要反复 `taskkill /f`，会丢超星登录态。
  - 讲中文。
  - 视觉证据优先；最终要“点一下能用”、可打包。
  - 不要动视频/文档/侧边栏以外无关模块；改自动答题/跳节/提交为主。

## 2. 环境与常用命令

- 扩展：MV3，Edge 加载解压目录 `D:\answertole\shua-xiaoke\extension`；service worker = `sw2.js`。
- 后端：`node server\server.js`，端口 3001；控制台 `http://127.0.0.1:3001/ui`。
- 当前版本：`1.8.12`；包：`dist\刷小课-1.8.12.zip`（195,844B）。
- 健康检查：`Invoke-RestMethod http://127.0.0.1:3001/api/health`。
- 最近日志：`/api/state` 只返回最后 100 条（内存 500 条）；`/api/cxlog` 返回 `{ok:true,items:[...]}`，最多 20 条，别当数组。
- 升版本：`node tools\set_version.js 1.8.12`
- 打包：`node tools\package.js`
- 语法检查：`node --check extension\engine.js`、`node --check extension\cx.js`。
- 重启后端（不要乱杀进程）：
  ```powershell
  $c=Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object -First 1
  Stop-Process -Id $c.OwningProcess
  Start-Process -FilePath 'D:\Node\node.exe' -ArgumentList 'server\server.js' -WorkingDirectory 'D:\answertole\shua-xiaoke' -WindowStyle Hidden
  ```
- 扩展更新后，用户必须在 `edge://extensions` 把「刷小课」**关闭再打开**，然后回页面 F5；只点“刷新”或只 F5 可能仍跑旧 content script。
- 关键安全项：`autoSubmit` 默认 false；开着时 10 秒兜底会强制提交（允许空题），真实页测试时要先确认。

## 3. 代码结构 / 关键位置

- `extension\engine.js`（约 1206 行）：共享答题引擎，`window.__SXK`。
  - mooc2 适配：`isMooc2Doc`、`mooc2Rows`、`mooc2State`、`mooc2HasSelection`、`decodeMooc2Saved`、`pressRow`、`applyMooc2Answer`。
  - 旧版答题：`clickOption`、`applyAnswer`、`fillTextAnswer`、`fillUEditor`、`nativeSetValue`、`fillHasValue`。
  - 自动提交：`watchAutoSubmit`、`questionAnswered`、`isExamPage`。
  - 10 秒兜底：`watchQuizIdle`、`jumpNextOnce`。
- `extension\cx.js`（约 1400 行）：学习页视频/文档/跳节。
  - `studyTabs`、`studyTabState`、`catalogItems`、`catalogCurrent`、`catalogNext`、`clickCatalog`、`catalogChapterId`、`goCatalog`。
  - `jumpNext`：先任务标签，后目录，旧路径也跨 iframe 查 `#prevNextFocusNext`。
  - `taskFinished`：文档分支有 10 秒兜底；顶层 `tick()` 有 `icon_Completed` 判断和 `allStuck` 兜底。
- `extension\sw2.js`：`pageSubmit()` 主世界提交；`AUTO_SUBMIT_PAGE` 用 `chrome.scripting.executeScript({allFrames:true,world:'MAIN'})`。
- `extension\brush.js`：启动 `watchAutoAnswer`、`watchAutoSubmit`、`watchQuizIdle`。
- `extension\sidebar.js`：`data-set="autoSubmit"` 开关。
- `server\server.js`：`/api/solve`、`/api/state`、`/api/cxlog`、mock 页。

## 4. 已修好的关键逻辑

### 4.1 新版 mooc2 选择题（真实 `/mooc-ans/mooc2/work/dowork`）

- 每题：`.fanyaMarking_left .questionLi.singleQuesId`，`data-questionid`、`typename`。
- 选项行：`.stem_answer .answerBg`，`onclick="addChoice(this)"` / `addMultipleChoice(this)`，`qid`、`qtype`。
- 字母：`.num_option`（单选/判断）或 `.num_option_dx`（多选）；选中类在 marker 上：`check_answer` / `check_answer_dx`。
- 内容：`.answer_p`；隐藏保存字段：`input#answer<qid>`。
- 点击目标是整行 `.answerBg`，不是 input；旧 engine 完全没适配，改为 `applyMooc2Answer` 后 mock 14/14 过。

### 4.2 旧版 `/mooc-ans/work/doHomeWorkNew` 选择题

- 旧版 radio/label 仍可用；`applyAnswer` 异步，兼容 `q.mooc2` 和普通题。

### 4.3 填空题 / UEditor

- 真实填空题页 `#7-#14`，每题 `.TiMu` 内有一个 UEditor iframe（id `ueditor_0..7`）和隐藏 textarea。
- `fillTextAnswer(root, raw)`：
  - 收集可见的 `input[type=text]`、`input:not([type])`、`textarea`、`[contenteditable=true]`、`.edui-body-container`；
  - `nativeSetValue` + `fireFieldInput`；
  - `fillUEditor` 在 iframe body 里 `execCommand('insertText')`，同步隐藏 textarea；
  - 90ms 后回读验证。
- 已真机写回：q8=`1`、q9=`¬B`、q10=`¬A`、q11=`无关`、q12=`附加`、q15=`CP`。
- 已知残留：q13（`(¬A→B)∧(B→¬C)⇒¬A→¬C`，答案“假言三段论”）因截图没截到题干而空白；q14（析取三段论）也可能没补。`fillHasValue` 已加，防已填题被二次覆盖。

### 4.4 学习页跳节

- 新版 `#prevNextFocusNext` 的语义是 **下一个任务标签**（PPT/教材/视频），不是下一章；只点它会在 URL 不变时被误判“空跳”。
- 真正的下一节在左侧目录：`div.posCatalog_select.posCatalog_active#cur<chapterId>`，内部 `span.posCatalog_name[onclick="getTeacherAjax(courseId,clazzid,chapterId)"]`。
- 当前实现：
  - 先点下一个任务标签；标签走完（已是最后一个）后点目录下一节；
  - 目录点击无反应时，用 `catalogChapterId` 解析 `getTeacherAjax` 最后一个长数字，`goCatalog` 直接改 `chapterId` 跳；
  - 目录当前节有 `span.icon_Completed`（“已完成”）就推进；
  - 文档任务 10 秒仍无 `.ans-job-finished` 时按已读推进。
- 真实日志曾出现：`第 1 次推进:任务标签 1PPT → 2教材`、`第 3 次推进:目录 1.1.2 → 1.1.3`，但目录 click 没触发平台；`getTeacherAjax` 手动调用可改 URL，故有 chapterId 直跳兜底。

### 4.5 自动提交

- `watchAutoSubmit(tag)`：
  - 仅顶层帧；
  - 要求 `settings.autoSubmit && settings.autoAnswer`；
  - 6 秒一查，首跑 5 秒；
  - 全部题已答（`questionAnswered`）后缓 4 秒复核；
  - 发 `AUTO_SUBMIT_PAGE`；日志 `auto-submit`；
  - 成功后 3 秒 `jumpNextOnce('auto-submit')`。
- `pageSubmit()`：
  - 可见、未 disabled；
  - 精确匹配 `提交|提交作业|交卷|提交答案|确定提交|提交试卷`；
  - 排除暂存/保存/取消/返回/解析；
  - 覆盖 `window.confirm`，点页面最下方最终提交；
  - 900ms 后扫弹层“确定/确认/提交/是/继续”；
  - 返回 `{ok,text,modalClicked,href}`。
- 真实提交按钮：`button.btnSubmit.workBtnIndex`（文字“提交”，无 id），在 `#iframe` 内；`allFrames:true` 能点到。
- mock 测试：
  - `tools\mock-submit.html`：`pageSubmit` 返回 `{ok:true,text:"提交",submitted:"1"}`。
  - `tools\mock-autosubmit.html`：`watchAutoSubmit` 日志走完 `监控启动` → `全部 2 题已作答,准备提交` → `已触发提交:提交`。
- 真实端到端未做，避免替用户误交。

### 4.6 10 秒兜底（1.8.12 重点）

- `watchQuizIdle(tag)` 仅顶层；条件：`autoAnswer` 开、`looksLikeWorkPage()`、非考试页、识别到题。
- 连续 10 秒 `lastAnswerAt` 无更新：
  - `autoSubmit` 开：先 `AUTO_SUBMIT_PAGE` 强制提交（允许空题），3 秒后 `jumpNextOnce`；
  - 关：直接 `jumpNextOnce`。
- `jumpNextOnce` 用 `lastJumpAt/lastJumpHref` 做 8 秒去重。
- **1.8.11 的 bug**：`if (!qs.length || answerBusy) return;`。真实 `SOLVE` 可能挂住，`answerBusy` 一直 true，兜底永远不触发。
- **1.8.12 修复**：
  - 删掉 `answerBusy` 门槛，只看 `lastAnswerAt`；
  - `answerPass` 每开始处理一道题就 `lastAnswerAt = Date.now()`；`autoAnswerAll` 每道题也刷新；
  - 启动日志 `quiz-idle:监控启动 autoAnswer=... autoSubmit=... autoJump=...`；
  - 验证 `tools\mock-idle-hung.html`（`SOLVE` 永不 resolve）PASS：`已 12 秒无新作答` → `chaoxing-jump:clicked` → `nextClicks=1`。

## 5. 真机现场与日志证据

- 当前用户页面曾停在：`https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=950681239&...`，章节 **1.1.6 章节测验2**，29 题。
- 07:44–07:46 日志：
  - 只有 `chaoxing-auto ...` 和 `auto-answer ... 已作答 8 题(共识别 29 题)`；
  - 没有 `quiz-idle`；
  - `/api/cxlog` 显示版本 1.8.11，任务 `#0 work fin=0 done=0`，目录 `1.1.6`，`icon=false`，跳节次数 0。
- 说明 1.8.11 兜底没跑（旧 content script 或 `answerBusy` 卡住）；1.8.12 已去掉卡点，但**还没拿到 1.8.12 的真实日志**。
- 用户尚未确认重载；最后一步已告诉他：`edge://extensions` 关闭再开 → F5 → 看 `quiz-idle:监控启动`。

## 6. 待办 / 下一步

1. **最高优先**：让用户重载 1.8.12，打开 1.1.6 章节测验页，F5，确认 `quiz-idle:监控启动` 出现。
   - 若没有：内容脚本没更新，检查扩展卡片版本；必要时用 UIA 点“重新加载”再关闭/开启。
   - 若有启动但没有“已 10 秒无新作答”：看 `lastAnswerAt` 是否被每道题刷新，或 `looksLikeWorkPage()` 是否 false。
2. 真实 29 题端到端：
   - 开 `autoAnswer + autoSubmit`，等 8/29 答完后应 10 秒强制提交（允许空题），再点下一节；
   - 观察 `auto-submit` / `quiz-idle` / `chaoxing-jump`；不要替用户手动提交。
3. q13 题干截图裁剪问题：
   - `needShot` 时已 `scrollIntoView({block:'start'})` + `scrollBy(0,-90)`，仍可能只截到后续题；
   - 可改为对 `.TiMu` 取 `getBoundingClientRect` 并临时放大视口/用 `document.body` 兜底。
4. 学习页跳节最终验证：任务标签 + 目录 + 10 秒文档兜底已打包；真实页还没看到“自动跳到下一节”的完整日志。
5. 自动答题剩余空题：q13/q14 需要人工或更稳的截图；不要为了补题反复覆盖已填题（`fillHasValue` 已防重复）。

## 7. 已知坑

- **编码**：用 PowerShell `Get-Content -Raw` + `Set-Content` 改中文会按 ANSI 读写，曾把 `cx.js` 写坏（`SyntaxError: Unexpected token 'function'`）。以后改这些文件必须用 Node `fs.readFileSync(...,'utf8')` / `writeFileSync`，或 `write`/`edit` 工具；改完 `node --check`。
- PowerShell `ConvertFrom-Json` 读 `manifest.json` 也会因无 BOM 乱码报错；验证版本用 `node -e "require('./extension/manifest.json').version"`。
- `cx.js` 备份：`_backup\cx-1.8.5.js`；1.8.8 包内也有可用 `extension/cx.js`。
- `/api/cxlog` 返回对象不是数组；`/api/state` 只留 100 条。
- `#prevNextFocusNext` 在章节测验页的 `#iframe` 内；顶层 `document.querySelector` 找不到。
- Edge 的 UIA 网页树默认可能只给浏览器按钮；需要 `edge://accessibility` 勾选 Native accessibility + Web accessibility（曾用 UIA 恢复）。
- 物理坐标/截图缩放不一致：截图 1707×1067，屏幕 2560×1600，鼠标要用物理坐标；优先 UIA，少用坐标。
- 扩展重载必须“关闭再打开”，否则 content script 可能是旧缓存。
- `autoSubmit` 会强制提交空题，测试真实页前先确认用户同意。

## 8. 关键文件

- `extension\engine.js`：mooc2、填空、自动提交、10 秒兜底。
- `extension\cx.js`：学习页任务标签、目录跳节、文档兜底、iframe 下一节。
- `extension\sw2.js`：`pageSubmit` + `AUTO_SUBMIT_PAGE`。
- `extension\brush.js`：启动三个 watcher。
- `extension\sidebar.js`：自动提交开关。
- `server\server.js`：solve/state/cxlog/mock。
- `tools\mock-mooc2.html`、`tools\mock-idle.html`、`tools\mock-idle-hung.html`、`tools\mock-autosubmit.html`、`tools\mock-submit.html`、`tools\serve-test.js`。
- `dist\刷小课-1.8.12.zip`（195,844B）。
- `MEMORY-1.8.10.md`、`MEMORY-1.8.11.md`、本文件。

## 9. 当前版本记录

- 1.8.6：学习页任务标签/目录跳节初版，mooc2 初版。
- 1.8.7：目录完成 icon、chapterId 直跳、填空初版。
- 1.8.8：文档 10 秒兜底（原 45 秒）。
- 1.8.9：自动提交 + sidebar 开关 + iframe 提交。
- 1.8.10：章节测验 iframe 下一节。
- 1.8.11：题目完成 10 秒兜底（但被 `answerBusy` 挡住）。
- 1.8.12：去掉 `answerBusy` 门槛，挂住的 SOLVE 也能兜底；新增 `quiz-idle:监控启动` 日志；mock hung PASS。
