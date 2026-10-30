'use strict';
/**
 * 在真实超星课程页上验证扩展:
 * 侧边栏是否自动弹出、后端是否连通、视频是否被接管(倍速/静音/播放)
 * 用法:node tools/verify_chaoxing.js "<课程页URL>"
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
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.text || '') : r.result?.value;
  };
  return { ev, close: () => ws.close() };
}

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('用法: node tools/verify_chaoxing.js "<URL>"'); process.exit(1); }

  const t = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' }).then((r) => r.json());
  console.log('  新标签页已打开,等待加载 …');
  await sleep(12000);
  const p = await attach(t);

  console.log('');
  console.log('=== 页面 ===');
  console.log('  title =', await p.ev('document.title'));
  console.log('  url   =', (await p.ev('location.href')).slice(0, 110));
  console.log('  iframe 数 =', await p.ev('document.querySelectorAll("iframe").length'));

  console.log('');
  console.log('=== 侧边栏 ===');
  console.log('  #sxk-root 存在 =', await p.ev("!!document.getElementById('sxk-root')"));
  console.log('  自动打开(.open) =', await p.ev("!!document.getElementById('sxk-root')?.classList.contains('open')"));
  console.log('  状态文本        =', JSON.stringify(await p.ev("document.querySelector('.sxk-status')?.textContent")));

  console.log('');
  console.log('=== 视频 ===');
  console.log(await p.ev(`(() => {
    const vs = [...document.querySelectorAll('video')];
    if (!vs.length) return '  页面里没有 video 元素(可能还在 iframe 内或未进入章节)';
    return vs.map((v, i) => '  video#' + i + ' rate=' + v.playbackRate + ' muted=' + v.muted + ' paused=' + v.paused + ' t=' + Math.round(v.currentTime) + '/' + Math.round(v.duration || 0)).join('\\n');
  })()`));

  console.log('');
  console.log('=== iframe 内的视频 ===');
  console.log(await p.ev(`(() => {
    const out = [];
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (!d) { out.push('  iframe ' + (f.src||'').slice(0,60) + ' -> 跨域读不到'); continue; }
        const vs = [...d.querySelectorAll('video')];
        out.push('  iframe ' + (f.src||'').slice(0,60) + ' -> video x' + vs.length + (vs[0] ? ' rate=' + vs[0].playbackRate + ' muted=' + vs[0].muted : ''));
      } catch (e) { out.push('  iframe 读取异常 ' + e.message); }
    }
    return out.join('\\n') || '  没有 iframe';
  })()`));

  p.close();
})().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
