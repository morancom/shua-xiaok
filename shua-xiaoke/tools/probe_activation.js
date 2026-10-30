'use strict';
/**
 * 诊断:在 /mock/course 里点击内层 iframe 位置后,播放器文档是否获得用户激活、play() 能否成功。
 * 用法: node tools/probe_activation.js
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(__dirname, '..', '_edge-act');
const PORT = 9349;
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
  await c.send('Page.navigate', { url: 'http://127.0.0.1:3001/mock/course' });
  await sleep(2500);

  const info = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  };

  const geoms = await info(`(() => {
    const outerEl = document.getElementById('iframe');
    const outer = outerEl.getBoundingClientRect();
    const sd = outerEl.contentDocument;
    const inners = [...sd.getElementsByTagName('iframe')].map((f, i) => {
      const r = f.getBoundingClientRect();
      return { i, x: Math.round(outer.x + r.x), y: Math.round(outer.y + r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return JSON.stringify({ outer: { x: outer.x, y: outer.y, w: outer.width, h: outer.height }, inners });
  })()`);
  console.log('  几何:', geoms);
  const g = JSON.parse(geoms);
  const t0 = g.inners[0];

  const click = async (x, y) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  await click(t0.x + Math.round(t0.w / 2), t0.y + Math.round(t0.h / 2));
  await sleep(800);

  const act = await info(`(() => {
    const outerEl = document.getElementById('iframe');
    const sd = outerEl.contentDocument;
    const f = sd.getElementsByTagName('iframe')[0];
    const w = f.contentWindow;
    const v = f.contentDocument.querySelector('#vjs_container_html5_api');
    return JSON.stringify({
      top: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
      study: (() => { try { return sd.defaultView.navigator.userActivation.hasBeenActive; } catch (e) { return 'err'; } })(),
      player: (() => { try { return w.navigator.userActivation.hasBeenActive; } catch (e) { return 'err'; } })(),
      paused: v.paused, ready: v.readyState, dur: v.duration,
    });
  })()`);
  console.log('  点击后激活状态:', act);

  // 不授予 gesture,直接用页面自己的 play() —— 看是否会 pending
  const playTry = await info(`(async () => {
    const outerEl = document.getElementById('iframe');
    const f = outerEl.contentDocument.getElementsByTagName('iframe')[0];
    const v = f.contentDocument.querySelector('#vjs_container_html5_api');
    v.muted = true;
    let err = null;
    let pending = false;
    const p = v.play();
    if (p && p.then) {
      p.then(() => {}).catch((e) => { err = (e && e.name) + ' ' + (e && e.message); });
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (v.paused && !err) pending = true;
    return JSON.stringify({ err, pending, paused: v.paused, t: v.currentTime });
  })()`);
  console.log('  play() 结果:', playTry);

  c.close();
  try { require('child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
})();
