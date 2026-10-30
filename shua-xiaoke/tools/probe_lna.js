'use strict';
/**
 * 璇婃柇:鍏叡 HTTPS 绔欑偣璁块棶 127.0.0.1 鏄惁琚€屾湰鍦扮綉缁滆闂?LNA)銆嶆嫤鎴?
 * 浠ュ強鎵╁睍 service worker 鏄惁涔熻鎷︺€? * 闇€瑕?Edge 甯?--remote-debugging-port=9222 涓斿凡 --load-extension
 */
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, { resolve });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await call('Runtime.enable');
  const ev = async (expr) =>
    (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  return { ev, close: () => ws.close() };
}

(async () => {
  const list = await fetch(`${BASE}/json/list`).then((r) => r.json());

  // ---- A. 鎵╁睍 service worker ----
  const sw = list.find((x) => x.type === 'service_worker' && String(x.url).includes('sw2.js'));
  if (sw) {
    const p = await attach(sw);
    const r = await p.ev(`
      fetch('http://127.0.0.1:3001/api/health')
        .then(r => r.json()).then(j => 'OK ' + j.version)
        .catch(e => 'FAIL ' + e.message)
    `);
    console.log('A. 鎵╁睍 service worker 璁块棶 127.0.0.1 =', r);
    p.close();
  } else {
    console.log('A. 娌℃壘鍒版墿灞?service worker');
  }

  // ---- B. 鍏叡 HTTPS 椤甸潰(涓讳笘鐣?----
  const t = await fetch(`${BASE}/json/new?${encodeURI('https://example.com/')}`, { method: 'PUT' }).then((r) => r.json());
  await sleep(3000);
  const page = await attach(t);
  const r2 = await page.ev(`
    Promise.race([
      fetch('http://127.0.0.1:3001/api/health').then(r=>r.json()).then(j=>'OK '+j.version).catch(e=>'FAIL '+e.message),
      new Promise(r=>setTimeout(()=>r('TIMEOUT'),4000))
    ])
  `);
  console.log('B. 鍏叡椤甸潰涓讳笘鐣岃闂?127.0.0.1 =', r2);

  // ---- C. 渚ц竟鏍忓湪鍏叡椤甸潰鐨勭湡瀹炶〃鐜?----
  await page.ev("document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,key:'s'}))");
  await sleep(2500);
  console.log('C. 渚ц竟鏍忔敞鍏?=', await page.ev("!!document.getElementById('sxk-root')"));
  console.log('   鐘舵€佹枃鏈?=', JSON.stringify(await page.ev("document.querySelector('.sxk-status')?.textContent")));

  page.close();
})().catch((e) => {
  console.error('璇婃柇澶辫触:', e.message);
  process.exit(1);
});
