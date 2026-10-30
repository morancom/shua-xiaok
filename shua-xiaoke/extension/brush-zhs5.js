'use strict';
/**
 * 刷小课 · 智慧树新版学习页(studyvideoh5 / studyh5 / studywenda)
 * 目标:自动倍速静音播放 + 弹题弹窗自动关闭 + 播完自动下一集。
 *
 * 设计取舍:
 * - 智慧树的播放器可能在同源 iframe 里,所以自己递归扫同源 iframe 的 document;
 *   manifest 里也开了 all_frames,子帧各管各的 video,顶层负责跳节。
 * - 首版带一次性结构诊断 `zhs5-dom`,只打一次/每个 href,用来对齐真实 DOM 再迭代。
 * - 只点「无害按钮」(继续学习/我知道了/关闭/下一集…),绝不点提交/交卷/删除。
 */
(async () => {
  await SXK.loadSettings();

  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const HREF = location.href;
  const TAG = IS_TOP ? 'zhs5' : 'zhs5@' + location.hostname;

  SXK.log(TAG, 'loaded path=' + location.pathname.slice(0, 80));

  // ---------------- 通用工具 ----------------
  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, '').trim();
  }

  function visible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const st = el.ownerDocument.defaultView.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      return true;
    } catch (e) { return false; }
  }

  // 自己 + 同源 iframe(最多两层)的所有 document
  function docs() {
    const out = [document];
    const walk = (d, depth) => {
      if (depth >= 2) return;
      let frames = [];
      try { frames = [...d.querySelectorAll('iframe')]; } catch (e) { return; }
      for (const f of frames) {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (cd && cd.documentElement) { out.push(cd); walk(cd, depth + 1); }
      }
    };
    walk(document, 0);
    return out;
  }

  function allVideos() {
    const out = [];
    for (const d of docs()) {
      try { out.push(...d.querySelectorAll('video')); } catch (e) {}
    }
    return out;
  }

  function desc(el) {
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  }

  // 从 el 往上找「像弹层」的祖先(智慧树弹题/提示框常带 quiz/dialog/pop/mask 类名)
  function inOverlay(el) {
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const c = typeof p.className === 'string' ? p.className : '';
      if (/dialog|popup|pop-|mask|modal|overlay|alert|layer|quiz|question|tips/i.test(c)) return true;
      p = p.parentElement;
    }
    return false;
  }

  // ---------------- 一次性结构诊断 ----------------
  let dumped = '';
  function dumpOnce() {
    if (!IS_TOP || dumped === HREF) return;
    dumped = HREF;
    try {
      const ds = docs();
      const vs = allVideos();
      const vinfo = vs.slice(0, 3).map((v) => {
        const chain = [];
        let p = v.parentElement, n = 0;
        while (p && n < 4) { chain.push(desc(p)); p = p.parentElement; n++; }
        return `id=${v.id || '-'} cls=${String(v.className || '-').slice(0, 36)} src=${String(v.currentSrc || v.src || '-').slice(0, 48)} dur=${Number(v.duration || 0).toFixed(1)} cur=${Number(v.currentTime || 0).toFixed(1)} paused=${v.paused} rate=${v.playbackRate} up=${chain.join('<')}`;
      });
      SXK.log('zhs5-dom', `docs=${ds.length} videos=${vs.length} :: ` + (vinfo.join(' || ') || 'no-video'));

      const btnRe = /^(下一集|下一节|下一章|下一课|继续学习|继续观看|我知道了|知道了|关闭|确定|开始学习|继续播放|播放)$/;
      const btns = [];
      for (const d of docs()) {
        let els = [];
        try { els = [...d.querySelectorAll('button,a,div,span')]; } catch (e) { continue; }
        for (const el of els) {
          const t = textOf(el);
          if (!t || t.length > 10 || !btnRe.test(t)) continue;
          if (!visible(el)) continue;
          btns.push(`${desc(el)}="${t}"${inOverlay(el) ? '@ovl' : ''}`);
          if (btns.length >= 20) break;
        }
        if (btns.length >= 20) break;
      }
      SXK.log('zhs5-dom', 'btns=' + (btns.join(' | ') || 'none'));

      const ovl = [];
      for (const d of docs()) {
        try {
          for (const el of d.querySelectorAll('[class*=dialog],[class*=pop],[class*=quiz],[class*=question],[class*=mask],[class*=modal]')) {
            if (!visible(el)) continue;
            ovl.push(desc(el));
            if (ovl.length >= 14) break;
          }
        } catch (e) {}
      }
      SXK.log('zhs5-dom', 'overlays=' + (ovl.join(' | ') || 'none'));
      SXK.log('zhs5-dom', 'text=' + String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 240));
    } catch (e) {
      SXK.log('zhs5-dom', 'err=' + (e && e.message));
    }
  }

  // ---------------- 自动播放 + 倍速 + 静音 ----------------
  // 注意:settings 是 engine.js 里 IIFE 的闭包私有变量,这里拿不到,
  // 必须走 SXK.getSettings()(否则会静默 ReferenceError,表现就是「不静音、不倍速」)。
  function cfg() {
    try { return (SXK.getSettings && SXK.getSettings()) || {}; } catch (e) { return {}; }
  }

  function ensurePlay() {
    const S = cfg();
    const rate = Number(S.playbackRate) || 1;
    for (const v of allVideos()) {
      try {
        if (!v.muted) v.muted = true;
        if (S.autoVideo && Math.abs(v.playbackRate - rate) > 0.05) {
          try { v.playbackRate = rate; } catch (e) {}
        }
        if (S.autoVideo && v.paused && !v.ended) {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {}
    }
  }

  // 15 秒一条进度心跳:用来判断「到底有没有在播」
  let beatAt = 0;
  let lastBeatKey = '';
  function beat() {
    const now = Date.now();
    if (now - beatAt < 15000) return;
    beatAt = now;
    const vs = allVideos();
    if (!vs.length) { SXK.log(TAG + '-video', 'no-video docs=' + docs().length); return; }
    const v = vs[0];
    const key = `${Math.round(Number(v.currentTime || 0))}/${Math.round(Number(v.duration || 0))}`;
    SXK.log(TAG + '-video', `cur=${Number(v.currentTime || 0).toFixed(1)} dur=${Number(v.duration || 0).toFixed(1)} ${key === lastBeatKey ? 'STUCK' : 'adv'} paused=${v.paused} ended=${v.ended} rate=${v.playbackRate} muted=${v.muted} rs=${v.readyState} err=${v.error ? v.error.code : '-'}`);
    lastBeatKey = key;
  }

  // ---------------- 弹题 / 提示框自动关闭 ----------------
  // 只点这些「无副作用」的文案;提交/交卷/放弃 一律不碰。
  const SAFE_POPUP = /^(继续学习|继续观看|我知道了|知道了|关闭|确定|开始学习|继续播放|播放)$/;
  let popupAt = 0;
  let popupSaid = '';
  function dismissPopups() {
    if (Date.now() - popupAt < 2500) return;
    popupAt = Date.now();
    for (const d of docs()) {
      let els = [];
      try { els = [...d.querySelectorAll('button,a,div[role=button],span')]; } catch (e) { continue; }
      for (const el of els) {
        const t = textOf(el);
        if (!t || !SAFE_POPUP.test(t)) continue;
        if (!visible(el)) continue;
        if (!inOverlay(el)) continue;
        try { el.click(); } catch (e) { continue; }
        const k = desc(el) + '=' + t;
        if (k !== popupSaid) { popupSaid = k; SXK.log(TAG + '-popup', 'click ' + k); }
        return;
      }
    }
  }

  // ---------------- 播完自动下一集 ----------------
  // 候选文案按优先级:下一集 > 下一节 > 下一章 > 下一课
  const NEXT_RE = /^(下一集|下一节|下一章|下一课)$/;
  let nextAt = 0;
  let nextClickedFor = '';   // 本条视频只跳一次,避免连点
  function videoDone() {
    const vs = allVideos();
    for (const v of vs) {
      const dur = Number(v.duration || 0);
      if (dur > 30 && (v.ended || Number(v.currentTime || 0) >= dur - 1.5)) return true;
    }
    return false;
  }

  function clickNext() {
    const S = cfg();
    if (!S.autoJump) return false;
    for (const d of docs()) {
      let els = [];
      try { els = [...d.querySelectorAll('button,a,div,span')]; } catch (e) { continue; }
      for (const el of els) {
        const t = textOf(el);
        if (!t || !NEXT_RE.test(t)) continue;
        if (!visible(el)) continue;
        try { el.click(); } catch (e) { continue; }
        SXK.log(TAG + '-jump', 'click ' + desc(el) + '="' + t + '"');
        return true;
      }
    }
    return false;
  }

  function maybeNext() {
    if (Date.now() - nextAt < 4000) return;
    nextAt = Date.now();
    if (!videoDone()) return;
    const key = String(Math.round(Date.now() / 60000)) + '|' + (location.href || '');
    if (nextClickedFor === key) return;
    nextClickedFor = key;
    if (IS_TOP) {
      if (!clickNext()) SXK.log(TAG + '-jump', 'video-ended-but-no-next-button');
    } else {
      // 播放器在被跨域 iframe 里时,顶层才是点「下一集」的地方
      askTopNext();
    }
  }

  // 子帧 → 顶层:请求点下一集(跨域 iframe 读不到顶层 DOM,只能 postMessage)
  const NEXT_MSG = 'SXK_ZHS_NEXT';

  function askTopNext() {
    try {
      if (IS_TOP) return clickNext();
      if (window.top === window) return false;
      window.top.postMessage({ type: NEXT_MSG, href: HREF }, '*');
      SXK.log(TAG + '-jump', 'ask-top');
      return true;
    } catch (e) { return false; }
  }

  if (IS_TOP) {
    window.addEventListener('message', (e) => {
      try {
        const d = e.data;
        if (!d || d.type !== NEXT_MSG) return;
        let host = '';
        try { host = new URL(e.origin).hostname; } catch (err) { return; }
        if (!/(^|\.)zhihuishu\.com$/.test(host) && !/^(127\.0\.0\.1|localhost)$/.test(host)) return;
        SXK.log(TAG + '-jump', 'top 收到子帧请求 from ' + host);
        clickNext();
      } catch (err) {}
    });
  }

  // ---------------- 主循环 ----------------
  function tick() {
    try { dumpOnce(); } catch (e) {}
    try { ensurePlay(); } catch (e) {}
    try { dismissPopups(); } catch (e) {}
    try { beat(); } catch (e) {}
    try { maybeNext(); } catch (e) {}
  }

  tick();
  setInterval(tick, 1500);
})();
