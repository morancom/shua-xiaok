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
const URL0 = process.argv[2] || 'http://127.0.0.1:3001/mock/course';

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
  // 自检前把开关打开(扩展严格按后端设置行事,开关关着就什么都不做)
  try {
    await fetch('http://127.0.0.1:3001/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoVideo: true, autoJump: true, autoAnswer: true, autoSubmit: false, playbackRate: 1 }),
    });
    console.log('  已把开关设为:自动播放/自动跳节/自动做题 = 开,倍速 = 1');
  } catch (e) {
    console.log('  [警告] 设置开关失败:', e.message);
  }

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

  // 上一轮探测的 Edge 若没退干净,会一直占着 9345 和这个配置目录:新进程会把命令行转发给旧实例后退出,
  // 于是 CDP 连上的是几小时前那个实例(跑着旧扩展代码)——踩过一次,所以这里按配置路径精确清理。
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    require('child_process').execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore', timeout: 25000 });
    await sleep(2000);
  } catch (e) {}

  const child = spawn(EDGE, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
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
  const consoleMsgs = [];
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  const pump = setInterval(() => {
    while (c.events.length) {
      const e = c.events.shift();
      if (e.method === 'Runtime.consoleAPICalled') {
        const txt = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleMsgs.push(`[${e.params.type}] ${txt}`);
      } else if (e.method === 'Runtime.exceptionThrown') {
        consoleMsgs.push(`[exception] ${e.params.exceptionDetails.text} ${e.params.exceptionDetails.exception?.description || ''}`);
      } else if (e.method === 'Log.entryAdded') {
        consoleMsgs.push(`[log:${e.params.entry.level}] ${e.params.entry.text}`);
      }
    }
  }, 150);

  await c.send('Page.navigate', { url: URL0 });
  // 探测用的 Edge 窗口通常在后台,页面 visibilityState=hidden 时 Chrome 会严重节流媒体加载
  // (readyState 一直是 0、连 tone.wav 都不会发出请求)。这里强制把页面当成前台+可见。
  try { await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  try { await c.send('Page.bringToFront'); } catch (e) {}
  await sleep(2500);

  // 浏览器只有在「文档被用户点过」之后才允许自动播放。
  // 真实场景里用户是点进课程页的,这里用 CDP 模拟真实点击:
  // 先点顶层,再点进两层 iframe 里的播放器位置,给它所在的文档授予用户激活。
  const click = async (x, y) => {
    try {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } catch (e) {}
  };
  await click(40, 40);
  await sleep(1200);

  // 计算「学习页 iframe 内第一个任务 iframe」在顶层视口中的坐标
  const rectExpr = `(() => {
    try {
      const outer = document.getElementById('iframe').getBoundingClientRect();
      const sd = document.getElementById('iframe').contentDocument;
      const inner = sd.getElementsByTagName('iframe')[0].getBoundingClientRect();
      return JSON.stringify({ x: Math.round(outer.x + inner.x + inner.width / 2), y: Math.round(outer.y + inner.y + inner.height / 2) });
    } catch (e) { return ''; }
  })()`;
  const rectRes = await c.send('Runtime.evaluate', { expression: rectExpr, returnByValue: true });
  let spot = null;
  try { spot = JSON.parse(rectRes.result.value); } catch (e) {}
  if (spot) {
    await click(spot.x, spot.y);
    await sleep(600);
    console.log(`  已在播放器位置 (${spot.x},${spot.y}) 点了一下,授予自动播放权限`);
  }

  const snaps = [];
  // 先验证「诊断日志」链路。
  // 注意:内容脚本跑在隔离世界,CDP 的 Runtime.evaluate 在页面主世界,看不到 window.SXKCX,
  // 所以这里模拟真实用户点侧边栏上的「🐞 诊断日志」按钮(点击事件在隔离世界里执行)。
  let diagInfo = '';
  try {
    const btnExpr = `(() => {
      const host = document.querySelector('#sxk-host');
      const root = host && host.shadowRoot;
      if (!root) return '';
      const btn = Array.from(root.querySelectorAll('.sxk-act')).find((b) => b.dataset.act === 'diag');
      if (!btn) return '';
      const r = btn.getBoundingClientRect();
      if (!r.width) return '';
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`;
    const br = await c.send('Runtime.evaluate', { expression: btnExpr, returnByValue: true });
    let bspot = null;
    try { bspot = JSON.parse(br.result.value); } catch (e) {}
    if (!bspot) {
      diagInfo = '没找到「诊断日志」按钮(侧边栏可能没打开)';
    } else {
      await click(bspot.x, bspot.y);
      await sleep(2500);
      const j = await (await fetch('http://127.0.0.1:3001/api/cxlog')).json();
      const items = (j && j.items) || [];
      diagInfo = items.length
        ? `点按钮后后端收到 ${items.length} 份,最新 ${String(items[0].text).split('\n').length} 行 ← ${items[0].host}${items[0].path}`
        : `点了按钮(${bspot.x},${bspot.y})但后端没收到日志`;
    }
  } catch (e) { diagInfo = 'err:' + e.message; }
  // 连续采样:两个 3 秒的视频先后播完、随即跳下一节,"完成"这个状态只存在不到 1 秒,
  // 稀疏采样会刚好错过(踩过),所以这里每 1.5 秒采一次
  const STEP = 1500;
  // 每个视频 3~5 秒,任务点越多需要等越久(3 个视频大概 40 秒)
  const expectN = Number((URL0.match(/[?&]n=(\d+)/) || [])[1] || 2);
  const END_AT = 14000 + expectN * 9000;
  let elapsed = 0;
  while (elapsed < END_AT) {
    const wait = Math.min(STEP, END_AT - elapsed);
    await sleep(wait);
    elapsed += wait;
    const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    snaps.push({ at: elapsed, d: JSON.parse(r.result.value) });
  }

  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_probe_course.png'), Buffer.from(shot.data, 'base64'));

  console.log('=== 快照 ===');
  snaps.forEach((s) => console.log(`  @${s.at}ms  ${JSON.stringify(s.d)}`));
  if (consoleMsgs.length) {
    console.log('=== 控制台 ===');
    consoleMsgs.slice(-8).forEach((m) => console.log('  ' + m));
  }

  const last = snaps[snaps.length - 1].d;
  const allEv = snaps.map((s) => s.d.ev || '').join(',');
  const allHref = snaps.map((s) => s.d.href || '').join(' ');
  // 取「任务点最多」的那一帧,因为最后会跳到第二节,jobs 会是空的
  const richest = snaps.map((s) => s.d).sort((a, b) => (b.jobs || []).length - (a.jobs || []).length)[0];
  const jobs = richest.jobs || [];
  const j1 = jobs[0] || {};
  const j2 = jobs[1] || {};
  // 单帧快照容易「刚好拍在标记完成之前」而误判失败,所以每个任务点都在全部快照里取最好结果
  const pick = (i) => snaps.map((s) => (s.d.jobs || [])[i]).filter(Boolean);
  const maxOf = (arr, f) => arr.reduce((m, x) => Math.max(m, Number(f(x)) || 0), 0);
  const anyOf = (arr, f) => arr.some((x) => !!f(x));
  const handles = [];
  for (let i = 0; i < jobs.length; i++) handles.push(pick(i));

  // 页面里可能还有文档型任务点,它们不算视频,也没有倍速概念
  // 跳节之后快照里就没有任务点了,所以取「任务点最多的那一帧」来判断
  const bestJobs = snaps.map((s) => s.d.jobs || []).reduce((a, b) => (b.length > a.length ? b : a), []);
  const vjobs = bestJobs.filter((j) => /ananas\/modules\/video/.test(j.src));
  const checks = [
    ['学习页 iframe 存在(两层 iframe 结构)', snaps.some((s) => s.d.studyDoc === true)],
    [`${expectN} 个视频任务 iframe 都命中 ananas/video`, vjobs.length === expectN && vjobs.every((j) => /ananas\/modules\/video/.test(j.src))],
    ['所有任务点倍速 = 1(默认一倍速)', vjobs.every((j) => j.rate === 1)],
  ];
  // 逐个任务点:播过 / 播完并标记完成 / 没有反复重播
  for (let i = 0; i < expectN; i++) {
    const h = handles[i] || [];
    checks.push([`任务点${i + 1} 被播放`, maxOf(h, (x) => x.playCount) >= 1]);
    checks.push([`任务点${i + 1} 播完并标记完成`, anyOf(h, (x) => x.finished) && maxOf(h, (x) => x.endedCount) >= 1]);
    checks.push([`任务点${i + 1} 没有被反复重播(只播1次)`, maxOf(h, (x) => x.playCount) === 1]);
  }
  checks.push(['「章节未完成」提示被自动关掉', /clicked:nextChapter/.test(allEv)]);
  checks.push(['视频弹题被自动作答', handles.some((h) => h.some((x) => !!x.quizAnswer))]);
  checks.push([`${expectN} 个任务点都完成后自动跳到下一节`, /chapter=2/.test(allHref) || last.chapter === 2]);
  checks.push(['跳节后没有继续乱点(第二节无下一节)', last.chapter === 2]);
  console.log('=== 判定 ===');
  console.log('  诊断日志:' + (diagInfo || '(未验证)'));
  let pass = 0;
  checks.forEach(([name, ok]) => { console.log(`  ${ok ? '[OK]  ' : '[FAIL]'} ${name}`); if (ok) pass++; });
  console.log(`  ${pass}/${checks.length} 通过`);
  console.log('  截图: _probe_course.png');

  clearInterval(pump);
  c.close();
  // 只关掉本次探测启动的那个实例,绝不能 taskkill 全部 msedge(会关掉用户正在用的浏览器)
  try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(pass === checks.length ? 0 : 2);
})();
