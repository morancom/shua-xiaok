# 刷小课 1.8.9 交接记忆

## 本轮完成

### 自动提交（m01675）
- `extension/engine.js`
  - `questionAnswered(q)`：mooc2 用 `mooc2HasSelection`；普通题看 `input.checked` / class / aria；无选项题看 `fillHasValue`。
  - `isExamPage()`：命中 `/exam|exam-ans|selectQuestion|examId=/` 时跳过。
  - `watchAutoSubmit(tag)`：仅顶层帧；要求 `settings.autoSubmit && settings.autoAnswer`；每 6 秒检查一次，首跑 5 秒；全部题已答后缓 4 秒复核，再 `sendMessage({type:'AUTO_SUBMIT_PAGE'})`；日志 tag `auto-submit`。
- `extension/brush.js` 末尾调用 `SXK.watchAutoSubmit('chaoxing')`。
- `extension/sw2.js`
  - `pageSubmit()` 在主世界执行：精确匹配「提交/提交作业/交卷/提交答案/确定提交/提交试卷」，排除暂存、保存、取消、解析；取页面最下方按钮。
  - 点击前临时覆盖 `window.confirm=()=>true`，点击后 900ms 扫自定义弹窗的「确定/确认/提交/是/继续」，4 秒后恢复。
  - 新消息分支 `AUTO_SUBMIT_PAGE`：`chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:pageSubmit})`。
- `extension/sidebar.js` 设置区新增「自动提交」开关（`data-set="autoSubmit"`）。
- 默认 `autoSubmit=false`，避免误交。

### 测试
- `pageSubmit` 纯函数测试：`tools/mock-submit.html`，结果 `{ok:true,text:"提交",submitted:"1"}`，证明按钮识别 + confirm 覆盖 + 点击生效。
- `watchAutoSubmit` 逻辑测试：`tools/mock-autosubmit.html`，结果 `PASS`，日志：
  `auto-submit:监控启动 submit=true answer=true` → `全部 2 题已作答,准备提交` → `已触发提交:提交`。
- **未做真实扩展开销链路测试**：`/mock/chaoxing` 的 content script 只加载 `engine.js + mock.js`，没有 `brush.js`，因此完整扩展端到端未跑通；真实超星作业页也尚未验证自动提交。

## 学习页跳节（m00402 / m01560 / m01648）
- 新 studentstudy 的 `#prevNextFocusNext` 是「切任务标签」，不是下一节。
- `cx.js`：
  - `studyTabs()/studyTabState()` 按 `#dct1/#dct2/#dct3` 的 active class 推进 PPT→教材→视频。
  - 最后一个标签后按左侧目录 `catalogNext` 点下一节；点击 3 秒无反应时 `goCatalog` 用 `chapterId` 直接改 URL。
  - 顶层 `tick()` 若当前目录有 `.icon_Completed` 或「已完成」，直接 `jumpNext(false,'目录已完成')`。
  - 文档任务滚到底 10 秒仍无完成标记，按已读推进（`taskFinished` + 顶层兜底）。
- 已真机验证过：任务标签推进、目录完成 `icon_Completed`、`chapterId` 直跳都能工作；但用户最新反馈「新版还是不会继续往下跳」时，Edge 内容脚本还没有重载到 1.8.8/1.8.9，需重载后复测。

## 自动答题 / 填空题
- mooc2 新版 `.stem_answer .answerBg` 已适配（`.num_option`/`.num_option_dx`、`check_answer`/`check_answer_dx`、hidden `answer<qid>`）。
- 旧版 `doHomeWorkNew` 的 UEditor 已适配：`fillUEditor` 用 iframe body `execCommand('insertText')` + 隐藏 textarea 同步；`fillTextAnswer` 同时处理普通 input/textarea/contenteditable。
- 真机填空已验证写入：q8=`1`、q9=`¬B`、q10=`¬A`、q11=`无关`、q12=`附加`、q15=`CP`。
- 已知问题：q13 的截图未覆盖题干，模型仍可能空着；已加 `fillHasValue` 跳过已填题、模型复述答案丢弃、截图向上留 90px。

## 版本与包
- 版本 1.8.9；`dist/刷小课-1.8.9.zip`，干净包 189,278B（15:14 打包，已剔除 shots、server.log、cx.js.bak165）。
- 包内已验证：manifest 1.8.9、`pageSubmit`、`data-set="autoSubmit"`、mock `id="submitWork"`。
- 后端已重启为 1.8.9（pid 23188，health v1.8.9）。

## 下一步
1. 用户在 `edge://extensions` 重载「刷小课」，打开真实作业页，侧边栏开「自动做题 + 自动提交」。
2. 观察 `/api/state` 的 `auto-submit` 日志与 `[solve]/[brush]`；确认提交前 4 秒复核、真实按钮点击。
3. 若真实页提交按钮文字不是「提交/交卷」等，需在 `pageSubmit` 增加实测文字，但不要放宽到「保存/暂存」。
4. q13 类填空若仍空，检查 `shot-*.png` 是否截到题干；必要时改为对题目容器外层做整块截图。
