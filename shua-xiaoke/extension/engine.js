'use strict';
/**
 * 刷小课 · 刷课引擎(共享逻辑)
 * 各平台 content script 引用本文件,复用同一套状态机与工具。
 * 机制均为通用公开页面操作:设置倍速、静音、自动点击播放/跳节/弹题、识别题目 DOM。
 */
const SXK = (() => {
  let settings = { autoVideo: true, playbackRate: 1, autoJump: true, autoAnswer: true, autoSubmit: false };
  let ready = false;

  async function loadSettings() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (r && r.settings) settings = { ...settings, ...r.settings };
    } catch (e) { /* 后端未启动则用默认 */ }
    ready = true;
  }

  // ---- 设置的实时同步 ----
  // 侧边栏/控制台改开关后:①background 广播 SETTINGS_CHANGED;②这里每 6 秒兜底回读一次。
  function applyLive() {
    try {
      document.querySelectorAll('video').forEach((v) => {
        if (!v) return;
        const rate = Number(settings.playbackRate) || 1;
        if (v.playbackRate !== rate) v.playbackRate = rate;
        if (settings.autoVideo && v.paused && !v.ended) {
          const p = v.play(); if (p && p.catch) p.catch(() => {});
        }
      });
    } catch (e) {}
  }

  function setLocalSettings(patch) {
    settings = { ...settings, ...(patch || {}) };
    applyLive();
  }

  async function setSettings(patch) {
    setLocalSettings(patch);
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
      if (r && r.settings) settings = { ...settings, ...r.settings };
      return r && r.ok;
    } catch (e) { return false; }
  }

  function startSettingsSync() {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'SETTINGS_CHANGED' && msg.settings) setLocalSettings(msg.settings);
      });
    } catch (e) {}
    setInterval(async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (r && r.settings) {
          const before = JSON.stringify(settings);
          settings = { ...settings, ...r.settings };
          if (JSON.stringify(settings) !== before) applyLive();
        }
      } catch (e) {}
    }, 6000);
  }

  function log(task, status) {
    try { chrome.runtime.sendMessage({ type: 'BRUSH_REPORT', site: location.hostname, task, status }); } catch (e) {}
  }

  // ---- 视频处理:倍速 + 静音 + 自动播放 ----
  function tuneVideo(video, rateOverride) {
    if (!video) return;
    try {
      video.muted = true;
      const rate = rateOverride || settings.playbackRate || 1;
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (settings.autoVideo && video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {}
  }

  // 监听页面里所有 video,统一调速并自动播放
  function watchVideos(rateOverride) {
    const apply = () => document.querySelectorAll('video').forEach(v => tuneVideo(v, rateOverride));
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // 周期兜底(有的播放器会替换节点/重置倍速)
    const iv = setInterval(apply, 2000);
    return { mo, iv };
  }

  // ---- 超星:自动跳下一节 ----
  // 页面公开提供"下一节"按钮 #prevNextFocusNext / .popBottom .nextChapter
  // 注意:章节测验/作业页的按钮在 #iframe 里,顶层 document 找不到。
  function chaoxingJumpNext() {
    if (!settings.autoJump) return false;
    // 学习页真正的「下一节」是左侧目录项(1.1.6 → 1.1.7):
    // 新版页面上右下角那个 #prevNextFocusNext 只是切任务标签,点了地址不变。
    // cx.js 里有成套的目录/chapterId 直跳逻辑,先交给它;它说没动再走下面的简单点按。
    try {
      const CX = (typeof window !== 'undefined' && window.SXKCX) || null;
      if (CX && typeof CX.jumpNext === 'function') {
        const moved = CX.jumpNext(true, 'engine-next');
        if (moved) { log('chaoxing-jump', '用 cx 目录逻辑跳下一节'); return true; }
        // cx 自己有限流(25 秒内不重复跳)。它说没动时**不能**再退回去点
        // #prevNextFocusNext —— 那个按钮在学习页只切任务标签,会把状态点乱。
        // 交给 jumpNextOnce 的定时重试,等它的限流过去再跳。
        return false;
      }
    } catch (e) {}
    let next = null;
    for (const root of collectRoots(false)) {
      try {
        const cands = [...root.querySelectorAll('#prevNextFocusNext,.popBottom .nextChapter,a.nextChapter')];
        cands.push(...[...root.querySelectorAll('a,button')].filter((el) => /^下一节$/.test(String(el.innerText || el.textContent || '').replace(/\s+/g, '').trim())));
        next = cands.find((el) => {
          try {
            const r = el.getBoundingClientRect();
            const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          } catch (e) { return false; }
        });
      } catch (e) { next = null; }
      if (next) break;
    }
    if (next) {
      try { next.scrollIntoView({ block: 'center' }); } catch (e) {}
      next.click();
      log('chaoxing-jump', 'clicked');
      return true;
    }
    return false;
  }

  // 超星:视频弹题自动关闭(公开弹题的"继续学习/关闭"按钮)
  function chaoxingDismissPopup() {
    const btn = document.querySelector('.popbtnbox .Btn_blue')      // 继续学习
      || document.querySelector('.popbox_con .determine')           // 确定
      || document.querySelector('.el-message-box__headerbtn');      // 通用关闭
    if (btn) { btn.click(); log('chaoxing-popup', 'dismissed'); return true; }
    return false;
  }

  // ---- 智慧树:自动跳下一节 + 倍速 ----
  function zhihuishuNext() {
    if (!settings.autoJump) return false;
    const next = document.querySelector('.el-icon-d-arrow-right')     // 右箭头(下一节)
      || document.querySelector('[class*="nextBtn"]')
      || document.querySelector('.㎖video-js .next-button');
    if (next) { next.click(); log('zhs-jump', 'clicked'); return true; }
    return false;
  }

  // ---- 题目识别:从页面提取题目文本与选项(通用启发式)----
  // 超星/学习通的作业、章节测验题目通常也在 #iframe 里面(同源,可直接访问)。
  // roots 参数就是这类"额外文档",一并扫描,否则只能看到顶层那几个。
  function collectRoots(excludeVideoFrames) {
    const roots = [document];
    // 顶层 #iframe(超星学习页 / 作业页)
    const f = document.getElementById('iframe');
    if (f) {
      try {
        const d = f.contentDocument;
        if (d) roots.push(d);
        // 作业/测验自己也会再套一层
        if (d) {
          for (const inner of d.getElementsByTagName('iframe')) {
            if (excludeVideoFrames && /\/ananas\/modules\/(video|audio)/.test(inner.src || '')) continue;
            try { if (inner.contentDocument) roots.push(inner.contentDocument); } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return roots;
  }

  // ---- 新版 fanya/mooc2 作业页适配 ----
  // 真机 /mooc-ans/mooc2/work/dowork 的选项不是 input+label,而是:
  //   .stem_answer > .answerBg[onclick="addChoice(this)"][qid][qtype]
  // 字母在 .num_option(单选/判断)/.num_option_dx(多选) 上,内部值在 data 属性;
  // 选中态是该字母节点上的 check_answer / check_answer_dx,并同步到行 aria-checked
  // 和隐藏字段 input#answer<qid>。只能点「选项行」让平台自己的处理器改状态,
  // 不能自己改 class / 隐藏字段(会与平台状态机打架)。
  const MOOC2_WORK_PATH = /^\/mooc-ans\/mooc2\/work\/dowork\/?$/i;

  function isMooc2Doc(doc) {
    try { return MOOC2_WORK_PATH.test(new URL(doc.URL || '').pathname); } catch (e) { return false; }
  }

  function mooc2Rows(el) {
    let rows = [];
    try { rows = [...el.querySelectorAll('.stem_answer .answerBg')]; } catch (e) { return []; }
    // 只认最内层选项行,避免皮肤把内容再包一层 .answerBg 时重复计选项
    rows = rows.filter((r) => {
      try { return !r.querySelector('.answerBg'); } catch (e) { return false; }
    });
    if (!rows.length) return [];
    if (el.matches && el.matches('.questionLi.singleQuesId')) {
      return rows.filter((r) => {
        try { return r.closest('.questionLi.singleQuesId') === el; } catch (e) { return false; }
      });
    }
    const qid = el.getAttribute && el.getAttribute('data-questionid');
    return qid ? rows.filter((r) => r.getAttribute('qid') === qid) : rows;
  }

  function mooc2RowInfo(row, idx, multi) {
    const marker = row.querySelector('.num_option_dx, .num_option') || null;
    const cls = String((marker && marker.className) || '');
    const clsSet = new Set(cls.split(/\s+/).filter(Boolean));
    const txt = String((marker && marker.textContent) || '').trim();
    const letter = ((txt.match(/[A-H]/i) || [])[1] || '').toUpperCase() || String.fromCharCode(65 + idx);
    const content = row.querySelector('.answer_p') || row;
    const text = String(content.innerText || content.textContent || '').replace(/\s+/g, ' ').trim();
    const img = content.querySelector('img');
    return {
      row, marker, letter, clsSet,
      data: marker ? String(marker.getAttribute('data') || '') : '',
      text: text || (img ? '[图片]' : ''),
      img: img ? (img.src || '') : '',
      selected: clsSet.has('check_answer') || clsSet.has('check_answer_dx'),
      wrong: multi ? clsSet.has('check_answer') : clsSet.has('check_answer_dx'),
    };
  }

  function mooc2SavedInput(el, qid) {
    try {
      const doc = el.ownerDocument || document;
      const wanted = 'answer' + qid;
      const all = [...doc.querySelectorAll('input[type=hidden],input[type="hidden"]')];
      const same = all.filter((i) => i.id === wanted || i.name === wanted);
      const own = same.find((i) => {
        try {
          const q = i.closest('.questionLi');
          return q === el || q === el.closest('.questionLi');
        } catch (e) { return false; }
      });
      return own || same[0] || null;
    } catch (e) { return null; }
  }

  function mooc2State(el) {
    const rows0 = mooc2Rows(el);
    const multi = rows0.some((r) => String(r.getAttribute('qtype') || '') === '1' || String(r.getAttribute('role') || '') === 'checkbox');
    const rows = rows0.map((r, i) => mooc2RowInfo(r, i, multi));
    const savedEl = mooc2SavedInput(el, rows0[0] ? String(rows0[0].getAttribute('qid') || '') : '');
    const saved = savedEl ? String(savedEl.value || '').trim() : null;
    const ariaBad = rows.some((r) => {
      const a = r.row.getAttribute('aria-checked');
      return a != null && (String(a) === 'true') !== r.selected;
    });
    const wrongClass = rows.some((r) => r.wrong);
    return {
      rows, multi, savedEl, saved,
      keys: rows.filter((r) => r.selected).map((r) => r.letter),
      consistent: !ariaBad && !wrongClass,
      ariaBad, wrongClass,
    };
  }

  function mooc2HasSelection(el) {
    const st = mooc2State(el);
    if (st.keys.length) return true;
    if (!st.saved) return false;
    // 有的页面隐藏字段初始是 0/-1 之类:只有能解码成真实选项才算已作答
    const dec = decodeMooc2Saved(st.saved, st.rows);
    return !!dec && dec.length > 0;
  }

  function decodeMooc2Saved(saved, rows) {
    const s = String(saved || '').trim();
    if (!s) return [];
    const datas = rows.map((r) => r.data).filter(Boolean);
    if (!datas.length) return null;
    if (datas.every((d) => d.length === 1)) {
      const out = [];
      for (const ch of s.split('')) {
        const hit = rows.filter((r) => r.data === ch)[0];
        if (!hit) return null;
        out.push(hit.letter);
      }
      return out;
    }
    const out = [];
    let i = 0;
    let guard = 0;
    while (i < s.length && guard++ < 64) {
      const cands = rows.filter((r) => r.data && s.startsWith(r.data, i));
      if (cands.length !== 1) return null;
      out.push(cands[0].letter);
      i += cands[0].data.length;
    }
    return i === s.length ? out : null;
  }

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  // ---- 填空题写回:优先用原生 setter 触发 Vue/React 的受控更新 ----
  // 直接 el.value=... 在受控输入上只会改 DOM,框架下一次渲染会把值冲掉,
  // 用户看到的就是「明明填了,框里却是空的」。
  function nativeSetValue(el, value) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, value); else el.value = value;
    } catch (e) {
      try { el.value = value; } catch (e2) {}
    }
  }

  function fireFieldInput(el, value) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) }));
    } catch (e) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
    }
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' })); } catch (e) {}
  }

  function visibleField(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return true; }
  }

  function answerSegments(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const segs = s.split(/#|;|\n/).map((x) => x.trim()).filter(Boolean);
    return segs.length ? segs : [s];
  }

  // UEditor:正文在 iframe(body contenteditable)里,隐藏 textarea 只是序列化载体。
  // 隔离世界拿不到父页面的 UE 实例,所以用 execCommand 模拟真实输入,再同步 textarea。
  function fillUEditor(root, value) {
    let n = 0;
    let frames = [];
    try {
      frames = [...root.querySelectorAll('iframe')].filter((f) => /edui|ueditor/i.test(String(f.className || '') + ' ' + String(f.id || '')));
    } catch (e) {}
    for (const f of frames) {
      let doc = null;
      try { doc = f.contentDocument; } catch (e) {}
      if (!doc || !doc.body) continue;
      try {
        const body = doc.body;
        body.focus();
        const sel = doc.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(body);
        sel.removeAllRanges();
        sel.addRange(range);
        let ok = false;
        try { ok = doc.execCommand('insertText', false, String(value)); } catch (e) {}
        if (!ok || !String(body.innerText || '').trim()) {
          body.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
          fireFieldInput(body, value);
        }
        n++;
      } catch (e) {}
    }
    // 同步关联的隐藏 textarea(平台保存时 serialize 的是它)
    try {
      const areas = [...root.querySelectorAll('textarea')];
      for (const a of areas) {
        if (!/answerEditor|answer\d+/i.test(String(a.id || '') + ' ' + String(a.name || ''))) continue;
        nativeSetValue(a, value);
        fireFieldInput(a, value);
      }
    } catch (e) {}
    return n;
  }

  function fillHasValue(root) {
    try {
      const fields = [...root.querySelectorAll('input[type=text],input:not([type]),textarea')].filter(visibleField);
      if (fields.some((f) => String(f.value || '').trim())) return true;
      for (const f of [...root.querySelectorAll('iframe')]) {
        try {
          const b = f.contentDocument && f.contentDocument.body;
          if (b && String(b.innerText || '').trim()) return true;
        } catch (e) {}
      }
      const eds = [...root.querySelectorAll('[contenteditable="true"],.edui-body-container')].filter(visibleField);
      return eds.some((e) => String(e.innerText || '').trim());
    } catch (e) { return false; }
  }

  async function fillTextAnswer(root, raw) {
    const segs = answerSegments(raw);
    const all = [...root.querySelectorAll('input[type=text],input:not([type]),textarea,[contenteditable="true"],.edui-body-container')]
      .filter((el) => !el.disabled && !el.readOnly);
    const fields = all.filter((el) => el.tagName !== 'DIV' && visibleField(el));
    const editables = all.filter((el) => el.tagName === 'DIV' && visibleField(el));
    let n = 0;
    fields.forEach((el, i) => {
      const v = segs[i] != null ? segs[i] : segs[0];
      el.focus();
      nativeSetValue(el, v);
      fireFieldInput(el, v);
      el.blur();
      n++;
    });
    editables.forEach((el, i) => {
      const v = segs[i] != null ? segs[i] : segs[0];
      el.focus();
      el.innerText = v;
      fireFieldInput(el, v);
      el.blur();
      n++;
    });
    n += fillUEditor(root, segs[0]);
    await sleep(90);
    const vals = fields.map((el) => String(el.value || '')).concat(editables.map((el) => String(el.innerText || '')));
    const want = String(segs[0] || '').replace(/\s+/g, '');
    const verified = vals.some((v) => v.replace(/\s+/g, '').indexOf(want) >= 0);
    return { count: n, verified, values: vals };
  }

  function pressRow(row) {
    try { row.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { row.click(); } catch (e) {}
  }

  function pressRowHard(row) {
    try {
      const opt = { bubbles: true, cancelable: true, view: window };
      row.dispatchEvent(new MouseEvent('mousedown', opt));
      row.dispatchEvent(new MouseEvent('mouseup', opt));
      row.dispatchEvent(new MouseEvent('click', opt));
    } catch (e) {}
  }

  function callRowHandler(row, multi) {
    try {
      const fn = window[multi ? 'addMultipleChoice' : 'addChoice'];
      if (typeof fn === 'function') fn(row);
    } catch (e) {}
  }

  async function applyMooc2Answer(q, raw, letters) {
    const el = q.el;
    const first = mooc2State(el);
    if (!letters.length) {
      // 填空/简答:普通输入框、contenteditable、UEditor iframe 都试一遍
      const r = await fillTextAnswer(el, raw);
      if (!r.count) return { ok: false, mode: 'mooc2-noletter' };
      return { ok: true, mode: 'mooc2-input', filled: r.count, verified: r.verified, got: r.values };
    }
    if (!first.rows.length) {
      // 有的题(填空/简答)整题没有 .answerBg;至少把文本输入填上
      const r = await fillTextAnswer(el, raw);
      if (!r.count) return { ok: false, mode: 'mooc2-norow' };
      return { ok: true, mode: 'mooc2-input', filled: r.count, verified: r.verified, got: r.values };
    }
    const targets = first.rows.filter((r) => letters.includes(r.letter));
    if (!targets.length) {
      return { ok: false, mode: 'mooc2-letter-miss', letters, available: first.rows.map((r) => r.letter) };
    }
    const want = targets.map((r) => r.letter).sort().join('');
    const cur = first.keys.slice().sort().join('');
    if (cur === want && first.consistent) {
      return { ok: true, mode: 'mooc2-already', letters, saved: first.saved, selected: first.keys };
    }
    const had = first.keys.slice();
    // 1) 正常点击(平台 inline onclick 就是给用户点击用的)
    for (const t of targets) {
      const now = mooc2State(el).rows.filter((r) => r.letter === t.letter)[0];
      if (now && now.selected) continue;
      pressRow(now ? now.row : t.row);
      await sleep(150);
    }
    let st = mooc2State(el);
    let deadline = Date.now() + 1000;
    while (Date.now() < deadline && !(st.keys.slice().sort().join('') === want && st.consistent)) {
      await sleep(120);
      st = mooc2State(el);
    }
    // 2) 页面皮肤不认 element.click():再补一轮完整鼠标事件 + 平台处理器兜底
    if (!(st.keys.slice().sort().join('') === want && st.consistent)) {
      for (const t of targets) {
        const now = mooc2State(el).rows.filter((r) => r.letter === t.letter)[0];
        if (now && now.selected) continue;
        pressRowHard(now ? now.row : t.row);
        await sleep(170);
      }
      st = mooc2State(el);
      deadline = Date.now() + 900;
      while (Date.now() < deadline && !(st.keys.slice().sort().join('') === want && st.consistent)) {
        await sleep(140);
        st = mooc2State(el);
      }
      if (!(st.keys.slice().sort().join('') === want && st.consistent)) {
        for (const t of targets) {
          const now = mooc2State(el).rows.filter((r) => r.letter === t.letter)[0];
          if (now && now.selected) continue;
          callRowHandler(now ? now.row : t.row, st.multi);
          await sleep(200);
        }
        st = mooc2State(el);
      }
    }
    let savedOk = null;
    if (st.saved) {
      const decoded = decodeMooc2Saved(st.saved, st.rows);
      savedOk = decoded ? decoded.slice().sort().join('') === want : false;
    }
    const got = st.keys.slice().sort().join('');
    // 以页面真实选中态(class + aria)为准;隐藏字段有些页面提交前才写,只作为附加诊断
    const ok = got === want && st.consistent;
    return {
      ok, mode: 'mooc2-click', letters, selected: st.keys, saved: st.saved, savedOk,
      had, stuck: ok ? undefined : true, available: st.rows.map((r) => r.letter),
    };
  }

  // 题干提取:超星作业页题干可能在 .Zy_TItle / .questionTxt / .mark_name 里,
// 也可能整题就是图片(这时文字只剩选项字母 A B C D)。逐个候选取「最像题干的」。
function stemOf(el) {
  const cands = [];
  const add = (t) => {
    const v = String(t == null ? '' : t).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (v) cands.push(v);
  };
  const inAnswer = (n) => {
    try { return !!(n.closest && n.closest('.stem_answer, .answerBg')); } catch (e) { return false; }
  };
  for (const sel of ['.Zy_TItle', '.questionTxt', '.mark_name', '.mark_key', '[class*="stem"]']) {
    try { el.querySelectorAll(sel).forEach((n) => { if (!inAnswer(n)) add(n.innerText); }); } catch (e) {}
  }
  // 整块文字里扣掉选项区,剩下的才像题干(新版 .stem_answer 必须整块扣掉)
  let rest = String(el.innerText || '');
  try {
    const sa = el.querySelector('.stem_answer');
    if (sa) {
      const t = String(sa.innerText || '').trim();
      if (t) rest = rest.split(t).join(' ');
    }
  } catch (e) {}
  try {
    el.querySelectorAll('.Zy_ulTop li, .Zy_ulBottom li, .answerList li, .optionItem, .answerBg, label').forEach((o) => {
      const t = String(o.innerText || '').trim();
      if (t && t.length > 0) rest = rest.split(t).join(' ');
    });
  } catch (e) {}
  add(rest);
  let best = '';
  let bestScore = -1;
  for (const c of cands) {
    const solid = c.replace(/[\sA-H、．\.)）:：]/g, '').length;
    const score = solid * 10 + Math.min(c.length, 120);
    if (solid > 0 && score > bestScore) { bestScore = score; best = c; }
  }
  return best || cands[0] || '';
}

﻿// 超星的题干/选项图是图片,而且常跨域(p.ananas.chaoxing.com)。
// 内容脚本直接 fetch 会被 CORS 挡掉,所以:先页面内 fetch(带 cookie),失败交给后台扩展 fetch
// (扩展有 host 权限,不受 CORS 限制),两条都不行才把 URL 原样给后端。
async function imgToData(u) {
  if (!u) return '';
  if (/^data:/.test(u)) return u;
  try {
    const r = await fetch(u, { credentials: 'include' });
    if (r && r.ok) {
      const b = await r.blob();
      if (b && b.size <= 3e6) {
        const fr = new FileReader();
        const d = await new Promise((res) => { fr.onload = () => res(String(fr.result || '')); fr.onerror = () => res(''); fr.readAsDataURL(b); });
        if (d) return d;
      }
    }
  } catch (e) {}
  try {
    const r2 = await chrome.runtime.sendMessage({ type: 'FETCH_IMG', url: u });
    if (r2 && r2.ok && r2.data) return r2.data;
    if (r2 && r2.errstr) log('img-fail', String(r2.errstr).slice(0, 60) + ' ' + String(u).slice(-40));
  } catch (e) {}
  return '';
}

  // 把一道题的题干+选项整块截图。超星很多题选项本身就是图片,还带防盗链,
  // 直接抓图会 403/被 CORS 挡,截屏是最稳的路。
  async function shotElement(el) {
    try {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const w = Math.min(r.width, vw - x);
      const h = Math.min(r.height, vh - y);
      if (w < 80 || h < 40) return '';
      const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_RECT', rect: { x: x, y: y, w: w, h: h }, dpr: window.devicePixelRatio || 1 });
      if (res && res.ok && res.data) return res.data;
      if (res && res.errstr) log('shot-fail', String(res.errstr).slice(0, 60));
    } catch (e) {}
    return '';
  }

  async function imgsAsData(imgs) {
  const out = [];
  const list = (imgs || []).slice(0, 6);
  for (const u of list) {
    if (!u) continue;
    const d = await imgToData(u);
    out.push(d || u);
  }
  return out;
}

﻿  // 题目容器:只认「最内层」。
  // 真机踩过:超星作业页整页 wrapper(#fanyaMarking)也带 .TiMu,它把 20 道题全包住;
  // 一旦保留外层,整份作业就被当成 1 道题 —— 只答出第一题的字母,后面的题永远不动。
  function qContainers(root) {
    const SEL = '.TiMu, .questionLi, .examPaper_question, .questionItem, .mark_item, .subtopic';
    let all = [];
    try { all = [...root.querySelectorAll(SEL)]; } catch (e) { all = []; }
    const leaf = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    const scored = leaf.filter((el) => el.querySelector('input[type=radio],input[type=checkbox],input[type=text],textarea,.Zy_ulTop li,.Zy_ulBottom li,.optionItem,.stem_answer .answerBg'));
    // 超星会在隐藏容器/隐藏 iframe 里再放一份同样的题,hidden 副本既点不动也截不到图。
    // 只保留真正参与布局的容器;若全被判隐藏(极端页面),回退原列表。
    let shown = [];
    try {
      shown = scored.filter((el) => {
        try {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
          const cs = getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden';
        } catch (e) { return true; }
      });
    } catch (e) { shown = []; }
    if (shown.length) return shown;
    return scored.length ? scored : leaf;
  }

  // 单题选项:按 DOM 顺序取,字母优先从 "A." 前缀或 .num_option 拿,拿不到按顺序补齐
  function optsIn(el) {
    // 新版 mooc2:每一项是 .answerBg 行,字母在 .num_option(_dx),内容在 .answer_p
    const mrows = mooc2Rows(el);
    if (mrows.length) {
      const multi = mrows.some((r) => String(r.getAttribute('qtype') || '') === '1' || String(r.getAttribute('role') || '') === 'checkbox');
      return mrows.map((row, i) => {
        const info = mooc2RowInfo(row, i, multi);
        return {
          el: row, letter: info.letter, text: info.text, img: info.img,
          mooc2: true, data: info.data, marker: info.marker,
        };
      });
    }
    let raw = [];
    try { raw = [...el.querySelectorAll('.Zy_ulTop li, .Zy_ulBottom li, .optionItem, .answerList li, [class*="option"]')]; } catch (e) { raw = []; }
    // 兜底:选项行类名不固定(真机 旧版测验/练习 用过 .mark_letter li 这类),按 radio/checkbox 反推所在行。
    // 没有这一步时 opts 恒为空,「是否已作答」只能看填空 → 已答的判断题被当成没答,提交门槛永远不满足。
    if (!raw.length) {
      let boxes = [];
      try { boxes = [...el.querySelectorAll('input[type=radio],input[type=checkbox]')]; } catch (e) { boxes = []; }
      boxes.forEach((box) => {
        let row = null;
        try { row = box.closest('li,label,dd,dl>div,p'); } catch (e) { row = null; }
        if (!row) row = box.parentElement;
        if (row && raw.indexOf(row) < 0) raw.push(row);
      });
    }
    // [class*="option"] 会把 <i class="num_option">A.</i> 这种字母标记也算进来,
    // 结果选项元素变成「只有字母的 i」,选项图/选项文字全丢 → 模型只能瞎猜字母。
    raw = raw.filter((o) => /^(LI|LABEL)$/i.test(o.tagName) || !!o.querySelector('input[type=radio],input[type=checkbox],img'));
    const leaf = raw.filter((o) => !raw.some((p) => p !== o && o.contains(p)));
    const seen = new Set();
    const out = [];
    leaf.forEach((o) => {
      if (seen.has(o)) return;
      seen.add(o);
      const t = String(o.innerText || '').replace(/\s+/g, ' ').trim();
      const im = o.querySelector('img');
      const numTxt = String(((o.querySelector('.num_option, .optionNum, i, em, span')) || {}).innerText || '').trim();
      const lab = ((t.match(/^([A-H])[\.、,．:：\s]/i) || [])[1]) || ((numTxt.match(/([A-H])/i) || [])[1]);
      const letter = lab ? lab.toUpperCase() : String.fromCharCode(65 + out.length);
      out.push({ el: o, letter, text: t || (im ? '[图片]' : ''), img: im ? (im.src || '') : '' });
    });
    return out;
  }

  function extractQuestions(opts) {
    const excludeVideoFrames = !opts || opts.includeVideoFrames !== true;
    const qs = [];
    for (const root of collectRoots(excludeVideoFrames)) {
      qContainers(root).forEach((el) => {
        const stemRaw = stemOf(el);
        const solid = stemRaw.replace(/[\sA-H、．\.)）:：]/g, '').length;
        const imgOnly = solid < 2;
        if (!stemRaw && !imgOnly) return;
        // 题干图(公式/化学式/电路图在超星里基本是图);新版 .stem_answer 是选项区,不能算题干图
        const stemImgs = [];
        try {
          el.querySelectorAll('.questionTxt img, .Zy_TItle img, [class*="stem"] img, .mark_name img').forEach((im) => {
            if (!im || !im.src || im.src.length <= 8) return;
            try { if (im.closest && im.closest('.stem_answer, .answerBg')) return; } catch (e) {}
            if (stemImgs.indexOf(im.src) < 0) stemImgs.push(im.src);
          });
        } catch (e) {}
        const opts = optsIn(el);
        // 新版 mooc2:记下 qid/单选多选,写回时按选项行点击 + 回读状态
        let mooc2 = null;
        const mrows = mooc2Rows(el);
        if (mrows.length) {
          mooc2 = {
            isMooc2: true,
            qid: String(mrows[0].getAttribute('qid') || el.getAttribute('data-questionid') || ''),
            typename: String(el.getAttribute('typename') || ''),
            multiple: mrows.some((r) => String(r.getAttribute('qtype') || '') === '1' || String(r.getAttribute('role') || '') === 'checkbox'),
          };
        }
        // 图片顺序必须和「哪一项」对应上,否则模型只能瞎猜字母
        const imgParts = [];
        stemImgs.slice(0, 2).forEach((s) => imgParts.push({ role: '题干', src: s }));
        opts.forEach((o) => {
          let list = [];
          try { list = [o.img].concat([...o.el.querySelectorAll('img')].map((x) => x.src || '')); } catch (e) { list = [o.img]; }
          const uniq = list.filter((v, i) => v && v.length > 8 && list.indexOf(v) === i);
          uniq.slice(0, 2).forEach((s) => { if (!imgParts.some((p) => p.src === s)) imgParts.push({ role: '选项' + o.letter, src: s }); });
        });
        const useParts = imgParts.slice(0, 6);
        const legend = useParts.length ? '【图片对照】' + useParts.map((p, i) => '图' + (i + 1) + '=' + p.role).join(';') : '';
        const stem = (legend ? legend + '\n' : '') + stemRaw.slice(0, 400);
        qs.push({ el, stem, stemText: stemRaw.slice(0, 400), options: opts.map((o) => o.text).slice(0, 8), imgs: useParts.map((p) => p.src), opts, imgOnly, legend, mooc2 });
      });
    }
    return qs;
  }

  // 点选项:超星把点击处理器绑在 label / a / li 上,直接点隐藏 radio 有时不会被它的脚本认可,
  // 所以按「用户真的会点的地方」来点,最后再确保 input 是选中的。
  function clickOption(el) {
    try {
      const box = el.querySelector('input[type=radio],input[type=checkbox]');
      const label = el.querySelector('label') || (el.tagName === 'LABEL' ? el : null) || el.querySelector('a') || el;
      try { label.click(); } catch (e) {}
      if (box && !box.checked) {
        try { box.checked = true; } catch (e) {}
        try { box.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { box.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      }
      try { el.classList.add('on'); } catch (e) {}
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    } catch (e) {}
  }

  // ---- 把答案写回页面 ----
  // answer 可能是字母("A" / "A#C" / "A,C")也可能是填空文本
  async function applyAnswer(q, answer) {
    const raw = String(answer == null ? '' : answer).trim();
    if (!raw || !q || !q.el) return { ok: false, mode: 'none' };

    // 1) 提取答案里的选项字母
    const letters = (raw.toUpperCase().match(/[A-H]/g) || []).filter((v, i, a) => a.indexOf(v) === i);

    // 1.5) 新版 mooc2 作业页:走选项行点击 + 状态回读。这里必须 await:
    // 平台的 addChoice/addMultipleChoice 是异步更新 class/aria/隐藏字段的。
    if (q.mooc2 && q.mooc2.isMooc2) return await applyMooc2Answer(q, raw, letters);
    if (!q.mooc2) {
      try {
        const doc = q.el.ownerDocument || document;
        if (isMooc2Doc(doc) || mooc2Rows(q.el).length) return await applyMooc2Answer(q, raw, letters);
      } catch (e) {}
    }

    // 2) 收集页面上的选项元素及其字母
    const optEls = [...q.el.querySelectorAll('.optionItem, .Zy_ulBottom li, [class*="option"], li')]
      .filter(el => (el.innerText || '').trim().length < 500);
    const parsed = optEls.map((el) => {
      const m = (el.innerText || '').trim().match(/^([A-H])[\.、,．:：\s]/i);
      return { el, letter: m ? m[1].toUpperCase() : '' };
    });

    // 3) 选择题:点击对应字母的选项
    if (letters.length && Array.isArray(q.opts) && q.opts.length) {
      // 以识别阶段记下的元素为准(图片选项没有文字,只能靠位置/字母对上)
      const mine = q.opts.filter((p) => p.letter && letters.includes(p.letter));
      if (mine.length) {
        mine.forEach(({ el }) => clickOption(el));
        const check = () => mine.some(({ el }) => {
          const b = el.querySelector('input[type=radio],input[type=checkbox]');
          if (b && b.checked) return true;
          const cls = String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || '');
          return /(^|\s)(on|cur|current|selected|check)(\s|$)/i.test(cls);
        });
        let stuck = check();
        if (!stuck) {
          // 有些皮肤只认 li 自身的 click
          mine.forEach(({ el }) => { try { el.click(); } catch (e) {} });
          stuck = check();
        }
        // 点完读不到选中状态就别假装成功:否则会「锁死成已完成」但页面上其实没选,
        // 或者一直重复点同一道题。返回失败让上层有限次重试。
        return { ok: !!stuck, mode: 'choice-img', letters, stuck };
      }
    }

    if (letters.length) {
      const targets = parsed.filter(p => p.letter && letters.includes(p.letter));
      if (targets.length) {
        targets.forEach(({ el }) => clickOption(el));
        return { ok: true, mode: 'choice', letters };
      }
    }

    // 3.5) 有选项的题(选择题)绝不走填空分支 —— 以前会先把选项点掉、再把答案打进输入框
    const hasOptionEls = optEls.some((el) => /(^|\s)(optionItem|Zy_ulBottom|cur|on)(\s|$)/.test(String(el.className || '')) || el.querySelector('input[type=radio],input[type=checkbox]'));
    if (hasOptionEls) return { ok: false, mode: 'choice-no-match' };

    // 4) 填空:写入输入框/富文本编辑器
    const rr = await fillTextAnswer(q.el, raw);
    if (rr.count) {
      return { ok: true, mode: 'input', filled: rr.count, verified: rr.verified, got: rr.values };
    }

    return { ok: false, mode: 'unmatched' };
  }

  // ---- 自动做题:识别 → 解题 → 写回页面 ----
  async function autoAnswerAll(tag) {
    const qs = extractQuestions();
    let solved = 0;
    let applied = 0;
    for (const q of qs) {
      lastAnswerAt = Date.now();
      const r = await solve(q.stem, q.options, q.imgs && q.imgs.length ? await imgsAsData(q.imgs) : null);
      if (!r || !r.answer) continue;
      solved++;
      const res = await applyAnswer(q, r.answer);
      if (res.ok) applied++;
      log(`${tag}-solve`, `${q.stem.slice(0, 20)} → ${r.answer} [${res.mode}${res.ok ? '' : '/未写入'}]`);
    }
    return { ok: applied > 0, count: applied, found: qs.length, solved };
  }

  // ---- 作业/测验页:自动开始做题 ----
  // 之前的版本只注册了 AUTO_ANSWER 监听,必须有「人来点一下」才动;
  // 作业页打开后一片安静就是这么来的。这里改成页面自己判断 + 定时跑。
  let answerWatchTimer = null;
  let autoSubmitTimer = null;
  // 答题活动时间:只有真正开始处理题目时才刷新,空转轮次不算,否则 10 秒兜底永远不会触发。
  let answerBusy = false;
  let lastAnswerAt = Date.now();
  let quizIdleTimer = null;
  let idleJumpedHref = '';
  let lastJumpAt = 0;
  let lastJumpHref = '';
  let lastSubmitAt = 0;
  let lastSubmitHref = '';
  // 诊断用:同一条 href 只体检一次,避免把日志刷满
  let autoSubmitProbed = '';
  let idleMissHref = '';
  let lastIdleMissLog = 0;
  let lastIdleBeat = 0;
  // 兜底用「已答题数」当时钟,不用 lastAnswerAt:答题器每 6 秒跑一轮,即使一道都没答上
  // 也会刷新 lastAnswerAt,那样 10 秒兜底永远不会触发(真机 29 题里就卡在这一条)。
  let idleDone = -1;
  let idleDoneAt = Date.now();
  const answeredKeys = new Set();
  // 用元素身份去重:题干文字每次可能不一样(选中态、序号),按文字去重会重复作答、把已选的答案改掉
  const answeredEls = new WeakSet();

  function qKey(q) {
    // 新版作业页用平台 qid 做身份,比题干文本稳(同一题干可能重复出现)
    if (q && q.mooc2 && q.mooc2.qid) return 'mq:' + q.mooc2.qid;
    return String(q.stem || '').replace(/\s+/g, '').slice(0, 80) + '#' + (q.options || []).join('|').slice(0, 60);
  }

  // 同一道题最多试 2 次。超星有些题的点击并不会真的选中(选了又弹回去),
  // 不设上限的话就是 6 秒一轮、永远在解题 —— 用户看到的就是「解题不会停」。
  const attempts = new Map();

  // 同一道题可能被「顶层内容脚本」和「iframe 里的内容脚本」同时看到,
  // 各自解一遍就会出现「先选 D 又改成 C」。这里用 chrome.storage 做 60 秒占位。
  async function claimQuestion(key) {
    try {
      const o = await chrome.storage.local.get('sxk_claim');
      const m = (o && o.sxk_claim) || {};
      const now = Date.now();
      Object.keys(m).forEach((k) => { if (now - m[k] > 120000) delete m[k]; });
      if (m[key] && now - m[key] < 60000) return false;
      m[key] = now;
      await chrome.storage.local.set({ sxk_claim: m });
      return true;
    } catch (e) { return true; }
  }
  function attemptKey(q) {
    return String(qKey(q) || '').replace(/\s+/g, '').slice(0, 70);
  }

  // 真机 learning 页(studentstudy)的题目在深层 iframe 里,顶层内容脚本看不见。
  // 所以「提交/兜底」现在每个 frame 都跑,由看得见题目的那一层动手;多层同名帧
  // 同时看见同一份作业时,用 chrome.storage 占位,避免一次作业被点两次「提交」。
  async function claimSubmit(href) {
    try {
      const key = 'sub:' + String(href || location.href).slice(-90);
      const o = await chrome.storage.local.get('sxk_submit');
      const m = (o && o.sxk_submit) || {};
      const now = Date.now();
      Object.keys(m).forEach((k) => { if (now - m[k] > 180000) delete m[k]; });
      if (m[key] && now - m[key] < 90000) return false;
      m[key] = now;
      await chrome.storage.local.set({ sxk_submit: m });
      return true;
    } catch (e) { return true; }
  }

  // 日志里标出干活的是哪一层 frame:顶层看不见题目时,靠这个字段定位
  function frameTag() {
    if (window.top === window) return 'top';
    let nm = '';
    try { nm = window.name || ''; } catch (e) {}
    return 'fr:' + String(nm || location.hostname).slice(0, 24);
  }

  // 左侧目录在顶层,跳节只能由顶层做;子 frame 提交完就请顶层代跳。
  function requestJumpFromTop(tag) {
    if (window.top === window) { jumpNextOnce(tag); return; }
    try {
      chrome.runtime.sendMessage({ type: 'SXK_JUMP_REQUEST', href: location.href, tag }, (r) => {
        log(tag, '已请顶层跳下一节:' + ((r && r.ok) ? 'ok' : ((r && (r.errstr || r.why)) || '无返回')));
      });
    } catch (e) { log(tag, '请求顶层跳节异常:' + e.message); }
  }

  function looksLikeWorkPage() {
    try {
      const path = location.pathname || '';
      const search = location.search || '';
      if (/\/(work|exam|quiz)(\/|$)/i.test(path)) return true;
      if (/doHomeWorkNew|workId=|examId=|selectWorkQuestion/i.test(path + search)) return true;
    } catch (e) {}
    try {
      if (document.querySelector('.TiMu, .questionLi, .Zy_TItle, .examPaper_question')) return true;
    } catch (e) {}
    try {
      const f = document.getElementById('iframe');
      const d = f && f.contentDocument;
      if (d && d.querySelector('.TiMu, .questionLi, .Zy_TItle, .examPaper_question')) return true;
    } catch (e) {}
    // 真机 studentstudy 的作业常常嵌在 #iframe 里再套一层 iframe(工作模块)。
    // 上层判断只看一层会漏，这里用真正的提取结果兜底：能提出题就是作业页。
    try { if (extractQuestions().length) return true; } catch (e) {}
    return false;
  }

  // 作业页结构一次性体检:把识别到的题目容器和片段记进日志,
  // 以后真实页提取不准时,看这一条就能知道选择器差在哪。
  let workDumped = false;
  function dumpWorkDom(tag) {
    if (workDumped) return;
    workDumped = true;
    try {
      const qs = extractQuestions();
      const lines = ['识题 ' + qs.length + ' 道', 'href=' + String(location.href).slice(0, 120)];
      lines.push('mooc2-doc=' + isMooc2Doc(document) + ' mooc2-all=' + qs.map((q, i) => q.mooc2 ? (q.mooc2.qid + ':' + q.opts.length + '/' + (q.mooc2.multiple ? 'M' : 'S')) : ('x' + i + ':' + q.opts.length)).join(','));
      try {
        for (const c of collectRoots(true)) {
          const n = c.querySelectorAll('.TiMu, .questionLi, .Zy_TItle, .examPaper_question').length;
          lines.push('root[' + String(c.URL || 'top').slice(0, 60) + '] hit=' + n);
        }
      } catch (e) {}
      qs.slice(0, 3).forEach((q, i) => {
        lines.push('#' + i + ' cls=' + String(q.el.className || '').slice(0, 40) + ' imgOnly=' + q.imgOnly + ' stem=' + JSON.stringify(String(q.stem || '').slice(0, 60)) + ' opts=' + q.opts.length + ' imgs=' + q.imgs.length);
        if (q.mooc2) {
          try {
            const st = mooc2State(q.el);
            lines.push('#' + i + ' mooc2 qid=' + q.mooc2.qid + ' type=' + (q.mooc2.typename || '?') + ' multi=' + q.mooc2.multiple + ' rows=' + st.rows.length + ' sel=' + st.keys.join('') + ' saved=' + JSON.stringify(String(st.saved == null ? '' : st.saved).slice(0, 24)) + ' ariaBad=' + st.ariaBad + ' wrong=' + st.wrongClass + ' letters=' + st.rows.map((r) => r.letter + ':' + r.data).join(','));
          } catch (e) {}
        }
        lines.push('#' + i + ' html=' + String(q.el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 600));
        try {
          const flds = [...q.el.querySelectorAll('input,textarea,[contenteditable="true"],iframe')]
            .map((x) => x.tagName + (x.id ? '#' + x.id : '') + (x.className ? '.' + String(x.className).split(/\s+/)[0] : '') + (x.type ? '[' + x.type + ']' : '') + (x.isContentEditable ? '[ce]' : '') + '@' + (() => { try { const r = x.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); } catch (e) { return '?'; } })())
            .join(' | ');
          lines.push('#' + i + ' fields=' + (flds || '无'));
        } catch (e) {}
      });
      log('work-dom', lines.join(' | '));
    } catch (e) { log('work-dom-err', String((e && e.message) || e)); }
  }

﻿  async function answerPass(tag) {
    const qs = extractQuestions();
    // 跨内容脚本实例(以及 iframe/多标签)都必须认同一把锁,所以锁写在 DOM 属性上
    const pending = qs.filter((q) => {
      const el = q.el || {};
      if (answeredEls.has(el) || answeredKeys.has(qKey(q))) return false;
      if (el.dataset && (el.dataset.sxkDone === '1' || el.dataset.sxkBusy === '1')) return false;
      return true;
    });
    const queue = pending.filter((q) => (attempts.get(attemptKey(q)) || 0) < 2);
    if (!queue.length) {
      if (pending.length) log('auto-answer', tag + ' ' + pending.length + ' 道题已试满 2 次仍没选上,本轮不再重试');
      return { found: qs.length, applied: 0, pending: pending.length };
    }
    let applied = 0;
    answerBusy = true;
    lastAnswerAt = Date.now();
    for (const q of queue) {
      // 用户随时可能在侧边栏/控制台把「自动做题」关掉:每道题前都复查一次,关了就立刻停手
      if (!settings.autoAnswer) { log('auto-answer', tag + ' 自动做题已关闭,停止作答'); break; }
      if (attempts.get(attemptKey(q)) >= 2) continue;
      // eslint-disable-next-line no-await-in-loop
      if (!(await claimQuestion(attemptKey(q)))) { log('auto-answer', tag + ' 这道题另一个实例正在做,跳过'); continue; }
      // 页面已经选好了(刷新回填/上次答过)就别再动,免得把对的答案改错
      try {
        const pre = [...q.el.querySelectorAll('input[type=radio],input[type=checkbox]')].some((b) => b.checked)
          || (q.mooc2 && q.mooc2.isMooc2 && mooc2HasSelection(q.el))
          || (!(q.opts || []).length && fillHasValue(q.el));
        if (pre) { answeredEls.add(q.el); try { q.el.dataset.sxkDone = '1'; } catch (e) {} continue; }
      } catch (e) {}
      lastAnswerAt = Date.now();
      try { q.el.dataset.sxkBusy = '1'; } catch (e) {}
      // 选项只有字母(内容在图片里)/整题是图片 → 直接截这块给模型看图作答
      const poorOpts = !(q.options || []).some((t) => String(t).replace(/^[A-H][\.、,．:：\s]*/i, '').trim().length >= 1);
      let imgs = null;
      let src = 'none';
      // 只有「整题就是一张图」或「选项里连一个字都没有」才值得截屏。
      // 判断题/选择题都有 对/错、A/B/C/D 文字,以前每道题都去截屏,既慢又被权限挡住。
      const needShot = q.imgOnly || (!(q.options || []).length && poorOpts);
      if (needShot) {
        try { q.el.scrollIntoView({ block: 'start' }); } catch (e) {}
        await new Promise((res2) => setTimeout(res2, 320));
        // 留一点上边距,避免题号/第一行被视口顶边裁掉
        try { window.scrollBy(0, -90); } catch (e) {}
        await new Promise((res2) => setTimeout(res2, 120));
        const shot = await shotElement(q.el);
        if (shot) { imgs = [shot]; src = 'shot'; }
        else {
          // 超星有的题容器在滚动层里,getBoundingClientRect 会被裁成很小;
          // 退化到整页可见区域截图,至少把当前这道题的真实字形带给模型(乱码题必须靠图)。
          const shot2 = await shotElement(document.body);
          if (shot2) { imgs = [shot2]; src = 'shot-page'; }
        }
      }
      if (!imgs && q.imgs && q.imgs.length) { imgs = await imgsAsData(q.imgs); src = 'img'; }
      const r = await solve(q.stem, q.options, imgs);
      if (r && r.answer && q.opts.length === 0 && /用户给了一个题目|这看起来是乱码|乱码严重|无法辨认|需要.*图片|选项.*未显示|^(题目要求|用户要求|我们需要|我需要|这看起来|图片)/.test(String(r.answer))) {
        log('auto-answer', '模型把题干复述回来了,丢弃这次答案:' + String(r.answer).slice(0, 40));
        r.answer = '';
      }
      let appliedOne = false;
      let lastRes = null;
      if (r && r.answer) {
        const res = await applyAnswer(q, r.answer);
        lastRes = res;
        if (res.ok) {
          try { answeredEls.add(q.el); q.el.dataset.sxkDone = '1'; } catch (e) {}
          try { delete q.el.dataset.sxkBusy; } catch (e) {}
          answeredKeys.add(qKey(q));
          applied++;
          appliedOne = true;
          log(tag + '-auto', (q.stemText || '').slice(0, 16) + ' → ' + r.answer + ' [' + res.mode + '/' + src + (res.stuck === false ? '/没选上' : '') + ']');
        }
      }
      if (!appliedOne) {
        try { delete q.el.dataset.sxkBusy; } catch (e) {}
        const ak = attemptKey(q);
        const n = (attempts.get(ak) || 0) + 1;
        attempts.set(ak, n);
        const why = lastRes ? (lastRes.mode || '') + (lastRes.available ? ' 可选=' + lastRes.available.join('') : '') + (lastRes.selected ? ' 选中=' + lastRes.selected.join('') : '') + (lastRes.saved ? ' 保存=' + String(lastRes.saved).slice(0, 16) : '') : (r && r.answer ? 'apply未返回' : '解题无答案');
        log('auto-answer', tag + ' 这道题没选上(第 ' + n + ' 次):' + String(q.stemText || q.stem || '').slice(0, 30) + ' [' + why + ']');
      } else {
        attempts.set(attemptKey(q), 99);
      }
      // 一题一题来,别把 20 道题瞬间糊在页面上(也避免上游限流)
      await new Promise((res2) => setTimeout(res2, 700));
    }
    answerBusy = false;
    lastAnswerAt = Date.now();
    return { found: qs.length, applied, pending: pending.length };
  }
  function watchAutoAnswer(tag) {
    if (answerWatchTimer) return;
    const tick = async () => {
      try {
        if (!settings.autoAnswer) return;
        if (/antispiderShowVerify|captcha|verify/i.test(location.href)) return;
        if (!looksLikeWorkPage()) return;
        dumpWorkDom(tag);
        let r = null;
        try {
          r = await answerPass(tag);
        } finally {
          answerBusy = false;
        }
        if (r && r.applied) log('auto-answer', `${tag} 已作答 ${r.applied} 题(共识别 ${r.found} 题)`);
      } catch (e) { /* 单轮失败不影响下一轮 */ }
    };
    answerWatchTimer = setInterval(tick, 6000);
    setTimeout(tick, 2000);
  }

  // ---- 自动提交 ----
  // 作业/测验页:所有题都有答案后才允许提交。只在顶层跑一次,避免 iframe 重复点。
  function questionAnswered(q) {
    try {
      if (q.mooc2) return mooc2HasSelection(q.el);
      const opts = q.opts || [];
      if (opts.length) {
        if (opts.some((o) => {
          const box = o.el.querySelector && o.el.querySelector('input[type=radio],input[type=checkbox]');
          return !!(box && box.checked);
        })) return true;
        return opts.some((o) => {
          const cls = String((o.el && o.el.className) || '');
          return /(^|\s)(on|cur|current|selected|check|checked)(\s|$)/i.test(cls) ||
            String(o.el.getAttribute('aria-checked') || '') === 'true';
        });
      }
      return fillHasValue(q.el);
    } catch (e) { return false; }
  }
  function isExamPage() {
    return /\/exam|exam-ans|selectQuestion|examId=/i.test(location.pathname + location.search);
  }
  // 提交成功和 10 秒兜底都可能想点「下一节」,这里做一次 8 秒去重,避免连跳两节。
  function jumpNextOnce(tag) {
    if (lastJumpHref === location.href && Date.now() - lastJumpAt < 8000) return false;
    lastJumpAt = Date.now();
    lastJumpHref = location.href;
    const ok = chaoxingJumpNext();
    log(tag, ok ? '已点下一节' : '没找到下一节按钮');
    if (!ok) scheduleJumpRetry(tag);
    return ok;
  }
  // 「提交完就卡在这一节不动」是真机上最常见的结果:cx 的跳节有 25 秒限流,
  // 提交完成的那一刻往往正好落在限流窗口里。这里按 9 秒间隔重试到限流过去。
  let jumpRetryTimer = null;
  function scheduleJumpRetry(tag) {
    if (jumpRetryTimer) return;
    const startHref = location.href;
    let n = 0;
    const step = () => {
      jumpRetryTimer = null;
      if (location.href !== startHref) return;      // 已经跳走了
      if (!settings.autoJump) return;
      n += 1;
      const ok = chaoxingJumpNext();
      log('jump-retry', `第 ${n} 次重试下一节 ` + (ok ? '成功' : '还没找到'));
      if (ok || n >= 4) return;
      jumpRetryTimer = setTimeout(step, 9000);
    };
    jumpRetryTimer = setTimeout(step, 9000);
  }
  // 子 frame 提交完成后,后台会把 SXK_JUMP_NEXT 转给顶层;只有顶层需要响应。
  let remoteJumpListening = false;
  function listenRemoteJump() {
    if (remoteJumpListening) return;
    remoteJumpListening = true;
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'SXK_JUMP_NEXT') return;
        if (window.top !== window) return;
        log('remote-jump', '收到子 frame 的跳节请求(' + (msg.from || '?') + '),0.8 秒后点下一节');
        setTimeout(() => { jumpNextOnce('remote-jump'); }, 800);
      });
    } catch (e) {}
  }

  function watchAutoSubmit(tag) {
    if (autoSubmitTimer) return;
    // 真机的题目可能只存在于深层 iframe 里:每个 frame 都监控,谁看得见题目谁提交。
    listenRemoteJump();
    log('auto-submit', `监控启动(${frameTag()}) submit=${!!settings.autoSubmit} answer=${!!settings.autoAnswer}`);
    let lastPendingLog = 0;
    let sentAt = 0;
    let sentHref = '';
    const tick = () => {
      try {
        if (!settings.autoSubmit || !settings.autoAnswer) return;
        // 每个 href 体检一次:真机出问题时,这条日志直接说明「这一层看不看得见作业/题目」
        if (autoSubmitProbed !== location.href) {
          autoSubmitProbed = location.href;
          let ifr = 'no-iframe';
          try {
            const f = document.getElementById('iframe');
            ifr = f ? (f.contentDocument ? 'ok:' + f.contentDocument.querySelectorAll('.TiMu,.questionLi,.Zy_TItle,.examPaper_question').length : 'crossorigin') : 'no-iframe';
          } catch (e) { ifr = 'err'; }
          log('auto-submit', '首轮体检(' + frameTag() + ') work=' + looksLikeWorkPage() + ' exam=' + isExamPage()
            + ' 本题=' + document.querySelectorAll('.TiMu,.questionLi,.Zy_TItle,.examPaper_question').length
            + ' 提取=' + (() => { try { return extractQuestions().length; } catch (e) { return 'err'; } })()
            + ' iframe=' + ifr + ' href=' + String(location.href).slice(0, 110));
        }
        if (location.href === sentHref && Date.now() - sentAt < 60000) return;
        if (!looksLikeWorkPage()) return;
        if (isExamPage()) {
          if (Date.now() - lastPendingLog > 60000) { lastPendingLog = Date.now(); log('auto-submit', '考试页不自动提交(只处理作业/测验)'); }
          return;
        }
        const qs = extractQuestions();
        if (!qs.length) return;
        const pending = qs.filter((q) => !questionAnswered(q));
        if (pending.length) {
          if (Date.now() - lastPendingLog > 30000) {
            lastPendingLog = Date.now();
            log('auto-submit', `还有 ${pending.length}/${qs.length} 题没作答,先不提交`);
          }
          return;
        }
        // 题都答完了:缓 4 秒,让最后一道题的平台状态落下去,再复核一次
        sentAt = Date.now();
        sentHref = location.href;
        log('auto-submit', `全部 ${qs.length} 题已作答,准备提交`);
        setTimeout(async () => {
          try {
            if (!settings.autoSubmit) return;
            const qs2 = extractQuestions();
            const left = qs2.filter((q) => !questionAnswered(q));
            if (left.length) { log('auto-submit', `提交前复核又有 ${left.length} 题没作答,取消`); return; }
            // 多层 frame 可能都看得见同一份作业,只让抢到占位的那一层点提交
            if (!(await claimSubmit(location.href))) { log('auto-submit', '另一层已经在提交这份作业,跳过'); return; }
            lastSubmitAt = Date.now();
            lastSubmitHref = location.href;
            chrome.runtime.sendMessage({ type: 'AUTO_SUBMIT_PAGE', href: location.href }, (resp) => {
              if (resp && resp.ok) {
                // 把页面那边真正点到了什么一起记下来:以后提交没生效,看这一条就知道
                // 是没找到按钮(why)、按钮点了没弹框、还是弹框在别的 frame。
                log('auto-submit', '已触发提交(' + frameTag() + '):' + (resp.text || resp.why || 'ok')
                  + ' | by=' + (resp.by || '?') + ' dialog=' + (resp.dialog || '无')
                  + ' frame=' + (resp.dialogFrame || '?') + ' yes=' + (resp.yes || '?')
                  + ' wait=' + (resp.waited || 0) + 'ms why=' + (resp.why || '?'));
                if (settings.autoJump) {
                  setTimeout(() => { requestJumpFromTop('auto-submit'); }, 3000);
                }
              } else {
                log('auto-submit', '提交没点成:' + ((resp && (resp.errstr || resp.why)) || '无返回')
                  + ' |' + JSON.stringify(resp || {}).slice(0, 300));
              }
            });
          } catch (e) { log('auto-submit', '提交异常:' + e.message); }
        }, 4000);
      } catch (e) { /* 单轮失败不影响下一轮 */ }
    };
    autoSubmitTimer = setInterval(tick, 6000);
    setTimeout(tick, 5000);
  }

  // ---- 答题完成后的兜底 ----
  // 有些测验会留空题(模型/截图都拿不到),自动提交的「全部答完」门槛会一直卡住。
  // 这里只看答题活动:识别到题后连续 10 秒没有任何新的作答动作,就认为本轮做完了,
  // 自动提交开着就先强制提交一次,然后点下一节;没开就只点下一节。
  function watchQuizIdle(tag) {
    if (quizIdleTimer) return;
    listenRemoteJump();
    let armed = false;
    const tick = () => {
      try {
        if (!settings.autoAnswer) return;
        if (!looksLikeWorkPage()) {
          // 只在顶层留体检:子 frame 里「看不见作业页」是正常现象,不该刷日志
          if (window.top === window && (idleMissHref !== location.href || Date.now() - lastIdleMissLog > 30000)) {
            idleMissHref = location.href;
            lastIdleMissLog = Date.now();
            let ifr = 'no-iframe';
            try {
              const f = document.getElementById('iframe');
              ifr = f ? (f.contentDocument ? 'ok:' + f.contentDocument.querySelectorAll('.TiMu,.questionLi,.Zy_TItle,.examPaper_question').length : 'crossorigin') : 'no-iframe';
            } catch (e) { ifr = 'err'; }
            log('quiz-idle', '未识别为作业页(' + frameTag() + ') 本题='
              + document.querySelectorAll('.TiMu,.questionLi,.Zy_TItle,.examPaper_question').length
              + ' iframe=' + ifr + ' href=' + String(location.href).slice(0, 110));
          }
          return;
        }
        if (isExamPage()) return;
        let qs = [];
        try { qs = extractQuestions(); } catch (e) { return; }
        if (!qs.length) return;
        let done = 0;
        try { done = qs.filter(questionAnswered).length; } catch (e) {}
        if (done !== idleDone) { idleDone = done; idleDoneAt = Date.now(); }
        // 心跳:真机里这条停止跳动,就说明页面 JS 被冻结(DevTools 断点 / 后台节流)
        if (Date.now() - lastIdleBeat > 30000) {
          lastIdleBeat = Date.now();
          log('quiz-idle', '心跳(' + frameTag() + ') 题=' + qs.length + ' 已答=' + done);
        }
        if (!armed) {
          armed = true;
          idleDoneAt = Date.now();
          log('quiz-idle', `识别到 ${qs.length} 题(${frameTag()}),连续 12 秒没有新作答就兜底`);
          return;
        }
        if (Date.now() - idleDoneAt < 12000) return;
        if (idleJumpedHref === location.href) return;
        idleJumpedHref = location.href;
        log('quiz-idle', `已 ${Math.round((Date.now() - idleDoneAt) / 1000)} 秒没有新作答(${done}/${qs.length}),执行兜底`);
        const doJump = () => {
          if (settings.autoJump) requestJumpFromTop('quiz-idle');
          else log('quiz-idle', '自动跳节关着,不点下一节');
        };
        if (settings.autoSubmit && lastSubmitHref !== location.href) {
          lastSubmitHref = location.href;
          lastSubmitAt = Date.now();
          log('quiz-idle', '先强制提交(允许空题)');
          claimSubmit(location.href).then((claimed) => {
            if (!claimed) { log('quiz-idle', '另一层已经在提交这份作业,交给它'); return; }
            try {
              chrome.runtime.sendMessage({ type: 'AUTO_SUBMIT_PAGE', href: location.href }, (resp) => {
                if (resp && resp.ok) log('quiz-idle', '提交已触发(' + frameTag() + '):' + (resp.text || 'ok'));
                else log('quiz-idle', '提交没点成:' + ((resp && (resp.errstr || resp.why)) || '无返回'));
                setTimeout(doJump, 3000);
              });
            } catch (e) { setTimeout(doJump, 3000); }
          });
        } else if (settings.autoSubmit && Date.now() - lastSubmitAt < 10000) {
          // 正常自动提交刚发出去,等它走完 confirm/弹窗再跳
          return;
        } else {
          doJump();
        }
      } catch (e) { /* 单轮失败不影响下一轮 */ }
    };
    quizIdleTimer = setInterval(tick, 2000);
    setTimeout(tick, 4500);
    log('quiz-idle', `监控启动(${frameTag()}) autoAnswer=${!!settings.autoAnswer} autoSubmit=${!!settings.autoSubmit} autoJump=${!!settings.autoJump}`);
  }

  // 统一的 AUTO_ANSWER 监听(各平台刷课脚本共用)
  function listenAutoAnswer(tag) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'AUTO_ANSWER') return;
      autoAnswerAll(tag)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, errstr: e.message }));
      return true;
    });
  }

  // ---- 与后台解题 ----
  async function solve(question, options, images) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SOLVE', question, options, images: images || [] });
      return r && r.result ? r.result : null;
    } catch (e) { return null; }
  }

  function isReady() { return ready; }
  function getSettings() { return settings; }

  return {
    loadSettings, getSettings, isReady, log,
    tuneVideo, watchVideos,
    chaoxingJumpNext, chaoxingDismissPopup, zhihuishuNext,
    extractQuestions, solve, applyAnswer, autoAnswerAll, listenAutoAnswer,
    watchAutoAnswer, answerPass, looksLikeWorkPage, setSettings, startSettingsSync, applyLive,
    watchAutoSubmit, questionAnswered, isExamPage, watchQuizIdle,
    mooc2State, mooc2Rows, isMooc2Doc,
  };
})()

// 同一个扩展的所有内容脚本共享同一个隔离世界(same isolated world),
// 所以侧边栏可以直接拿这份引擎去识别/作答,不必绕 background 转一圈。
try {
  if (typeof window !== 'undefined' && window) window.__SXK = SXK;
} catch (e) {}
