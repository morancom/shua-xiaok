'use strict';
/**
 * 刷小课 · 非目标站点行为验证
 * 在控制台页(不是超星/智慧树等)点「自动做题」,应给出「非目标站点」的明确提示,
 * 而不是含糊的「未识别到题目」。
 * 用法:node tools/e2e_nontarget.js  (需 Edge 已带扩展启动并开着调试端口 9222)
 */
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(url) {
  const t = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
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
  const p = await attach('http://127.0.0.1:3001/ui');
  await sleep(2800);

  console.log('=== 控制台页(非目标站点)===');
  console.log('  注入 =', await p.ev("!!document.getElementById('sxk-root')"));

  await p.ev("document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,key:'s'}))");
  await sleep(800);
  console.log('  侧边栏打开 =', await p.ev("document.getElementById('sxk-root')?.classList.contains('open')"));

  await p.ev("document.querySelector('.sxk-act[data-act=\"answer\"]').click()");
  await sleep(2500);
  const status = await p.ev("document.querySelector('.sxk-status')?.textContent");
  console.log('  自动做题提示 =', JSON.stringify(status));

  const good = /非目标站点|没有刷课脚本|未识别/.test(String(status));
  console.log(good ? '  [OK] 提示明确' : '  [X] 提示不明确');
  p.close();
  process.exit(good ? 0 : 1);
})();
