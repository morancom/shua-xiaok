'use strict';
/**
 * 刷小课 · 自检页端到端验证
 * 验证「侧边栏 → background → 页面脚本 → 后端解题 → 写回页面」整条链路
 */
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const targets = await fetch(`${BASE}/json/list`).then((r) => r.json());
  let t = targets.find((x) => x.url.includes(url));
  if (!t) t = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await call('Runtime.enable');
  await call('Page.enable');
  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result?.value;
  };
  return { evalJs, call, close: () => ws.close() };
}

(async () => {
  const page = await connect('/mock/chaoxing');
  await page.call('Page.navigate', { url: 'http://127.0.0.1:3001/mock/chaoxing' });
  await sleep(3500);

  console.log('=== 1. 页面与脚本注入 ===');
  console.log('  TiMu 题块 =', await page.evalJs("document.querySelectorAll('.TiMu').length"));
  console.log('  #sxk-root 存在 =', await page.evalJs("!!document.getElementById('sxk-root')"));

  console.log('');
  console.log('=== 2. 打开侧边栏 ===');
  await page.evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,key:'s'}))");
  await sleep(900);
  console.log('  已打开 =', await page.evalJs("document.getElementById('sxk-root')?.classList.contains('open')"));

  console.log('');
  console.log('=== 3. 点击「自动做题」 ===');
  await page.evalJs("document.querySelector('.sxk-act[data-act=\"answer\"]').click()");
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const st = await page.evalJs("document.querySelector('.sxk-status')?.textContent || ''");
    if (/已作答|未识别|没找到|未响应|失败|非目标/.test(st)) { console.log('  状态:', st, `(${i + 1}s)`); break; }
    if (i === 24) console.log('  状态(超时):', st);
  }

  console.log('');
  console.log('=== 4. 页面实际变化 ===');
  console.log('  选中项 =', await page.evalJs("(()=>{const o=document.querySelector('.optionItem.on');return o?o.dataset.letter:'(无)'})()"));
  console.log('  radio 勾选 =', await page.evalJs("[...document.querySelectorAll('input[type=radio]')].map(r=>r.checked).join(',')"));
  console.log('  填空题值 =', JSON.stringify(await page.evalJs("document.querySelector('.fillInput')?.value || ''")));
  console.log('  提示1 =', JSON.stringify(await page.evalJs("document.getElementById('r1')?.textContent || ''")));
  console.log('  提示2 =', JSON.stringify(await page.evalJs("document.getElementById('r2')?.textContent || ''")));

  page.close();
})().catch((e) => {
  console.error('自检失败:', e.message);
  process.exit(1);
});
