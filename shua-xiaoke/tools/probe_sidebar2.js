'use strict';
/**
 * 用 CDP 在「临时配置」里检查内容脚本是否注入、侧边栏是否创建、有没有报错。
 * 临时配置不受默认配置那套限制,适合做快速诊断。
 *
 * 用法:node probe_sidebar2.js [页面URL]
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, '..', '_edge-probe');
const EXT = path.join(__dirname, '..', 'extension');
const PORT = 9333;
const URL0 = process.argv[2] || 'http://127.0.0.1:3001/mock/chaoxing';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { resolve(b); }
      });
    }).on('error', reject);
  });
}

async function waitPort(timeoutMs = 25000) {
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
    } else if (m.method) {
      events.push(m);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  return { ready, send, events, close: () => ws.close() };
}

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

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

  if (!(await waitPort())) {
    console.log('[FAIL] CDP 端口没起来');
    process.exit(1);
  }

  const targets = await get('/json/list');
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page) { console.log('[FAIL] 没有 page target'); process.exit(1); }

  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;

  const consoleMsgs = [];
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await c.send('Runtime.addBinding', { name: '__noop__' }).catch(() => {});

  // 收集控制台与异常
  const raw = c.events;
  const pump = setInterval(() => {
    while (raw.length) {
      const e = raw.shift();
      if (e.method === 'Runtime.consoleAPICalled') {
        const txt = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleMsgs.push(`[${e.params.type}] ${txt}`);
      } else if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        consoleMsgs.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
      } else if (e.method === 'Log.entryAdded') {
        consoleMsgs.push(`[log:${e.params.entry.level}] ${e.params.entry.text}`);
      }
    }
  }, 150);

  await c.send('Page.navigate', { url: URL0 });
  await sleep(6000);

  const probe = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('sxk-host');
      const sr = h && h.shadowRoot;
      const q = (s) => (sr ? sr.querySelector(s) : null);
      const panel = q('.sxk-panel');
      const cs = panel ? getComputedStyle(panel) : null;
      return JSON.stringify({
        host: !!h,
        shadow: !!sr,
        styleLen: q('style') ? q('style').textContent.length : 0,
        panel: !!panel,
        open: !!q('.sxk-root.open'),
        panelRadius: cs ? cs.borderRadius : '',
        panelBg: cs ? cs.backgroundColor : '',
        panelWidth: cs ? cs.width : '',
        conn: q('.sxk-conn') ? q('.sxk-conn').textContent : '',
        ballCount: sr ? sr.querySelectorAll('.sxk-ball').length : 0,
        status: q('.sxk-status') ? q('.sxk-status').textContent : ''
      });
    })()`,
    returnByValue: true,
  });
  clearInterval(pump);

  console.log('=== 页面探测 ===');
  console.log(probe.result.value);
  console.log('');
  console.log('=== 控制台/异常(' + consoleMsgs.length + ' 条)===');
  consoleMsgs.slice(0, 30).forEach((m) => console.log('  ' + m));

  // 截图
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(__dirname, '..', '_probe_shot.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('');
  console.log('  截图:', out);

  // 再截一张「收起状态」,确认右侧浮球 dock 的样式
  await c.send('Runtime.evaluate', {
    expression: `(() => {
      const sr = document.getElementById('sxk-host').shadowRoot;
      const close = sr.querySelector('.sxk-close');
      if (close) close.click();
      return !!close;
    })()`,
    returnByValue: true,
  });
  await sleep(900);
  const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
  const out2c = path.join(__dirname, '..', '_probe_closed.png');
  fs.writeFileSync(out2c, Buffer.from(shot2.data, 'base64'));
  console.log('  收起截图:', out2c);

  // 可选的「自动做题」端到端验证
  if (process.argv[3] === 'answer') {
    console.log('');
    console.log('=== 触发「自动做题」 ===');
    await c.send('Runtime.evaluate', {
      expression: `(() => {
        const h = document.getElementById('sxk-host');
        const sr = h && h.shadowRoot;
        const btn = sr && sr.querySelector('.sxk-act[data-act="answer"]');
        if (btn) btn.click();
        return !!btn;
      })()`,
      returnByValue: true,
    });
    await sleep(25000);
    const after = await c.send('Runtime.evaluate', {
      expression: `(() => {
        const h = document.getElementById('sxk-host');
        const sr = h && h.shadowRoot;
        const checked = [...document.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')].map((i) => i.value || i.dataset.letter || '');
        const filled = [...document.querySelectorAll('input[type=text], textarea')].map((i) => i.value).filter(Boolean);
        return JSON.stringify({
          checked, filled,
          status: sr && sr.querySelector('.sxk-status') ? sr.querySelector('.sxk-status').textContent : '',
          bubbles: sr ? sr.querySelectorAll('.sxk-bubble').length : 0,
        });
      })()`,
      returnByValue: true,
    });
    console.log('  ' + after.result.value);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    const out2 = path.join(__dirname, '..', '_probe_answer.png');
    fs.writeFileSync(out2, Buffer.from(shot2.data, 'base64'));
    console.log('  第二张截图:', out2);
  }

  c.close();
  try { process.kill(-child.pid); } catch (e) { try { child.kill(); } catch (e2) {} }
  console.log('  已关闭探测用 Edge');
  process.exit(0);
})();
