'use strict';
/**
 * 刷小课 · 超星/学习通(chaoxing.com / xuexitong.com)
 *
 * 逻辑对照原「大学搜题酱」插件:
 *  - 视频在两层 iframe 里(顶层 → #iframe → iframe[src*=ananas/modules/video])
 *    → 走 cx.js,从顶层拿 contentDocument 驱动播放,不需要 all_frames
 *  - 视频弹题:任务 iframe 内 .ans-videoquiz 可见时先做题再继续
 *  - 「章节未完成」提示(.jobFinishTip)出现时点 .popBottom .nextChapter 强推
 *  - 作业/测验页面:题目同样在 #iframe 里,extractQuestions 已支持跨 iframe
 */
(async () => {
  await SXK.loadSettings();
  const isTop = (() => { try { return window.top === window; } catch (e) { return true; } })();
  SXK.log('chaoxing', isTop ? 'loaded' : 'loaded@iframe');

  // 主循环:关弹窗 + 驱动视频 + 弹题 + 跳下一节
  setInterval(() => {
    if (!SXK.isReady()) return;
    const cx = window.SXKCX;
    if (!cx) return;
    cx.tick().catch(() => {});
  }, 2000);

  // 章节页路由变化(超星是 SPA 式切节,地址变了要重新开始)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      SXK.log('chaoxing', 'route:' + location.pathname);
    }
  }, 1500);

  // 学习页加载完先报一次结构诊断,后端日志里就能看到「谁在播、谁没完成」
  // (只在顶层做,1 次就够;方便排查真实课程页的任务点结构)
  if (isTop) {
    setTimeout(() => {
      try {
        const cx = window.SXKCX;
        if (cx && cx.diag) SXK.log('cx-diag', JSON.stringify(cx.diag()).slice(0, 900));
      } catch (e) {}
    }, 6000);
  }

  // 监听侧边栏发来的"自动做题"指令(作业/章节测验页)
  SXK.listenAutoAnswer('chaoxing');

  // 设置实时生效(侧边栏一改,这里 6 秒内跟上)
  if (SXK.startSettingsSync) SXK.startSettingsSync();
  // 作业/测验页:打开就自己开始做题,不用等用户点侧边栏
  if (SXK.watchAutoAnswer) SXK.watchAutoAnswer('chaoxing');
  // 自动提交:等所有题都有答案后,顶层点最终提交(只在作业/测验页,考试页跳过)
  if (SXK.watchAutoSubmit) SXK.watchAutoSubmit('chaoxing');
  // 兜底:题目识别后连续 10 秒没有新的作答动作(允许有空白题),就提交/下一节,防止卡死
  if (SXK.watchQuizIdle) SXK.watchQuizIdle('chaoxing');
})();
