'use strict';
/**
 * 刷小课 · U校园(welearn.sflep.com / centercourseware.sflep.com)
 * 视频/音频自动倍速静音播放 + 自动跳节 + 识别题目
 * 注意:centercourseware 常在 iframe 内,故 all_frames: true
 */
(async () => {
  await SXK.loadSettings();
  SXK.log('welearn', 'loaded');

  // 视频 + 音频统一调速静音自动播放
  SXK.watchVideos();
  const applyAudio = () => {
    document.querySelectorAll('audio').forEach(a => {
      try {
        a.muted = true;
        const rate = SXK.getSettings().playbackRate || 1;
        if (a.playbackRate !== rate) a.playbackRate = rate;
        if (SXK.getSettings().autoVideo && a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
      } catch (e) {}
    });
  };
  applyAudio();
  new MutationObserver(applyAudio).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(applyAudio, 2000);

  // U校园"下一单元"按钮(公开 DOM)
  const jump = () => {
    if (!SXK.getSettings().autoJump) return;
    const next = document.querySelector('[class*="nextBtn"], .next-unit, a.next');
    if (next) { next.click(); SXK.log('welearn-jump', 'clicked'); }
  };
  setInterval(() => { if (SXK.isReady()) try { jump(); } catch (e) {} }, 3000);

  SXK.listenAutoAnswer('welearn');
})();
