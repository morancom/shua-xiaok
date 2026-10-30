'use strict';
/**
 * 单独验证 mock 播放器能否被 play() —— 排除扩展的干扰
 * 用法: node tools/probe_player.js
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, '..', '_edge-player');
const PORT = 9347;
const URL0 = 'http://127.0.0.1:3001/mock/player?task=1&d=3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    }).on('error', reject);
  });
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
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  const child = spawn(EDGE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 60; i++) { try { await get('/json/version'); break; } catch (e) { await sleep(400); } }
  const list = await get('/json/list');
  const page = (list || []).find((t) => t.type === 'page');
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: URL0 });
  await sleep(2500);

  const expr = `(async () => {
    const v = document.querySelector('#vjs_container_html5_api');
    const before = { paused: v.paused, ready: v.readyState, net: v.networkState, dur: v.duration, src: v.currentSrc };
    v.muted = true;
    let err = null;
    try { await v.play(); } catch (e) { err = (e && e.name) + ' | ' + (e && e.message); }
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.stringify({ before, err, after: { paused: v.paused, t: v.currentTime, ready: v.readyState, dur: v.duration } });
  })()`;
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  console.log('  裸页面 play() 结果:', r.result.value);

  c.close();
  try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
})();
