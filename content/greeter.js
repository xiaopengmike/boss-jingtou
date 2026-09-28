/* 精投助手 - greeter（按需注入职位详情页，ISOLATED）
 * 职责：定位并点击「立即沟通」→ 识别分支（跳聊天页 / 同页弹聊天 / 已沟通 / 验证码）→ 上报 GREET_RESULT。
 * 定位策略借参考扩展 fill-engine 哲学：BOSS class 名混淆，只能靠**文本**匹配，不靠固定 class。
 * 常量与 lib/constants.js 同值（greetTexts/greetedTexts/captchaTexts 正式版应从 __JT_GREET_CONFIG__.rules 读，M0 后接）。
 */
(function () {
  'use strict';
  if (window.__JT_GREETER__) return;
  window.__JT_GREETER__ = true;

  var cfg = window.__JT_GREET_CONFIG__ || {};
  var rules = cfg.rules || {};
  var GREET_TEXTS = rules.greetTexts || ['立即沟通', '打招呼'];
  var GREETED_TEXTS = rules.greetedTexts || ['继续沟通'];
  var CAPTCHA_TEXTS = rules.captchaTexts || ['安全验证', '拖动下方滑块', '滑块', 'captcha'];
  var CHAT_URL = rules.chatUrlIncludes || ['/web/chat'];
  /* M0 取证（2026-09-28 晚）：点「立即沟通」后 BOSS 可能直接自动发默认招呼语并弹确认框 */
  var AUTO_SENT_TEXTS = rules.autoSentTexts || ['已向BOSS发送消息'];
  /* M0 取证：BOSS 弹框输入框为 textarea（非 contenteditable），与 chat-sender 的 editorSelectors 对齐 */
  var EDITOR_SEL = rules.editorSelectors || ['[contenteditable="true"]', 'textarea'];
  var TIMEOUT_MS = 20000;

  var done = false;
  var startUrl = location.href;

  function report(payload) {
    if (done) return;
    done = true;
    try {
      chrome.runtime.sendMessage(
        { type: 'GREET_RESULT', payload: Object.assign({ jobId: cfg.jobId || '' }, payload) },
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
  /* 文本精确匹配 + 叶子优先（防父容器整段文本误命中） */
  function findByText(texts) {
    var all = document.querySelectorAll('a,button,div,span');
    for (var t = 0; t < texts.length; t++) {
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0 && el.tagName !== 'A' && el.tagName !== 'BUTTON') continue;
        var tx = (el.textContent || '').trim();
        if (tx === texts[t] && visible(el)) return el;
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
  function onChatPage() {
    for (var i = 0; i < CHAT_URL.length; i++) {
      if (location.href.indexOf(CHAT_URL[i]) !== -1) return true;
    }
    return false;
  }
  /* 检测「已向BOSS发送消息」确认框；命中则提取框内所发招呼语原文（剔除标题/提示/按钮行）。
   * 返回 '' = 未出现；返回非空 = 已出现（text 为原文，取不到时给占位串） */
  function findAutoSentDialog() {
    var all = document.querySelectorAll('h1,h2,h3,h4,div,span,p');
    for (var t = 0; t < AUTO_SENT_TEXTS.length; t++) {
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        /* 不跳父容器：标题文本可能被拆进嵌套标签；textContent 精确相等本身已保证无多余内容 */
        var tx = (el.textContent || '').trim();
        if (tx !== AUTO_SENT_TEXTS[t] || !visible(el)) continue;
        var box = el.parentElement || el;
        var lines = (box.innerText || '').split('\n');
        var keep = [];
        for (var j = 0; j < lines.length; j++) {
          var ln = lines[j].trim();
          if (!ln || ln === AUTO_SENT_TEXTS[t]) continue;
          if (ln.indexOf('如需修改打招呼内容') !== -1) continue;
          if (ln === '留在此页' || ln === '继续沟通') continue;
          keep.push(ln);
        }
        return (keep.join(' ') || '（BOSS已确认发送，未取到原文）').slice(0, 300);
      }
    }
    return '';
  }
  /* 与 chat-sender.findEditor 同语义：优先判定打招呼弹框内 textarea，兜底可见编辑元素 */
  function hasEditor() {
    /* M0 取证（2026-09-28）：聊天框为顶层 .dialog-wrap.startchat-dialog，内含 textarea.input-area */
    var dlg = document.querySelector(rules.chatDialogSelector || '.dialog-wrap.startchat-dialog');
    if (dlg && dlg.querySelector('textarea')) return true;
    for (var i = 0; i < EDITOR_SEL.length; i++) {
      var els = document.querySelectorAll(EDITOR_SEL[i]);
      for (var j = 0; j < els.length; j++) {
        if (visible(els[j])) return true;
      }
    }
    return false;
  }

  setTimeout(function () { report({ ok: false, branch: 'timeout' }); }, TIMEOUT_MS);

  var tries = 0;
  var iv = setInterval(function () {
    if (done) { clearInterval(iv); return; }
    tries++;
    if (hasCaptcha()) {
      clearInterval(iv);
      reportCaptcha();
      report({ ok: false, branch: 'captcha' });
      return;
    }
    /* 已沟通过（出现「继续沟通」且没有「立即沟通」）→ 不重复发，记 msged */
    if (findByText(GREETED_TEXTS) && !findByText(GREET_TEXTS)) {
      clearInterval(iv);
      report({ ok: true, branch: 'already' });
      return;
    }
    var btn = findByText(GREET_TEXTS);
    if (!btn) {
      if (tries > 24) {
        clearInterval(iv);
        report({ ok: false, branch: 'btn_not_found' });
      }
      return;
    }
    clearInterval(iv);
    btn.click();
    /* 点击后等分支：跳聊天页(navigate) / 同页出聊天输入框(same_page_chat) / 验证码 / 超时 */
    var n = 0;
    var iv2 = setInterval(function () {
      if (done) { clearInterval(iv2); return; }
      n++;
      if (location.href !== startUrl && onChatPage()) {
        clearInterval(iv2);
        report({ ok: true, branch: 'navigate' });
        return;
      }
      /* BOSS 自动发送分支：确认框出现 = 消息已送达，无需 chat 阶段 */
      var as = findAutoSentDialog();
      if (as) {
        clearInterval(iv2);
        report({ ok: true, branch: 'auto_sent', sentText: as });
        return;
      }
      if (hasEditor()) {
        clearInterval(iv2);
        report({ ok: true, branch: 'same_page_chat' });
        return;
      }
      if (hasCaptcha()) {
        clearInterval(iv2);
        reportCaptcha();
        report({ ok: false, branch: 'captcha' });
        return;
      }
      if (n > 20) {
        clearInterval(iv2);
        report({ ok: false, branch: 'post_click_timeout' });
      }
    }, 500);
  }, 500);
})();
