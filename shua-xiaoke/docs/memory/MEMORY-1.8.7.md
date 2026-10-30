# 刷小课 1.8.7 交接记忆（自动答题 / 填空题）

日期：2026-10-25
项目：D:\answertole\shua-xiaoke
后端：node server\server.js，端口 3001，控制台 http://127.0.0.1:3001/ui
当前版本：1.8.7
包：dist\刷小课-1.8.7.zip

## 这版改了什么
1. 学习页「下一节」：新版 studentstudy 的 `#prevNextFocusNext` 实际是切换任务标签（PPT/教材/视频），不是下一节。代码按 `#dct1/#dct2/#dct3` 的 active class 逐个推进；最后一个标签完成后点左侧目录下一节；目录点击 3 秒不跳时读 `getTeacherAjax(...)` 里的 chapterId 直接改 URL。
   - 重要补充：`cx.js` 在 iframe 里也有一份，iframe 里 `catalogCurrent()` 永远拿不到左侧目录，所以 `taskFinished()` 里的 `icon_Completed` 分支在 iframe 里是死路。1.8.7 改为**顶层 tick 直接检查目录当前节是否 icon_Completed**，完成就 `jumpNext(false,'目录已完成')`，不再等 iframe 的 taskFinished。
2. 文档完成判定：左侧目录 `span.icon_Completed` / 「已完成」也算完成，不再死等 iframe 的 `.ans-job-finished`（真机 PDF 不打这个标记）。
3. 自动做题（mooc2）：新版选项是 `.stem_answer .answerBg`，按 `.num_option`/`.num_option_dx` + `check_answer`/`check_answer_dx` + hidden `answer<qid>` 回读；旧的 input+label 路径保留。
4. 填空题（本轮重点）：
   - 真机旧版 `/mooc-ans/work/doHomeWorkNew` 的填空是 **UEditor**：每题一个隐藏 textarea（id `answerEditor<qid>`）+ 一个 `iframe#ueditor_N`。
   - `fillUEditor()` 向 iframe body 插入文本（execCommand，失败则 innerHTML），并同步 textarea；`fillTextAnswer()` 同时兼容普通 input/textarea/contenteditable。
   - 普通输入框用原型 value setter + InputEvent/change/keyup。
   - 已填过的题按 iframe/textarea/contenteditable 是否有内容跳过，防止二次覆盖。
   - 模型把题干复述当答案（「题目要求…」「这看起来是乱码…」等）时丢弃，不写。
   - 截图先截题目容器；被裁切时回退整页可见区域，并留 90px 上边距。

## 真机验证到哪一步
- 真实填空页 `studentstudy?chapterId=950684951`（1.1.10 章节测验3，旧版 doHomeWorkNew，20 题：0-6 单选、7-14 填空、15-19 判断）。
- 已确认写回成功：q8=`1`、q9=`¬B`、q10=`¬A`、q11=`无关`、q12=附加、q15=`CP` 等；q13 因截图当时没截到题干而空白，q8 一度被模型复述覆盖，已加「已填跳过 + 丢弃复述」防止再发生。
- 真实作业页（mooc2 dowork）尚未重新验证；1.8.5 时代真机全失败是因为旧选择器没有 `.answerBg`。
- 自动提交 `autoSubmit` 始终为 false，未点提交。

## 关键文件
- extension\engine.js：mooc2 写回、UEditor/填空写回、截图、answerPass。
- extension\cx.js：学习页跳节（任务标签 + 目录 + chapterId 直跳）。
- extension\manifest.json：version 1.8.7。
- tools\mock-mooc2.html、tools\mock-study.html、tools\serve-test.js：本地 mock 回归（1.8.6 时 14/14 + 4/4）。
- _ref\sources_question-parser.js、sources_question-actions.js：新版 mooc2 DOM 契约参考。
- CHANGELOG.md：1.8.6 / 1.8.7 条目。

## 下一步
1. 在 Edge 扩展页把「刷小课」关闭再启用（或点重新加载），刷新作业页；确保侧边栏版本显示 1.8.7。
2. 打开真实作业页，确认 `work-dom` 里 `mooc2-doc=true` 或旧版 20 题；看 `chaoxing-auto` 的 `[mooc2-...]`/`[input/...]` 是否 ok。
3. 若填空题仍空，先看 `work-dom` 的 `#N fields=` 行：是 input / textarea / contenteditable / iframe；再看 `shot-fail` 是否「可见区域太小」。
4. 不要自动提交；需要时手动「暂时保存」。
