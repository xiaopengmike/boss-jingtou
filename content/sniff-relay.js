/* 精投助手 - sniff-relay（ISOLATED world, document_start）
 * MAIN ↔ SW 双向中转（照搬参考扩展 collect-bridge 的协议形态）：
 * - 上行只接受 event.source===window 且带魔术字段的消息（防同页脚本伪造投毒）；
 * - 下行 SET_RULES / EXTRACT 走 requestId 应答模式，1.5s 超时；
 * - Extension context invalidated（扩展重载后旧页面脚本还在）时静默退出，不报错刷屏。
 * 常量与 lib/constants.js 同值，改时必须同步。
 */
(function () {
  'use strict';
  if (window.__JT_RELAY__) return;
  window.__JT_RELAY__ = true;

  var NS = '__jingtou__';
  var NS_VAL = 'v1';
  var CMD_TIMEOUT = 1500;

  function alive() {
    try { return !!chrome.runtime.id; } catch (e) { return false; }
  }

  /* 上行：MAIN → SW */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[NS] !== NS_VAL) return;
    if (!alive()) return;
    var t = d.type;
    if (t === 'SNIFF_READY') {
      chrome.runtime.sendMessage({ type: 'SNIFF_HOOK_READY', payload: d.payload }, function () { void chrome.runtime.lastError; });
    } else if (t === 'SNIFF_HIT') {
      chrome.runtime.sendMessage({ type: 'SNIFF_HIT', payload: d.payload }, function () { void chrome.runtime.lastError; });
    } else if (t === 'EXTRACT_RESULT') {
      chrome.runtime.sendMessage({ type: 'SNIFF_EXTRACT_RESULT', payload: d.payload, requestId: d.requestId }, function () { void chrome.runtime.lastError; });
    }
  });

  /* 下行：SW → MAIN（requestId 应答模式） */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.__jingtouCmd) return;
    var requestId = 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var done = false;
    function fin(r) {
      if (done) return;
      done = true;
      window.removeEventListener('message', onResp);
      sendResponse(r);
    }
    function onResp(ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d[NS] !== NS_VAL || d.requestId !== requestId) return;
      fin({ ok: true, payload: d.payload });
    }
    window.addEventListener('message', onResp);
    setTimeout(function () { fin({ ok: false, timeout: true }); }, CMD_TIMEOUT);
    var out = { type: msg.__jingtouCmd, payload: msg.payload || null, requestId: requestId };
    out[NS] = NS_VAL;
    window.postMessage(out, location.origin);
    return true;
  });
})();
