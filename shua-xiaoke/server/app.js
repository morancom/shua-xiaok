'use strict';
const $ = (s, r = document) => r.querySelector(s);
const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
let state = null;
let pollTimer = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function load() {
  try {
    state = await api('/api/state');
    // 连上了就把状态灯点亮 —— 之前这里只写了「失败」分支,
    // 导致只要失败过一次,标题栏就永远显示「离线」,哪怕后端早恢复了。
    const dot = $('#statusDot');
    const txt = $('#statusTxt');
    if (dot) dot.classList.remove('off');
    if (txt) txt.textContent = '在线';
    render();
  } catch (e) {
    const dot = $('#statusDot');
    const txt = $('#statusTxt');
    if (dot) dot.classList.add('off');
    if (txt) txt.textContent = '离线';
  }
}

function render() {
  const s = state.settings, st = state.stats;
  // stats
  $('#statSolve').textContent = st.solveCount;
  $('#statChat').textContent = st.chatCount;
  $('#statUptime').textContent = uptime(st.startedAt);
  // settings controls
  $('#setAutoVideo').checked = !!s.autoVideo;
  $('#setAutoJump').checked = !!s.autoJump;
  $('#setAutoAnswer').checked = !!s.autoAnswer;
  $('#setAutoSubmit').checked = !!s.autoSubmit;
  // 倍速滑块同理:正在拖动时别被轮询打断
  const rateEl = $('#setRate');
  if (rateEl && rateEl !== document.activeElement) rateEl.value = s.playbackRate;
  $('#setRateVal').textContent = s.playbackRate + 'x';
  // 上游配置三个输入框不能无条件覆盖:这个 render 每 3 秒被轮询触发一次,
  // 以前无条件写 value ⇒ 正在输入的密钥每 3 秒被服务端里的旧值冲回去
  // (用户表现:填完 key 切到别的页面复个网址,回来又变回默认 key)。
  fillUpstreamInputs(s);
  // upstream badge(放在最前面渲染:即使后面表格出错,这个状态卡也不会卡在「加载中」)
  const has = !!(s.upstreamUrl && s.upstreamKey);
  const badge = $('#upstreamBadge');
  if (badge) {
    badge.innerHTML = has
      ? '<span class="tag ok">真实模型已配置</span>'
      : '<span class="tag warn">演示模式</span>';
  }
  // solves table
  const tb = $('#solveTable tbody');
  tb.innerHTML = state.solves.length ? '' : '<tr><td colspan="3" style="color:var(--txt3)">暂无解题记录</td></tr>';
  for (const r of state.solves) {
    const conf = Math.round((r.confidence || 0) * 100);
    const cls = conf >= 70 ? 'ok' : conf >= 40 ? 'warn' : 'err';
    tb.insertAdjacentHTML('beforeend',
      `<tr><td class="mono">${fmt(r.t)}</td><td>${esc(r.q)}</td><td><span class="tag ${cls}">${esc(String(r.a))} · ${conf}%</span></td></tr>`);
  }
  // logs
  const lg = $('#logs');
  lg.innerHTML = state.logs.map(l =>
    `<div class="log"><span class="time">${fmt(l.t)}</span><span class="tag2">[${esc(l.tag)}]</span><span class="msg">${esc(l.msg)}</span></div>`).join('');
  lg.scrollTop = lg.scrollHeight;
}

// ---- 上游配置(接口 / 密钥 / 模型)----
// 轮询每 3 秒重画一次页面,这三个输入框必须「正在编辑 / 有未保存改动时不动」,
// 否则刚粘贴的密钥会被服务端里的旧值覆盖 —— 这就是「填完 key 切出去再回来又变回默认」的原因。
const UPSTREAM_FIELDS = [
  ['setUpstreamUrl', 'upstreamUrl'],
  ['setUpstreamKey', 'upstreamKey'],
  ['setModel', 'model'],
];
const upstreamDirty = new Set();
let savingUpstream = false;

function fillUpstreamInputs(s) {
  for (const [id, key] of UPSTREAM_FIELDS) {
    const el = $('#' + id);
    if (!el) continue;
    if (el === document.activeElement || upstreamDirty.has(id)) continue;
    const v = s[key] || '';
    if (el.value !== v) el.value = v;
  }
}

function setUpstreamHint(text, warn) {
  const el = $('#upstreamHint');
  if (!el) return;
  el.textContent = text;
  el.style.color = warn ? '#e6a23c' : '';
}

function upstreamBody() {
  const body = {};
  for (const [id, key] of UPSTREAM_FIELDS) {
    const el = $('#' + id);
    body[key] = el ? el.value.trim() : '';
  }
  return body;
}

async function saveUpstream(reason) {
  if (savingUpstream) return;
  savingUpstream = true;
  const label = reason === 'auto' ? '切走已自动保存' : '已保存';
  try {
    const r = await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody()),
    });
    if (r && r.ok) {
      upstreamDirty.clear();
      const live = !!(r.settings && r.settings.upstreamUrl && r.settings.upstreamKey);
      setUpstreamHint(`${label} ${fmt(Date.now())} · 当前:${live ? '真实模型' : '演示模式'}`);
      await load();
    } else {
      setUpstreamHint('保存失败:' + JSON.stringify(r).slice(0, 80), true);
    }
  } catch (e) {
    setUpstreamHint('保存失败:' + e.message, true);
  } finally {
    savingUpstream = false;
  }
}

// 切标签 / 切窗口 / 关页面之前,把没保存的改动发出去,避免「填完就没了」
function flushUpstreamOnLeave() {
  if (!upstreamDirty.size || savingUpstream) return;
  try {
    fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody()), keepalive: true,
    });
    setUpstreamHint('正在保存…');
  } catch (e) { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushUpstreamOnLeave();
  else load();
});
window.addEventListener('blur', flushUpstreamOnLeave);
window.addEventListener('pagehide', flushUpstreamOnLeave);

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function uptime(start) {
  const d = Math.floor((Date.now() - start) / 1000);
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), sec = d % 60;
  return `${h}h ${m}m ${sec}s`;
}

// settings bindings
function bindToggles() {
  const map = { setAutoVideo: 'autoVideo', setAutoJump: 'autoJump', setAutoAnswer: 'autoAnswer', setAutoSubmit: 'autoSubmit' };
  for (const [id, key] of Object.entries(map)) {
    $('#' + id).addEventListener('change', async (e) => {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: e.target.checked }) });
      load();
    });
  }
  $('#setRate').addEventListener('change', async (e) => {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackRate: Number(e.target.value) }) });
    load();
  });
  $('#btnSaveUpstream').addEventListener('click', () => saveUpstream('manual'));
  for (const [id] of UPSTREAM_FIELDS) {
    const el = $('#' + id);
    if (!el) continue;
    // 只标记「有未保存改动」,不在这里自动保存 —— 密钥常常是粘贴进来的,
    // 等用户切走(visibilitychange / blur)或点保存时再写,避免半截 key 落盘。
    el.addEventListener('input', () => {
      upstreamDirty.add(id);
      setUpstreamHint('有改动未保存(切走会自动保存;点右边按钮立即保存)', true);
    });
  }
  const eye = $('#upstreamEye');
  if (eye) eye.addEventListener('click', () => {
    const k = $('#setUpstreamKey');
    if (k) k.type = k.type === 'password' ? 'text' : 'password';
  });
  $('#btnClearLogs').addEventListener('click', async () => { await api('/api/logs/clear', { method: 'POST' }); load(); });
  $('#btnTestSolve').addEventListener('click', testSolve);
  $('#btnSend').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
}

async function testSolve() {
  const q = $('#testQ').value.trim() || '下列哪个是偶数?';
  const opts = ($('#testOpts').value.trim() || '1,2,3,4').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  addBubble('user', `解题:${q}`);
  const r = await api('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, options: opts }) });
  const d = r.data || {};
  addBubble('ai', `答案:${d.answer}\n${d.analysis || ''}`);
  load();
}

async function sendChat() {
  const inp = $('#chatInput');
  const p = inp.value.trim();
  if (!p) return;
  inp.value = '';
  addBubble('user', p);
  const aiBubble = addBubble('ai', '');
  try {
    const resp = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: p }) });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const lines = part.split('\n');
        const ev = (lines.find(l => l.startsWith('event:')) || '').slice(6).trim();
        const dataLine = (lines.find(l => l.startsWith('data:')) || '').slice(5).trim();
        if (ev === 'delta') {
          try { aiBubble.textContent += JSON.parse(dataLine).text; } catch {}
          $('.chat').scrollTop = $('.chat').scrollHeight;
        }
      }
    }
    load();
  } catch (e) { aiBubble.textContent = '错误:' + e.message; }
}

function addBubble(who, text) {
  const chat = $('.chat');
  const b = document.createElement('div');
  b.className = 'bubble ' + who;
  b.textContent = text;
  chat.appendChild(b);
  chat.scrollTop = chat.scrollHeight;
  return b;
}

// ---- 诊断日志(课程页) ----
let cxLogText = '';

async function loadCxLog() {
  try {
    const r = await api('/api/cxlog');
    const items = (r && r.items) || [];
    if (!items.length) {
      cxLogText = '';
      $('#cxLogMeta').textContent = '还没有收到诊断日志。在课程页打开侧边栏,点「诊断日志」即可采集。';
      $('#cxLogText').textContent = '';
      return;
    }
    const latest = items[0];
    cxLogText = latest.text || '';
    const lines = cxLogText.split('\n').length;
    $('#cxLogMeta').textContent = `最近一份:${latest.host}${latest.path} · ${fmt(latest.t)} · ${lines} 行(${items.length} 份)` +
      (latest.t > 0 && (Date.now() - latest.t < 120000) ? ' · 刚刚收到' : '');
    $('#cxLogText').textContent = cxLogText;
  } catch (e) {
    $('#cxLogMeta').textContent = '读取诊断日志失败:' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindToggles();
  load();
  loadCxLog();
  pollTimer = setInterval(load, 3000);
  const bl = $('#btnLoadCxLog');
  if (bl) bl.addEventListener('click', loadCxLog);
  const bc = $('#btnCopyCxLog');
  if (bc) bc.addEventListener('click', async () => {
    if (!cxLogText) { await loadCxLog(); }
    if (!cxLogText) { $('#cxLogMeta').textContent = '还没有可复制的诊断日志'; return; }
    try { await navigator.clipboard.writeText(cxLogText); $('#cxLogMeta').textContent = '已复制到剪贴板,可直接粘贴发送'; }
    catch (e) { $('#cxLogMeta').textContent = '复制失败,请手动选中文本复制'; }
  });
  // 有新日志就自动刷新文本框
  setInterval(loadCxLog, 8000);
});
