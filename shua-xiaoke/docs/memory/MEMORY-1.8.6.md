# 刷小课 1.8.6 交接记忆

> 1.8.5 的完整模块说明仍看 `MEMORY-1.8.5.md`；本文件只记录 1.8.6 的增量。

## 版本与产物
- 版本：1.8.6（manifest / server.js 均已改）。
- 包：`dist\刷小课-1.8.6.zip`（16,049,114 字节，15,673 KB）。
- 后端：`node server\server.js`，端口 3001，控制台 `http://127.0.0.1:3001/ui`。
- 磁盘上的 server.js 已是 1.8.6；如果 3001 还在跑旧进程，`/api/health` 仍会显示 1.8.5，重启后端即可。

## 本轮改动
### 1) 学习页不能继续下一节（用户 2026-10-25 新报）
关键发现（真机 `mooc1.chaoxing.com/mycourse/studentstudy`）：
- 新版页面顶部有任务标签 `#dct1`(PPT) / `#dct2`(教材) / `#dct3`(视频)，class 是 `c1/c2/c3`，active 用 class 表达。
- `#prevNextFocusNext` 的文案是「下一节」，但它真实行为是**切到下一个任务标签**，顶层 URL 不变；旧代码只看 `location.href` 是否变化，切标签被误判「空跳」，两次后 `stop`。
- 左侧目录项是 `div.posCatalog_select`，可点击的是内部 `span.posCatalog_name`（带 `onclick="getTeacherAjax(courseId,clazzid,chapterId)"`）；点外层 div 不会触发。
- 当前节完成后目录项带 `span.icon_Completed`（内含「已完成」）；真机 PDF 任务 iframe 里**不会**出现旧的 `.ans-job-finished`，所以旧逻辑一直等超星打完成标记，卡 100 多秒。

`extension\cx.js` 已改：
- 新增 `studyTabs/studyTabState/tabText`，按 active class 推进任务标签。
- `jumpNext`：还有下一个标签就点标签；最后一个标签完成才走目录下一节。
- 新增 `catalogItems/catalogCurrent/catalogNext`。
- 新增 `clickCatalog`，点 `span.posCatalog_name` 而不是外层 div。
- 新增 `catalogChapterId`（从 onclick 的 `getTeacherAjax(...)` 取最后一段 6 位以上数字）和 `goCatalog`（直接改 URL 的 `chapterId`），作为隔离世界无法调页面函数、合成点击不生效时的兜底。
- `taskFinished` 文档分支先看当前目录的 `.icon_Completed` 或文案「已完成」，命中直接算完成。
- 诊断日志增加「任务标签」「当前/下一目录」「目录DOM」「目录完成」。

真机验证：
- 已看到 `第 2 次推进:任务标签 2教材 → 3视频`，视频正常播放。
- 视频结束时已触发 `第 3 次推进:目录 1.1.2 命题公式及分类 → 1.1.3 章节测验1`；当时目录项 click 没反应，随后在 DevTools 用真实 `getTeacherAjax('249709761','153142699','949073938')` 验证 URL 确实能跳到 1.1.3，故加了 chapterId 直跳兜底。**兜底后的自动跳节尚未再跑一遍真机全流程。**

### 2) 自动答题（用户最初的核心诉求）
- 真机作业页是 `mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork`，选项不是 `input+label`，而是：
  - `.fanyaMarking_left .questionLi.singleQuesId`
  - `.stem_answer > .answerBg`，带 `qid`、`qtype`（0 单选/1 多选）、`onclick="addChoice(this)"` 或 `addMultipleChoice(this)`。
  - 字母在 `.num_option`（多选 `.num_option_dx`）的文本里；内部值在它的 `data` 属性；选中 class 是 `check_answer`（多选 `check_answer_dx`）；保存字段是隐藏的 `input#answer<qid>`。
- `extension\engine.js` 已加 mooc2 适配层：`mooc2Rows/mooc2State/mooc2SavedInput/applyMooc2Answer`，点击选项行并回读 class/aria/隐藏字段；题干不再混入选项文字，选项图不再误当题干图；`applyAnswer` 改为 async。
- 本地证据：`tools\mock-mooc2.html` 回归 14/14；`tools\probe_work.js` 旧 mock 回归 18/18。
- **真实作业页尚未复测**（用户还没重新打开 dowork 页）。复测时看 `/api/state` 的 `work-dom`（`mooc2-doc`、`mooc2-all`、每题 `qid/type/multi/rows/sel/saved/ariaBad/wrong/letters`）以及 `没选上` 日志里的 `[mode 可选=... 选中=... 保存=...]`。

## 操作注意
- 扩展是解压目录加载：`D:\answertole\shua-xiaoke\extension`；改完代码必须到 `edge://extensions` **关闭再打开**「刷小课」开关，再 F5，仅点刷新可能还是旧内容脚本。
- 不要反复 `taskkill /f`，会丢超星登录态；用日常 Edge + 默认配置。
- 打包：`node tools\package.js`；改版本：`node tools\set_version.js 1.8.6`。
- 用户要求：讲中文；视觉证据优先；其他模块先不要动；最终要能点一下用、能打包。

## 待办
1. 打开真实 `mooc-ans/mooc2/work/dowork` 作业页，验证自动做题能否逐题选中并写回；如果仍 `没选上`，抓 `work-dom` 和失败日志继续修。
2. 再跑一遍学习页 1.1.2 → 1.1.3 的完整自动跳节，确认 `目录点击没反应` 时 chapterId 直跳真的生效。
3. 后端重启到 1.8.6，扩展重载 1.8.6 后做最终用户验收。
