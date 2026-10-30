# 刷小课 · 1.8.10 交接记忆

## 项目
- 目录：`D:\answertole\shua-xiaoke`
- 后端：`node server\server.js`，端口 3001，控制台 `http://127.0.0.1:3001/ui`
- 当前版本：**1.8.10**，包：`dist\刷小课-1.8.10.zip`（约 192 KB，已清理测试截图）
- 扩展加载方式：Edge `edge://extensions` 里加载解压目录 `extension`；改代码后必须关闭再打开扩展开关，再 F5 页面。

## 1.8.10 修了什么
1. **章节测验/作业页「提交 + 下一节」**
   - 真实页面 `studentstudy?chapterId=...` 的「提交」是 `button.btnSubmit.workBtnIndex`（文字「提交」，无 id）；
   - 「下一节」是 `#prevNextFocusNext`（class `jb_btn ...`），它们都在 `#iframe` 里，顶层 `document.querySelector` 找不到。
   - `extension\cx.js` 的 `jumpNext` 已改成遍历 `document + #iframe + 内层 iframe`，按 id / `a.nextChapter` / 可见文字「下一节」兜底。
   - `extension\engine.js` 的 `chaoxingJumpNext` 同样改成 `collectRoots(false)` 跨 iframe 查找。
   - `engine.js watchAutoSubmit` 在 `AUTO_SUBMIT_PAGE` 成功后，如果 `settings.autoJump` 开着，会延迟 3 秒调用 `chaoxingJumpNext`，日志 `提交后已点下一节` / `提交后没找到下一节按钮`。
2. 自动提交（1.8.9 起）
   - 侧边栏「自动提交」开关 `data-set="autoSubmit"`，默认 false。
   - `watchAutoSubmit` 只在作业/章节测验页、`autoSubmit && autoAnswer` 时工作；全部题答完才提交，提交前 4 秒复核。
   - `sw2.js pageSubmit` 在主世界按精确文字找「提交/交卷/提交答案」等按钮，临时覆盖 `confirm`，点自定义弹窗「确定」，返回 `{ok,text,...}`。
3. 学习页跳节
   - 1.8.6 起按 `#dct1/#dct2/#dct3` 任务标签推进；最后一个标签后点左侧目录下一节。
   - 1.8.7 顶层直接看目录 `span.icon_Completed`，避免 iframe 里拿不到目录。
   - 1.8.8 文档滚到底 10 秒仍无完成标记就强制推进。
4. 自动答题/填空
   - 新版 mooc2 选项 `.stem_answer > .answerBg`，按 `.num_option/check_answer` 回读；旧版作业 UEditor 用 `fillTextAnswer` 写 iframe body + 同步隐藏 textarea。
   - 已答题跳过（`fillHasValue`），防覆盖。

## 已验证 / 未验证
- 已验证：mock 作业页 14/14；`probe_work.js` 18/18；`pageSubmit` 纯函数 `{ok:true}`；`watchAutoSubmit` mock 输出「全部 2 题已作答/已触发提交」；1.8.10 包内 `cx.js` 含 iframe 查找、`engine.js` 含提交后跳节。
- 未验证：真实超星 **29 题章节测验** 的自动提交 + 提交后下一节；需要用户开「自动做题 + 自动提交 + 自动跳节」后观察。
- 已知风险：q13 之类题干截图裁切可能仍空白；`questionAnswered` 对少数题型可能误判；`autoSubmit` 默认关闭，避免误交。

## 调试入口
- 后端日志：`GET http://127.0.0.1:3001/api/state`（最后 100 条），`/api/cxlog`（最近 20 条诊断 dump）。
- 页面诊断：侧边栏「诊断日志」按钮（聚焦页面后按物理坐标点）。
- 真机 DOM 可用 Edge `edge://accessibility` 打开 Native/Web accessibility，再用 UIA 读控件；不要依赖 `F12` 长时间开着，超星有 `debugger` 反调试。
- 改中文 JS 文件必须用 Node `fs.readFileSync(...,'utf8')` / `writeFileSync` 或 edit 工具；**不要用 PowerShell `Get-Content -Raw` + `Set-Content`**，会按 ANSI 写坏中文。
- 打包：`node tools\set_version.js 1.8.10` + `node tools\package.js`；打包前把 `server\shots\*.png` 等测试产物移出，否则包会变大。

## 用户红线
- 用日常 Edge + 默认配置，不新建临时 profile 干活；不要反复 `taskkill /f` 丢超星登录态。
- 只改自动答题/提交/跳节相关模块；其他模块不要动。
- 中文交流，视觉证据优先，最终要能一键安装/打包。
