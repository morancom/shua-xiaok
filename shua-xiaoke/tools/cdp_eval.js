'use strict';
/**
 * 最小 CDP 客户端:打开指定页面,取页面文本。
 * 用法: node cdp_eval.js "<url-to-open>" [jsExpression]
 * Node 22+ 自带 WebSocket,无需依赖。
 */
const BASE = 'http://127.0.0.1:9222';

async function main() {
  const url = process.argv[2] || 'edge://policy/';
  const expr = process.argv[3] || 'document.body.innerText';

  const t = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 2500));

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  await call('Runtime.enable');
  const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
  ws.close();
  await fetch(`${BASE}/json/close/${t.id}`).catch(() => {});
}

main().catch((e) => {
  console.error('CDP 失败:', e.message);
  process.exit(1);
});
