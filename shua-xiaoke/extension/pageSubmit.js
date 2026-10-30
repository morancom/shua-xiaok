'use strict';
/**
 * 刷小课 · 页面内「提交」执行器（页面主世界）
 *
 * 为什么单独一个文件：
 *   - sw2.js 用 importScripts('pageSubmit.js') 引入，AUTO_SUBMIT_PAGE 里仍然是
 *     chrome.scripting.executeScript({ func: pageSubmit, allFrames: true, world: 'MAIN' })；
 *   - mock 页可以直接 <script src="/extension/pageSubmit.js"> 引入，用真浏览器回归测试。
 *
 * 真机 2026-10-25 抓到的作业页结构（mooc1 studentstudy 的 #iframe 内）：
 *   <a class="btnSubmit workBtnIndex" href="javascript:void(0);" role="button"
 *      onclick="btnBlueSubmit();"><span title="提交">提交</span></a>
 *   <div class="mask" style="display:none"></div>
 *   <div class="Alertcon2" id="confirmWin" style="width:338px;height:139px;display:none"
 *        role="alertdialog" aria-label="确认提交"> ... 确定 / 取消 ... </div>
 * 旧实现只认 .maskDiv/.layui-layer/.dialog/[class*=dialog] 这些弹窗类名，
 * #confirmWin(.Alertcon2) 一个都不匹配，于是点了提交就停住 —— 这里补齐。
 *
 * 注意：本函数会被 executeScript 序列化，函数体内不能引用任何外部变量。
 */
async function pageSubmit() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
  const txt = (el) => norm(el && (el.value || el.innerText || el.textContent || el.getAttribute('title') || ''));
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 4 || r.height <= 4) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0.05) return false;
      if (!el.getClientRects().length) return false;
      return true;
    } catch (e) { return false; }
  };

  const CLICKABLE = 'button,a,input[type=button],input[type=submit],[role=button],span[onclick],div[onclick]';
  // 题目内部的「答题选项」不能当成提交按钮
  const IN_QUESTION = '.TiMu,.questionLi,.Zy_ulTop,.stem_answer,.questionItem,.answerBg,.examPaper_question,.subject,.questionWrap';
  const SUBMIT_TEXT = /^(提交|提交作业|交卷|提交答案|确定提交|提交试卷|保存并提交)$/;
  const NEVER = /(暂存|暂时保存|保存草稿|取消|返回|上一题|下一题|上一节|下一节|查看|解析|重做|再想想|关闭|退出)/;
  const YES_TEXT = /^(确定|确认|确认提交|确定提交|是|继续|提交|提交作业|好的|OK)$/i;
  const NO_TEXT = /(取消|关闭|返回|暂不|再想想|重做)/;

  const report = {
    ok: false, href: String(location.href).slice(0, 160), title: String(document.title || '').slice(0, 60),
    frames: 1, picked: '', by: '', click: false, dialog: '', yes: '', waited: 0, why: '',
  };

  // ---- 1) 先按平台已知的类名找（最快最准），找不到再按文字兜底 ----
  const hardCands = [];
  const hardSel = 'a.btnSubmit,button.btnSubmit,.btnSubmit.workBtnIndex,.workBtnIndex,#submitBtn,#btnSubmit,#submitWork,input[type=submit][value*="提交"]';
  try {
    for (const el of document.querySelectorAll(hardSel)) {
      if (!visible(el)) continue;
      const t = txt(el);
      if (NEVER.test(t)) continue;
      hardCands.push({ el, text: t || '(无字)', how: 'selector', cls: String(el.className || '').slice(0, 40) });
    }
  } catch (e) {}

  let cands = hardCands;
  if (!cands.length) {
    try {
      cands = [...document.querySelectorAll(CLICKABLE)]
        .filter((el) => {
          if (!visible(el)) return false;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
          if (el.closest && el.closest(IN_QUESTION)) return false;
          const t = txt(el);
          if (!SUBMIT_TEXT.test(t) || NEVER.test(t)) return false;
          // 只认叶子级按钮，父容器文字里带「提交」不算
          const childHas = [...el.querySelectorAll(CLICKABLE)].some((c) => SUBMIT_TEXT.test(txt(c)) && !NEVER.test(txt(c)));
          return !childHas;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, text: txt(el) || '(无字)', how: 'text', top: r.top, left: r.left, cls: String(el.className || '').slice(0, 40) };
        });
    } catch (e) { cands = []; }
  }

  if (!cands.length) {
    report.why = 'no-button';
    // 把「页面上所有含提交字样的东西」都带回去，下次改选择器就不用再猜
    try {
      report.near = [...document.querySelectorAll(CLICKABLE.concat(',span,div'))]
        .filter((el) => /提交|交卷/.test(norm(el.textContent)) && visible(el))
        .slice(0, 6)
        .map((el) => (el.tagName + '.' + String(el.className || '').replace(/\s+/g, '.')).slice(0, 50) + '=' + txt(el).slice(0, 12));
    } catch (e) {}
    try {
      const f = document.getElementById('iframe');
      report.hasIframe = !!f;
      report.iframeReachable = !!(f && f.contentDocument);
    } catch (e) {}
    return report;
  }

  // 页面上「最靠下」的那个才是最终提交（顶部可能还有分页小按钮）
  cands.forEach((c) => { try { c.top = c.el.getBoundingClientRect().top; } catch (e) { c.top = 0; } });
  cands.sort((a, b) => (b.top - a.top) || 0);
  const hit = cands[0];
  report.picked = hit.text + '|' + hit.cls;
  report.by = hit.how;

  // ---- 2) 屏蔽原生 alert/confirm（平台有时用它们，会卡住渲染线程）----
  const oldConfirm = window.confirm;
  const oldAlert = window.alert;
  try { window.confirm = () => true; } catch (e) {}
  try { window.alert = () => {}; } catch (e) {}

  // ---- 3) 点击：先补一套鼠标事件，兼容 jQuery/bind 的处理器 ----
  try { hit.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
  await sleep(200);
  const evOpt = { bubbles: true, cancelable: true, view: window };
  try {
    hit.el.dispatchEvent(new MouseEvent('mouseover', evOpt));
    hit.el.dispatchEvent(new MouseEvent('mousedown', evOpt));
    hit.el.dispatchEvent(new MouseEvent('mouseup', evOpt));
  } catch (e) {}
  try {
    hit.el.click();
    report.click = true;
  } catch (e) {
    try {
      hit.el.dispatchEvent(new MouseEvent('click', evOpt));
      report.click = true;
    } catch (e2) {}
  }

  // ---- 4) 等确认框（平台的、jQuery 的、layer 的、原生 confirm 的）----
  // 真机 #confirmWin 是 .Alertcon2，旧选择器完全覆盖不到，这里显式列出 + 通用兜底。
  const DLG_SEL = [
    '#confirmWin', '.Alertcon2', '#popup_container', '.layui-layer', '.aui_state_highlight',
    '.el-message-box', '.dialog', '.modal', '.popup', '.tips', '.maskDiv',
    '[class*="dialog"]', '[class*="popup"]', '[class*="layer"]', '[role="alertdialog"]', '[role="dialog"]',
  ].join(',');
  const looksLikeDialog = (el) => {
    if (!el || !visible(el)) return false;
    try {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.position === 'fixed' || cs.position === 'absolute') return true;
      if (Number(cs.zIndex || 0) > 100) return true;
      return r.width > 120 && r.height > 60;
    } catch (e) { return false; }
  };
  // 提交按钮在 #iframe 里、确认框却挂在顶层页面的模板也有（同源才读得到）。
  // 只扫自己这一个 document 会「点了提交但确定框永远没被点」—— 这里把同源的上下层都算进来。
  const collectDocs = () => {
    const out = [];
    const push = (doc, tag) => {
      if (!doc || out.some((d) => d.doc === doc)) return;
      out.push({ doc, tag });
    };
    push(document, 'self');
    try { if (window.top && window.top !== window) push(window.top.document, 'top'); } catch (e) {}
    try { if (window.parent && window.parent !== window) push(window.parent.document, 'parent'); } catch (e) {}
    try {
      const list = [...document.querySelectorAll('iframe')];
      if (window.top && window.top !== window) {
        try { list.push(...window.top.document.querySelectorAll('iframe')); } catch (e) {}
      }
      for (const f of list.slice(0, 8)) {
        let d = null;
        try { d = f.contentDocument; } catch (e) { d = null; }
        if (d) push(d, 'iframe');
      }
    } catch (e) {}
    report.frames = out.length;
    return out;
  };

  const start = Date.now();
  while (Date.now() - start < 4500) {
    await sleep(250);
    report.waited = Date.now() - start;
    for (const entry of collectDocs()) {
      if (report.ok) break;
      let boxes = [];
      try { boxes = [...entry.doc.querySelectorAll(DLG_SEL)].filter(looksLikeDialog); } catch (e) { boxes = []; }
      for (const box of boxes) {
        let btns = [];
        try { btns = [...box.querySelectorAll(CLICKABLE)].filter(visible); } catch (e) { btns = []; }
        const yes = btns.find((b) => {
          const t = txt(b);
          return YES_TEXT.test(t) && !NO_TEXT.test(t);
        }) || btns.find((b) => {
          // 有的弹窗确定按钮没字，只有一个图标/箭头：取非取消里的第一个
          const t = txt(b);
          return b !== hit.el && !NO_TEXT.test(t) && !SUBMIT_TEXT.test(t) && t.length <= 4;
        });
        if (!yes) continue;
        report.dialog = (box.id ? '#' + box.id : '') + '.' + String(box.className || '').split(/\s+/)[0];
        report.dialogFrame = entry.tag;
        report.yes = txt(yes);
        const win = (entry.doc.defaultView) || window;
        const ev2 = { bubbles: true, cancelable: true, view: win };
        try { yes.scrollIntoView({ block: 'center' }); } catch (e) {}
        await sleep(120);
        try {
          yes.dispatchEvent(new win.MouseEvent('mousedown', ev2));
          yes.dispatchEvent(new win.MouseEvent('mouseup', ev2));
          yes.click();
          report.ok = true;
          report.why = 'submitted-with-confirm';
        } catch (e) { report.why = 'confirm-click-failed:' + ((e && e.message) || e); }
        await sleep(600);
        break;
      }
    }
    if (report.ok) break;
    // 有些页点完提交直接跳转/刷新了，DOM 里没有确认框
    if (document.readyState === 'loading') { report.ok = true; report.why = 'navigating'; break; }
  }

  if (!report.ok && !report.why) {
    // 没有确认框：可能平台直接提交了。回头看一眼按钮态/是否出现「已提交」字样
    report.ok = report.click;
    report.why = report.click ? 'clicked-no-dialog' : 'click-failed';
  }

  setTimeout(() => { try { window.confirm = oldConfirm; window.alert = oldAlert; } catch (e) {} }, 5000);
  return report;
}
