# 刷小课 · 1.8.11 交接记忆

在 1.8.10 基础上的增量；项目路径、启动方式、用户红线见 `MEMORY-1.8.10.md`。

## 1.8.11 新增：题目完成 10 秒兜底
- `extension\engine.js` 新增 `watchQuizIdle(tag)`，`brush.js` 启动时调用。
- 触发条件：
  - 顶层帧、`settings.autoAnswer` 开着；
  - `looksLikeWorkPage()` 且不是考试页；
  - `extractQuestions().length > 0`；
  - 没有正在跑的答题任务（`answerBusy === false`）；
  - 距离最后一次真正答题活动 `lastAnswerAt` 已满 **10 秒**。
- **不要求每道题都有答案**，允许空题；只有空转轮次不刷新 `lastAnswerAt`，避免永远不触发。
- 触发后：
  - `autoSubmit` 开着：先发 `AUTO_SUBMIT_PAGE` 强制提交（允许空题），3 秒后点下一节；
  - `autoSubmit` 关着：直接点下一节；
  - 提交/跳节都走 `jumpNextOnce()`，同一 URL 8 秒内只点一次，防连跳两节。
- 日志 tag：`quiz-idle`（识别到题、10 秒无新作答、强制提交、已点下一节/没找到）。
- 验证：`tools\mock-idle.html`（1 道已答 + 1 道空题）PASS：
  `quiz-idle:识别到 2 题...` → `quiz-idle:已 10 秒无新作答` → `先强制提交(允许空题)` → `提交已触发:提交` → `chaoxing-jump:clicked` → `nextClicks=1`。

## 当前状态
- 版本 **1.8.11**，包 `dist\刷小课-1.8.11.zip`（194,531B，已清理 QA 截图）。
- 后端已重启，`/api/health` 返回 1.8.11。
- 真实 29 题章节测验仍未做端到端提交（避免误交）；需要用户重载扩展、开「自动做题 + 自动提交 + 自动跳节」后验证。
- 学习页/测验页的「下一节」仍在 `#iframe` 内，1.8.10 的跨 iframe 查找已包含。
