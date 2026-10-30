'use strict';
/**
 * 刷小课 · background service worker
 * 职责:中转 content script 与本地后端(server.js @ http://127.0.0.1:3001)
 * 提供:解题 / AI对话(SSE) / 设置读取 / 刷课日志上报
 */
const SERVER = 'http://127.0.0.1:3001';

// 页面主世界里的提交执行器单独放 pageSubmit.js：AUTO_SUBMIT_PAGE 和 mock 页共用一份，
// 真机确认框 #confirmWin(.Alertcon2) 也在那里处理。
importScripts('pageSubmit.js');


// ---- 启动心跳 ----
// 只要扩展被加载,这条请求就会出现在后端日志里。
// 用来判断「扩展到底有没有装上」:没日志 = 没加载。
// 注意 service worker 刚启动时首次 fetch 可能失败,所以重试几次。
(function heartbeat(retry = 0) {
  try {
    const v = chrome.runtime.getManifest().version;
    fetch(`${SERVER}/api/brush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: 'background', task: 'startup', status: `v${v} try=${retry} at=${new Date().toISOString()}` }),
    })
      .then((r) => r.json())
      .catch(() => {
        if (retry < 4) setTimeout(() => heartbeat(retry + 1), 1500);
      });
  } catch (e) {}
})();

async function getSettings() {
  try {
    const r = await fetch(`${SERVER}/api/state`);
    const j = await r.json();
    return j.settings || {};
  } catch (e) {
    // 后端未启动时返回默认值
    return { autoVideo: true, playbackRate: 1, autoJump: true, autoAnswer: true, autoSubmit: false };
  }
}

// 把后端里的刷课开关广播给所有页面:侧边栏一改,课程页/作业页立刻跟着改
function broadcastSettings(settings) {
  try {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((t) => {
        if (!t || !t.id) return;
        chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_CHANGED', settings }).catch(() => {});
      });
    });
  } catch (e) {}
}

async function postJSON(path, body) {
  const r = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

// ---- 消息路由(content scripts 通过 chrome.runtime.onMessage 发来)----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_SETTINGS':
          sendResponse({ ok: true, settings: await getSettings() });
          break;

        case 'CHECK_BACKEND': {
          // 内容脚本不直连 127.0.0.1(会被 Edge 的本地网络访问权限拦),
          // 统一由后台代发
          try {
            const r = await fetch(`${SERVER}/api/health`, { cache: 'no-store' });
            const health = await r.json();
            sendResponse({ ok: true, health });
          } catch (e) {
            sendResponse({ ok: false, errstr: e.message });
          }
          break;
        }

        case 'SOLVE': {
          const r = await postJSON('/api/solve', {
            question: msg.question || '',
            options: msg.options || [],
            context: msg.context || '',
            images: Array.isArray(msg.images) ? msg.images : (msg.image ? [msg.image] : []),
          });
          sendResponse({ ok: true, result: r.data || r });
          break;
        }

        case 'SET_SETTINGS': {
          // 侧边栏开关 → 立刻写回后端,并把新设置广播给所有页面(实时生效)
          const patch = (msg && msg.patch) || {};
          const j = await postJSON('/api/settings', patch);
          const merged = (j && j.settings) || {};
          broadcastSettings(merged);
          sendResponse({ ok: true, settings: merged });
          break;
        }

        case 'CAPTURE_RECT': {
          // 把页面上某一块(一道题的题干+选项)截下来给模型看。
          // 超星很多题的选项就是图片,还带防盗链(直连 403),截图是唯一稳的路子。
          try {
            const [tb] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tb || !tb.id) { sendResponse({ ok: false, errstr: '没有活动标签页' }); break; }
            // Windows 上窗口被别的程序挡住时,captureVisibleTab 可能截到「屏幕上那块区域」而不是本页,
            // 表现为截到别的程序的深色界面。先把标签页/窗口抬到最前,再等一帧再截。
            try { await chrome.tabs.update(tb.id, { active: true }); } catch (e) {}
            try { await chrome.windows.update(tb.windowId, { focused: true }); } catch (e) {}
            await new Promise((r) => setTimeout(r, 260));
            const full = await chrome.tabs.captureVisibleTab(tb.windowId, { format: 'png' });
            const blob0 = await (await fetch(full)).blob();
            const bmp = await createImageBitmap(blob0);
            const dpr = Number(msg.dpr) || 1;
            const r = msg.rect || {};
            const sx = Math.max(0, Math.round((Number(r.x) || 0) * dpr));
            const sy = Math.max(0, Math.round((Number(r.y) || 0) * dpr));
            const sw = Math.min(bmp.width - sx, Math.round((Number(r.w) || 0) * dpr));
            const sh = Math.min(bmp.height - sy, Math.round((Number(r.h) || 0) * dpr));
            if (sw < 16 || sh < 16) { sendResponse({ ok: false, errstr: '可见区域太小' }); break; }
            const cv = new OffscreenCanvas(sw, sh);
            const cx = cv.getContext('2d');
            cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
            // 窗口在后台时 captureVisibleTab 会返回整块黑屏;这种图发给模型只会得到瞎猜的答案
            try {
              const px = cx.getImageData(0, 0, sw, sh).data;
              let sum = 0;
              let n = 0;
              for (let i = 0; i < px.length; i += 28) { sum += (px[i] + px[i + 1] + px[i + 2]) / 3; n++; }
              const mean = sum / (n || 1);
              // 刷课页面基本都是白底;平均亮度太低说明截到的是别的窗口(深色界面),这种图不能发给模型
              if (mean < 110) { sendResponse({ ok: false, errstr: '截图不可信(平均亮度 ' + Math.round(mean) + ',可能截到别的窗口)' }); break; }
            } catch (e) {}
            const ob = await cv.convertToBlob({ type: 'image/png' });
            const buf = new Uint8Array(await ob.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            const out = 'data:image/png;base64,' + btoa(bin);
            try { fetch('http://127.0.0.1:3001/api/shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: out }) }); } catch (e) {}
            sendResponse({ ok: true, data: out });
          } catch (e) { sendResponse({ ok: false, errstr: String((e && e.message) || e) }); }
          break;
        }
        case 'FETCH_IMG': {
          // 内容脚本抓不到跨域图(CORS)时的兜底:扩展 fetch 有 host 权限,不受 CORS 限制
          try {
            const r = await fetch(msg.url, { credentials: 'include' });
            if (!r || !r.ok) { sendResponse({ ok: false, errstr: 'HTTP ' + (r ? r.status : 0) }); break; }
            const b = await r.blob();
            if (!b || b.size > 3e6) { sendResponse({ ok: false, errstr: '图太大或为空' }); break; }
            const buf = new Uint8Array(await b.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            sendResponse({ ok: true, data: 'data:' + (b.type || 'image/png') + ';base64,' + btoa(bin) });
          } catch (e) { sendResponse({ ok: false, errstr: String((e && e.message) || e) }); }
          break;
        }
        case 'CAPTURE_TAB': {
          // 侧边栏「截图搜题」:抓当前可见标签页(仅可视区域,不需要额外权限)
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) { sendResponse({ ok: false, errstr: '没有活动标签页' }); break; }
          // MV3 的 captureVisibleTab 需要 host 权限。没拿到就直接说清楚怎么补,别让他只看到"截图失败"
          let hasAll = false;
          try { hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch (e) { hasAll = false; }
          if (!hasAll) {
            sendResponse({ ok: false, errstr: '扩展还没拿到「在所有网站上读取数据」的权限。请到 edge://extensions 把「刷小课」关掉再打开(不是只点刷新),弹权限提示时点允许。', needPerm: true });
            break;
          }
          // 截图可能失败(权限/窗口不在前台/页面受保护),把真实原因带回去,别让用户只看到"截图失败"
          let dataUrl = '';
          let lastErr = '';
          try {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          } catch (e1) {
            lastErr = 'png:' + ((e1 && e1.message) || e1);
            try {
              // 退回 jpeg:体积小,某些情况下 png 编码会失败
              dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
            } catch (e2) {
              lastErr += ' / jpeg:' + ((e2 && e2.message) || e2);
              try {
                // 再退回不带窗口参数的写法
                dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
              } catch (e3) { lastErr += ' / plain:' + ((e3 && e3.message) || e3); }
            }
          }
          if (!dataUrl) { sendResponse({ ok: false, errstr: lastErr || 'captureVisibleTab 返回空' }); break; }
          sendResponse({ ok: true, dataUrl, tabId: tab.id, width: tab.width, height: tab.height, warn: lastErr });
          break;
        }

        case 'AUTO_SUBMIT_PAGE': {
          // 内容脚本确认“所有题都已作答”后发来。主世界执行:点最终提交 + 处理 confirm/弹窗。
          const tabId = sender && sender.tab && sender.tab.id;
          if (!tabId) { sendResponse({ ok: false, errstr: '没有标签页 id' }); break; }
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              world: 'MAIN',
              func: pageSubmit,
            });
            const arr = (results || []).map((r) => r && r.result).filter(Boolean);
            const hit = arr.find((x) => x && x.ok) || arr.find((x) => x && x.why === 'no-button') || null;
            sendResponse(hit ? Object.assign({ frames: arr.length }, hit) : { ok: false, why: 'no-frame-result' });
          } catch (e) {
            sendResponse({ ok: false, errstr: String((e && e.message) || e) });
          }
          break;
        }

        case 'SXK_JUMP_REQUEST': {
          // 子 frame 提交完,请顶层去点「下一节」(左侧目录只存在于顶层)。
          const tabId = sender && sender.tab && sender.tab.id;
          if (!tabId) { sendResponse({ ok: false, errstr: '没有标签页 id' }); break; }
          try {
            await chrome.tabs.sendMessage(tabId, { type: 'SXK_JUMP_NEXT', from: msg.tag || '' }, { frameId: 0 });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, errstr: String((e && e.message) || e) });
          }
          break;
        }

        case 'BRUSH_REPORT':
          await postJSON('/api/brush', { site: msg.site, task: msg.task, status: msg.status });
          sendResponse({ ok: true });
          break;

        case 'CX_LOG_DUMP':
          // 课程页的诊断日志:内容脚本不直连本地后端,由后台转发
          try {
            await postJSON('/api/cxlog', {
              host: msg.host || '',
              path: msg.path || '',
              text: String(msg.text || '').slice(0, 200000),
            });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, errstr: e.message });
          }
          break;

        case 'AUTO_ANSWER': {
          // 侧边栏 → background → 当前标签页的刷课脚本(content script 之间不能直接通信)
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) { sendResponse({ ok: false, errstr: '没有活动标签页' }); break; }
          try {
            // 注意:侧边栏脚本本身也在该页面注册了监听器,但它不处理 AUTO_ANSWER,
            // 会「静默返回 undefined」。所以拿不到对象回复就要按「没有刷课脚本」处理。
            const res = await chrome.tabs.sendMessage(tab.id, { type: 'AUTO_ANSWER' });
            if (res && typeof res === 'object') sendResponse(res);
            else sendResponse({ ok: false, errstr: '当前页面没有刷课脚本(非目标站点)' });
          } catch (e) {
            sendResponse({ ok: false, errstr: '当前页面没有刷课脚本(非目标站点)' });
          }
          break;
        }

        case 'OPEN_SIDEBAR':
          // 由 sidebar.js 自身监听 Ctrl+Shift+S,bg 只做扩展图标点击的兜底
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
          });
          sendResponse({ ok: true });
          break;

        case 'OPEN_UI':
          // 侧边栏「控制台」按钮 → 打开本地可视化控制台
          chrome.tabs.create({ url: `${SERVER}/ui` });
          sendResponse({ ok: true });
          break;

        default:
          // 把收到的实际内容回显出来,方便判断「到底是哪一版后台在跑」「type 是什么」
          sendResponse({
            ok: false,
            errstr: 'unknown type=' + String(msg && msg.type) +
              ' keys=' + Object.keys(msg || {}).join(',') +
              ' bgv=' + chrome.runtime.getManifest().version,
          });
      }
    } catch (e) {
      sendResponse({ ok: false, errstr: e.message });
    }
  })();
  return true; // 异步响应
});

// ---- AI 对话流式转发 ----
// 内容脚本建立 port(sxk-chat) → 后台 fetch 后端的 SSE → 逐块推回内容脚本。
// 这样页面上完全不出现对 127.0.0.1 的请求,不会触发「访问本设备上的应用和服务」授权弹窗。
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'sxk-chat') return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'ASK') return;
    const push = (m) => { if (!closed) { try { port.postMessage(m); } catch (e) {} } };
    try {
      const r = await fetch(`${SERVER}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg.prompt || '', images: Array.isArray(msg.images) ? msg.images.slice(0, 4) : [] }),
      });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!evMatch) continue;
          const ev = evMatch[1].trim();
          const raw = dataMatch ? dataMatch[1].trim() : '{}';
          if (ev === 'delta') {
            let text = '';
            try { text = JSON.parse(raw).text || ''; } catch (e) {}
            if (text) push({ type: 'delta', text });
          } else if (ev === 'error') {
            let errstr = '';
            try { errstr = JSON.parse(raw).message || ''; } catch (e) {}
            push({ type: 'error', errstr });
          }
        }
      }
      push({ type: 'done' });
    } catch (e) {
      push({ type: 'error', errstr: e.message });
      push({ type: 'done' });
    }
  });
});

// 扩展图标点击 → 打开本地控制台
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${SERVER}/ui` });
});

// 快捷键(Ctrl+Shift+S)→ 切换侧边栏
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
    });
  }
});

// 安装/更新时打开说明页
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${SERVER}/ui` });
  }
});
