'use strict';
/**
 * 刷小课 · 超星/学习通课程页驱动(对照原「大学搜题酱」插件的实现)
 *
 * 关键结构(原插件 iframes.js / videoDom.js 的做法,已按源码还原):
 *
 *   顶层文档 (mycourse/studentstudy)
 *     └─ #iframe                      ← 学习页,同源,可直接拿 contentDocument
 *          └─ iframe[src*="/ananas/modules/video/"]   ← 真正的播放器,视频在这个里面
 *
 * 所以「页面里查不到 video」不是因为没视频,而是视频藏在两层 iframe 里。
 * 原插件就是从顶层拿到 #iframe.contentDocument,再遍历里面的任务 iframe 来操作的,
 * 不需要 all_frames。
 *
 * 另外「章节未完成」弹窗是超星自己的 .jobFinishTip(block 时可见),
 * 原插件的做法是点 .popBottom .nextChapter 强行继续,而不是去点「确定」。
 */
(() => {
  const CX = {};
  const MODULE_RE = /\/ananas\/modules\/([^/?#]+)/;
  const TIP_WAIT_MS = 4000;   // 点完「下一节」等弹窗出现
  const JUMP_GAP_MS = 7000;   // 两次跳节之间的最小间隔,避免原地重复点
  let lastJumpAt = 0;
  let lastTickLog = 0;
  let lastDbg = 0;
  let lastCatDoneLog = 0;                     // 「目录已完成」日志节流(原来每 2 秒一条,把后端日志刷爆)
  let catDoneCache = { at: 0, val: false };    // 目录勾缓存(1.2 秒),避免每轮重复查 DOM
  let catSkipSaid = '';                        // 已为哪个 href 打过「按目录勾跳过」的说明

  // ---- 防「来回跳 / 被判异常」的节流与熔断状态 ----
  const GAP_JUMP_MS = 25000;    // 两次跳节最短间隔,宁可慢也别把超星惹毛
  const MAX_JUMPS = 60;         // 单页最多跳这么多次(原 8 次太容易误判,长章节根本刷不完)
  let jumpCount = 0;
  let lastHref = '';
  let stalledJumps = 0;         // 点了下一节但地址没变的次数
  let stopped = false;          // 熔断:一旦怀疑异常就彻底停手
  let stopReason = '';

  // ---- 温和模式:不跟超星的风控对着干 ----
  // 实战教训:每秒都去 play() 一次,超星会看到「一秒播一秒停」的诡异节奏,
  // 直接判异常 → 页面全白 + 要验证码。所以拉播放必须慢、必须有上限。
  const PLAY_RETRY_MS = 8000;      // 同一个视频两次「拉起播放」至少隔 8 秒
  const MAX_PLAY_RETRIES = 40;     // 单个任务最多拉 40 次(原 8 次:遇到 dur=0 的播放器必误判)
  const PAUSE_WINDOW_MS = 60000;   // 观察窗口:60 秒
  const PAUSE_LIMIT = 4;           // 窗口内被「外部」暂停 4 次 → 判定风控,立刻停
  const COOLDOWN_MS = 60 * 1000;   // 停手后的冷却时间。用户 2026-10-24 明确要求:不要熔断机制。
  // 原来 10 分钟 + 写 storage 持久化,等于「一次误判就废掉整个刷课」。
  // 现在只软停 60 秒,到点自动恢复并清零所有重试计数,永远不需要人工干预。
  // ★ 2026-10-24 真实反馈「鼠标一动就暂停,然后再也不放了」:
  //   超星播放器会因为 mouseleave/防挂机自己 pause,一分钟凑 4 次曾被当成风控硬熔断 10 分钟。
  //   改成软退避:只拉长重试间隔、绝不停手,并在 2.5 秒后主动把播放接回来。
  const SOFT_BACKOFF_MS = 20000;
  let softBackoffUntil = 0;
  let pendingResume = null;
  // 当前真正在驱动的那个播放器元素。被外部暂停后自动接回时,只接回它 ——
  // 否则上一个已经播完的视频会被反复 play()(真机日志里 ext-resume 一直在接 #0),
  // 既抢播放权又刷屏,还把该播的第二个视频一直压在暂停状态。
  let lastPickVideoEl = null;
  let pauseMarks = [];
  const playRetries = new Map();
  let blankCount = 0;
  let cooldownUntil = 0;
  let lastStopLogAt = 0;
  let softStopCount = 0;

  // ★ 2026-10-24 用户明确要求「把熔断机制删除掉」:不再有任何停手分支,这里只记一条日志。
  //   之前那套(停止/冷却/写 storage)的起因是「来回跳播放源 → 触发人机检测」,
  //   根因在择段逻辑,择段修好后操作本身是正常的,熔断只会误伤(鼠标一动就整晚不刷)。
  function stop(reason) {
    stopReason = reason;
    softStopCount += 1;
    rec('stop', { reason });
    log('cx-warn', '（仅记录,不停止）' + reason);
    // ★ 不再写 chrome.storage.local:旧版把冷却期持久化,刷新页面都恢复不了,
    //   用户实测「一次误判就整晚不刷」。现在只软停,60 秒后 tick() 自己恢复。
    // 现场日志限流发送,避免软停循环把控制台刷满
    if (Date.now() - lastStopLogAt > 180000) { lastStopLogAt = Date.now(); sendLog(); }
  }

  // 超星判定异常时会跳验证码页,或者弹出验证层 —— 看到就立刻停
  function looksBlocked() {
    try {
      const t = (document.title || '') + ' ' + (location.href || '');
      if (/验证码|captcha|verifycode|seccode|异常|请稍后再试/i.test(t)) return 'url/title';
      if (document.querySelector('.verifyCode, #captcha, .captcha, .vcode, #vcodeImg, .sec-code')) return 'captcha-dom';
      const tip = document.querySelector('.jobFinishTip');
      if (tip && /异常|验证|频繁/.test(tip.innerText || '')) return 'tip-text';
      return '';
    } catch (e) { return ''; }
  }

  // 任务的稳定标识:超星 iframe 的 src 会带时间戳参数,必须去掉 query 再当 key,
  // 否则每次重载都算「新任务」→ 反复重播同一个视频。
  function taskKey(t, idx) {
    let src = (t.src || '').split('?')[0];
    let id = '';
    try { id = t.el.getAttribute('data-dx-task-id') || ''; } catch (e) {}
    return (id || idx) + '|' + src;
  }

  function getSXK() {
    try { if (typeof SXK !== 'undefined' && SXK) return SXK; } catch (e) {}
    return (typeof window !== 'undefined' && (window.SXK || window.__SXK)) || null;
  }
  function cfg() {
    const s = getSXK();
    return (s && s.getSettings && s.getSettings()) || {};
  }
  function isReady() {
    const s = getSXK();
    return !!(s && s.isReady && s.isReady());
  }
  function log(task, status) {
    const s = getSXK();
    if (s && s.log) s.log(task, status);
  }

  // ==================================================================
  // 诊断日志(排查真实课程页用)
  //   内容脚本不方便直接 fetch 本地后端(本地网络访问限制 + 隔离世界),
  //   所以先在内存里环形缓冲,用户点「诊断日志」时整段交给后台转发到控制台。
  // ==================================================================
  const LOGBUF = [];
  const LOGBUF_MAX = 500;
  let logSendPending = false;
  const stallState = new Map();   // 每个任务点的「进度卡住」探测状态
  let lastAutoDump = 0;
  let lastPickLog = 0;           // 上次自动上传日志的时间

  function ts(ms) {
    const d = new Date(ms);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function rec(ev, extra) {
    const item = { t: Date.now(), ev };
    if (extra) for (const k of Object.keys(extra)) item[k] = extra[k];
    LOGBUF.push(item);
    if (LOGBUF.length > LOGBUF_MAX) LOGBUF.shift();
    return item;
  }

  // 把缓冲区拼成可读文本
  function dumpLog() {
    // 每个任务点单独一行「体检表」:多视频场景一眼就能看出谁没播、谁播完了没被标记
    let table = '';
    try {
      const fr = taskFrames();
      table = fr.map((t, i) => {
        let hasV = 0, fin = 0, done = 0, vis = 0, iv = 0, st = '-';
        try { hasV = findVideo(t.doc) ? 1 : 0; } catch (e) {}
        try { fin = taskFinished(t) ? 1 : 0; } catch (e) {}
        try { done = endedOf(t) ? 1 : 0; } catch (e) {}
        try { vis = visible(t.el, studyDoc()) ? 1 : 0; } catch (e) {}
        try {
          const r = t.el.getBoundingClientRect();
          iv = r.bottom > 8 && r.top < (window.innerHeight || 800) - 8 ? 1 : 0;
        } catch (e) {}
        try {
          const v = findVideo(t.doc);
          if (v) st = `${Math.round(v.currentTime || 0)}/${Math.round(v.duration || 0)}s p=${v.paused ? 1 : 0} e=${v.ended ? 1 : 0}`;
        } catch (e) {}
        // 完成图标的真实长相(className + 内联样式):万一某个已完成任务点的播放器被移除、
        // 需要靠图标判断,这里的数据就是依据。
        let ic = '-';
        try {
          const p0 = t.el && t.el.parentElement;
          const n = p0 && p0.querySelector('.ans-job-icon');
          if (n) ic = (n.className || '') + '|' + String(n.getAttribute('style') || '').replace(/[\s;]/g, '').slice(0, 20);
        } catch (e) {}
        return `  #${i} ${t.type} hasVideo=${hasV} fin=${fin} done=${done} vis=${vis} inView=${iv} ${st} ic=${ic} src=${(t.src || '').split('?')[0].slice(-40)}`;
      }).join('\n');
    } catch (e) { table = '  (读取任务表失败:' + ((e && e.message) || e) + ')'; }

    const head = [
      `=== 刷小课 诊断日志 ===`,
      `时间: ${new Date().toISOString()}`,
      `版本: ${(() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })()}` +
        ` 倍速: ${(() => { try { return cfg().playbackRate; } catch (e) { return '?'; } })()}` +
        ` 开关: ${(() => { try { const c = cfg(); return [c.autoVideo ? '播' : '', c.autoJump ? '跳' : '', c.autoAnswer ? '答' : ''].filter(Boolean).join('') || '全关'; } catch (e) { return '?'; } })()}`,
      `主循环: ${document.hidden ? '后台(hid=1)' : '前台'}  tick间隔 3s`,
      `页面: ${location.hostname}${location.pathname}`,
      `标题: ${(document.title || '').slice(0, 60)}`,
      `UA: ${String(navigator.userAgent).slice(0, 90)}`,
      `任务标签: ${(() => { try { const t = studyTabState(); return t.tabs.map((x, i) => (x === t.active ? '*' : '') + i + ':' + tabText(x)).join(' | ') || '无'; } catch (e) { return '?'; } })()}`,
      `目录: ${(() => { try { const it = catalogItems(); const cur = catalogCurrent(it); const nxt = catalogNext(it, cur); return '当前=' + catalogText(cur) + ' 下一=' + catalogText(nxt) + ' 共' + it.length; } catch (e) { return '?'; } })()}`,
      `目录DOM: ${(() => { try { const it = catalogItems(); const cur = catalogCurrent(it); return cur ? String(cur.outerHTML || '').replace(/\s+/g, ' ').slice(0, 900) : '无'; } catch (e) { return '?'; } })()}`,
      `任务DOM: ${(() => { try { const t = taskFrames().find((x) => isDocTask(x)); if (!t) return '无'; const p = t.el && (t.el.parentElement || t.el.closest('.ans-job')); return String((p && p.outerHTML) || '').replace(/\s+/g, ' ').slice(0, 900); } catch (e) { return '?'; } })()}`,
      `目录完成: ${(() => { try { const it = catalogItems(); const cur = catalogCurrent(it); if (!cur) return '无当前'; return 'icon=' + !!cur.querySelector('.icon_Completed') + ' text=' + String(cur.innerText || '').replace(/\s+/g, ' ').slice(0, 80); } catch (e) { return '?'; } })()}`,
      `任务数: ${(() => { try { return taskFrames().length; } catch (e) { return '?'; } })()}` +
        ` 已播完(去重表): ${endedAt.size}` +
        ` 跳节次数: ${jumpCount}` +
        ` 已停止: ${stopped ? '软停中(' + stopReason + '),到点自动恢复' : '否'}` + ` 软停次数: ${softStopCount}`,
      `--- 任务点体检 ---`,
      table || '  (没有任务点)',
      `--- 时间线 ---`,
    ].join('\n');
    const body = LOGBUF.map((x) => {
      const rest = {};
      for (const k of Object.keys(x)) if (k !== 't' && k !== 'ev') rest[k] = x[k];
      const tail = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      return ts(x.t) + '  ' + x.ev + tail;
    }).join('\n');
    return head + '\n' + body + '\n=== 日志结束 ===';
  }

  // 交给后台 -> 本地控制台(内容脚本不直接访问 127.0.0.1)
  function sendLog() {
    const text = dumpLog();
    if (logSendPending) return text;
    logSendPending = true;
    try {
      chrome.runtime.sendMessage({ type: 'CX_LOG_DUMP', text, host: location.hostname, path: location.pathname }, () => {
        logSendPending = false;
      });
    } catch (e) { logSendPending = false; }
    return text;
  }

  // ---------------- 「视频播完了吗」 ----------------
  // 不能只信 v.ended:超星播放器收尾方式不止一种
  //   ① 正常触发 ended
  //   ② 播到末尾后自己 pause() 停在最后(不触发 ended)
  //   ③ 末尾把 currentTime 归零(ended 一闪而过,下一轮就看不到了)
  // 所以用「ended / 进度到末尾 / 停在最后两秒」三条一起判。
  function videoDone(v) {
    if (!v) return false;
    try {
      if (v.ended) return true;
      const dur = Number(v.duration);
      const cur = Number(v.currentTime);
      if (!isFinite(dur) || dur <= 0) return false;
      if (cur >= dur - 0.8) return true;
      if (v.paused && dur - cur <= 2) return true;
      if (v.paused && cur / dur >= 0.995) return true;
    } catch (e) {}
    return false;
  }

  // ---------- DOM 定位 ----------
  // 学习页主 iframe(原插件 getCxStudyIframe)
  function studyFrame() {
    return document.getElementById('iframe') || document.querySelector('iframe#iframe');
  }
  // 学习页文档(原插件 getCxStudyDocument)
  function studyDoc() {
    try { const f = studyFrame(); return f ? f.contentDocument : null; } catch (e) { return null; }
  }
  // 任务 iframe 列表,带类型(原插件 resolveTaskIframe + extractCxRawTaskType)
  function taskFrames() {
    const d = studyDoc();
    if (!d) return [];
    const out = [];
    for (const el of d.getElementsByTagName('iframe')) {
      const src = el.src || '';
      const m = src.match(MODULE_RE);
      if (!m) continue;
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      out.push({ el, doc, type: m[1].toLowerCase(), src });
    }
    return out;
  }
  function framesOf(type) { return taskFrames().filter((t) => t.type === type); }

  // ==================================================================
  // 文档型任务点(超星 /ananas/modules/doc* / pdf):
  //   超星判定「文档读完」的依据是文档的垂直滚动条被拉到最底。
  //   原来的 tick() 只处理 video,文档任务落到最后的 else 分支里干等 taskFinished(),
  //   而 taskFinished 对「从没有过播放器」的任务点一律返回 false —— 整章就卡死在文档节点上。
  //   这里替人把滚动条一路滚到底,并在到底后轻微抖动(页面靠 scroll 事件推进度)。
  // ==================================================================
  const docState = new Map();
  // 亲眼把某个文档滚到最底的 src 集合:超星会预挂 .ans-job-finished,
  // 真机日志里 pdf 任务点一进来 fin=1,插件据此直接跳节、文档一下都没滚 —— 必须自证
  const docBottomSrc = new Set();
  const docNoDom = new Map();
  const docFirstAt = new Map();
  const docJumped = new Map();     // src -> 我们把它拖到底的时刻
  const docSrcKey = (t) => String((t && t.src) || '').split('?')[0];
  const DOC_STEP_RATIO = 0.8;      // 每次前进约 0.8 屏,接近真人拖滚动条的速度

  function isDocUrl(u) {
    return /\/ananas\/modules\/(doc|document|pdf)/i.test(String(u || ''));
  }
  function isDocTask(t) {
    if (!t) return false;
    if (isDocUrl(t.src)) return true;
    return /^(doc|document|pdf)$/i.test(String(t.type || ''));
  }

  // 找出文档里所有「真的能滚」的容器(超星不同文档模板的滚动层不一样:
  // 有整页滚的,有 #docContainer 自己滚的,也有自定义 overflow:auto 的 div)
  function docScrollBoxes(doc) {
    const out = [];
    if (!doc) return out;
    const push = (el) => { if (el && out.indexOf(el) < 0) out.push(el); };
    const can = (el) => {
      try { return (el.scrollHeight - el.clientHeight) > 40; } catch (e) { return false; }
    };
    try { if (can(doc.scrollingElement)) push(doc.scrollingElement); } catch (e) {}
    try { if (can(doc.documentElement)) push(doc.documentElement); } catch (e) {}
    try { if (can(doc.body)) push(doc.body); } catch (e) {}
    let all = [];
    try { all = Array.from(doc.querySelectorAll('div,section,main,article')); } catch (e) { all = []; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!can(el)) continue;
      let cs = null;
      try { cs = doc.defaultView.getComputedStyle(el); } catch (e) { cs = null; }
      const oy = String((cs && cs.overflowY) || '');
      if (!/auto|scroll|overlay/.test(oy)) continue;
      push(el);
    }
    // 嵌套的同源 iframe(PDF/图书阅读器常把内容单独放在一层 iframe 里)
    try {
      const frames = Array.from(doc.querySelectorAll('iframe'));
      for (let i = 0; i < frames.length && i < 4; i++) {
        let inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; }
        if (!inner) continue;
        const sub = docScrollBoxes(inner);
        for (let k = 0; k < sub.length; k++) push(sub[k]);
      }
    } catch (e) {}
    return out;
  }

  // 滚一次:每个可滚容器前进约 0.8 屏;已经到底的就每 3 秒抖一下,骗出 scroll 事件
  function taskDoc(t) {
    try {
      const el = t && t.el;
      if (el && el.contentDocument) return el.contentDocument;
      const inner = el && el.querySelector ? el.querySelector('iframe') : null;
      if (inner && inner.contentDocument) return inner.contentDocument;
    } catch (e) {}
    return (t && t.doc) || null;
  }

  function scrollDocOnce(doc, key, mark) {
    if (!doc) return { ok: false, why: 'no-doc' };
    const boxes = docScrollBoxes(doc);
    if (!boxes.length) {
      try {
        const w = doc.defaultView;
        const max = (w.scrollHeight || 0) - (w.innerHeight || 0);
        if (w && max > 8 && (w.scrollY || 0) < max - 6) {
          try { w.scrollTo(0, max); } catch (e) { w.scrollBy(0, max); }
          try {
            w.dispatchEvent(new WheelEvent('wheel', { deltaY: max, bubbles: true, cancelable: true }));
          } catch (e) {}
          return { ok: true, moved: 1, atBottom: 1, pct: 100, boxes: 0 };
        }
      } catch (e) {}
      // 找不到滚动容器(PDF 画布阅读器):往视口里补发滚轮 + PageDown,让它自己动
      try {
        const w = doc.defaultView || window;
        const vh = w.innerHeight || 700;
        const vw = w.innerWidth || 900;
        const pts = [[vw / 2, vh * 0.5], [vw / 2, vh * 0.72], [vw / 2, vh * 0.3]];
        for (let i = 0; i < pts.length; i++) {
          let tgt = null;
          try { tgt = doc.elementFromPoint(pts[i][0], pts[i][1]); } catch (e) { tgt = null; }
          tgt = tgt || doc.body || doc.documentElement;
          try {
            tgt.dispatchEvent(new WheelEvent('wheel', {
              deltaY: Math.round(vh * 0.5), deltaMode: 0, bubbles: true, cancelable: true,
              clientX: Math.round(pts[i][0]), clientY: Math.round(pts[i][1]),
            }));
          } catch (e) {}
        }
        const keyEv = (key, code) => {
          try {
            const el = doc.body || doc.documentElement;
            el.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, keyCode: key === 'PageDown' ? 34 : 35, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: code, keyCode: key === 'PageDown' ? 34 : 35, bubbles: true }));
          } catch (e) {}
        };
        keyEv('PageDown', 'PageDown');
        const sc = doc.scrollingElement || doc.documentElement;
        try { if (sc) { sc.scrollTop = Math.min(sc.scrollHeight, (sc.scrollTop || 0) + vh * 0.5); } } catch (e) {}
        return { ok: true, moved: 1, atBottom: 0, pct: 0, boxes: 0 };
      } catch (e) {}
      return { ok: false, why: 'no-scrollbox', boxes: 0 };
    }
    let atBottom = 1, pct = 100, moved = 0, main = null, mainMax = -1;
    for (let i = 0; i < boxes.length; i++) {
      const el = boxes[i];
      let max = 0, cur = 0, ch = 0;
      try { max = el.scrollHeight - el.clientHeight; cur = el.scrollTop || 0; ch = el.clientHeight || 0; } catch (e) { continue; }
      if (max <= 0) continue;
      if (max > mainMax) { mainMax = max; main = el; }
      const p = Math.round((cur / max) * 100);
      if (p < pct) pct = p;
      if (cur >= max - 6) continue;
      atBottom = 0;
      const step = Math.max(120, Math.round(max - cur));
      try {
        // 用户要求:能直接拖到底就直接拖到底,不做逐帧滚动
        try {
          if (el.scrollTo) el.scrollTo({ top: max, behavior: 'instant' });
          else el.scrollTop = max;
        } catch (e) { el.scrollTop = max; }
        try { el.scrollTop = max; } catch (e) {}
        moved = 1;
      } catch (e) {}
      try {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaY: step, bubbles: true, cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.top + r.height / 2),
        }));
      } catch (e) {}
      try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
    }
    if (atBottom) {
      if (mark) docBottomSrc.add(mark);
      try { doc.documentElement.setAttribute('data-sxk-doc-bottom', '1'); } catch (e) {}
    }
    if (atBottom && main) {
      const st = docState.get(key) || {};
      if (Date.now() - (st.nudgeAt || 0) > 3000) {
        st.nudgeAt = Date.now();
        docState.set(key, st);
        try { main.scrollTop = Math.max(0, mainMax - 4); main.scrollTop = mainMax; } catch (e) {}
        try { main.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
      }
    }
    return { ok: true, moved, atBottom, pct, boxes: boxes.length };
  }

  // 驱动单个文档任务点(日志节流)
  function driveDoc(t, idx) {
    const key = 'doc|' + taskKey(t, idx);
    const st = docState.get(key) || { at: 0, pct: -1 };
    const src = docSrcKey(t);
    if (!docFirstAt.has(src)) docFirstAt.set(src, Date.now());
    const r = scrollDocOnce(taskDoc(t), key, src);
    if (!r.ok && r.why === 'no-doc') docNoDom.set(src, (docNoDom.get(src) || 0) + 1);
    else if (r.ok) docNoDom.delete(src);
    if (r.ok && r.atBottom && !docJumped.has(src)) {
      docJumped.set(src, Date.now());
      log('cx-doc', '文档 #' + idx + ' 已直接拖到底,等超星打完成标记(没打上就不会跳下一节)');
    }
    if (r.ok && r.atBottom) {
      const waited = Date.now() - (docJumped.get(src) || Date.now());
      if (waited > 45000 && Date.now() - (st.pokeAt || 0) > 45000) {
        st.pokeAt = Date.now();
        try {
          const boxes2 = docScrollBoxes(taskDoc(t));
          if (boxes2.length) {
            const el2 = boxes2[0];
            try { el2.scrollTop = 0; } catch (e) {}
            setTimeout(function () {
              try { el2.scrollTop = el2.scrollHeight - el2.clientHeight; } catch (e) {}
              try { el2.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
            }, 900);
          }
          try { const w2 = taskDoc(t) && taskDoc(t).defaultView; if (w2) w2.focus(); } catch (e) {}
        } catch (e) {}
        log('cx-doc', '文档 #' + idx + ' 已等 ' + Math.round(waited / 1000) + ' 秒还没完成标记,重新从头拉到底再来一遍');
      }
    }
    if (r.ok && r.atBottom && Date.now() - (st.waitLog || 0) > 15000) {
      st.waitLog = Date.now();
      log('cx-doc', '文档 #' + idx + ' 仍在等完成标记,已等 ' + Math.round((Date.now() - (docJumped.get(src) || Date.now())) / 1000) + ' 秒');
    }
    docState.set(key, st);
    if (!r.ok) {
      if (Date.now() - st.at > 10000) {
        st.at = Date.now();
        log('cx-doc', '文档任务点 #' + idx + ' 找不到可滚动容器(' + r.why + ')');
      }
      return r;
    }
    // 自走:每 900ms 再滚一步(后台标签可能被浏览器降频,所以上面那次连滚是主力)
    if (r.ok && !r.atBottom) {
      st.chain = (st.chain || 0) + 1;
      if (!st.timer && st.chain < 600) {
        st.timer = setTimeout(function () {
          st.timer = 0;
          try {
            if (taskFinished(t)) return;
            driveDoc(t, idx);
          } catch (e) {}
        }, 900);
      }
    } else if (r.atBottom || !r.ok) {
      st.chain = 0;
    }
    if (Date.now() - st.at > 5000 || r.pct !== st.pct) {
      st.at = Date.now();
      st.pct = r.pct;
      let extra = '';
      if (!r.boxes) extra = ' 没找到滚动容器,已补发滚轮/PageDown';
      else if (r.boxes > 1) extra = ' 容器数 ' + r.boxes;
      log('cx-doc', '文档滚动 #' + idx + ' ' + r.pct + '%' + extra + (r.atBottom ? ',已到底,等超星打完成标记' : ''));
    }
    if (r.atBottom && !st.saidBottom) {
      st.saidBottom = 1;
      log('cx-doc', '文档 #' + idx + ' 已经滚到最底,等超星打完成标记');
    }
    return r;
  }

  // 一次只滚「当前显示在屏幕上的」那个文档任务点,和视频的择段逻辑保持一致
  function driveDocQueue(list, frames) {
    if (!list || !list.length) return null;
    const sd = studyDoc();
    const vis = list.filter((t) => { try { return visible(t.el, sd); } catch (e) { return false; } });
    const pool = vis.length ? vis : list;
    const t = pool[0];
    const idx = frames ? frames.indexOf(t) : -1;
    return driveDoc(t, idx < 0 ? 0 : idx);
  }

  // 元素是否真的可见(原插件 m()/B() 的简化版)
  function visible(el, doc) {
    if (!el) return false;
    const win = (doc && doc.defaultView) || window;
    let n = el;
    while (n && n.nodeType === 1) {
      const s = win.getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 任务是否已完成(2026-10-24 重写:修「第二个视频没播就被当成播完、直接跳下一节」)
  //
  // 旧实现:iframe 的父节点带 .ans-job-finished 且里面有 .ans-job-icon 就算完成。
  // 真机日志证明它会误报 —— 同一节里 #0/#1 都没动,#2 却 fin=1 且 0/0s(视频元数据都没加载)。
  // 超星会预先把 .ans-job-finished 挂在容器上,.ans-job-icon 更是每个任务点都有,
  // 所以「有图标」根本不能证明「播完了」。一旦误判,unfinished 变空 → 立刻跳下一节。
  //
  // 新规则:能读到播放器就以播放器为准;播放器已经被移除(超星确认完成后会拆掉)
  // 才回退去看官方完成标记。
  function taskFinished(t) {
    try {
      // 目录里当前节已打勾 → 服务端认为整节都完成了,视频任务点也算完成(见 catalogCurrentCompleted)
      if (catalogCurrentCompleted()) {
        const href = String(location.href || '');
        if (catSkipSaid !== href) {
          catSkipSaid = href;
          log('cx-video', '本章播放器没播过但目录已打勾,按服务端进度算完成,不再重播');
        }
        return true;
      }
      const v = findVideo(t && t.doc);
      if (v) {
        // 记下「这个任务点确实挂过播放器」,后面回退看官方标记时要求这条证据
        try { if (t && t.el) t.el.__sxkSawVideo = 1; } catch (e) {}
        const dur = Number(v.duration) || 0;
        const cur = Number(v.currentTime) || 0;
        if (dur > 0) {
          if (v.ended) return true;
          if (cur >= dur - 1) return true;
          if (cur / dur >= 0.995) return true;
          return false;              // 没播完 → 一律不算完成,忽略父节点的 finished 类
        }
        return false;                // dur=0:元数据还没加载,绝不算完成
      }
      // 播放器不见了(超星确认完成后会把它拆掉)→ 才回退看官方标记。
      // 但必须「我们亲眼见过这个任务点有播放器」:懒加载的 iframe 还没挂视频时,
      // 容器上预先挂好的 .ans-job-finished 会把没播的视频骗成已完成,
      // 这是「第二个视频没播就跳下一节」的另一个入口。
      // 文档型任务点没有播放器。真机日志证明:超星会给 pdf 任务点**预挂**
      // .ans-job-finished(一进来 fin=1,文档一下都没滚),所以「有类」不能算完成。
      // 规则:亲眼把它滚到最底才算完成;只有在完全读不到它的 DOM(跨源)且试过几次时,
      // 才退让去认官方标记。
      if (isDocTask(t)) {
        // 目录里当前节已经打勾(icon_Completed / 已完成):整节任务点都算完成。
        // 真机 1.1.2 的 PDF 早已读完、目录也打勾,但 .ans-job-finished 一直不出现,
        // 旧逻辑就死等 1000 秒;以目录的官方完成标记为准可以直接推进。
        try {
          const cur = catalogCurrent(catalogItems());
          if (cur && (cur.querySelector('.icon_Completed') || /已完成/.test(String(cur.innerText || '')))) return true;
        } catch (e) {}
        const src = docSrcKey(t);
        const jumpedAt = docJumped.get(src) || 0;
        // 真机:PDF 阅读器的内容在它自己的 viewer 里,插件把外层滚到 100%,
        // 超星也可能一直不落 .ans-job-finished / 目录不打勾(已等 16 分钟)。
        // 到底 10 秒还没标记,就按“已读”推进,否则整门课会永远卡在这一节。
        if (jumpedAt && Date.now() - jumpedAt > 10000) return true;
        const pd = t && t.el && (t.el.parentElement || t.el.closest && t.el.closest('.ans-job'));
        const fin = !!(pd && pd.classList && pd.classList.contains('ans-job-finished'));
        // 关键:超星会在文档任务点上预挂 .ans-job-finished。所以「有类」不能算完成,
        // 必须是我们先把文档拖到底、之后超星自己再挂上的类才算数。
        if (!fin) return false;
        if (!docJumped.has(src)) return false;               // 还没拖到底过
        if (Date.now() - docJumped.get(src) < 1200) return false; // 刚拖到底,给超星 1.2 秒落标记
        return true;
      }
      const p = t && t.el && t.el.parentElement;
      const sawIt = !!(t && t.el && t.el.__sxkSawVideo === 1);
      return !!(sawIt && p && p.classList.contains('ans-job-finished'));
    } catch (e) { return false; }
  }

  function findVideo(doc) {
    if (!doc) return null;
    return doc.querySelector('#vjs_container_html5_api') || doc.querySelector('video');
  }

  // ---------- 视频驱动 ----------
  // 给播放元素挂一次性事件监听:谁在 pause/play、当时页面有没有焦点,全记进诊断日志。
  // 真实超星页上「播一下停一下」时,靠这个区分是超星自己暂停(防挂机/失焦)还是我们的动作。
  let playByUs = 0;
  function watchVideo(v, idx) {
    try {
      if (!v || v.__sxkWatch) return;
      v.__sxkWatch = 1;
      const note = (type) => {
        const byUs = playByUs ? 1 : 0;
        rec('ev:' + type, {
          i: idx,
          cur: Math.round((v.currentTime || 0) * 10) / 10,
          byUs,
          hid: document.hidden ? 1 : 0,
          foc: typeof document.hasFocus === 'function' && document.hasFocus() ? 1 : 0,
        });
        // 暂停溯源:统计「不是我们叫的」暂停。短时间内反复被外部暂停 = 超星在拦
        if (type === 'pause') {
          const now = Date.now();
          // ★ 2026-10-24 真实日志:整段刷课 document.hidden=1、foc=0(课程页在后台标签页),
          //   超星播放器会自己 pause;60 秒凑够 4 次就把我们熔断 10 分钟 —— 这不是风控,
          //   是浏览器对后台媒体播放的正常限制。后台/失焦引起的暂停一律不计数。
          const bg = !!(document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()));
          if (bg && !byUs) {
            rec('pause-bg', { i: idx, cur: Math.round((v.currentTime || 0) * 10) / 10 });
          } else {
            pauseMarks = pauseMarks.filter((x) => now - x.t < PAUSE_WINDOW_MS);
            pauseMarks.push({ t: now, byUs });
            const outside = pauseMarks.filter((x) => !x.byUs).length;
            // 鼠标移动 / 播放器自身的防挂机暂停:先排一次 2.5 秒后的自动接回,
            // 且不消耗「同一视频最多拉 8 次」的额度。
            // 只在「确实播过一段」时才安排接回:超星收尾时会把 currentTime 归零再 pause,
            // 那种 0 秒暂停如果也去 play(),会把已经播完的视频从头重播一遍。
            if (!videoDone(v) && (v.currentTime || 0) > 3) pendingResume = { v, at: now + 2500 };
            if (outside >= PAUSE_LIMIT) {
              softBackoffUntil = Math.max(softBackoffUntil, now + SOFT_BACKOFF_MS);
              pauseMarks = [];
              rec('pause-ext-backoff', { i: idx, n: outside, ms: SOFT_BACKOFF_MS });
              log('cx-backoff', '一分钟内被外部暂停 ' + outside + ' 次,退避 ' + Math.round(SOFT_BACKOFF_MS / 1000) + ' 秒后继续(不熔断)');
            }
          }
        }
      };
      ['play', 'pause', 'ended', 'waiting', 'seeking', 'ratechange', 'stalled', 'suspend', 'error'].forEach((t) => {
        try { v.addEventListener(t, () => note(t)); } catch (e) {}
      });
    } catch (e) {}
  }

  // 带节流的「拉起播放」:同一个视频 8 秒内最多拉一次,总共最多 8 次。
  // 直接每秒 play() 会被超星判成异常行为(它能看到 pause/play 的频繁抖动)。
  function tryPlay(v, key, tag) {
    const now = Date.now();
    if (softBackoffUntil && now < softBackoffUntil) return false;   // 软退避期内先别和播放器抢
    const st = playRetries.get(key) || { n: 0, at: 0 };
    if (now - st.at < PLAY_RETRY_MS) return false;
    if (st.n >= MAX_PLAY_RETRIES) {
      // 不再放弃:计数清零继续拉(熔断已删除)。真遇到拉不动的播放器,
      // 60 秒一次的节奏会一直重试,而不是整晚停在那里。
      st.n = 0;
      log('cx-playretry', '同一视频已拉 ' + MAX_PLAY_RETRIES + ' 次仍未播动,清零继续(不停止)');
    }
    st.n += 1;
    st.at = now;
    playRetries.set(key, st);
    rec('play-attempt', { i: tag, n: st.n, cur: Math.round((v.currentTime || 0) * 10) / 10 });
    try {
      playByUs = 1;
      const p = v.play();
      // 复位别用 setTimeout(0):超星播放器常在 play 之后几十毫秒内自己 pause 一次,
      // setTimeout(0) 复位太早,于是「我们自己的 play 引起的 pause」被记成外部暂停 → 误熔断。
      const resetByUs = () => { playByUs = 0; };
      if (p && typeof p.then === 'function') { p.then(resetByUs, resetByUs); }
      setTimeout(resetByUs, 1500);
      if (p && p.catch) {
        p.catch((e) => {
          const why = (e && e.name) || 'error';
          if (why !== lastPlayErr) { lastPlayErr = why; log('cx-playerr', why + ' | ' + String((e && e.message) || '').slice(0, 90)); }
        });
      }
    } catch (e) { playByUs = 0; }
    return true;
  }

  function driveVideo(t, idx) {
    // 隐藏的任务(iframe 被收起来)绝对不要 play —— 否则会把正在播的那个抢断/来回跳
    if (!visible(t.el, studyDoc())) return { ok: false, why: 'hidden' };
    const v = findVideo(t.doc);
    if (!v) return { ok: false, why: 'no-video' };
    watchVideo(v, idx === undefined ? -1 : idx);
    const s = cfg();
    const rate = Number(s.playbackRate) || 1;
    try {
      v.muted = true;                       // 静音,避免被浏览器拦自动播放
      if (v.playbackRate !== rate) v.playbackRate = rate;
      // 真机上出现过 readyState=0(播放器在,但没加载任何媒体):这种 play() 不会有反应,
      // 表现就是「视频停在那里永远不动」。每 10 秒补一次 load() 把它踹活。
      if (v.paused && !v.ended && v.readyState === 0) {
        const now2 = Date.now();
        const lk = 'load|' + (idx === undefined ? -1 : idx);
        const lt = playRetries.get(lk) || { n: 0, at: 0 };
        if (now2 - lt.at > 10000) {
          lt.at = now2; lt.n += 1; playRetries.set(lk, lt);
          try { v.load(); rec('kick-load', { i: idx === undefined ? -1 : idx, n: lt.n }); } catch (e) {}
        }
      }
      lastPickVideoEl = v;
      if (s.autoVideo !== false && v.paused && !v.ended) tryPlay(v, taskKey(t, idx), idx === undefined ? -1 : idx);
    } catch (e) { return { ok: false, why: 'error:' + e.message }; }
    return { ok: true, video: v, paused: v.paused, ended: v.ended, t: v.currentTime, dur: v.duration };
  }
  let lastPlayErr = '';

  // ---------- 视频弹题 ----------
  // 原插件:任务 iframe 里 .x-container-default 下的 .ans-videoquiz .tkTopic 可见即弹题
  function quizBox(t) {
    try {
      const root = t.doc && t.doc.getElementsByClassName('x-container-default')[0];
      if (!root) return null;
      const topic = root.querySelector('.ans-videoquiz .tkTopic');
      if (!topic || !visible(topic, t.doc)) return null;
      return root;
    } catch (e) { return null; }
  }

  async function handleQuiz(t) {
    const root = quizBox(t);
    if (!root) return false;
    const doc = t.doc;
    const stem = (root.innerText || '').trim().slice(0, 600);
    const title = (doc.getElementsByClassName('tkTopic_title')[0] || {}).innerText || '';
    const opts = Array.from(doc.getElementsByClassName('ans-videoquiz-opt')).map((e) => (e.innerText || '').trim());
    log('cx-quiz', 'found: ' + stem.slice(0, 40));

    const s = getSXK();
    const r = s ? await s.solve(stem, opts) : null;
    if (!r || !r.answer) { log('cx-quiz', 'solve-failed'); return true; }

    const answer = String(r.answer).toUpperCase();
    const submit = doc.getElementById('videoquiz-submit');
    if (!submit) { log('cx-quiz', 'no-submit'); return true; }

    const LETTER = /^\s*([A-Za-z])\s*[.、,，:：)）]?/;
    const pick = (el) => {
      const input = el.querySelector('[name="ans-videoquiz-opt"]') || el.querySelector('input');
      if (input) { if (!input.checked) input.click(); }
      else el.click();
    };
    const list = Array.from(doc.getElementsByClassName('ans-videoquiz-opt'));
    let clicked = 0;
    for (const el of list) {
      const m = (el.innerText || '').trim().match(LETTER);
      if (!m) continue;
      const letter = m[1].toUpperCase();
      const want = answer.includes(letter);
      const input = el.querySelector('[name="ans-videoquiz-opt"]') || el.querySelector('input');
      const isRadio = input && input.type === 'radio';
      if (want) { pick(el); clicked++; }
      else if (!isRadio && input && input.checked) input.click(); // 多选:取消不该选的
    }
    log('cx-quiz', 'answer=' + answer + ' clicked=' + clicked);
    submit.click();

    // 提交后若出现「继续学习」按钮,点它继续播放
    setTimeout(() => {
      try {
        const doc2 = t.doc;
        for (const id of ['videoquiz-continue', 'knowledgeBack']) {
          const b = doc2.getElementById(id);
          if (b && visible(b, doc2)) { b.removeAttribute('href'); b.click(); log('cx-quiz', 'continue:' + id); break; }
        }
        const v = findVideo(doc2);
        if (v && (cfg().autoVideo !== false)) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      } catch (e) {}
    }, 1500);
    return true;
  }

  // ---------- 「章节未完成」弹窗 ----------
  // 原插件 g():点完下一节等 4s,若 .jobFinishTip 是 block,就点 .popBottom .nextChapter 强行走
  function dismissJobTip() {
    const tip = document.querySelector('.jobFinishTip');
    if (!tip) return false;
    if (window.getComputedStyle(tip).display !== 'block') return false;
    const next = document.querySelector('.popBottom .nextChapter');
    if (!next) { log('cx-tip', 'jobFinishTip 但找不到 .popBottom .nextChapter'); return false; }
    next.removeAttribute('href');
    next.click();
    log('cx-tip', '点继续学习强行跳过未完成提示');
    return true;
  }

  // 其它常见遮挡:超星自己的「确定」弹层
  function dismissOtherPopups() {
    const btn =
      document.querySelector('.popbtnbox .Btn_blue') ||
      document.querySelector('.popbox_con .determine') ||
      document.querySelector('.el-message-box__headerbtn');
    if (btn && visible(btn, document)) { btn.click(); log('cx-popup', 'dismissed'); return true; }
    return false;
  }

  // ---------- 新版学习页:任务标签(PPT/教材/视频)+ 左侧目录 ----------
  // 2026-10-25 真机确认:新版 studentstudy 顶部有三个任务标签(dct1/dct2/dct3),
  // 平台自己的 #prevNextFocusNext 现在是「切到下一个任务标签」,不是「下一节」。
  // 旧逻辑只看 location.href 变没变,切标签时地址不变 → 误判空跳 → 整章卡住。
  function studyTabs() {
    try {
      const all = [...document.querySelectorAll('[id^="dct"]')];
      return all.filter((el) => /^dct\d+$/.test(el.id || ''));
    } catch (e) { return []; }
  }
  function studyTabState() {
    const tabs = studyTabs();
    let active = null;
    for (const t of tabs) {
      if (/(^|\s)(active|cur|current|on)(\s|$)/.test(String(t.className || ''))) { active = t; break; }
    }
    return { tabs, active, count: tabs.length, index: active ? tabs.indexOf(active) : -1 };
  }
  function tabText(el) {
    if (!el) return '?';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }
  function catalogItems() {
    try {
      let arr = [...document.querySelectorAll('.posCatalog_select')];
      if (!arr.length) {
        arr = [...document.querySelectorAll('.posCatalog_name')]
          .map((n) => n.closest('li,div'))
          .filter(Boolean);
      }
      return arr.filter((el, i) => arr.indexOf(el) === i);
    } catch (e) { return []; }
  }
  function catalogCurrent(items) {
    try {
      let cur = items.find((el) => /(^|\s)(active|cur|current|on)(\s|$)/.test(String(el.className || '')));
      if (!cur) {
        const cid = new URL(location.href).searchParams.get('chapterId') || '';
        if (cid) cur = items.find((el) => String(el.innerHTML || '').includes(cid));
      }
      if (!cur) {
        const title = String((document.querySelector('.chapter_title,.chapterTitle,.mark_title,.posCatalog_title') || {}).innerText || '').trim();
        if (title) cur = items.find((el) => String(el.innerText || '').includes(title));
      }
      return cur || null;
    } catch (e) { return null; }
  }
  // 目录里当前节打了勾(icon_Completed / 「已完成」)= 超星服务端认定的「整节任务点已完成」。
  // 2026-10-25 真机死锁:1.1.7 在目录里已经打勾,但页面上的播放器从没播过
  // (video.duration=0、currentTime=0),taskFinished 只看播放器 → fin=0,
  // 于是「跳节安全网」永远拦下(拦下跳节(目录已完成):还有 1 个视频任务没完成),
  // 而 tick 在拦下后直接 return,视频也得不到驱动 → 既不跳也不播,整门课停死。
  // 目录勾是服务端权威进度(文档任务点早就在用它),视频任务点同样采信;
  // 子 frame 没有左侧目录,只能继续用播放器的严格判定。
  function catalogCurrentCompleted() {
    if (window.top !== window) return false;
    try {
      if (Date.now() - catDoneCache.at < 1200) return catDoneCache.val;
      const cur = catalogCurrent(catalogItems());
      const val = !!(cur && (cur.querySelector('.icon_Completed') || /已完成/.test(String(cur.innerText || ''))));
      catDoneCache = { at: Date.now(), val };
      return val;
    } catch (e) { return false; }
  }

  // 目录里「下面连续几节都已打勾」时,直接跨过它们跳到第一个没打勾的节。
  // 真机整门课有大半节早就刷完了(1.1.1~1.1.5 全是 ✓),一节一节跳要 25 秒一节,
  // 跨过已完成节既省时间也少碰超星的风控。只跳过「节」(1.1.7 这种),章标题不动。
  function skipPastCompleted(items, cur) {
    if (window.top !== window) return false;
    if (cfg().autoSkipDone === false) return false;
    const now = Date.now();
    if (now - lastJumpAt < GAP_JUMP_MS) return false;
    const i = items ? items.indexOf(cur) : -1;
    if (i < 0) return false;
    let skipped = 0;
    let target = null;
    for (let j = i + 1; j < items.length; j++) {
      const el = items[j];
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/^\d+(\.\d+){1,3}\s/.test(t)) continue;                        // 章标题("1.1 第1章 命题逻辑")
      if (el.querySelector('.icon_Completed')) { skipped += 1; continue; }  // 已完成 → 跳过
      target = el;
      break;
    }
    if (!target || !skipped) return false;   // 紧挨着的下一节没打勾 → 交给正常跳节逻辑
    const cid = catalogChapterId(target);
    if (!cid) return false;
    lastJumpAt = now;
    jumpCount += 1;
    const toText = catalogText(target);
    log('cx-jump', `目录里 ${skipped} 节已完成,直接跳到 ${toText}`);
    rec('jump', { n: jumpCount, by: 'skip-done', skip: skipped, to: toText, cid });
    if (!goCatalog(target)) clickCatalog(target);
    return true;
  }

  function catalogNext(items, cur) {
    const i = items.indexOf(cur);
    if (i < 0) return null;
    for (let j = i + 1; j < items.length; j++) {
      const t = String(items[j].innerText || '').replace(/\s+/g, ' ').trim();
      // 只要真正的节(1.1.3 这种),跳过「1.1 第1章」这种章标题
      if (/^\d+(\.\d+){1,3}\s/.test(t)) return items[j];
    }
    return null;
  }
  function catalogText(el) {
    if (!el) return '?';
    return String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  function clickCatalog(item) {
    if (!item) return false;
    try {
      // 真机目录的可点击节点是 item 内的 span.posCatalog_name（onclick="getTeacherAjax(...)"），
      // 点外层 div 不会冒泡到它，旧实现因此出现「目录点击没反应」。
      const name = item.querySelector('.posCatalog_name') || item;
      try { name.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      name.click();
      return true;
    } catch (e) { return false; }
  }
  function catalogChapterId(item) {
    try {
      const name = (item && item.querySelector('.posCatalog_name')) || item;
      const code = String((name && name.getAttribute && name.getAttribute('onclick')) || '') + ' ' +
        String((item && item.getAttribute && item.getAttribute('onclick')) || '');
      const m = /getTeacherAjax\s*\(([^)]*)\)/.exec(code);
      if (m) {
        const nums = m[1].match(/\d{6,}/g);
        if (nums && nums.length) return nums[nums.length - 1];
      }
      const idm = String((item && item.id) || '').match(/^cur(\d+)$/);
      if (idm) return idm[1];
      const a = item && item.querySelector && item.querySelector('a[href*="chapterId="]');
      if (a) return new URL(a.href, location.href).searchParams.get('chapterId') || '';
    } catch (e) {}
    return '';
  }
  // 真机页面会给目录项绑 isTrusted 检查/框架事件，content script 里的合成 click 不生效；
  // 直接用目录项 onclick 里的 chapterId 拼 studentstudy URL，最稳。
  function goCatalog(item) {
    const cid = catalogChapterId(item);
    if (!cid) return false;
    try {
      const u = new URL(location.href);
      u.searchParams.set('chapterId', cid);
      location.href = u.toString();
      return true;
    } catch (e) { return false; }
  }
  function callCatalogHandler(item) {
    return goCatalog(item);
  }
  function clickStudyTab(tab) {
    if (!tab) return false;
    try {
      const a = tab.querySelector('a');
      (a || tab).click();
      return true;
    } catch (e) { return false; }
  }

  // ---------- 跳下一节 ----------
  // whose:'caller' 只用于日志,方便事后看清是谁触发的跳节
  function jumpNext(force, whose) {
    if (stopped) return false;
    if (cfg().autoJump === false) return false;
    const now = Date.now();
    if (now - lastJumpAt < GAP_JUMP_MS) return false;

    // 熔断已删除:这些计数只用来限流,不再停手。到顶就清零,
    // 否则一次卡住会把「跳下一节」永久禁掉,表现就是「全停了」。
    if (jumpCount >= MAX_JUMPS) {
      log('cx-jump', `已跳 ${jumpCount} 次,计数清零继续(不停止)`);
      jumpCount = 0;
    }
    if (stalledJumps >= 2) {
      log('cx-jump', '连续两次点下一节页面没变化,计数清零重试(不停止)');
      stalledJumps = 0;
    }

    // 安全网:只要本章还有没完成的视频任务,就不许跳 —— 这是「来回跳/漏播」的根源
    if (!force) {
      const sd = studyDoc();
      if (sd) {
        const pend = taskFrames().filter((t) => t.type === 'video' && !taskFinished(t));
        if (pend.length) {
          if (Date.now() - lastTickLog > 20000) {
            lastTickLog = Date.now();
            log('cx-jump', `拦下跳节(${whose || '?'}):还有 ${pend.length} 个视频任务没完成`);
          }
          return false;
        }
      }
    }

    const before = location.href;
    lastHref = before;

    // ★ 新版学习页:有任务标签时,先按标签顺序推进,最后才用目录跳下一节。
    //   直接点平台「下一节」也行,但它只切标签、不改地址,旧代码会误判失败。
    const ts = studyTabState();
    if (ts.count > 0 && ts.index >= 0) {
      if (ts.index < ts.count - 1) {
        const nxtTab = ts.tabs[ts.index + 1];
        const fromText = tabText(ts.active);
        const toText = tabText(nxtTab);
        clickStudyTab(nxtTab);
        lastJumpAt = now;
        jumpCount += 1;
        log('cx-jump', `第 ${jumpCount} 次推进:任务标签 ${fromText} → ${toText}`);
        rec('jump', { n: jumpCount, by: whose || 'unknown', tab: toText, href: location.href.slice(-40) });
        setTimeout(() => {
          const after = studyTabState();
          if (after.index === ts.index) {
            stalledJumps += 1;
            log('cx-jump', `标签没切过去(第 ${stalledJumps} 次),改点平台下一节`);
            const nb = document.querySelector('#prevNextFocusNext');
            if (nb) { try { nb.click(); } catch (e) {} }
          } else {
            stalledJumps = 0;
            log('cx-jump', `已切到任务标签 ${tabText(after.active)}`);
          }
        }, 1600);
        return true;
      }

      // 已经是最后一个任务标签 → 用左侧目录跳到真正的下一节
      const items = catalogItems();
      const cur = catalogCurrent(items);
      const nxt = catalogNext(items, cur);
      if (nxt) {
        const toText = catalogText(nxt);
        clickCatalog(nxt);
        lastJumpAt = now;
        jumpCount += 1;
        log('cx-jump', `第 ${jumpCount} 次推进:目录 ${catalogText(cur)} → ${toText}`);
        rec('jump', { n: jumpCount, by: whose || 'unknown', catalog: toText, href: location.href.slice(-40) });
        setTimeout(() => {
          if (location.href === before) {
            const nowCur = catalogCurrent(catalogItems());
            if (nowCur && catalogText(nowCur) === toText) {
              log('cx-jump', '目录点击后地址没变,可能已切换(继续观察)');
            } else {
              stalledJumps += 1;
              if (stalledJumps <= 1 && callCatalogHandler(nxt)) {
                log('cx-jump', `目录点击没反应(第 ${stalledJumps} 次),改用 chapterId 直跳`);
              } else {
                log('cx-jump', `目录点击没反应(第 ${stalledJumps} 次)`);
              }
            }
          } else {
            stalledJumps = 0;
          }
        }, 3000);
        return true;
      }
      log('cx-jump', `最后一个任务标签 ${tabText(ts.active)} 完成,但目录里找不到下一节,退回平台下一节`);
    }

    // 有的章节测验把「下一节」放在 #iframe 里,顶层 querySelector 找不到。
    // 先查顶层,再查学习页 iframe 和它内部的 iframe;最后按可见文字兜底。
    const nextDocs = [];
    try {
      nextDocs.push(document);
      const f0 = document.getElementById('iframe');
      if (f0 && f0.contentDocument) nextDocs.push(f0.contentDocument);
      for (const f of document.querySelectorAll('iframe')) {
        try { if (f.contentDocument && nextDocs.indexOf(f.contentDocument) < 0) nextDocs.push(f.contentDocument); } catch (e) {}
      }
      for (const d of nextDocs.slice()) {
        for (const f of d.querySelectorAll('iframe')) {
          try { if (f.contentDocument && nextDocs.indexOf(f.contentDocument) < 0) nextDocs.push(f.contentDocument); } catch (e) {}
        }
      }
    } catch (e) {}
    let next = null;
    for (const d of nextDocs) {
      try {
        next = d.querySelector('#prevNextFocusNext') || d.querySelector('a.nextChapter') || d.querySelector('.popBottom .nextChapter');
        if (!next) {
          next = [...d.querySelectorAll('a,button')].find((el) => /^下一节$/.test(String(el.innerText || el.textContent || '').replace(/\s+/g, '').trim()));
        }
      } catch (e) { next = null; }
      if (next) break;
    }
    if (!next) return false;
    const nextWin = (next.ownerDocument && next.ownerDocument.defaultView) || window;
    const disp = nextWin.getComputedStyle(next).display;
    if (disp === 'none') { log('cx-jump', '没有下一节了(课程可能已完成)'); return false; }

    try { const anchor = document.querySelector('#prevNextFocus'); if (anchor) anchor.scrollIntoView(); } catch (e) {}
    const beforeTab = tabText(ts.active);
    next.click();
    lastJumpAt = now;
    jumpCount += 1;
    log('cx-jump', `第 ${jumpCount} 次点下一节(触发:${whose || 'unknown'})`);
    rec('jump', { n: jumpCount, by: whose || 'unknown', href: location.href.slice(-40) });

    // 8 秒后看地址/任务标签有没有变:切标签也算成功,不能只看 URL
    setTimeout(() => {
      const changedTab = tabText(studyTabState().active) !== beforeTab;
      if (location.href === before && !changedTab) {
        stalledJumps += 1;
        log('cx-jump', `点了没反应(空跳 ${stalledJumps} 次)`);
        if (stalledJumps >= 2) stop('下一节点了不生效');
      } else {
        stalledJumps = 0;
        if (changedTab) log('cx-jump', `地址没变但任务标签已切换(${beforeTab} → ${tabText(studyTabState().active)})`);
      }
    }, 8000);
    return true;
  }

  // ---------- 主循环 ----------
  const START_AT = Date.now();
  let sawTaskFrame = false;
  let emptyTicks = 0;
  // 已经播完的任务(src → 时间戳),用来避免「播完又回到上一个视频」的死循环
  const endedAt = new Map();

  // 当前该操作哪个视频任务:
  // 1) 先排除已完成的
  // 2) 再挑「可见的」那个 —— 多个视频任务时,隐藏 iframe 里的视频绝不能去 play,
  //    否则会出现「播着播着被拉回第一个视频」的来回跳
  // 3) 优先还没播完的
  function pickVideoTask(vids) {
    const sd = studyDoc();
    const isVisible = (t) => {
      try {
        // 只看任务 iframe 本身是否显示。媒体元素在加载前尺寸可能是 0,不能拿来当判据。
        return visible(t.el, sd) && !!findVideo(t.doc);
      } catch (e) { return false; }
    };
    const inView = (t) => {
      try {
        const r = t.el.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        return r.bottom > 8 && r.top < vh - 8;
      } catch (e) { return false; }
    };
    // ★ 2026-10-24 真实页面实测(诊断日志「任务点体检」):
    //   #0 fin=0 vis=1 inView=1 20/860s / #1 fin=0 vis=1 inView=1 0/109s / #2 fin=0 vis=1 inView=0 18/106s
    //   三个视频**同时 vis=1,还有两个同时 inView=1**,src 去 query 后还完全一样。
    //   所以「取数组第一个」等于让随便一个视频接管 —— 表现就是「播一会跳到另一个视频」。
    //   新顺序:正在播的(锁死) > 未完成的 > 离视口中心最近的。
    const playingNow = vids.find((t) => {
      try {
        const vv = findVideo(t.doc);
        return !!vv && !vv.paused && !vv.ended && !vv.seeking && !taskFinished(t);
      } catch (e) { return false; }
    });
    if (playingNow) return playingNow;          // 已经在播的那个不许被换掉

    const unfinished = vids.filter((t) => !taskFinished(t));
    const pool = unfinished.length ? unfinished : vids;
    const shown = pool.filter(isVisible);
    const vis = shown.length ? shown : pool;
    // 同屏多个任务点都「可见」时,只驱动离视口中心最近的那个:
    // 超星把整章任务点一次性渲染出来,滚到屏幕外的那个去 play 会把正在播的抢断
    const onScreen = vis.filter(inView);
    const base = onScreen.length ? onScreen : vis;
    const fresh = base.filter((t) => !endedOf(t));
    const list = fresh.length ? fresh : base;
    const mid = (window.innerHeight || 800) / 2;
    const dist = (t) => {
      try { const r = t.el.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - mid); }
      catch (e) { return 1e9; }
    };
    return list.slice().sort((a, b) => dist(a) - dist(b))[0] || null;
  }

  // 这个任务是否已经播过
  // ★ 2026-10-24 修:以前拿 src.split('?')[0] 比较。超星一节课的 3 个视频任务 src 去掉 query
  //   后**完全一样**(都是 .../ananas/modules/video/index.html),于是任意一个视频播完,
  //   endedOf 对另外两个也返回 true → 去重表串味 → 挑任务退化成数组第一个。
  //   现在一律用 taskKey(带 data-dx-task-id 或序号)精确匹配,退化时也用完整 src(含 query)。
  function endedOf(t) {
    try {
      const fr = taskFrames();
      const idx = fr.findIndex((x) => x.el === t.el);
      if (idx >= 0 && endedAt.has(taskKey(t, idx))) return true;
    } catch (e) {}
    const full = (t.src || '').split('?')[0];
    if (!full) return false;
    // 一节课 3 个视频可能用完全相同的播放器地址(src 只差 query,甚至一模一样)。
    // 这种时候绝对不能靠 src 认「播完」:一个播完会把另外两个一起标成完成,
    // 触发「本章视频全完成」提前跳节,已播进度全丢。只有 src 在任务表里唯一时才允许兜底。
    let dup = 0;
    try { for (const x of taskFrames()) if ((x.src || '').split('?')[0] === full) dup++; } catch (e) { return false; }
    if (dup > 1) return false;
    for (const k of endedAt.keys()) {
      if (k.slice(k.indexOf('|') + 1) === full) return true;
    }
    return false;
  }

  // ---------- 结构诊断 ----------
  // 把当前课程页的 iframe / 任务点 / 视频状态导出成一行日志,
  // 用来在用户真实页面上一眼看清楚「谁在播、谁没完成」。
  function diag() {
    const out = {
      href: location.href.slice(0, 140),
      title: (document.title || '').slice(0, 50),
      hasStudy: !!studyDoc(),
      next: !!document.querySelector('#prevNextFocusNext'),
      tip: !!document.querySelector('.jobFinishTip'),
      jump: jumpCount,
      stopped: stopped || '',
      frames: [],
    };
    try {
      const fr = taskFrames();
      out.frames = fr.map((t, i) => {
        let fin = null, hasV = null, state = '';
        try { fin = taskFinished(t); } catch (e) {}
        try {
          const v = findVideo(t.doc);
          hasV = !!v;
          if (v) state = `${Math.floor(v.currentTime)}/${Math.floor(v.duration || 0)}s ended=${v.ended} paused=${v.paused} rate=${v.playbackRate}`;
        } catch (e) {}
        return { i, type: t.type, src: (t.src || '').split('?')[0].slice(-50), fin, hasV, state, done: endedOf(t) };
      });
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  }

  async function tick() {
    if (!isReady()) return;
    // 熔断机制已删除:这里没有任何「停止」状态,每轮都照常跑。

    // 先看是不是被超星判异常了(验证码/风控页),看到立刻停手,不要继续点
    const why = looksBlocked();
    if (why) { stop('页面出现验证/异常(' + why + ')'); return; }

    // 页面整片变白(超星风控后的典型表现):连续 3 次空白就停手,别在空白页上乱点
    const bodyLen = (((document.body && document.body.innerText) || '')).trim().length;
    if (bodyLen < 40) {
      blankCount += 1;
      if (blankCount >= 3) { stop('页面内容空白,疑似被风控拦截'); return; }
      return;
    }
    blankCount = 0;

    // 被超星播放器(鼠标移动/失焦/防挂机)暂停后 2.5 秒自动接回播放:
    // 不走 tryPlay 的 8 秒节流、也不消耗重试额度 —— 否则动几下鼠标额度就用光了。
    if (pendingResume && Date.now() >= pendingResume.at) {
      const pr = pendingResume;
      pendingResume = null;
      try {
        const isCurrent = !lastPickVideoEl || pr.v === lastPickVideoEl;
        if (!isCurrent) {
          rec('ext-resume-skip', { cur: Math.round((pr.v && pr.v.currentTime || 0) * 10) / 10 });
        } else if (pr.v && pr.v.paused && !pr.v.ended && !videoDone(pr.v)) {
          playByUs = 1;
          const p = pr.v.play();
          const off = () => { playByUs = 0; };
          if (p && typeof p.then === 'function') p.then(off, off); else off();
          setTimeout(off, 1500);
          rec('ext-resume', { cur: Math.round((pr.v.currentTime || 0) * 10) / 10 });
        }
      } catch (e) { playByUs = 0; }
    }

    if (dismissJobTip()) return;
    dismissOtherPopups();

    const sd = studyDoc();
    if (!sd) return;                       // 不是学习页(作业页/考试页交给通用逻辑),不要乱点

    // 关键:cx.js 在 iframe 里也跑一份,iframe 里拿不到左侧目录,catalogCurrent 永远是 null。
    // 顶层这里直接看目录:当前节已经打勾(icon_Completed)=整节任务点都完成,立刻推进下一节,
    // 不再依赖某个 iframe 的 taskFinished 去发现这件事。
    if (window.top === window) {
      try {
        const catItems = catalogItems();
        const catCur = catalogCurrent(catItems);
        if (catCur && catCur.querySelector('.icon_Completed')) {
          if (Date.now() - lastCatDoneLog > 15000) {
            lastCatDoneLog = Date.now();
            log('cx-jump', '目录当前节已完成(icon_Completed),推进下一节');
          }
          // 跳成功就结束本轮;被 25 秒限流拦下时继续往下走,
          // 让视频/文档任务点照样被驱动 —— 否则会停在「目录已完成」这条分支里什么都不做。
          // 后面连着几节也都打勾时,一次跨过去(否则 25 秒才挪一节);没有可跨的再走普通跳节
          if (skipPastCompleted(catItems, catCur)) return;
          if (jumpNext(false, '目录已完成')) return;
        }
      } catch (e) {}
    }

    const frames = taskFrames();
    if (frames.length) { sawTaskFrame = true; emptyTicks = 0; } else { emptyTicks += 1; }

    // iframe 还在加载:先等,别急着点「下一节」(原插件用 waitForDomState 做同样的事)
    // 必须连续多次都看不到任务 iframe 才认定「本章没有视频任务」,否则一次瞬时为空就会误跳,
    // 把还没播的任务点整章跳过(user 反馈的「视频来回跳/课不刷」就死在这里)
    if (!frames.length) {
      if (emptyTicks < 6) return;
      if (!sawTaskFrame && Date.now() - START_AT < 12000) return;
      jumpNext(false, '无任务iframe');
      return;
    }

    // 文档型任务点先推一步(不影响正在播的视频,只是把文档滚一点)
    const docs = frames.filter((t) => isDocTask(t));
    const undoneDoc = docs.filter((t) => !taskFinished(t));
    if (undoneDoc.length && window.top === window) {
      // taskFinished 里已经给了 10 秒兜底;这里再判一次,防止某个 iframe 的
      // docJumped 只在它自己那份 content script 里,顶层拿不到。
      const allStuck = undoneDoc.every((t) => {
        const src = docSrcKey(t);
        const at = docJumped.get(src) || 0;
        return at && Date.now() - at > 10000;
      });
      if (allStuck) {
        log('cx-doc', '文档到底 10 秒仍未收到完成标记,按已读推进下一节');
        jumpNext(false, '文档到底超时');
        return;
      }
    }
    if (undoneDoc.length) {
      try { driveDocQueue(undoneDoc, frames); } catch (e) {}
    }

    const vids = frames.filter((t) => t.type === 'video');
    if (vids.length) {
      // 每 60 秒自动把现场日志送到控制台:真实课程页出问题时不必等用户手动点按钮
      if (Date.now() - lastAutoDump > 60000) {
        lastAutoDump = Date.now();
        rec('auto', { frames: frames.length, vids: vids.length, done: vids.filter(taskFinished).length });
        sendLog();
      }
      const unfinished = vids.filter((t) => !taskFinished(t));
      // 视频全完成、但还有文档任务点没读完 -> 先别跳下一节,继续把文档滚完
      if (!unfinished.length && undoneDoc.length) {
        if (Date.now() - lastTickLog > 15000) {
          lastTickLog = Date.now();
          log('cx-doc', '视频都完成了,还有 ' + undoneDoc.length + ' 个文档任务点没读完,继续滚文档');
        }
        return;
      }
      // 所有视频任务点都完成了 → 跳下一节
      if (!unfinished.length) { jumpNext(false, '本章视频全完成'); return; }

      const t = pickVideoTask(vids);
      if (!t) {
        if (Date.now() - lastTickLog > 20000) {
          lastTickLog = Date.now();
          log('cx-video', `有 ${unfinished.length} 个未完成任务但挑不出可播的(可能都在加载)`);
        }
        return;
      }
      const key = taskKey(t, frames.indexOf(t));

      // 每 10 秒记一次「选中了谁、为什么」,多视频场景排查用
      if (Date.now() - lastPickLog > 10000) {
        lastPickLog = Date.now();
        rec('pick', {
          i: frames.indexOf(t),
          vids: vids.length,
          unfinished: unfinished.length,
          done: vids.filter(taskFinished).length,
          endedKeys: endedAt.size,
        });
      }

      // 有视频正在播:就让它播,绝不在这时点「下一节」或去驱动别的视频
      const playing = vids.find((x) => {
        try { const vv = findVideo(x.doc); return vv && !vv.paused && !vv.ended; } catch (e) { return false; }
      });
      if (playing && playing !== t) {
        // 例外:正在播的那个其实已经播完/被标记完成 → 让它停,好推进下一个。
        // (以前一律 return,一个「已完成但还在播」的视频会把整节课卡死,永远不推进。)
        let pv = null;
        try { pv = findVideo(playing.doc); } catch (e) { pv = null; }
        if (pv && (videoDone(pv) || taskFinished(playing))) {
          try { pv.pause(); } catch (e) {}
          rec('pause-done', { i: frames.indexOf(playing) });
        } else {
          return;
        }
      }

      if (await handleQuiz(t)) return;      // 有弹题先做题

      const v = findVideo(t.doc);

      // 每秒记一条现场快照(不发给后端,只进内存环形缓冲,点「诊断日志」时才导出)
      if (v) {
        rec('vid', {
          i: frames.indexOf(t),
          cur: Math.round((v.currentTime || 0) * 10) / 10,
          dur: Math.round((v.duration || 0) * 10) / 10,
          p: v.paused ? 1 : 0,
          e: v.ended ? 1 : 0,
          d: videoDone(v) ? 1 : 0,
          r: v.playbackRate,
          fin: taskFinished(t) ? 1 : 0,
          hid: document.hidden ? 1 : 0,
          foc: typeof document.hasFocus === 'function' && document.hasFocus() ? 1 : 0,
          rs: v.readyState,
          ns: v.networkState,
        });
      } else {
        rec('vid', { i: frames.indexOf(t), v: 0, fin: taskFinished(t) ? 1 : 0 });
      }

      // 调试:每 3 秒说一次为什么播/不播(排查真实页面时非常有用)
      if (Date.now() - lastDbg > 3000) {
        lastDbg = Date.now();
        log('cx-dbg', `frame=${frames.indexOf(t)} vis=${(() => { try { return visible(t.el, studyDoc()); } catch (e) { return 'err'; } })()} hasVideo=${!!v} fake=${v ? !!v.__fake : '-'} id=${v ? v.id || v.tagName : '-'} dur=${v ? v.duration : '-'} finished=${taskFinished(t)} ended=${v ? v.ended : '-'} paused=${v ? v.paused : '-'} rate=${v ? v.playbackRate : '-'}`);
      }

      // 这个视频已经播完:记下来,别再回头播它(否则会在几个视频之间来回跳)
      //
      // ★ 2026-10-24 真机:第一个视频播完后,同页第二个视频被当成「已播完」而永久暂停
      //   (日志:pick 一直选 i=1,但 i=1 的 cur 停在 63s 不再前进,也没有任何 play 尝试)。
      //   根因是 endedAt 的 key 撞车(data-dx-task-id 相同 / src 去掉 query 后相同),
      //   前一个视频播完把后一个也标成了「已播完」。这里以播放器事实为准:没播到底就清记录、继续驱动。
      const trulyDone = !!(v && videoDone(v));
      if (v && !trulyDone && endedAt.has(key)) {
        const dur1 = Number(v.duration) || 0;
        const cur1 = Number(v.currentTime) || 0;
        // readyState=0 = 播放器根本没加载媒体(真机日志里第二个视频就是这种),
        // 这种情况绝不能当成「已播完」,否则它会被永久暂停在这个分支里。
        const notLoaded = v.readyState === 0;
        if (notLoaded || (dur1 > 0 && cur1 < dur1 - 1)) {
          endedAt.delete(key);
          if (Date.now() - lastTickLog > 20000) {
            lastTickLog = Date.now();
            log('cx-video', '纠正误判:当前视频只到 ' + Math.round(cur1) + '/' + Math.round(dur1) + 's,不是播完,继续播放');
          }
        }
      }
      if (v && (trulyDone || endedAt.has(key))) {
        if (!endedAt.has(key)) {
          endedAt.set(key, Date.now());
          rec('ended', { i: frames.indexOf(t), cur: Math.round((v.currentTime || 0) * 10) / 10, dur: Math.round((v.duration || 0) * 10) / 10, e: v.ended ? 1 : 0, p: v.paused ? 1 : 0 });
        }
        try { v.pause(); } catch (e) {}
        const waited = Date.now() - (endedAt.get(key) || 0);
        // 播完后给超星最多 45 秒去标「已完成」;标上了才跳,没标也只在超过 45 秒后跳一次
        if (taskFinished(t)) { jumpNext(false, '任务已标记完成'); return; }
        if (waited > 45000) {
          // 只有这个视频真的播到底了才允许强制跳节。以前 endedAt 里有记录就 force 跳,
          // 而 endedAt 的 key 会串味(3 个视频 src 去 query 后完全一样),结果就是
          //「还没播完就强制跳下一节」—— 用户看到的「播一会就跳走」。
          if (v && videoDone(v)) {
            log('cx-video', '播完 45 秒仍未标记完成,尝试跳下一节');
            jumpNext(true, '超时未标记');
          } else if (Date.now() - lastTickLog > 20000) {
            lastTickLog = Date.now();
            log('cx-video', 'endedAt 有记录但当前视频没播到结尾,不强制跳节');
          }
        } else if (Date.now() - lastTickLog > 15000) {
          lastTickLog = Date.now();
          log('cx-video', `任务已播完(${endedAt.size}个),等超星标记完成 ${Math.floor(waited / 1000)}s`);
        }
        return;
      }

      // 卡住检测:显示「在播」但进度长时间不动 —— 真实超星播放器上很常见
      // (播放器内部暂停了但 paused 仍是 false,进度就永远停在某一秒)
      if (v) {
        const c0 = Number(v.currentTime) || 0;
        const st = stallState.get(key) || { cur: -1, at: 0, n: 0 };
        if (Math.abs(c0 - st.cur) < 0.05) {
          if (!st.at) st.at = Date.now();
          if (Date.now() - st.at > 15000) {
            st.n += 1;
            st.at = Date.now();
            rec('stall', { i: frames.indexOf(t), cur: Math.round(c0 * 10) / 10, dur: Math.round((v.duration || 0) * 10) / 10, p: v.paused ? 1 : 0 });
            log('cx-video', `进度卡在 ${Math.round(c0)}s 不动(第 ${st.n} 次),重新拉起播放`);
            // 必须走 tryPlay 节流:直接 v.play() 会绕过 8 秒节流,变成高频 play/pause 抖动,
            // 正是把超星惹毛(白屏+验证码)的动作。
            tryPlay(v, key, frames.indexOf(t));
          }
        } else { st.cur = c0; st.at = 0; st.n = 0; }
        stallState.set(key, st);
      }

      const r = driveVideo(t, frames.indexOf(t));
      if (r.ok && r.video && videoDone(r.video)) {
        endedAt.set(key, Date.now());
        rec('ended', { i: frames.indexOf(t), via: 'drive' });
        log('cx-video', '播放结束 → 等超星标记完成');
        return;                             // 交给下一轮 tick 判断是否已完成,不立刻跳
      }
      if (Date.now() - lastTickLog > 20000) {
        lastTickLog = Date.now();
        log('cx-video', r.ok
          ? `播放中 ${Math.floor(r.t || 0)}/${Math.floor(r.dur || 0)}s paused=${r.paused} rate=${r.video.playbackRate} 第${endedAt.size + 1}个任务`
          : 'no-video:' + r.why);
      }
      return;
    }

    // 文档/作业/章节测验等:全部完成后才跳
    // 整章只有文档任务点、并且都滚完了(超星已打完成标记)→ 跳下一节
    const nonDocTasks = frames.filter((t) => !isDocTask(t) && t.type !== 'audio');
    if (docs.length && !undoneDoc.length && !nonDocTasks.length) {
      jumpNext(false, '本章文档任务全完成');
      return;
    }

    const others = frames.filter((t) => t.type !== 'audio');
    if (others.length) {
      if (others.every((t) => taskFinished(t))) jumpNext();
      return;
    }
  }

  // ---------- 在子 iframe 内部运行时的精简循环 ----------
  // 有些页面把任务 iframe 挂到了别的子域(跨源),顶层拿不到 contentDocument。
  // 这时内容脚本会以 all_frames 注入到 iframe 内部,就地驱动视频即可。
  //
  // ★ 2026-10-24 修的坑:manifest 里是 all_frames,一个学习页有 3 个视频 iframe,
  //   于是 3 个 iframe 各自叫自己的 video.play() —— 三个视频同时播,超星播放器
  //   只允许一个在播,于是互相 pause,表现就是「播一下停一下、几个视频来回跳」。
  //   所以:iframe 里必须先确认自己是「当前显示在屏幕上的那个」,否则绝对不许 play。
  let lastLocalLog = 0;
  function frameOnScreen() {
    try {
      const fe = window.frameElement;
      if (!fe) return true;                          // 顶层,交给 tick()
      const doc = fe.ownerDocument || document;
      const win = doc.defaultView || window.parent;
      const r = fe.getBoundingClientRect();
      const vh = win.innerHeight || 800;
      if (r.width < 80 || r.height < 80) return false;
      // 只要和视口有一点点重叠就算「在显示」(超星是把任务点纵向排列、滚动切换)
      return r.top < vh * 1.05 && r.bottom > -vh * 0.05;
    } catch (e) {
      // 跨源时拿不到 frameElement,只能用自身文档可见性兜底
      return document.visibilityState === 'visible';
    }
  }

  // 同源时顶层 tick() 能直接驱动本帧(studyDoc → 任务 iframe → video),子帧不要插一脚。
  // 只有顶层根本够不到我们(跨源),或顶层 tick 明显没在跑(15 秒没心跳)时才自救。
  function shouldDriveSelf() {
    let topDoc = null;
    try { topDoc = window.top.document; void topDoc.title; } catch (e) { return true; }   // 跨源,只能自救
    try {
      const el = topDoc.documentElement;
      const beat = Number(el && el.getAttribute('data-sxk-top-tick')) || 0;
      if (beat && Date.now() - beat < 15000) return false;   // 顶层在跑 → 让它统一驱动
    } catch (e) {}
    return true;
  }

  function localTick() {
    const v = findVideo(document);
    if (!v) {
      // 文档型任务 iframe:同源时顶层 tick() 直接滚它;跨源时顶层拿不到 contentDocument,
      // 只能在自己的文档里自救,否则跨源文档任务点永远不会动。
      if (isDocUrl(location.pathname || '')) {
        try { scrollDocOnce(document, 'doc|local|' + (location.pathname || '').slice(0, 40)); } catch (e) {}
      }
      return false;
    }
    // ★ 2026-10-24 实测(诊断日志任务点体检):一节课 3 个视频任务的 src 去掉 query 完全一样,
    //   manifest 是 all_frames,于是三个 iframe 各自跑 localTick、各自 play 自己的 video,
    //   互相抢播放权 —— 表现为「播一会跳到另一个视频」。而顶层 tick() 同源就能直接驱动它们。
    //   证据:#2 从来没被顶层 pick 过,却有 18/106s 的进度。
    if (!shouldDriveSelf()) {
      if (Date.now() - lastLocalLog > 60000) {
        lastLocalLog = Date.now();
        log('cx-frame', '顶层在驱动本页,子帧让出播放权');
      }
      return false;
    }
    if (!frameOnScreen()) {
      if (Date.now() - lastLocalLog > 15000) {
        lastLocalLog = Date.now();
        log('cx-frame', '不是当前显示的任务,跳过播放 ' + (location.pathname || '').slice(0, 40));
      }
      return false;
    }
    const s = cfg();
    const rate = Number(s.playbackRate) || 1;
    try {
      v.muted = true;
      if (v.playbackRate !== rate) v.playbackRate = rate;
      // 子 iframe 里同样要节流,别每秒 play() 一次
      if (s.autoVideo !== false && v.paused && !v.ended) {
        watchVideo(v, 'local');
        tryPlay(v, 'local|' + (location.pathname || '').slice(0, 60), 'local');
      }
    } catch (e) {}
    return true;
  }

  async function safeTick() {
    try {
      if (window.top !== window) { localTick(); return; }
      // 子帧心跳:写在 DOM 属性上(跨 isolated world 一定可见)。不能写 window 属性 ——
      // 每个 frame 的内容脚本各有独立 isolated world,window 上的属性互相看不见。
      try { document.documentElement.setAttribute('data-sxk-top-tick', String(Date.now())); } catch (e) {}
      await tick();
    } catch (e) {
      log('cx-error', String((e && e.message) || e).slice(0, 120));
    }
  }

  CX.tick = safeTick;
  CX.jumpNext = jumpNext;
  CX.dismissJobTip = dismissJobTip;
  CX.handleQuiz = handleQuiz;
  CX.diag = diag;
  CX.framesOf = framesOf;
  CX.studyDoc = studyDoc;
  CX.taskFinished = taskFinished;
  CX.findVideo = findVideo;
  CX.videoDone = videoDone;
  // 诊断日志:面板点「诊断」按钮时调用(返回文本,同时把文本送到本地控制台)
  CX.dumpLog = dumpLog;
  CX.sendLog = sendLog;

  // 页面加载时读一次冷却标记:上次若因风控停手,现在还没到点就先别刷
  try {
    chrome.storage.local.get(['sxk_cx_cooldown_until', 'sxk_cx_stop_reason'], (r) => {
      // 熔断机制已删除:历史残留的冷却标记一律清掉,任何情况下都不阻断自动刷课。
      const until = Number((r && r.sxk_cx_cooldown_until) || 0);
      if (until || (r && r.sxk_cx_stop_reason)) {
        try { chrome.storage.local.remove(['sxk_cx_cooldown_until', 'sxk_cx_stop_reason']); } catch (e) {}
        log('cx-note', '已清理历史熔断记录(旧版本遗留),不影响本次刷课');
      }
    });
  } catch (e) {}

  window.SXKCX = CX;
})();
