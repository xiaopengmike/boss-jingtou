/* 精投助手 - sniff-hook（MAIN world, document_start）
 * 改造自参考扩展 collect-hook：hook fetch/XHR → clone 响应体 → 内存环形缓冲 → 命中上报。
 * 与参考扩展相同的铁律：绝不阻断、绝不改响应、绝不为页面请求加延迟；自身异常全吞；二进制不穿消息通道。
 * 常量与 lib/constants.js 同值，改时必须同步（content 脚本无法共享常量文件，参考扩展踩过顶层作用域冲突的坑）。
 */
(function () {
  'use strict';
  if (window.__JT_SNIFF_HOOKED__) return;
  window.__JT_SNIFF_HOOKED__ = true;

  var NS = '__jingtou__';
  var NS_VAL = 'v1';
  var TRUNC = 256 * 1024;
  var MAX_KEEP = 400;
  var SCAN_DEPTH = 7;
  var SCAN_BUDGET = 1200;
  var ARRAY_MAX = 60;
  var NOISE = [
    '/wapi/zpCommon/actionLog/',
    '/wapi/zpApm/actionLog/',
    '/wapi/zpApm/httpMetrics/',
    '/wapi/zpCommon/log',
    '/wapi/zpgeek/actionlog'
  ];
  var JOB_KEYS = ['encryptJobId', 'jobName', 'salaryDesc', 'brandName', 'bossName', 'skills', 'labels', 'cityName', 'areaDistrict'];
  /* pocMode（M0 取证）：记录全部非噪音 JSON；正式运行切 false，只报含职位特征的响应 */
  var pocMode = true;

  var buffer = [];

  function keep(item) {
    buffer.push(item);
    while (buffer.length > MAX_KEEP) buffer.shift();
  }
  function post(type, payload, requestId) {
    try {
      var d = { type: type, payload: payload, requestId: requestId || null };
      d[NS] = NS_VAL;
      window.postMessage(d, location.origin);
    } catch (e) { /* 吞 */ }
  }
  function isNoise(url) {
    for (var i = 0; i < NOISE.length; i++) {
      if (url.indexOf(NOISE[i]) !== -1) return true;
    }
    return false;
  }
  /* 迭代 DFS（递归会爆栈，参考扩展同款预算三件套：depth/budget/arrayMax） */
  function scanHit(json) {
    var budget = { n: SCAN_BUDGET };
    var stack = [{ v: json, d: 0 }];
    var seen = new Set();
    while (stack.length && budget.n > 0) {
      var cur = stack.pop();
      budget.n--;
      var v = cur.v;
      if (!v || typeof v !== 'object') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (cur.d > SCAN_DEPTH) continue;
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length && i < ARRAY_MAX; i++) stack.push({ v: v[i], d: cur.d + 1 });
        continue;
      }
      var keys = Object.keys(v);
      var local = 0;
      for (var k = 0; k < keys.length; k++) {
        if (JOB_KEYS.indexOf(keys[k]) !== -1) local++;
      }
      /* 同节点命中 ≥2 个职位特征键 = 强证据（防通用字段误报） */
      if (local >= 2) return true;
      for (var j = 0; j < keys.length; j++) stack.push({ v: v[keys[j]], d: cur.d + 1 });
    }
    return false;
  }
  function handleText(url, text) {
    try {
      if (!text || text.length < 2) return;
      if (text[0] !== '{' && text[0] !== '[') return;
      var kind = 'poc';
      if (!pocMode) {
        var json;
        try { json = JSON.parse(text); } catch (e) { return; }
        if (!scanHit(json)) return;
        kind = 'hit';
      }
      var payload = {
        url: url,
        ts: Date.now(),
        text: text.length > TRUNC ? text.slice(0, TRUNC) : text,
        trimmed: text.length > TRUNC,
        kind: kind
      };
      keep(payload);
      post('SNIFF_HIT', payload);
    } catch (e) { /* 吞 */ }
  }

  /* fetch：只 clone 读副本，原响应原路返回 */
  var of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function () {
      var p = of.apply(this, arguments);
      try {
        var url = String((arguments[0] && arguments[0].url) || arguments[0] || '');
        if (!isNoise(url)) {
          p.then(function (resp) {
            try {
              var ct = (resp.headers && resp.headers.get('content-type')) || '';
              if (ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
              resp.clone().text().then(function (t) { handleText(url, t); }).catch(function () { /* 吞 */ });
            } catch (e) { /* 吞 */ }
          }).catch(function () { /* 吞 */ });
        }
      } catch (e) { /* 吞 */ }
      return p;
    };
  }

  /* XHR：load 后读 responseText 副本 */
  var OO = XMLHttpRequest.prototype.open;
  var OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__jtUrl = String(u || '');
    return OO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      var url = this.__jtUrl || '';
      if (!isNoise(url)) {
        var xhr = this;
        xhr.addEventListener('load', function () {
          try {
            var ct = (xhr.getResponseHeader && xhr.getResponseHeader('content-type')) || '';
            if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
            if (xhr.responseType === '' || xhr.responseType === 'text') {
              handleText(url, xhr.responseText);
            }
          } catch (e) { /* 吞 */ }
        });
      }
    } catch (e) { /* 吞 */ }
    return OS.apply(this, arguments);
  };

  /* 下行指令：SET_RULES（键表/噪音/pocMode 热更新）/ EXTRACT（M0 取全量缓冲） */
  window.addEventListener('message', function (ev) {
    try {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d[NS] !== NS_VAL) return;
      if (d.type === 'SET_RULES') {
        var r = d.payload || {};
        if (Array.isArray(r.jobKeys) && r.jobKeys.length) JOB_KEYS = r.jobKeys;
        if (Array.isArray(r.noise) && r.noise.length) NOISE = r.noise;
        if (typeof r.pocMode === 'boolean') pocMode = r.pocMode;
        post('RULES_ACK', { ok: true }, d.requestId);
      } else if (d.type === 'EXTRACT') {
        post('EXTRACT_RESULT', { items: buffer.slice(-MAX_KEEP) }, d.requestId);
      }
    } catch (e) { /* 吞 */ }
  });

  post('SNIFF_READY', { url: location.href, pocMode: pocMode });
})();
