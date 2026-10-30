'use strict';
/**
 * 作业/测验页自检:验证「打开就自动做题」+ 侧边栏设置开关实时生效。
 * 用法: node tools/probe_work.js [url]
 */
const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, '..', '_edge-work');
const EXT = path.join(__dirname, '..', 'extension');
const PORT = 9346;
const URL0 = process.argv[2] || 'http://127.0.0.1:3001/mock/chaoxing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  [PASS] ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.log('  [FAIL] ' + name + (extra ? ' ' + extra : '')); } }

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    }).on('error', reject);
  });
}
function getPort(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    }).on('error', reject);
  });
}
async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const l = await get('/json/version'); if (l && l.webSocketDebuggerUrl) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  return { ready, send, close: () => ws.close() };
}

const READ = '(() => {' +
  'const host = document.getElementById("sxk-host");' +
  'const sr = host && host.shadowRoot;' +
  'const rows = sr ? [...sr.querySelectorAll(".sxk-set-row")] : [];' +
  'const res = (id) => { const e = document.getElementById(id); return e ? e.textContent : ""; };' +
  'const fill = document.querySelector(".fillInput");' +
  'return JSON.stringify({' +
  '  host: !!host, rows: rows.length,' +
  '  autoJumpOn: !!(sr && sr.querySelector(".sxk-set-row[data-set=autoJump]") && sr.querySelector(".sxk-set-row[data-set=autoJump]").classList.contains("on")),' +
  '  rateOn: (sr && sr.querySelector(".sxk-rates b.on") ? sr.querySelector(".sxk-rates b.on").textContent : ""),' +
  '  r1: res("r1"), r2: res("r2"),' +
  '  on: [...document.querySelectorAll(".optionItem.on")].map(e => e.dataset.letter).join(","),' +
  '  hasFill: !!fill, fill: fill ? fill.value : ""' +
  '});' +
  '})()';

(async () => {
  // 开关拉满
  try {
    await fetch('http://127.0.0.1:3001/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoVideo: true, autoJump: true, autoAnswer: true, playbackRate: 1 }) });
  } catch (e) {}

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  try {
    const psCmd = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Where-Object { $_.CommandLine -like \'*' + PROFILE + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    execSync('powershell -NoProfile -Command "' + psCmd + '"', { stdio: 'ignore', timeout: 25000 });
    await sleep(1500);
  } catch (e) {}

  const child = spawn(EDGE, [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--load-extension=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--disable-features=Translate,msEdgeSplitScreen', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  if (!(await waitPort())) { console.log('[FAIL] CDP 端口没起来'); process.exit(1); }
  const targets = await get('/json/list');
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page) { console.log('[FAIL] 没有 page target'); process.exit(1); }
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: URL0 });
  try { await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  try { await c.send('Page.bringToFront'); } catch (e) {}
  await sleep(3000);

  const evalJS = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : undefined;
  };

  // 1) 侧边栏设置区存在
  let st = {};
  for (let i = 0; i < 10; i++) {
    const raw = await evalJS(READ);
    try { st = JSON.parse(raw); } catch (e) { st = {}; }
    if (st.rows >= 4) break;
    await sleep(1000);
  }
  ok('侧边栏出现刷课设置区(4 行)', st.rows >= 4, 'rows=' + st.rows);
  ok('开关状态与后端一致(自动跳节=开)', st.autoJumpOn === true);

  // 2) 自动做题(作业页打开就动)
  for (let i = 0; i < 20; i++) {
    const raw = await evalJS(READ);
    try { st = JSON.parse(raw); } catch (e) {}
    if ((st.on && st.on.length) && (!st.hasFill || (st.fill && st.fill.length))) break;
    await sleep(2000);
  }
  ok('选择题已被自动选中', !!(st.on && st.on.length), '选项=' + st.on);
  ok('题目已全部作答(有填空就检查填空)', (!st.hasFill ? true : !!(st.fill && st.fill.length)), 'fill=' + JSON.stringify(st.fill) + ' on=' + st.on);

  // 3) 侧边栏点 2x,后端立刻收到(实时性)
  await evalJS('(() => { const sr = document.getElementById("sxk-host").shadowRoot; const b = sr.querySelector(".sxk-rates b[data-rate=\\"2\\"]"); if (b) b.click(); return 1; })()');
  await sleep(1500);
  const state = await getPort(3001, '/api/state');
  ok('侧边栏点 2x 后后端立即为 2', Number(state.settings && state.settings.playbackRate) === 2, 'playbackRate=' + (state.settings && state.settings.playbackRate));
  const raw2 = await evalJS(READ);
  let st2 = {}; try { st2 = JSON.parse(raw2); } catch (e) {}
  ok('侧边栏倍速高亮跟着变', st2.rateOn === '2x', '高亮=' + st2.rateOn);

  // 4) 从后端改回 1x,侧边栏 3 秒内同步(实时反向)
  await fetch('http://127.0.0.1:3001/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackRate: 1 }) });
  await sleep(4500);
  const raw3 = await evalJS(READ);
  let st3 = {}; try { st3 = JSON.parse(raw3); } catch (e) {}
  ok('后端改 1x 后侧边栏自动同步', st3.rateOn === '1x', '高亮=' + st3.rateOn);

  // 5) 做题记录落到后端
  const stt = await getPort(3001, '/api/state');
  ok('后端记录到解题次数', Number(stt.stats && stt.stats.solveCount) > 0, 'solveCount=' + (stt.stats && stt.stats.solveCount));

  // 6) 图片题:题干只有图片、选项是图片 → 必须也能作答
  await c.send('Page.navigate', { url: 'http://127.0.0.1:3001/mock/workimg' });
  await sleep(3500);
  const READ_IMG = '(() => {' +
    'const qs = [...document.querySelectorAll(".TiMu")];' +
    'return JSON.stringify(qs.map((q) => {' +
    '  const on = q.querySelector(".optionItem.on");' +
    '  return { letter: on ? on.dataset.letter : "", res: (q.querySelector(".res") || {}).textContent || "" };' +
    '}));' +
    '})()';
  let img = [];
  for (let i = 0; i < 20; i++) {
    const raw = await evalJS(READ_IMG);
    try { img = JSON.parse(raw) || []; } catch (e) { img = []; }
    if (img.length >= 3 && img.every((x) => x.letter)) break;
    await sleep(2000);
  }
  ok('图片选项页:3 道题都以被选中', img.length >= 3 && img.every((x) => x.letter), JSON.stringify(img));
  const q3 = img[2] || {};
  ok('图片选项页:二次函数题选对 B', (img[0] || {}).letter === 'B', 'Q1=' + (img[0] || {}).letter);
  ok('图片选项页:题干是图片的题也答了', !!q3.letter, 'Q3=' + q3.letter + ' res=' + q3.res);

  // 7) 截图搜题按钮真能拿到画面(不要求答对,只要求不报错)
  await evalJS('(() => { const sr = document.getElementById("sxk-host").shadowRoot; const b = sr.querySelector(".sxk-act[data-act=\\"shot\\"]") || [...sr.querySelectorAll(".sxk-act")].find(x => /截图/.test(x.textContent)); if (b) b.click(); return !!b; })()');
  await sleep(9000);
  const SHOT = '(() => { const sr = document.getElementById("sxk-host").shadowRoot; const st = sr.querySelector(".sxk-status"); const bubbles = [...sr.querySelectorAll(".sxk-chat > *")].map(e => (e.textContent||"").slice(0,120)); return JSON.stringify({ status: st ? st.textContent : "", bubbles }); })()';
  let shot = {};
  for (let i = 0; i < 15; i++) {
    const raw = await evalJS(SHOT);
    try { shot = JSON.parse(raw); } catch (e) { shot = {}; }
    if (shot.status && !/正在/.test(shot.status)) break;
    await sleep(2000);
  }
  const shotOk = !!(shot.status && !/失败/.test(shot.status));
  ok('截图搜题没有报错', shotOk, 'status=' + JSON.stringify(String(shot.status || '').slice(0, 90)));

  // 8) 输入框粘贴图片 → 发给 AI → AI 必须能从图里读出内容
  const PASTE = '(() => {' +
    'const host = document.getElementById("sxk-host"); const sr = host.shadowRoot;' +
    'const ta = sr.querySelector(".sxk-input");' +
    'return fetch("/mock/img/num.png").then(r => r.blob()).then(b => new Promise((res) => {' +
    '  const f = new File([b], "num.png", { type: "image/png" });' +
    '  const dt = new DataTransfer(); dt.items.add(f);' +
    '  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });' +
    '  ta.dispatchEvent(ev);' +
    '  setTimeout(() => {' +
    '    const thumbsAtPaste = sr.querySelectorAll(".sxk-thumb").length;' +
    '    window.__thumbsAtPaste = thumbsAtPaste;' +
    '    ta.value = "这张图里的数字是多少?只回数字";' +
    '    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));' +
    '    setTimeout(() => res(JSON.stringify({' +
    '      thumbs: window.__thumbsAtPaste || 0,' +
    '      status: (sr.querySelector(".sxk-status") || {}).textContent || "",' +
    '      bubbles: [...sr.querySelectorAll(".sxk-chat > *")].map(e => (e.textContent || "").slice(0, 80))' +
    '    })), 6000);' +
    '  }, 900);' +
    '}));' +
    '})()';
  let pv = {};
  const rawP = await evalJS(PASTE);
  try { pv = JSON.parse(rawP); } catch (e) { pv = {}; }
  ok('粘贴图片后出现缩略图', Number(pv.thumbs) >= 1, 'thumbs=' + pv.thumbs);
  const allText = (pv.bubbles || []).join(' | ');
  ok('AI 读到了图片内容(4726)', /4726/.test(allText), 'chats=' + String(allText).slice(0, 160));

  // 9) 6 题作业页:必须每题都被选中(以前只答第一题)
  const SIX = '(() => {const wrap=document.getElementById("fanyaMarking");' +
    'const qs=[...wrap.querySelectorAll(":scope > .TiMu")];' +
    'return JSON.stringify({n:qs.length,sel:qs.map(q=>q.dataset.sel||""),ans:qs.map(q=>q.dataset.ans||"")})})()';
  let six = {};
  for (let i = 0; i < 40; i++) {
    const rawS = await evalJS(SIX);
    try { six = JSON.parse(rawS); } catch (e) { six = {}; }
    if (six.sel && six.sel.every((v) => v)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok('6 题都识别到', Number(six.n) === 6, 'n=' + six.n);
  const filled = (six.sel || []).filter((v) => v).length;
  ok('6 题全部作答', filled === 6, '已答 ' + filled + '/6 sel=' + JSON.stringify(six.sel));
  const right = (six.sel || []).filter((v, i) => v && v === (six.ans || [])[i]).length;
  ok('答案正确率 >= 5/6', right >= 5, '正确 ' + right + '/6 期望=' + JSON.stringify(six.ans) + ' 实际=' + JSON.stringify(six.sel));
  ok('图片选项题(第1题)选对 B', (six.sel || [])[0] === 'B', 'sel0=' + (six.sel || [])[0]);

  console.log('\n  ' + pass + '/' + (pass + fail) + ' 通过');
  try { c.close(); } catch (e) {}
  try {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'msedge.exe\'\\" | Where-Object { $_.CommandLine -like \'*' + PROFILE + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore', timeout: 25000 });
  } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
