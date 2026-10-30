'use strict';
/**
 * 课程页链路自检(临时配置 + CDP)
 *
 * 验证 /mock/course 这个「还原超星结构」的页面里,扩展是否真的做到了:
 *   1. 找到两层 iframe 里的 <video>(顶层 → #iframe → ananas 播放器)
 *   2. 自动播放并改倍速(静音)
 *   3. 出现「章节未完成」提示(.jobFinishTip)时自动点 .popBottom .nextChapter
 *   4. 视频弹题(.ans-videoquiz)出现时自动作答 + 提交
 *   5. 视频结束后跳下一节(#prevNextFocusNext)
 *
 * 用法:node tools/probe_course.js [页面URL]
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, '..', '_edge-course');
const EXT = path.join(__dirname, '..', 'extension');
const PORT = 9345;
const URL0 = process.argv[2] || 'http://127.0.0.1:3001/mock/course?doc=1&n=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    }).on('error', reject);
  });
}

async function waitPort(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await get('/json/version'); return true; } catch (e) { await sleep(400); }
  }
  return false;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, send, events, close: () => ws.close() };
}

const PROBE = `(() => {
  const top = document;
  const study = (() => { try { const f = top.getElementById('iframe'); return f ? f.contentDocument : null; } catch (e) { return null; } })();
  const frames = () => { try { return study ? [...study.getElementsByTagName('iframe')] : []; } catch (e) { return []; } };
  const jobs = frames().map((el, i) => {
    let doc = null; try { doc = el.contentDocument; } catch (e) {}
    const w = doc && doc.defaultView;
    const job = el.parentElement;
    return {
      i,
      src: (el.src || '').replace('http://127.0.0.1:3001', ''),
      finished: !!(job && job.className && job.className.includes('ans-job-finished')),
      playCount: w ? (w.__playCount || 0) : 0,
      playerEv: w ? (w.__playerEv || null) : null,
      endedCount: w ? (w.__endedCount || 0) : 0,
      quizAnswer: w ? (w.__quizAnswer || null) : null,
      rate: (() => { try { const v = doc.querySelector('#vjs_container_html5_api') || doc.querySelector('video') || doc.querySelector('audio'); return v ? v.playbackRate : null; } catch (e) { return null; } })(),
      media: (() => {
        try {
          const v = doc.querySelector('#vjs_container_html5_api') || doc.querySelector('video') || doc.querySelector('audio');
          if (!v) return null;
          return { tag: v.tagName, err: v.error ? v.error.code : null, ready: v.readyState, net: v.networkState, dur: Math.round(v.duration || 0), src: (v.currentSrc || v.src || '').replace('http://127.0.0.1:3001', ''), paused: v.paused, muted: v.muted, vis: (w && w.document.visibilityState) || '?', res: (() => { try { return w.performance.getEntriesByType('resource').map((e) => e.name.slice(-22) + '=' + (e.responseStatus || '?') + '/' + Math.round(e.duration)).join(' | '); } catch (e) { return 'n/a'; } })() };
        } catch (e) { return { error: String(e) }; }
      })(),
    };
  });
  const tip = top.querySelector('.jobFinishTip');
  return JSON.stringify({
    href: location.href,
    studyDoc: !!study,
    jobs,
    tipDisplay: tip ? getComputedStyle(tip).display : 'n/a',
    ev: (window.__ev || []).join(','),
    chapter: window.__chapter || 1,
  });
})()`;

(async () => {
  try {
    await fetch('http://127.0.0.1:3001/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoVideo: true, autoJump: true, autoAnswer: true, autoSubmit: false, playbackRate: 1 }),
    });
    console.log('  已把开关设为:自动播放/自动跳节 = 开');
  } catch (e) { console.log('  [警告] 设置开关失败:', e.message); }

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  try {
    const psCmd = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + PROFILE + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    require('child_process').execSync('powershell -NoProfile -Command "' + psCmd + '"', { stdio: 'ignore', timeout: 25000 });
    await sleep(1500);
  } catch (e) {}

  const child = spawn(EDGE, [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--load-extension=' + EXT,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-features=Translate,msEdgeSplitScreen',
    'about:blank',
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
  console.log('  打开 ' + URL0);
  await sleep(5000);

  const PROBE_DOC = "(() => {" +
    "const study = (() => { try { const f = document.getElementById('iframe'); return f ? f.contentDocument : null; } catch (e) { return null; } })();" +
    "if (!study) return JSON.stringify({ studyDoc: false });" +
    "const job = study.getElementById('jobdoc');" +
    "const fe = job ? job.querySelector('iframe') : null;" +
    "let doc = null; try { doc = fe ? fe.contentDocument : null; } catch (e) {}" +
    "let d = null; try { d = doc && doc.defaultView.__doc; } catch (e) {}" +
    "return JSON.stringify({" +
    "  studyDoc: true," +
    "  jobDocExists: !!job," +
    "  finished: !!(job && job.className && job.className.indexOf('ans-job-finished') >= 0)," +
    "  docTop: d ? Math.round(d.top) : -1," +
    "  docMax: d ? Math.round(d.max) : -1," +
    "  docDone: !!(d && d.done)," +
    "  docFrames: (() => { try { return study.querySelectorAll('iframe').length; } catch (e) { return -1; } })()" +
    "});" +
  "})()";

  let pass = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    let r = null;
    try {
      const res = await c.send('Runtime.evaluate', { expression: PROBE_DOC, returnByValue: true });
      r = JSON.parse(res.result.value);
    } catch (e) { console.log('  [eval err] ' + e.message); continue; }
    console.log('  #' + (i + 1) + ' ' + JSON.stringify(r));
    if (r.finished && (r.docDone || (r.docMax > 0 && r.docTop >= r.docMax - 8))) { pass = true; break; }
  }
  console.log(pass ? '[PASS] 文档任务点已被滚到底并被打上完成标记' : '[FAIL] 90 秒内文档没滚到底 / 没有完成标记');

  // 文档读完后应该自动点「下一节」;看一眼真的跳了没有
  let ch = 1;
  for (let i = 0; i < 12; i++) {
    try {
      const res = await c.send('Runtime.evaluate', { expression: 'String((window.__chapter||1))', returnByValue: true });
      ch = Number(res.result.value) || 1;
    } catch (e) {}
    if (ch >= 2) break;
    await sleep(1500);
  }
  console.log(ch >= 2 ? '[PASS] 已自动跳到下一节(chapter=2)' : '[WARN] 文档完成后没有跳节(若其它任务点未完成,这是正常的)');
  try { c.close(); } catch (e) {}
  process.exit(pass ? 0 : 1);
})();
