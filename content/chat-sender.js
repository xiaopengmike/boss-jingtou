/* 精投助手 - chat-sender（按需注入聊天页，ISOLATED）
 * 职责：点发送 → **校验落库**（本方案防静默失效的关键一步）：
 * 发送后在聊天区轮询刚发的文本，出现=verified，超时=suspected_silent（计入熔断）。
 *
 * 打招呼文本来源（greetingMode）：
 * - 'system'（默认，实测可用）：不改写输入框，直接发 BOSS 预置的默认招呼语
 *   （首次沟通时由 friend/add 接口下发，如"觉得我和贵公司的岗位很匹配…"）。
 *   之所以不再填自定义文本：清空+insertText 注入的自定义内容在 BOSS 侧发不出去。
 * - 'template'（旧路径，保留待回退）：清空输入框后填入 cfg.greeting。
 * 两种模式都会把**实际发出的文本**随 CHAT_RESULT 回报，台账记真实内容而非模板。
 * 常量与 lib/constants.js 同值，改时必须同步。
 */
(function () {
  'use strict';
  if (window.__JT_CHAT_SENDER__) return;
  window.__JT_CHAT_SENDER__ = true;

  var cfg = window.__JT_CHAT_CONFIG__ || {};
  var rules = cfg.rules || {};
  var SEND_TEXTS = rules.sendBtnTexts || ['发送'];
  var EDITOR_SEL = rules.editorSelectors || ['[contenteditable="true"]', 'textarea'];
  var CAPTCHA_TEXTS = rules.captchaTexts || ['安全验证', '拖动下方滑块', '滑块'];
  /* M0 取证（2026-09-28）：打招呼弹框全在顶层 DOM——.dialog-wrap.startchat-dialog 内
   * textarea.input-area（placeholder="请简短描述您的问题"），发送按钮 div.send-message（空输入带 disable class） */
  var DIALOG_SEL = rules.chatDialogSelector || '.dialog-wrap.startchat-dialog';
  var SEND_BTN_CLASS = rules.sendBtnClass || 'send-message';
  var SEND_DISABLE_CLASS = rules.sendBtnDisabledClass || 'disable';
  var TIMEOUT_MS = 20000;
  var VERIFY_MS = 10000;
  var DEFAULT_TEXT_WAIT_MS = 3000; // system 模式下等预置文本到位（friend/add 可能晚于弹框渲染）

  var done = false;

  function report(p) {
    if (done) return;
    done = true;
    try {
      chrome.runtime.sendMessage(
        { type: 'CHAT_RESULT', payload: Object.assign({ jobId: cfg.jobId || '' }, p) },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) { /* context invalidated */ }
  }
  function reportCaptcha() {
    try {
      chrome.runtime.sendMessage(
        { type: 'CAPTCHA_HIT', payload: { url: location.href } },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) { /* ignore */ }
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findEditor() {
    /* 优先：打招呼弹框内的 textarea（M0 取证确认的输入框，避免误选页面其它 textarea） */
    var dlg = document.querySelector(DIALOG_SEL);
    if (dlg) {
      var tas = dlg.querySelectorAll('textarea');
      for (var k = 0; k < tas.length; k++) {
        if (visible(tas[k])) return tas[k];
      }
    }
    for (var i = 0; i < EDITOR_SEL.length; i++) {
      var els = document.querySelectorAll(EDITOR_SEL[i]);
      for (var j = 0; j < els.length; j++) {
        if (visible(els[j])) return els[j];
      }
    }
    return null;
  }
  /* 框架受控组件必须走 赋值 + 事件派发（参考扩展 setValuish 同款处理）；仅 template 模式使用 */
  function fillEditor(ed, text) {
    ed.focus();
    if (ed.isContentEditable) {
      /* M0 取证确认：friend/add 接口下发预置默认招呼语（"觉得我和贵公司的岗位很匹配…"），
       * insertText 是追加语义，必须先全选清空再插入，否则发出两条拼接的招呼语。 */
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    } else {
      var proto = ed instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(ed, text);
      else ed.value = text;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      ed.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  /* 读输入框当前内容：system 模式靠它取 BOSS 预置招呼语原文 */
  function readEditor(ed) {
    var s = ed.isContentEditable ? (ed.innerText || ed.textContent || '') : (ed.value || '');
    return String(s).trim();
  }
  function findSendBtn() {
    /* 优先：弹框内 .send-message（M0 取证：是 div 不是 button） */
    var dlg = document.querySelector(DIALOG_SEL);
    if (dlg) {
      var btns = dlg.querySelectorAll('.' + SEND_BTN_CLASS);
      for (var k = 0; k < btns.length; k++) {
        if (visible(btns[k])) return btns[k];
      }
    }
    var all = document.querySelectorAll('button,a,div,span');
    for (var t = 0; t < SEND_TEXTS.length; t++) {
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0 && el.tagName !== 'BUTTON' && el.tagName !== 'A') continue;
        var tx = (el.textContent || '').trim();
        if (tx === SEND_TEXTS[t] && visible(el)) return el;
      }
    }
    return null;
  }
  function hasCaptcha() {
    var body = (document.body && document.body.innerText) || '';
    for (var i = 0; i < CAPTCHA_TEXTS.length; i++) {
      if (body.indexOf(CAPTCHA_TEXTS[i]) !== -1) return true;
    }
    return false;
  }

  /* 文本就位后：等 disable class 摘除 → 点击发送 → 校验落库。text 即"实际发出的文本" */
  function sendWhenReady(text) {
    setTimeout(function () {
      /* M0 取证：空输入时 .send-message 带 disable class，需等框架响应 input 事件摘除后再点击 */
      var w0 = Date.now();
      var wiv = setInterval(function () {
        if (done) { clearInterval(wiv); return; }
        var btn = findSendBtn();
        if (!btn) {
          clearInterval(wiv);
          report({ sent: false, verified: false, err: 'send_btn_not_found' });
          return;
        }
        if (String(btn.className).indexOf(SEND_DISABLE_CLASS) !== -1) {
          if (Date.now() - w0 > 3000) {
            clearInterval(wiv);
            report({ sent: false, verified: false, err: 'send_btn_disabled' });
          }
          return;
        }
        clearInterval(wiv);
        btn.click();
        /* 落库校验：聊天区出现刚发文本的前 20 字 */
        var probe = text.slice(0, 20);
        var v0 = Date.now();
        var viv = setInterval(function () {
          if (done) { clearInterval(viv); return; }
          var body = (document.body && document.body.innerText) || '';
          if (body.indexOf(probe) !== -1) {
            clearInterval(viv);
            report({ sent: true, verified: true, sentText: text });
            return;
          }
          if (Date.now() - v0 > VERIFY_MS) {
            clearInterval(viv);
            report({ sent: true, verified: false, sentText: text });
          }
        }, 500);
      }, 200);
    }, 400);
  }

  setTimeout(function () { report({ sent: false, verified: false, err: 'timeout' }); }, TIMEOUT_MS);

  var tries = 0;
  var iv = setInterval(function () {
    if (done) { clearInterval(iv); return; }
    tries++;
    if (hasCaptcha()) {
      clearInterval(iv);
      reportCaptcha();
      report({ sent: false, verified: false, captcha: true });
      return;
    }
    var ed = findEditor();
    if (!ed) {
      if (tries > 20) {
        clearInterval(iv);
        report({ sent: false, verified: false, err: 'editor_not_found' });
      }
      return;
    }
    clearInterval(iv);

    if (cfg.greetingMode === 'template') {
      /* 旧路径：清空输入框 → 填自定义模板 → 发送 */
      var tpl = String(cfg.greeting || '').slice(0, 300);
      if (!tpl) {
        report({ sent: false, verified: false, err: 'empty_greeting' });
        return;
      }
      fillEditor(ed, tpl);
      sendWhenReady(tpl);
      return;
    }

    /* 默认路径：不改写输入框，等 BOSS 预置招呼语到位后原样发送 */
    var t0 = Date.now();
    var tiv = setInterval(function () {
      if (done) { clearInterval(tiv); return; }
      var cur = readEditor(ed);
      if (cur) {
        clearInterval(tiv);
        ed.focus();
        sendWhenReady(cur.slice(0, 300));
        return;
      }
      if (Date.now() - t0 > DEFAULT_TEXT_WAIT_MS) {
        clearInterval(tiv);
        report({ sent: false, verified: false, err: 'no_default_greeting' });
      }
    }, 300);
  }, 500);
})();
