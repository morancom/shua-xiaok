'use strict';
/** 在当前活动标签页(超星)上检查侧边栏状态与本地网络访问权限 */
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const call = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, { resolve }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await call('Runtime.enable');
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result ? r.result.value : undefined;
  };
  return { ev, close: () => ws.close() };
}

(async () => {
  const list = await fetch(BASE + '/json/list').then((r) => r.json());
  const pages = list.filter((x) => x.type === 'page' && /chaoxing/.test(x.url));
  if (!pages.length) { console.log('没有超星页面'); return; }
  const t = pages[pages.length - 1];
  console.log('目标页:', t.url.slice(0, 80));
  const p = await attach(t);
  await sleep(1500);

  const html = await p.ev('document.getElementById("sxk-root") ? document.getElementById("sxk-root").innerHTML.slice(0,700) : "(空)"');
  console.log('');
  console.log('=== 侧边栏 HTML(前 700)===');
  console.log(String(html).split('\n').map((s) => '    ' + s).join('\n'));

  const txt = await p.ev('document.getElementById("sxk-root") ? document.getElementById("sxk-root").innerText.slice(0,300) : ""');
  console.log('');
  console.log('=== 侧边栏可见文本 ===');
  console.log(JSON.stringify(txt));

  const st = await p.ev(`Promise.race([
    fetch('http://127.0.0.1:3001/api/health').then(r=>r.json()).then(j=>'OK ' + j.name + ' ' + j.version).catch(e=>'FAIL ' + e.message),
    new Promise(r=>setTimeout(()=>r('TIMEOUT'),5000))
  ])`);
  console.log('');
  console.log('=== 从该页面请求本地后端 ===');
  console.log('  ', st);
  p.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
