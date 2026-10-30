'use strict';
/**
 * 刷小课 · 智慧树(onlineweb.zhihuishu.com)
 * 自动倍速静音播放 + 自动跳下一节 + 识别题目
 */
(async () => {
  await SXK.loadSettings();
  SXK.log('zhs', 'loaded');

  SXK.watchVideos();

  setInterval(() => {
    if (!SXK.isReady()) return;
    try { SXK.zhihuishuNext(); } catch (e) {}
  }, 3000);

  SXK.listenAutoAnswer('zhs');
})();
