'use strict';
/** 处理超星「温馨提示」页并进入章节,验证视频是否被接管 */
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
  const call = (m2, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, { resolve }); ws.send(JSON.stringify({ id: mid, method: m2, params })); });
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
  const t = list.filter((x) => x.type === 'page' && /chaoxing/.test(x.url)).pop();
  if (!t) { console.log('没有超星页面'); return; }
  const p = await attach(t);

  console.log('=== 当前提示页内容 ===');
  const bodyText = String(await p.ev('document.body.innerText.slice(0,600)'));
  console.log(bodyText.split('\n').filter(Boolean).map((s) => '  ' + s).join('\n'));

  console.log('');
  console.log('=== 尝试点击「继续/我知道了」 ===');
  const clicked = await p.ev(`(() => {
    const cands = [...document.querySelectorAll('a,button,input[type=button],span,div')]
      .filter(el => /^(继续学习|继续|我知道了|确定|进入学习)$/.test((el.innerText||el.value||'').trim()) && el.offsetParent);
    if (!cands.length) return 'none';
    cands[0].click();
    return 'clicked: ' + (cands[0].innerText||cands[0].value);
  })()`);
  console.log('  ', clicked);

  await sleep(8000);
  console.log('');
  console.log('=== 点击后 ===');
  console.log('  url   =', String(await p.ev('location.href')).slice(0, 120));
  console.log('  title =', await p.ev('document.title'));
  console.log('  iframe 数 =', await p.ev('document.querySelectorAll("iframe").length'));
  console.log('  video 数  =', await p.ev('document.querySelectorAll("video").length'));
  console.log('  侧边栏 open =', await p.ev('!!document.getElementById("sxk-root") && document.getElementById("sxk-root").classList.contains("open")'));

  p.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
