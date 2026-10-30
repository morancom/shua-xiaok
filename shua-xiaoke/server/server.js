'use strict';
/**
 * 刷小课 · 本地后端
 * 零依赖 Node,单端口 3000。
 * - /ui  可视化控制台(状态、解题记录、设置、日志)
 * - /api 解题、AI对话(SSE)、刷课辅助、设置
 * - 全部走 127.0.0.1,不经过任何第三方服务器
 *
 * 接真实模型:设环境变量 UPSTREAM_URL / UPSTREAM_KEY / UPSTREAM_MODEL
 * 不设则返回演示答案,方便离线联调。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3001);
const HOST = '127.0.0.1';

// ---- 可配置的模型上游(可选)----
// 默认接 DeepSeek;可用环境变量 UPSTREAM_URL / UPSTREAM_KEY / UPSTREAM_MODEL 覆盖。
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://api.deepseek.com/v1/chat/completions';
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || '';
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || 'deepseek-chat';

// 把用户填的地址补全成 chat/completions 端点。
// 常见误填:只写 https://api.deepseek.com —— 裸域名 POST 会返回 404 空响应,
// 上层 r.json() 就抛 "Unexpected end of JSON input",最后静默退回演示答案。
function normalizeUpstreamUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

// ---- 内存状态(持久化到 data.json)----
const DATA_FILE = path.join(__dirname, 'data.json');
let healthLoggedAt = 0;
const state = {
  settings: {
    autoVideo: true,      // 自动播放/倍速
    playbackRate: 1,    // 播放倍速
    autoJump: true,       // 自动跳下一节
    autoAnswer: true,     // 自动做题
    autoSubmit: false,    // 自动交卷(默认关,避免误交)
    model: UPSTREAM_MODEL,
    upstreamUrl: UPSTREAM_URL,
    upstreamKey: UPSTREAM_KEY,
  },
  logs: [],               // 环形日志
  solves: [],             // 解题记录
  cxlogs: [],             // 课程页诊断日志(扩展上报,最多留 20 份)
  stats: { solveCount: 0, chatCount: 0, startedAt: Date.now() },
};
loadState();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (j.settings) Object.assign(state.settings, j.settings);
      if (Array.isArray(j.solves)) state.solves = j.solves.slice(-200);
      if (j.stats) Object.assign(state.stats, j.stats);
      // 诊断日志也持久化:后端重启不该把用户刚点出来的现场日志弄丢
      if (Array.isArray(j.cxlogs)) state.cxlogs = j.cxlogs.slice(0, 20);
    }
  } catch (e) { /* ignore */ }
}
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      settings: state.settings, solves: state.solves.slice(-200), stats: state.stats,
      cxlogs: (state.cxlogs || []).slice(0, 20),
    }, null, 2));
  } catch (e) { /* ignore */ }
}
function log(tag, msg) {
  const line = { t: Date.now(), tag, msg };
  state.logs.push(line);
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
  console.log(`[${tag}] ${msg}`);
}

// 启动/崩溃信息额外落一份到 server.log ——
// bat 用最小化窗口启动后端,窗口一闪而过时看不到报错,这张日志就是唯一的证据。
const SERVER_LOG = path.join(__dirname, 'server.log');
function appendServerLog(msg) {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`;
    if (fs.existsSync(SERVER_LOG) && fs.statSync(SERVER_LOG).size > 256 * 1024) {
      fs.writeFileSync(SERVER_LOG, line, 'utf8');
    } else {
      fs.appendFileSync(SERVER_LOG, line, 'utf8');
    }
  } catch (e) { /* ignore */ }
}

// ---- HTTP 工具 ----
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function text(res, code, s) {
  const b = Buffer.from(s, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function html(res, code, s) {
  const b = Buffer.from(s, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function parseJson(buf) { try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return {}; } }

// ---- 解题(核心)----
// 输入:{ question, options, type, context }
// ---- 答案格式约定(用户要求:选择题只给选项,填空题只给答案)----
const ANSWER_RULES = [
  '只输出一个 JSON 对象,不要 markdown 代码块、不要任何解释性文字。',
  'JSON 结构:{"answer":"...","analysis":"...","confidence":0.9}',
  'answer 的硬性约定:',
  '1) 选择题(含多选):只写选项字母,大写连写,如 "B" 或 "ACD";不要写选项内容、不要「答案:」前缀、不要括号句号。',
  '2) 判断题:选项是 A/B 时按选择题写字母;没有选项时只写「对」或「错」。',
  '3) 填空题:只写要填的内容,多个空按顺序用 | 分隔,如「光合作用|叶绿体」;不要题号、不要「答:」。',
  '4) 简答/论述/计算:只写可直接粘贴的答案正文,不要重复题目。',
  '5) 图片题:先读图里的文字与公式再作答,答案仍遵守上面的格式。',
  'analysis 不超过 30 字;confidence 取 0-1。',
].join('\n');

// 把模型给的答案收敛成约定格式:选择题只留字母,填空题去掉前缀和句读
function normalizeAnswerResult(res, question, options) {
  const out = Object.assign({ analysis: '', confidence: 0.6 }, res || {});
  let a = String(out.answer == null ? '' : out.answer).trim();
  a = a.replace(/^[\s"'“”‘’「」【】\[\]]+/, '')
    .replace(/^(?:正确|参考)?答案[::]?\s*/, '')
    .replace(/^(?:答|选)[::]?\s*/, '')
    .replace(/[\s"'“”‘’「」【】\[\]]+$/, '')
    .replace(/[。;]$/, '')
    .trim();
  const optList = (Array.isArray(options) ? options : []).filter((x) => x && String(x).trim());
  const letterOk = (L) => {
    const idx = L.charCodeAt(0) - 65;
    return idx >= 0 && idx < Math.max(optList.length, 1);
  };
  if (optList.length >= 2 && a) {
    // 1) 模型直接给了字母
    const pureLetters = !/[\u4e00-\u9fa5]/.test(a) && /^[A-Ha-h][A-Ha-h\s,，、/|]*$/.test(a);
    let picked = '';
    if (pureLetters) {
      picked = Array.from(new Set((a.toUpperCase().match(/[A-H]/g) || []))).sort().join('');
    } else {
      // 2) 模型给了选项内容 → 反查字母
      for (let i = 0; i < optList.length; i++) {
        const t = String(optList[i]).replace(/^[A-H][\.、,．::\s]*/i, '').trim();
        if (t && t.length >= 2 && a.indexOf(t) >= 0) picked += String.fromCharCode(65 + i);
      }
      if (!picked) {
        // 3) 兜底:去掉标点后的首个字母
        const m2 = a.toUpperCase().match(/[A-H]/g);
        if (m2 && !/[\u4e00-\u9fa5]{2,}/.test(a)) picked = Array.from(new Set(m2)).sort().join('');
      }
    }
    picked = picked.split('').filter(letterOk).join('');
    if (picked) a = picked;
  }
  out.answer = a;
  if (!out.answer) out.answer = '';
  return out;
}

// 输出:{ answer, analysis, confidence }
async function solveQuestion(input) {
  const { question = '', options = [], context = '', images = [] } = input;
  const rawImgs = (Array.isArray(images) ? images : [images])
    .filter((u) => typeof u === 'string' && (/^data:image\//.test(u) || /^https?:\/\//.test(u)))
    .slice(0, 6);
  // 超星把题干图/选项图放在 p.ananas.chaoxing.com 这类跨域 CDN 上,
  // 内容脚本里的 canvas 会被污染取不到,所以 URL 交给后端下载再转 base64。
  const imgs = [];
  for (const u of rawImgs) {
    if (/^data:image\//.test(u)) { imgs.push(u); continue; }
    try {
      const ir = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!ir.ok) { log('solve', '取图 HTTP ' + ir.status + ' ' + u.slice(0, 70)); continue; }
      const ct = String(ir.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\//.test(ct)) { log('solve', '取图非图片 ' + ct + ' ' + u.slice(0, 70)); continue; }
      const buf = Buffer.from(await ir.arrayBuffer());
      if (!buf.length || buf.length > 3 * 1024 * 1024) { log('solve', '取图过大/空 ' + buf.length); continue; }
      imgs.push('data:' + ct + ';base64,' + buf.toString('base64'));
    } catch (e) { log('solve', '取图失败 ' + u.slice(0, 70) + ' ' + e.message); }
  }
  const sys = '你是「刷小课」的做题机,严格执行下面的输出约定。\n' + ANSWER_RULES;
  const optTxt = options.length
    ? options.map((o, i) => String.fromCharCode(65 + i) + '. ' + String(o).replace(/^[A-H][\.、,．::\s]*/i, '')).join(' | ')
    : '(无选项)';
  const userText = `题目:${question || '(题干没抓到文字,请完全依据图片作答)'}\n选项:${optTxt}\n上下文:${context}`;
  const user = imgs.length
    ? [
        { type: 'text', text: userText + '\n(题干或选项里有图片,见附图。请先读出图里的文字再作答;选择题只回字母。)' },
        ...imgs.map((u) => ({ type: 'image_url', image_url: { url: u } })),
      ]
    : userText;

  const upUrl = normalizeUpstreamUrl(state.settings.upstreamUrl);
  if (upUrl && state.settings.upstreamKey) {
    try {
      const r = await fetch(upUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.upstreamKey}` },
        body: JSON.stringify({
          model: state.settings.model || UPSTREAM_MODEL,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.2,
          max_tokens: 1500,
        }),
      });
      const bodyText = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${bodyText.slice(0, 200).replace(/\s+/g, ' ')}`);
      let j;
      try { j = JSON.parse(bodyText); } catch { throw new Error('响应不是 JSON:' + bodyText.slice(0, 200)); }
      const _msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
      const raw = String(_msg.content || '').trim() || String(_msg.reasoning_content || '').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { return normalizeAnswerResult(JSON.parse(m[0]), question, options); } catch { /* fallthrough */ }
      }
      return normalizeAnswerResult({ answer: raw.trim(), analysis: '', confidence: 0.7 }, question, options);
    } catch (e) {
      log('solve', `上游调用失败(${upUrl}):${e.message}`);
      return {
        answer: demoAnswer(question, options).answer,
        analysis: `上游模型调用失败:${e.message}。已退回演示答案。`,
        confidence: 0.1,
        upstreamError: e.message,
      };
    }
  }
  // 演示答案(离线)
  return demoAnswer(question, options);
}

function demoAnswer(question, options) {
  const pick = options.length ? options[0] : 'A';
  return {
    answer: pick,
    analysis: `演示模式:${question.slice(0, 20)}… → 选 ${pick}(配置上游模型可得真实答案)`,
    confidence: 0.3,
  };
}

// ---- AI 对话(SSE)----
async function* demoChatStream(prompt) {
  const reply = `这是本地演示回复。你问:${prompt.slice(0, 40)}。\n配置上游模型(UPSTREAM_URL/UPSTREAM_KEY)可获得真实 AI 回答。`;
  const words = reply.split('');
  for (let i = 0; i < words.length; i += 2) {
    yield words.slice(i, i + 2).join('');
    await sleep(12);
  }
}
const CHAT_RULES = [
  '你是「刷小课」的做题机。',
  '如果用户发来的是一道题(或题目截图),只给答案本身,不要解释、不要复述题目:',
  '- 选择题只回选项字母,如 B 或 ACD;判断题回 对/错;',
  '- 填空题只回要填的内容,多个空用 | 分隔;',
  '- 简答题只回可粘贴的答案正文。',
  '如果不是题目,就像普通助手一样简短回答。',
].join('\n');

async function* upstreamChatStream(prompt, images) {
  const upUrl = normalizeUpstreamUrl(state.settings.upstreamUrl);
  const imgs = (Array.isArray(images) ? images : [])
    .filter((u) => typeof u === 'string' && /^data:image\//.test(u)).slice(0, 6);
  const content = imgs.length
    ? [{ type: 'text', text: prompt || '按约定只给答案。' }, ...imgs.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
    : (prompt || '');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.upstreamKey}` },
    body: JSON.stringify({
      model: state.settings.model || UPSTREAM_MODEL,
      messages: [{ role: 'system', content: CHAT_RULES }, { role: 'user', content }],
      stream: true,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content || '';
        if (delta) yield delta;
      } catch { /* skip */ }
    }
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 路由 ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  // CORS(扩展页面需要)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // === API ===
    if (p === '/api/health') {
      // 侧边栏每次打开都会经后台请求一次健康检查。这里打一条日志(2 秒去重),
      // 用来判断「扩展侧边栏是否真的连上了后端」。
      const now = Date.now();
      if (now - healthLoggedAt > 2000) {
        healthLoggedAt = now;
        log('health', '侧边栏已连接后端');
      }
      return json(res, 200, {
        ok: true,
        name: '刷小课',
        version: '1.8.17',
        upstream: !!(state.settings.upstreamUrl && state.settings.upstreamKey),
        upstreamUrl: normalizeUpstreamUrl(state.settings.upstreamUrl),
        model: state.settings.model || UPSTREAM_MODEL,
      });
    }

    if (p === '/api/state') return json(res, 200, { settings: state.settings, stats: state.stats, logs: state.logs.slice(-100), solves: state.solves.slice(-50), cxlogs: (state.cxlogs || []).slice(0, 5).map((x) => ({ t: x.t, host: x.host, path: x.path, lines: String(x.text).split('\n').length })) });

    if (p === '/api/cxlog' && req.method === 'GET') {
      return json(res, 200, { ok: true, items: (state.cxlogs || []).slice(0, 20) });
    }

    if (p === '/api/cxlog' && req.method === 'POST') {
      // 课程页诊断日志(扩展后台转发过来),只留最近 20 份
      const body = parseJson(await readBody(req));
      const item = {
        t: Date.now(),
        host: String(body.host || '').slice(0, 80),
        path: String(body.path || '').slice(0, 120),
        text: String(body.text || '').slice(0, 200000),
      };
      state.cxlogs = state.cxlogs || [];
      state.cxlogs.unshift(item);
      if (state.cxlogs.length > 20) state.cxlogs.length = 20;
      saveState();
      const lines = item.text.split('\n').length;
      log('cxlog', `收到诊断日志 ${item.host}${item.path} (${lines} 行)`);
      return json(res, 200, { ok: true, count: lines });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      Object.assign(state.settings, body);
      saveState();
      log('settings', `更新:${Object.keys(body).join(',')}`);
      return json(res, 200, { ok: true, settings: state.settings });
    }

    if (p === '/api/solve' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      const result = await solveQuestion(body);
      state.stats.solveCount++;
      const rec = { t: Date.now(), q: (body.question || '').slice(0, 120), a: result.answer, confidence: result.confidence };
      state.solves.unshift(rec);
      if (state.solves.length > 200) state.solves.length = 200;
      saveState();
      log('solve', `解题 ${rec.q} → ${rec.a}`);
      return json(res, 200, { errNo: 0, data: result });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      const prompt = body.prompt || body.question || '';
      state.stats.chatCount++;
      saveState();
      log('chat', `对话 ${prompt.slice(0, 40)}`);
      // SSE
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      try {
        const stream = (state.settings.upstreamUrl && state.settings.upstreamKey) ? upstreamChatStream(prompt, body.images) : demoChatStream(prompt);
        for await (const chunk of stream) {
          res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
        }
        res.write(`event: done\ndata: {}\n\n`);
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      }
      res.end();
      return;
    }

    if (p === '/api/brush' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      log('brush', `站点 ${body.site || '?'} 任务 ${body.task || '?'} 状态 ${body.status || '?'}`);
      return json(res, 200, { errNo: 0 });
    }

    if (p === '/api/logs/clear') { state.logs = []; return json(res, 200, { ok: true }); }

    // === 可视化控制台(从磁盘读取独立 UI 文件)===
    const serveFile = (file, ctype) => {
      const fp = path.join(__dirname, file);
      if (!fs.existsSync(fp)) return text(res, 404, `missing ${file}`);
      return html(res, 200, fs.readFileSync(fp, 'utf8'));
    };
    if (p === '/' || p === '/ui' || p === '/index.html') {
      // 控制台页面禁止缓存:否则改了界面后浏览器还拿旧 HTML,会出现
      // 「统计数字更新了、卡片却卡在加载中」这种看不懂的现象。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (p === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'app.js')));
    }
    if (p === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'style.css')));
    }

    // === 自检页:模拟超星题型 DOM,验证「识别题目 → 解题 → 写回页面」===
    // === 选项是图片的作业页(验证视觉搜题链路) ===
    if (p.indexOf('/mock/img/') === 0) {
      const name = p.slice('/mock/img/'.length).replace(/[^a-z0-9_.]/gi, '');
      const fp = require('path').join(__dirname, 'mock-img', name);
      try {
        const buf = require('fs').readFileSync(fp);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('no img');
      }
    }

﻿    if (p === '/api/shot' && req.method === 'POST') {
      // 保存扩展截下来的「一道题」,用来核对 AI 实际看到的内容
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const m = /^data:image\/png;base64,(.+)$/.exec(String(j.data || ''));
          if (!m) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false}'); }
          const dir = path.join(__dirname, 'shots');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const files = fs.readdirSync(dir).filter((f) => /\.png$/.test(f)).sort();
          while (files.length > 9) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) {} }
          const name = 'shot-' + Date.now() + '.png';
          fs.writeFileSync(path.join(dir, name), Buffer.from(m[1], 'base64'));
          log('shot', '已保存题目截图 ' + name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: name }));
        } catch (e) { res.writeHead(500); res.end('{"ok":false}'); }
      });
      return;
    }

    if (p === '/mock/workimg') {
      // 刻意复刻超星作业页的真实结构:整页 wrapper #fanyaMarking 也带 .TiMu,
      // 里面才是 20 个 .TiMu 题目(以前就是被 wrapper 骗成「整页 1 道题」)。
      const qs = [
        { n: 1, stem: '1. (单选题) 下列函数中,是二次函数的是:', ans: 'B', imgOpts: true },
        { n: 2, stem: '2. (单选题) 一元二次方程 ax^2+bx+c=0 的判别式是:', ans: 'A', opts: ['b^2-4ac', 'b^2+4ac', '2a', 'a+b+c'] },
        { n: 3, stem: '3. (单选题) 题干是图片,请读图作答:', ans: 'B', stemImg: true, opts: ['y = x + 1', 'y = x^2 + 1', 'y = 1/x'] },
        { n: 4, stem: '4. (单选题) 1 + 1 = ?', ans: 'B', opts: ['1', '2', '3'] },
        { n: 5, stem: '5. (单选题) 水的化学式是:', ans: 'A', opts: ['H2O', 'CO2', 'O2'] },
        { n: 6, stem: '6. (单选题) 下面哪个是偶数?', ans: 'C', opts: ['3', '5', '8'] },
      ];
      const imgA = '<img src="/mock/img/lin.png" alt="A">';
      const imgB = '<img src="/mock/img/quad.png" alt="B">';
      const imgC = '<img src="/mock/img/recip.png" alt="C">';
      const body = qs.map((q) => {
        const stem = q.stemImg ? '<img src="/mock/img/stemq.png" alt="题干">' : q.stem;
        let lis = '';
        if (q.imgOpts) {
          lis = '<li class="optionItem" data-letter="A"><i class="num_option">A.</i>' + imgA + '</li>' +
            '<li class="optionItem" data-letter="B"><i class="num_option">B.</i>' + imgB + '</li>' +
            '<li class="optionItem" data-letter="C"><i class="num_option">C.</i>' + imgC + '</li>';
        } else {
          lis = q.opts.map((t, i) => {
            const L = String.fromCharCode(65 + i);
            return '<li class="optionItem" data-letter="' + L + '"><input type="radio" name="q' + q.n + '"> <i class="num_option">' + L + '.</i> ' + t + '</li>';
          }).join('');
        }
        return '<div class="TiMu" data-q="' + q.n + '" data-ans="' + q.ans + '">' +
          '<div class="Zy_TItle"><div class="clearfix">' + stem + '</div></div>' +
          '<ul class="Zy_ulBottom">' + lis + '</ul>' +
          '<div class="res"></div></div>';
      }).join('');
      const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>刷小课 · 作业页自检(6 题)</title>' +
        '<style>body{font:15px/1.7 system-ui,"Microsoft YaHei";background:#f5f6fa;margin:0;padding:28px;color:#222}' +
        '.wrap{max-width:820px;margin:0 auto}.TiMu{background:#fff;border-radius:14px;padding:18px 22px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:16px}' +
        '#fanyaMarking{border:1px dashed #ccd;background:#fafbff}' +
        '.Zy_TItle{font-weight:600;display:block;margin-bottom:12px}.Zy_TItle img{max-width:320px}' +
        '.Zy_ulBottom{list-style:none;margin:0;padding:0}' +
        '.optionItem{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #e6e8ef;border-radius:10px;margin-bottom:8px;cursor:pointer}' +
        '.optionItem.on{border-color:#6c8cff;background:#eef2ff}.optionItem img{max-height:52px}' +
        '.num_option{font-style:normal;color:#666;margin-right:4px}' +
        '.res{margin-top:8px;font-size:13px;color:#166534}</style></head><body><div class="wrap">' +
        '<div class="fanyaMarking TiMu" id="fanyaMarking">' +
        '<div class="mark_title">2.1-2.2作业(自检)</div>' + body + '</div></div>' +
        '<script>document.querySelectorAll(".optionItem").forEach(function(li){li.addEventListener("click",function(){' +
        'var box=li.closest(".TiMu");box.querySelectorAll(".optionItem").forEach(function(x){x.classList.remove("on")});' +
        'li.classList.add("on");box.dataset.sel=li.dataset.letter||"";' +
        'var r=li.querySelector("input[type=radio]");if(r)r.checked=true;' +
        'var res=box.querySelector(".res");if(res)res.textContent="已选:"+box.dataset.sel})});</script></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page);
    }

    if (p === '/mock/chaoxing') {
      const mock = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>刷小课 · 自检页</title>
<style>
  body{font:15px/1.7 system-ui,"Microsoft YaHei";background:#f5f6fa;margin:0;padding:28px;color:#222}
  .wrap{max-width:760px;margin:0 auto}
  .hd{background:#fff;border-radius:14px;padding:18px 22px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:18px}
  .hd h1{margin:0 0 6px;font-size:19px}
  .hd p{margin:0;color:#666;font-size:13px}
  .TiMu{background:#fff;border-radius:14px;padding:18px 22px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:16px}
  .questionTxt{font-weight:600;display:block;margin-bottom:12px}
  .Zy_ulBottom{list-style:none;margin:0;padding:0}
  .optionItem{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #e6e8ef;border-radius:10px;margin-bottom:8px;cursor:pointer;transition:.15s}
  .optionItem:hover{border-color:#6c8cff;background:#f7f9ff}
  .optionItem.on{border-color:#6c8cff;background:#eef2ff}
  .fillInput{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e6e8ef;border-radius:10px;font-size:14px}
  .fillInput:focus{outline:none;border-color:#6c8cff}
  .res{margin-top:8px;font-size:13px;color:#166534}
</style></head><body><div class="wrap">
  <div class="hd"><h1>刷小课 · 自检页</h1>
  <p>本页模拟超星题型结构。按 Ctrl+Shift+S 打开侧边栏,点「自动做题」,观察选项是否被自动选中、填空是否被填入。</p></div>

  <div class="TiMu">
    <span class="questionTxt">1. 下列关于细胞的说法正确的是</span>
    <ul class="Zy_ulBottom">
      <li class="optionItem" data-letter="A"><input type="radio" name="q1"> A. 细胞是生物体结构和功能的基本单位</li>
      <li class="optionItem" data-letter="B"><input type="radio" name="q1"> B. 所有生物都由细胞构成</li>
      <li class="optionItem" data-letter="C"><input type="radio" name="q1"> C. 细胞不能分裂</li>
      <li class="optionItem" data-letter="D"><input type="radio" name="q1"> D. 细胞没有细胞膜</li>
    </ul>
    <div class="res" id="r1"></div>
  </div>

  <div class="TiMu">
    <span class="questionTxt">2. 细胞是生物体____和功能的基本单位</span>
    <input type="text" class="fillInput" placeholder="填写答案">
    <div class="res" id="r2"></div>
  </div>
  <div style="margin:18px 0"><button id="submitWork" style="padding:10px 28px;border:0;border-radius:10px;background:#2655fe;color:#fff;font-size:15px">提交</button></div>
</div>
<script>
  document.getElementById('submitWork').addEventListener('click', function () {
    if (window.confirm('确定提交这份作业吗？')) {
      document.body.dataset.submitted = '1';
      window.__submitted = 1;
    } else {
      document.body.dataset.submitted = 'cancelled';
    }
  });
</script>
<script>
  document.querySelectorAll('.optionItem').forEach(function (li) {
    li.addEventListener('click', function () {
      li.parentNode.querySelectorAll('.optionItem').forEach(function (x) { x.classList.remove('on'); });
      li.classList.add('on');
      var r = li.querySelector('input[type=radio]'); if (r) r.checked = true;
      var box = li.closest('.TiMu').querySelector('.res');
      if (box) box.textContent = '已选:' + (li.dataset.letter || '');
    });
  });
  var fi = document.querySelector('.fillInput');
  if (fi) fi.addEventListener('input', function (e) {
    document.getElementById('r2').textContent = '已填:' + e.target.value;
  });
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(mock);
    }

    // === 课程自检页:还原超星「视频在两层 iframe 里」的真实结构 ===
    // 顶层 → #iframe(学习页) → iframe[src*="/ananas/modules/video/"](播放器)
    if (p === '/mock/course') {
      const sp = new URL(req.url, 'http://127.0.0.1').searchParams;
      const ch = sp.get('chapter') || '1';
      const vn = Math.max(1, Math.min(6, Number(sp.get('n')) || 1));
      if (ch === '2') {
        // 第二节:全部任务点已完成,「下一节」隐藏 —— 让扩展自然停下
        const done = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>刷小课 · 课程页自检(第二节)</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei";background:#eef1f6;margin:0;color:#222}
.bar{background:#fff;padding:12px 18px;box-shadow:0 2px 10px rgba(0,0,0,.06);display:flex;gap:10px;align-items:center}
.bar a{padding:6px 12px;border-radius:8px;background:#2655fe;color:#fff;text-decoration:none;font-size:13px}
.msg{max-width:900px;margin:16px auto;font-size:13px;color:#2f6b46}</style></head><body>
<div class="bar"><b>金融市场学 · 第二节</b><a href="#" id="prevNextFocusNext" style="display:none">下一节</a></div>
<div class="msg" id="ok">本节全部任务点已完成(第一节的自检通过后应该自动跳到这里)</div>
<script>window.__ev=['chapter2'];window.__chapter=2;</script>
</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(done);
      }
      const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>刷小课 · 课程页自检</title>
<style>
  body{font:15px/1.7 system-ui,"Microsoft YaHei";background:#eef1f6;margin:0;color:#222}
  .bar{background:#fff;padding:12px 18px;box-shadow:0 2px 10px rgba(0,0,0,.06);display:flex;gap:10px;align-items:center}
  .bar b{font-size:15px}
  .bar a{padding:6px 12px;border-radius:8px;background:#2655fe;color:#fff;text-decoration:none;font-size:13px}
  #prevNextFocusNext[style*="none"]{pointer-events:none}
  .msg{max-width:900px;margin:14px auto;font-size:13px;color:#666}
  iframe#iframe{display:block;width:100%;height:520px;border:0;background:#dfe4ee}
  .jobFinishTip{position:fixed;left:50%;top:38%;transform:translateX(-50%);background:#fff;border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.25);padding:20px 26px;font-size:14px;z-index:9}
  .popBottom{position:fixed;left:50%;top:60%;transform:translateX(-50%);z-index:9;display:none}
  .popBottom a{padding:8px 14px;border-radius:8px;background:#2655fe;color:#fff;text-decoration:none;font-size:13px}
  #log{max-width:900px;margin:14px auto;font:12px/1.6 Consolas,monospace;color:#334;white-space:pre-wrap}
</style></head><body>
<div class="bar"><b>金融市场学 · 章节自检</b>
  <span id="prevNextFocus">当前节点</span>
  <a href="#" id="prevNextFocusNext">下一节</a>
</div>
<div class="msg">本页还原超星「视频藏在两层 iframe 里」的结构。扩展应当:自动播放并改倍速、自动处理视频弹题、出现「章节未完成」提示时自动点继续。</div>
  <iframe id="iframe" src="/mock/study?${(vn > 1 ? 'n=' + vn + '&' : '') + (sp.get('doc') ? 'doc=' + sp.get('doc') : '')}"></iframe>
<div id="log"></div>
<div class="jobFinishTip" style="display:none">本章节任务点未完成,是否继续?</div>
<div class="popBottom"><a href="#" class="nextChapter">继续学习</a></div>
<script>
  var ev = window.__ev = [];
  function rec(s){ ev.push(s); document.getElementById('log').textContent = ev.join('\\n'); }
  document.getElementById('prevNextFocusNext').addEventListener('click', function(e){
    e.preventDefault(); rec('clicked:prevNextFocusNext');
    // 真实超星点「下一节」会换地址,这里也换成第二节,方便验证扩展的跳转逻辑
    setTimeout(function(){ location.href = '/mock/course?chapter=2'; }, 600);
  });
  document.querySelector('.popBottom .nextChapter').addEventListener('click', function(e){
    e.preventDefault(); rec('clicked:nextChapter');
    document.querySelector('.jobFinishTip').style.display = 'none';
    document.querySelector('.popBottom').style.display = 'none';
  });
  // 3 秒后仿真「章节未完成」提示弹出来
  setTimeout(function(){
    document.querySelector('.jobFinishTip').style.display = 'block';
    document.querySelector('.popBottom').style.display = 'block';
    rec('tip:shown');
  }, 3000);
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page);
    }

    // 学习页:里面再套两层任务 iframe(和超星一样),这里放两个视频任务点
    if (p === '/mock/study') {
      const qn = Number(new URL(req.url, 'http://x').searchParams.get('n')) || 2;
      // doc=1 的文档自检页不要视频任务点,免得视频抢戏
      const docv = String(new URL(req.url, 'http://x').searchParams.get('doc') || '');
      const preHung = /(^|,|^1)pre/.test(docv);
      const tn = /^1/.test(docv) ? 0 : Math.max(1, Math.min(6, qn));
      let jobs = '';
      for (let i = 1; i <= tn; i++) {
        jobs += '<div class="ans-job" id="job' + i + '">' +
          '<div class="ans-job-hd"><span class="ans-job-icon"></span>视频任务点 ' + i + '</div>' +
          '<iframe allow="autoplay" src="/ananas/modules/video/index.html?task=' + i + '&d=' + (2 + i) + '"></iframe>' +
          '</div>';
      }
      // doc=1:再挂一个「文档型」任务点(和超星一样是 iframe,但要靠滚到底才算完成)
      const spd = new URL(req.url, 'http://x').searchParams;
      if (spd.get('doc')) {
        jobs += '<div class="ans-job' + (/(^|,|^1)pre/.test(docv) ? ' ans-job-finished' : '') + '" id="jobdoc">' +
          '<div class="ans-job-hd"><span class="ans-job-icon"></span>文档任务点</div>' +
          '<iframe src="/ananas/modules/document/index.html?task=doc"></iframe>' +
          '</div>';
      }
      const study = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body{margin:0;font:13px/1.6 system-ui,"Microsoft YaHei";background:#fff;padding:14px}
  .ans-job{border:1px solid #e3e7f0;border-radius:12px;overflow:hidden;margin-bottom:12px}
  .ans-job-hd{padding:8px 12px;background:#f7f9ff;font-size:12px;color:#556;display:flex;gap:8px;align-items:center}
  .ans-job-icon{width:10px;height:10px;border-radius:50%;background:#c9d2e6}
  iframe{display:block;width:100%;height:120px;border:0}
</style></head><body>
${jobs}
<script>
  // 文档任务点滚到底后由文档页 postMessage 过来(模拟超星的完成标记)
  window.addEventListener('message', function(e){
    if (String(e.data || '') !== 'doc-finished') return;
    var jd = document.getElementById('jobdoc');
    if (!jd) return;
    jd.classList.add('ans-job-finished');
    var icd = jd.querySelector('.ans-job-icon'); if (icd) icd.style.background = '#2fbf71';
  });
  // 播完后给对应任务点打「已完成」标记(模拟超星)
  window.addEventListener('message', function(e){
    var m = String(e.data || '').match(/^video-ended:(\\d+)$/);
    if (!m) return;
    var job = document.getElementById('job' + m[1]);
    if (!job) return;
    job.classList.add('ans-job-finished');
    var ic = job.querySelector('.ans-job-icon'); if (ic) ic.style.background = '#2fbf71';
  });
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(study);
    }

    // 生成一段真能播放的静音 WAV(自检页拿它当"视频",这样 play()/ended 都是真实行为)
    if (p === '/mock/tone.wav') {
      const secs = Math.max(1, Math.min(10, Number(new URL(req.url, 'http://x').searchParams.get('d')) || 2));
      const rate = 8000, ch = 1, bits = 16;
      const dataLen = rate * ch * (bits / 8) * secs;
      const buf = Buffer.alloc(44 + dataLen);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
      buf.writeUInt32LE(rate * ch * (bits / 8), 28); buf.writeUInt16LE(ch * (bits / 8), 32);
      buf.writeUInt16LE(bits, 34); buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      return res.end(buf);
    }

    // 文档阅读页:一个很高的可滚动文档,滚到底才向上层报「读完了」
    if (p === '/mock/doc' || p === '/ananas/modules/document/index.html') {
      const docPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body{margin:0;font:13px/1.8 system-ui,"Microsoft YaHei";background:#f4f6fa;color:#223}
  #docBox{height:260px;overflow-y:auto;background:#fff;border:1px solid #e3e7f0}
  .pg{padding:14px 18px;font-size:13px}
  .pg h4{margin:0 0 6px}
</style></head><body>
<div id="docBox">
  <div style="height:4400px">
    <div class="pg"><h4>第一章 金融市场概述</h4>这是一段很长的文档内容,超星要求把滚动条拉到最底才算读完。</div>
    <div class="pg" style="margin-top:3800px"><h4>—— 文档结尾 ——</h4>看到这里说明已经滚到最底部。</div>
  </div>
</div>
<script>
  var box = document.getElementById('docBox');
  var sent = false;
  function upd() {
    var max = box.scrollHeight - box.clientHeight;
    window.__doc = { top: Math.round(box.scrollTop), max: Math.round(max), done: sent };
    if (sent) return;
    if (box.scrollTop >= max - 8) {
      sent = true;
      window.__doc.done = true;
      try { parent.postMessage('doc-finished', '*'); } catch (e) {}
    }
  }
  box.addEventListener('scroll', upd);
  window.addEventListener('wheel', upd, true);
  setTimeout(upd, 200);
<\/script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(docPage);
    }

    // 播放器页:真正的播放元素在这里(路径特意做成超星的 /ananas/modules/video)
    if (p === '/mock/player' || p === '/ananas/modules/video/index.html') {
      const player = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body{margin:0;background:#0d1220;color:#cfd8ea;font:12px/1.6 system-ui}
  .box{padding:10px 14px}
  audio,video{width:100%;height:52px;background:#000;display:block}
  .x-container-default{margin-top:8px}
  .ans-videoquiz{border:1px solid #2b3a5c;border-radius:10px;padding:10px;display:none}
  .tkTopic{font-weight:600;margin-bottom:6px}
  .ans-videoquiz-opt{padding:4px 0;cursor:pointer}
  #videoquiz-submit{margin-top:6px;padding:5px 12px;border:0;border-radius:6px;background:#2655fe;color:#fff}
</style></head><body>
<div class="box">
  <audio id="vjs_container_html5_api" src="/mock/tone.wav?d=3" muted playsinline preload="auto"></audio>
  <div class="x-container-default">
    <div class="ans-videoquiz">
      <div class="tkTopic_title">单选题</div>
      <div class="tkTopic">视频弹题:1+1 等于几?</div>
      <div class="ans-videoquiz-opt"><input type="radio" name="ans-videoquiz-opt"> A. 1</div>
      <div class="ans-videoquiz-opt"><input type="radio" name="ans-videoquiz-opt"> B. 2</div>
      <div class="ans-videoquiz-opt"><input type="radio" name="ans-videoquiz-opt"> C. 3</div>
      <button id="videoquiz-submit">提交</button>
    </div>
  </div>
  <div id="state"></div>
</div>
<script>
  var qs = new URLSearchParams(location.search);
  var taskNo = qs.get('task') || '1';
  var v = document.getElementById('vjs_container_html5_api');
  var st = document.getElementById('state');

  // 真实媒体元素,muted 保证无用户手势也能自动播放;
  // 所有状态都读原生属性,扩展(隔离世界)与页面看到的是同一份真实状态。
  window.__player = v;
  window.__playerEv = [];
  window.__taskNo = taskNo;
  window.__playCount = 0;
  window.__endedCount = 0;
  window.__quizAnswer = null;

  function rep(s) {
    try {
      fetch('/api/brush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'mock', task: 'player' + taskNo, status: s }) });
    } catch (e) {}
  }
  function note(ev) {
    window.__playerEv.push(ev + '@' + v.playbackRate.toFixed(2));
    st.textContent = window.__playerEv.slice(-4).join(' | ');
  }
  rep('loaded d=' + (v.duration || '?') + ' t=' + Date.now());

  v.addEventListener('play', function () { window.__playCount++; note('play'); rep('play #' + window.__playCount); });
  v.addEventListener('pause', function () { note('pause'); });
  v.addEventListener('ratechange', function () { note('rate'); });
  v.addEventListener('ended', function () {
    window.__endedCount++;
    note('ended');
    rep('ended');
    try { window.parent.postMessage('video-ended:' + taskNo, '*'); } catch (e) {}
  });
  v.addEventListener('error', function () { rep('error code=' + (v.error && v.error.code)); });

  // 2 秒后弹视频弹题(模拟超星)
  setTimeout(function () {
    var q = document.querySelector('.ans-videoquiz');
    if (q) { q.style.display = 'block'; window.__quizShown = true; }
  }, 2000);

  document.getElementById('videoquiz-submit').addEventListener('click', function () {
    var picked = null;
    document.querySelectorAll('.ans-videoquiz-opt input').forEach(function (i) {
      if (i.checked) picked = i.parentNode.textContent.trim().charAt(0);
    });
    window.__quizAnswer = picked;
    document.querySelector('.ans-videoquiz').style.display = 'none';
  });
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(player);
    }

    text(res, 404, 'Not Found');
  } catch (e) {
    log('error', e.message);
    json(res, 500, { errNo: -1, errstr: e.message });
  }
});

server.on('error', (e) => {
  // 端口被占用时最常见:另一个 node 还在跑,或者别的程序占了 3001。
  // 这里必须自己处理,否则 Node 会直接抛异常退出 —— 用 bat 启动时窗口一闪就没了。
  const msg =
    e && e.code === 'EADDRINUSE'
      ? `端口 ${PORT} 已被占用(可能已有一个后端在运行)。可以直接用 http://${HOST}:${PORT}/ui`
      : `后端启动失败:${(e && e.message) || e}`;
  console.error('  [错误] ' + msg);
  appendServerLog('[错误] ' + msg);
  process.exit(1);
});

process.on('uncaughtException', (e) => {
  const msg = '未捕获异常:' + ((e && e.stack) || e);
  console.error(msg);
  appendServerLog(msg);
});
process.on('unhandledRejection', (e) => {
  appendServerLog('未处理的 Promise 拒绝:' + ((e && (e.stack || e.message)) || e));
});

server.listen(PORT, HOST, () => {
  console.log(`刷小课后端已启动:http://${HOST}:${PORT}`);
  console.log(`可视化控制台:http://${HOST}:${PORT}/ui`);
  console.log(`上游模型:${state.settings.upstreamUrl ? state.settings.upstreamUrl : '未配置(演示模式)'}`);
  appendServerLog(`启动成功 pid=${process.pid} port=${PORT} node=${process.version}`);
});

// ---- 兼容端口 ----
// 早期文档/收藏夹里写的是 :3000,这里顺带也监听一份,免得用户点旧链接打不开。
const ALIAS_PORTS = [3000, 3002].filter((p) => p !== PORT);
for (const p of ALIAS_PORTS) {
  try {
    const aliasServer = http.createServer(server.listeners('request')[0]);
    aliasServer.on('error', () => {});
    aliasServer.listen(p, HOST, () => {
      console.log(`兼容端口已开启:http://${HOST}:${p}/ui`);
    });
  } catch (e) {}
}
