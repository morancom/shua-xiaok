'use strict';
/**
 * 刷小课 · 侧边栏
 *
 * 写法参考原「大学搜题酱」插件(它的 SideBar.d70b0916.js 用 Plasmo 的
 * createShadowContainer 把整个侧边栏塞进 #plasmo-shadow-container 的 shadow root,
 * 再在页面右侧放一排圆形按钮 .sidebar{top:97px;right:8px})。这里用原生 API 复刻同样的结构:
 *
 *   1. 宿主 div#sxk-host 固定定位、z-index 2147483647、pointer-events:none;
 *   2. attachShadow({mode:'open'}),里面的样式文件以内联 <style> 注入 ——
 *      这样不需要 web_accessible_resources,页面 CSS 也污染不到面板;
 *   3. shadow 内分两部分:右侧竖排圆形按钮(.sxk-dock)+ 悬浮圆角面板(.sxk-panel)。
 *
 * 对外能力:快捷键 Ctrl+Shift+S、扩展图标(经 background 转发)、
 * 目标站点自动弹出、AI 对话(经 background 走 SSE)、一键自动做题。
 */
(() => {
  if (window.__sxkInjected) return;
  window.__sxkInjected = true;

  // 自检上报:内容脚本跑没跑、连没连上后端,都写进本地后端日志,
  // 这样即使打不开 DevTools 也能在后端控制台看到侧边栏的真实状态。
  function report(task, status) {
    try { chrome.runtime.sendMessage({ type: 'BRUSH_REPORT', site: 'sidebar', task, status: String(status) }); } catch (e) {}
  }

  const CSS_URL = chrome.runtime.getURL('sidebar.css');
  // 仅用于界面提示(内容脚本自己不发请求,统一经 background 转发)
  const SERVER = 'http://127.0.0.1:3001';
  const HOSTED_ON = /(^|\.)(chaoxing\.com|xuexitong\.com|zhihuishu\.com|sflep\.com|zuoyebang\.com)$/;

  let host = null;
  let wrap = null;
  let panel = null;
  let chatBox = null;
  let inputEl = null;
  let statusEl = null;
  let dotEl = null;
  let sendBtn = null;
  let open = false;
  let cssReady = false;
  let backendTimer = null;

  const ICONS = {
    panel:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#2655FE" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/>' +
      '<path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5A1.5 1.5 0 0 0 20 18.5z"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#2655FE" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 6 9 17l-5-5"/></svg>',
    console:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#2655FE" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h5M7 13h9M7 17h4"/></svg>',
    send:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5 12h13M12 5l7 7-7 7"/></svg>',
    logo:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H11v14H5.5A1.5 1.5 0 0 1 4 17.5z"/>' +
      '<path d="M20 6.5A1.5 1.5 0 0 0 18.5 5H13v14h5.5A1.5 1.5 0 0 0 20 17.5z"/></svg>',
  };

  function ball(iconKey, tipText, onClick, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sxk-ball' + (extraClass ? ' ' + extraClass : '');
    b.innerHTML = ICONS[iconKey] + `<span class="sxk-tip">${tipText}</span>`;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'sxk-host';
    // 宿主本身不拦截页面点击,只让 dock / 面板可交互
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });

    // 样式:优先读扩展内的 sidebar.css,内联进 shadow root
    const style = document.createElement('style');
    shadow.appendChild(style);
    wrap = document.createElement('div');
    wrap.className = 'sxk-root';
    wrap.style.display = 'none'; // 等样式到位再显示,避免闪一下没样式的内容
    shadow.appendChild(wrap);

    fetch(CSS_URL)
      .then((r) => r.text())
      .then((css) => {
        style.textContent = css;
        cssReady = true;
        wrap.style.display = '';
      })
      .catch(() => { wrap.style.display = ''; });

    // ---- 右侧浮球 dock ----
    const dock = document.createElement('div');
    dock.className = 'sxk-dock';
    dock.appendChild(ball('panel', '刷小课', () => toggle(), 'sxk-ball-panel'));
    dock.appendChild(ball('check', '自动做题', () => doAnswer()));
    dock.appendChild(ball('console', '打开控制台', () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_UI' }); } catch (e) {}
    }));
    wrap.appendChild(dock);

    // ---- 悬浮面板 ----
    panel = document.createElement('div');
    panel.className = 'sxk-panel';
    panel.innerHTML = `
      <div class="sxk-head">
        <div class="sxk-logo">${ICONS.logo}</div>
        <div class="sxk-headtext">
          <div class="sxk-title">刷小课</div>
          <div class="sxk-sub"><span class="sxk-dot"></span><span class="sxk-conn">正在连接本地后端…</span></div>
        </div>
        <button class="sxk-close" type="button" title="关闭">✕</button>
      </div>
      <div class="sxk-actions">
        <div class="sxk-act" data-act="clear"><span class="ic">⟲</span>清空对话</div>
        <div class="sxk-act" data-act="openui"><span class="ic">⚙</span>控制台</div>
        <div class="sxk-act" data-act="diag"><span class="ic">🐞</span>诊断日志</div>
        <div class="sxk-act" data-act="shot"><span class="ic">📷</span>截图搜题</div>
      </div>
      <div class="sxk-settings">
        <div class="sxk-set-head">刷课设置<span class="sxk-set-tip">改完立刻生效</span></div>
        <div class="sxk-set-row on" data-set="autoVideo"><span>自动播放</span><i class="sxk-sw"></i></div>
        <div class="sxk-set-row on" data-set="autoJump"><span>自动跳节</span><i class="sxk-sw"></i></div>
        <div class="sxk-set-row on" data-set="autoAnswer"><span>自动做题</span><i class="sxk-sw"></i></div>
        <div class="sxk-set-row" data-set="autoSubmit"><span>自动提交</span><i class="sxk-sw"></i></div>
        <div class="sxk-set-row" data-set="rate"><span>播放倍速</span>
          <span class="sxk-rates"><b data-rate="1">1x</b><b data-rate="1.5">1.5x</b><b data-rate="2">2x</b></span>
        </div>
      </div>
      <div class="sxk-chat">
        <div class="sxk-empty"><b>你好,我是刷小课</b>把题目贴进来,或者点「自动做题」<br>让我识别当前页面的题目并作答</div>
      </div>
      <div class="sxk-inputbar">
        <div class="sxk-status"></div>
        <div class="sxk-chips">
          <div class="sxk-chip">解释这道题</div>
          <div class="sxk-chip">给出答案</div>
          <div class="sxk-chip">总结本节要点</div>
        </div>
        <div class="sxk-attach"></div>
        <div class="sxk-inputrow">
          <textarea class="sxk-input" rows="1" placeholder="输入问题,Enter 发送…"></textarea>
          <button class="sxk-send" type="button" title="发送">${ICONS.send}</button>
        </div>
      </div>`;
    wrap.appendChild(panel);

    chatBox = panel.querySelector('.sxk-chat');
    inputEl = panel.querySelector('.sxk-input');
    statusEl = panel.querySelector('.sxk-status');
    dotEl = panel.querySelector('.sxk-dot');
    sendBtn = panel.querySelector('.sxk-send');

    panel.querySelector('.sxk-close').addEventListener('click', () => toggle(false));
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    inputEl.addEventListener('paste', async (e) => {
      const n = await grabClipboardImages(e);
      if (n) e.preventDefault();
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
    });
    panel.querySelectorAll('.sxk-chip').forEach((c) =>
      c.addEventListener('click', () => { inputEl.value = c.textContent.trim(); inputEl.focus(); }));
    panel.querySelectorAll('.sxk-act').forEach((a) =>
      a.addEventListener('click', () => onAction(a.dataset.act)));

    // 设置开关
    panel.querySelectorAll('.sxk-set-row[data-set]').forEach((row) => {
      const k = row.dataset.set;
      if (k === 'rate') {
        row.querySelectorAll('b[data-rate]').forEach((b) => {
          b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pushSetting({ playbackRate: Number(b.dataset.rate) });
          });
        });
      } else {
        row.addEventListener('click', () => pushSetting({ [k]: !curSettings[k] }));
      }
    });

    document.documentElement.appendChild(host);
  }

  function toggle(force) {
    build();
    open = typeof force === 'boolean' ? force : !open;
    wrap.classList.toggle('open', open);
    const ballPanel = wrap.querySelector('.sxk-ball-panel');
    if (ballPanel) ballPanel.classList.toggle('active', open);
    if (open) {
      checkBackend(0);
      loadSettingsUI();
      setTimeout(() => { if (inputEl) inputEl.focus(); }, 260);
    } else if (backendTimer) {
      clearTimeout(backendTimer); backendTimer = null;
    }
  }

  function setConn(text, state) {
    const t = panel && panel.querySelector('.sxk-conn');
    if (t) t.textContent = text;
    if (dotEl) dotEl.className = 'sxk-dot' + (state ? ' ' + state : '');
  }

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isErr);
  }

  async function checkBackend(retry) {
    // 内容脚本直连 127.0.0.1 会被 Edge 的「访问本设备上的应用和服务」拦一次,
    // 统一交给 background 代发。
    // 注意:后端可能比浏览器晚几秒起来(双击 启动.bat 的顺序),所以失败要自动重试,
    // 否则面板会一直卡在「本地后端未启动」——之前的版本就踩了这个坑。
    const n = retry || 0;
    if (backendTimer) { clearTimeout(backendTimer); backendTimer = null; }
    if (!open) return;
    setConn(n === 0 ? '正在连接本地后端…' : `正在重试(${n}/6)…`, '');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'CHECK_BACKEND' });
      if (r && r.ok && r.health) {
        const ver = r.health.version ? ' v' + r.health.version : '';
        setConn((r.health.upstream ? '已连接 · 真实模型' : '已连接 · 演示模式') + ver, 'ok');
        setStatus('');
        report('health', 'ok' + ver);
        return;
      }
      // 后台在,但后台拉不到后端:把真实原因显示出来,方便定位
      const why = (r && r.ok === false && r.errstr) ? r.errstr : '后台没有回复';
      report('health', 'fail:' + why);
      fail(why, n);
    } catch (e) {
      const msg = String((e && e.message) || e);
      report('health', 'throw:' + msg);
      // 扩展被重新加载/更新后,老页面里的内容脚本会与扩展失联
      if (/context invalidated|Extension context/i.test(msg)) {
        setConn('扩展已更新', 'err');
        setStatus('扩展刚被重新加载,请刷新页面(F5)后重新打开侧边栏', true);
        return;
      }
      fail(msg, n);
    }
  }

  function fail(why, n) {
    if (n >= 6) {
      setConn('本地后端未启动', 'err');
      setStatus('连不上 ' + SERVER + '(' + why + ')。请先双击「启动.bat」启动后端', true);
      return;
    }
    setConn('本地后端未启动', 'err');
    setStatus('正在重试连接本地后端…(' + n + '/6)', true);
    backendTimer = setTimeout(() => checkBackend(n + 1), 2000);
  }

  function addBubble(who, text) {
    const empty = chatBox.querySelector('.sxk-empty');
    if (empty) empty.remove();
    const b = document.createElement('div');
    b.className = 'sxk-bubble ' + who;
    b.textContent = text || '';
    chatBox.appendChild(b);
    chatBox.scrollTop = chatBox.scrollHeight;
    return b;
  }

  // ---- 粘贴截图(输入框支持 Ctrl+V 贴图)----
  let pendingImgs = [];
  let attachEl = null;

  function fileToDataURL(f) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => rej(new Error('读取剪贴板图片失败'));
      fr.readAsDataURL(f);
    });
  }

  function renderAttach() {
    if (!attachEl) attachEl = panel.querySelector('.sxk-attach');
    if (!attachEl) return;
    attachEl.innerHTML = '';
    if (!pendingImgs.length) { attachEl.style.display = 'none'; return; }
    attachEl.style.display = 'flex';
    pendingImgs.forEach((src, i) => {
      const box = document.createElement('div');
      box.className = 'sxk-thumb';
      const im = document.createElement('img');
      im.src = src;
      const x = document.createElement('b');
      x.textContent = '×';
      x.title = '移除';
      x.addEventListener('click', () => { pendingImgs.splice(i, 1); renderAttach(); });
      box.appendChild(im);
      box.appendChild(x);
      attachEl.appendChild(box);
    });
  }

  async function grabClipboardImages(e) {
    let got = 0;
    const items = (e && e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (!it || !it.type || it.type.indexOf('image/') !== 0) continue;
      const f = it.getAsFile && it.getAsFile();
      if (!f) continue;
      try {
        const d = await fileToDataURL(f);
        if (d) { pendingImgs.push(d); got++; }
      } catch (err) { setStatus('粘贴图片失败:' + err.message, true); }
    }
    if (got) { renderAttach(); setStatus('已粘贴 ' + pendingImgs.length + ' 张图,Enter 发送', false); }
    return got;
  }

  async function send() {
    const q = inputEl.value.trim();
    const imgs = pendingImgs.slice();
    if (!q && !imgs.length) return;
    pendingImgs = [];
    renderAttach();
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setStatus('', false);
    addBubble('user', q || (imgs.length ? '【图片】只看图作答' : ''));
    if (imgs.length) {
      const pic = document.createElement('div');
      pic.className = 'sxk-bubble-imgs';
      imgs.forEach((s) => { const im = document.createElement('img'); im.src = s; pic.appendChild(im); });
      (chatBox.lastElementChild || chatBox).appendChild(pic);
    }
    const ai = addBubble('ai', '');
    ai.innerHTML = '<span class="sxk-typing"><span></span><span></span><span></span></span>';
    let first = true;
    let finished = false;
    try {
      const port = chrome.runtime.connect({ name: 'sxk-chat' });
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'delta') {
          if (first) { ai.textContent = ''; first = false; }
          ai.textContent += m.text || '';
          chatBox.scrollTop = chatBox.scrollHeight;
        } else if (m.type === 'error') {
          finished = true;
          ai.textContent = '出错了:' + (m.errstr || '未知错误');
        } else if (m.type === 'done') {
          finished = true;
          if (first) ai.textContent = '(无回复)';
          try { port.disconnect(); } catch (e) {}
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished && first) ai.textContent = '(连接已断开)';
      });
      port.postMessage({ type: 'ASK', prompt: q || '请按约定只给答案。', images: imgs });
    } catch (e) {
      ai.textContent = '连接本地后端失败:' + e.message + '\n请确认已双击「启动.bat」';
    }
  }

  // ---- 刷课设置(和控制台同一份数据,改完立刻生效)----
  let curSettings = {};

  function renderSettings() {
    if (!panel) return;
    panel.querySelectorAll('.sxk-set-row[data-set]').forEach((row) => {
      const k = row.dataset.set;
      if (k === 'rate') {
        const cur = Number(curSettings.playbackRate || 1);
        row.querySelectorAll('b[data-rate]').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === cur));
        return;
      }
      row.classList.toggle('on', !!curSettings[k]);
    });
  }

  async function loadSettingsUI() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      curSettings = (r && r.settings) || {};
    } catch (e) { curSettings = curSettings || {}; }
    renderSettings();
  }

  async function pushSetting(patch) {
    curSettings = { ...curSettings, ...patch };
    renderSettings();
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
      if (r && r.settings) { curSettings = r.settings; renderSettings(); }
      setStatus('已保存并立即生效:' + Object.keys(patch).join(',') + ' → ' + JSON.stringify(patch), false);
    } catch (e) {
      setStatus('设置保存失败:' + e.message, true);
    }
  }

  // 面板开着的时候每 3 秒回读一次,控制台那边改动这边也会跟着变
  setInterval(() => { if (open) loadSettingsUI(); }, 3000);

  // 截图搜题:抓当前标签页可见区域 → 后端视觉模型识别并作答
  async function doScreenshot() {
    if (!open) toggle(true);
    setStatus('正在截图…', false);
    try {
      let cap = null;
      // 先把面板藏掉,免得把侧边栏也截进去
      try { if (wrap) wrap.style.visibility = 'hidden'; } catch (e) {}
      await new Promise((r) => setTimeout(r, 120));
      try {
        cap = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
      } finally {
        try { if (wrap) wrap.style.visibility = ''; } catch (e) {}
      }
      if (!cap || !cap.ok || !cap.dataUrl) {
        setStatus('截图失败:' + ((cap && cap.errstr) || '没有拿到画面'), true);
        addBubble('ai', '截图失败:' + ((cap && cap.errstr) || '没有拿到画面') + '\n可以改用 Ctrl+V 把题目图片粘进输入框,效果一样。');
        return;
      }
      addBubble('user', '【截图搜题】已截取当前屏幕');
      const ai = addBubble('ai', '识别中…');
      setStatus('正在识别题目…', false);
      const r = await chrome.runtime.sendMessage({
        type: 'SOLVE',
        question: '【截图搜题】请先准确读出截图里的题干和所有选项(选项可能是图片,也要读出来),再判断答案。选择题只回字母,多选回多个字母。',
        options: [],
        images: [cap.dataUrl],
      });
      const res = r && r.result;
      if (!res || !res.answer) {
        ai.textContent = '没解出答案:' + String(JSON.stringify(res || r)).slice(0, 200);
        setStatus('截图搜题失败:模型没有返回答案', true);
        return;
      }
      ai.textContent = '答案:' + res.answer + (res.analysis ? '\n解析:' + res.analysis : '');
      setStatus('截图搜题完成', false);
    } catch (e) {
      setStatus('截图搜题失败:' + e.message, true);
    }
  }

  async function doAnswer() {
    if (!open) toggle(true);
    setStatus('正在识别并作答…', false);
    try {
      // 目标站点上 engine.js 和本脚本在同一个隔离世界里,直接调用最稳;
      // 其它页面没有引擎,再退回 background 转发(会提示"非目标站点")
      const api = window.__SXK;
      if (api && typeof api.autoAnswerAll === 'function') {
        const r = await api.autoAnswerAll('sidebar');
        if (!r.found) setStatus('当前页未识别到题目', true);
        else if (r.count) setStatus(`已作答 ${r.count}/${r.found} 题`, false);
        else setStatus(`识别到 ${r.found} 题,但没找到可填写的选项`, true);
        return;
      }
      const r = await chrome.runtime.sendMessage({ type: 'AUTO_ANSWER' });
      if (!r) setStatus('页面未响应,请刷新后重试', true);
      else if (r.errstr) setStatus(r.errstr, true);
      else if (!r.found) setStatus('当前页未识别到题目', true);
      else if (r.count) setStatus(`已作答 ${r.count}/${r.found} 题`, false);
      else setStatus(`识别到 ${r.found} 题,但没找到可填写的选项`, true);
    } catch (e) {
      setStatus('自动做题失败:' + e.message, true);
    }
  }

  // 诊断日志:把课程页驱动的现场时间线导出来,方便排查「视频不播/来回跳」
  async function doDiag() {
    if (!open) toggle(true);
    setStatus('正在收集诊断日志…', false);
    try {
      const cx = window.SXKCX || window.__SXKCX;
      if (!cx || typeof cx.dumpLog !== 'function') {
        setStatus('本页没有课程页驱动脚本(仅超星/学习通课程页可用)', true);
        return;
      }
      const text = cx.dumpLog();
      // 内容脚本不直连 127.0.0.1,交给后台转发到本地控制台
      try {
        chrome.runtime.sendMessage({ type: 'CX_LOG_DUMP', text, host: location.hostname, path: location.pathname });
      } catch (e) {}
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
      if (typeof cx.sendLog === 'function') { try { cx.sendLog(); } catch (e) {} }
      setStatus(copied ? '诊断日志已复制到剪贴板,并已发到控制台' : '诊断日志已发到控制台(可在控制台查看)', false);
    } catch (e) {
      setStatus('导出诊断失败:' + e.message, true);
    }
  }

  function onAction(act) {
    if (act === 'clear') {
      chatBox.innerHTML = '<div class="sxk-empty"><b>已清空</b>来问点什么吧</div>';
      setStatus('');
    } else if (act === 'openui') {
      try { chrome.runtime.sendMessage({ type: 'OPEN_UI' }); } catch (e) {}
    } else if (act === 'answer') {
      doAnswer();
    } else if (act === 'diag') {
      doDiag();
    } else if (act === 'shot') {
      doScreenshot();
    }
  }

  // Ctrl+Shift+S
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      toggle();
    }
  }, true);

  // background 转来的开关指令:扩展图标点击的兜底
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'TOGGLE_SIDEBAR') toggle();
    else if (msg.type === 'SHOW_SIDEBAR') toggle(true);
    else if (msg.type === 'HIDE_SIDEBAR') toggle(false);
  });

  // 目标站点自动弹出(与原插件一致:进课程页就把面板摆出来)
  const autoOpen = HOSTED_ON.test(location.hostname) || /^\/mock\//.test(location.pathname);
  report('inject', 'autoOpen=' + autoOpen + ' host=' + location.hostname);
  if (autoOpen) {
    setTimeout(() => {
      try { toggle(true); } catch (e) { report('inject', 'toggle-error:' + ((e && e.message) || e)); }
    }, 900);
  }
})();
