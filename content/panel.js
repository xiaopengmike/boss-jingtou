/* 精投助手 - 面板（ISOLATED, document_idle, 仅 /web/geek/*）
 * Shadow DOM 浮层（照搬参考扩展 collect-button 的隔离手法：all:initial + z-index 2147483647 + 仅顶层帧）。
 * 职责：从 SW 嗅探缓冲解析职位 → 本地筛选打分分级 → 高置信自动入队 / 灰名单人工勾选入队 → 启停投递。
 * 所有筛选在本地跑，不联网。常量与 lib/constants.js 同值，改时必须同步。
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__JT_PANEL__) return;
  window.__JT_PANEL__ = true;

  var RE_ENC = /^[0-9A-Za-z_~-]{16,64}$/;
  var SCAN_DEPTH = 7;
  var SCAN_BUDGET = 1200;
  var ARRAY_MAX = 60;
  var REQUIRED = ['encryptJobId', 'jobName'];
  var LABEL_KEYS = ['skills', 'labels', 'jobLabels', 'welfareList'];

  var seenJobIds = new Set();
  var grayItems = [];
  var lastStats = { autoAdded: 0, grayNew: 0, dropped: 0 };

  function send(msg) {
    return new Promise(function (res) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          void chrome.runtime.lastError;
          res(r || null);
        });
      } catch (e) { res(null); }
    });
  }

  /* ---------- 解析：DFS 找"元素含 encryptJobId+jobName 的数组"（反用参考扩展多人拦截：多加密 ID 同框 = 列表信号） ---------- */
  function isJobItem(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    for (var i = 0; i < REQUIRED.length; i++) {
      if (!(REQUIRED[i] in o)) return false;
    }
    return typeof o.encryptJobId === 'string' && RE_ENC.test(o.encryptJobId);
  }
  function normItem(o) {
    var labels = [];
    for (var k = 0; k < LABEL_KEYS.length; k++) {
      var arr = o[LABEL_KEYS[k]];
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          if (typeof arr[i] === 'string') labels.push(arr[i]);
        }
      }
    }
    return {
      jobId: o.encryptJobId,
      title: o.jobName || '',
      company: o.brandName || '',
      salary: o.salaryDesc || '',
      boss: o.bossName || '',
      active: o.activeTimeDesc || '',
      city: o.cityName || '',
      district: o.areaDistrict || '',
      labels: labels
    };
  }
  function extractJobs(text, out) {
    var json;
    try { json = JSON.parse(text); } catch (e) { return; }
    var budget = { n: SCAN_BUDGET };
    var stack = [{ v: json, d: 0 }];
    var seen = new Set();
    while (stack.length && budget.n > 0) {
      var cur = stack.pop();
      budget.n--;
      var v = cur.v;
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      if (cur.d > SCAN_DEPTH) continue;
      if (Array.isArray(v)) {
        if (v.length && isJobItem(v[0])) {
          for (var i = 0; i < v.length; i++) {
            if (isJobItem(v[i])) out.push(normItem(v[i]));
          }
          continue; /* 找到职位数组即停，不再下钻 */
        }
        for (var j = 0; j < v.length && j < ARRAY_MAX; j++) stack.push({ v: v[j], d: cur.d + 1 });
        continue;
      }
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length; k++) stack.push({ v: v[keys[k]], d: cur.d + 1 });
    }
  }

  /* ---------- 筛选打分分级：逻辑在 lib/scoring.js（manifest 里先于本文件注入，Node 单测同用一份） ---------- */

  async function scanBuffer() {
    var st = await send({ type: 'GET_SETTINGS' });
    if (!st || !st.ok) return;
    var settings = st.settings;
    var r = await send({ type: 'GET_BUFFER' });
    if (!r || !r.ok) return;
    var raw = [];
    (r.items || []).forEach(function (it) {
      if (it && it.text) extractJobs(it.text, raw);
    });
    var freshAuto = [];
    var freshGray = [];
    var dropped = 0;
    raw.forEach(function (it) {
      if (seenJobIds.has(it.jobId)) return;
      seenJobIds.add(it.jobId);
      var sc = jtScoreItem(it, settings);
      if (sc.drop) { dropped++; return; }
      it.score = sc.score;
      it.keywords = sc.keywords;
      /* 分级：full 模式全部高置信；hybrid 模式按阈值 */
      var auto = settings.autoMode === 'full' || sc.score >= (settings.highThreshold | 0);
      it.tier = auto ? 'auto' : 'gray';
      if (auto) freshAuto.push(it);
      else freshGray.push(it);
    });
    if (freshAuto.length) {
      var ar = await send({ type: 'QUEUE_ADD', items: freshAuto, auto: true });
      lastStats.autoAdded += ar && ar.added ? ar.added : 0;
    }
    freshGray.forEach(function (it) {
      if (!grayItems.some(function (g) { return g.jobId === it.jobId; })) {
        grayItems.push(it);
        lastStats.grayNew++;
      }
    });
    lastStats.dropped += dropped;
    renderList();
    refreshState();
  }

  /* ---------- UI（Shadow DOM） ---------- */
  var CSS = [
    ':host{all:initial}',
    '#fab{position:fixed;right:16px;bottom:96px;z-index:2147483647;background:#1677ff;color:#fff;border:none;',
    'border-radius:20px;padding:8px 14px;font:13px/1.2 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
    '#panel{position:fixed;right:16px;bottom:140px;z-index:2147483647;width:360px;max-height:70vh;display:flex;flex-direction:column;',
    'background:#fff;color:#222;border:1px solid #ddd;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.2);font:12px/1.5 sans-serif;overflow:hidden}',
    '#panel.hide,#fab.hide{display:none}',
    '#head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f6f8fa;border-bottom:1px solid #e5e5e5}',
    '#head b{font-size:13px}',
    '#stLine{flex:1;color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#close{border:none;background:none;cursor:pointer;font-size:16px;color:#999;padding:0 2px}',
    '#runLine{padding:6px 10px;color:#444;background:#fff;border-bottom:1px solid #f0f0f0;font-size:11px}',
    '#runLine.warn{color:#c41d7f;background:#fff0f6}',
    '#btns{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid #f0f0f0;flex-wrap:wrap}',
    '#btns button{flex:1;min-width:70px;border:1px solid #d9d9d9;background:#fff;border-radius:6px;padding:5px 0;cursor:pointer;font-size:12px;color:#333}',
    '#btns button.primary{background:#1677ff;border-color:#1677ff;color:#fff}',
    '#btns button:hover{opacity:.85}',
    '#list{overflow-y:auto;padding:4px 0;flex:1}',
    '.row{display:flex;gap:6px;align-items:flex-start;padding:6px 10px;border-bottom:1px solid #f5f5f5}',
    '.row input{margin-top:3px}',
    '.row .t{font-weight:600;color:#222}',
    '.row .c{color:#888;font-size:11px}',
    '.row .s{margin-left:auto;color:#1677ff;font-weight:600;white-space:nowrap}',
    '.empty{padding:16px;text-align:center;color:#999}'
  ].join('\n');

  var shadow;
  var els = {};

  function buildUI() {
    var host = document.createElement('div');
    host.id = '__jt_panel_host__';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<button id="fab">精投</button>' +
      '<div id="panel" class="hide">' +
      '<div id="head"><b>精投助手</b><span id="stLine">…</span><button id="close">×</button></div>' +
      '<div id="runLine">—</div>' +
      '<div id="btns">' +
      '<button id="scan">扫描缓冲</button>' +
      '<button id="addSel">选中入队</button>' +
      '<button id="go" class="primary">开始投递</button>' +
      '<button id="pause">暂停</button>' +
      '</div>' +
      '<div id="list"><div class="empty">点「扫描缓冲」解析已抓到的职位</div></div>' +
      '</div>';
    els.fab = shadow.getElementById('fab');
    els.panel = shadow.getElementById('panel');
    els.stLine = shadow.getElementById('stLine');
    els.runLine = shadow.getElementById('runLine');
    els.list = shadow.getElementById('list');
    els.fab.addEventListener('click', function () {
      els.panel.classList.toggle('hide');
      refreshState();
    });
    shadow.getElementById('close').addEventListener('click', function () {
      els.panel.classList.add('hide');
    });
    shadow.getElementById('scan').addEventListener('click', scanBuffer);
    shadow.getElementById('addSel').addEventListener('click', addSelected);
    shadow.getElementById('go').addEventListener('click', async function () {
      await send({ type: 'QUEUE_GO' });
      refreshState();
    });
    shadow.getElementById('pause').addEventListener('click', async function () {
      await send({ type: 'QUEUE_PAUSE' });
      refreshState();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderList() {
    if (!grayItems.length) {
      els.list.innerHTML = '<div class="empty">灰名单为空（高置信职位已自动入队）</div>';
      return;
    }
    var html = '';
    grayItems.forEach(function (it, idx) {
      html +=
        '<div class="row">' +
        '<input type="checkbox" data-idx="' + idx + '">' +
        '<div><div class="t">' + esc(it.title) + ' <span class="s">' + esc(it.salary) + '</span></div>' +
        '<div class="c">' + esc(it.company) + ' · ' + esc(it.city) + ' · ' + esc(it.active || '') +
        ' · 分' + it.score + (it.keywords.length ? ' · ' + esc(it.keywords.join('/')) : '') + '</div></div>' +
        '</div>';
    });
    els.list.innerHTML = html;
  }

  async function addSelected() {
    var boxes = els.list.querySelectorAll('input[type=checkbox]:checked');
    var items = [];
    boxes.forEach(function (b) {
      var it = grayItems[+b.getAttribute('data-idx')];
      if (it) items.push(it);
    });
    if (!items.length) return;
    await send({ type: 'QUEUE_ADD', items: items, auto: false });
    grayItems = grayItems.filter(function (it) {
      return !items.some(function (x) { return x.jobId === it.jobId; });
    });
    renderList();
    refreshState();
  }

  function fmtWait(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + ' 秒';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' 分钟';
    return (m / 60).toFixed(1) + ' 小时';
  }

  async function refreshState() {
    var s = await send({ type: 'GET_STATE' });
    if (!s || !s.ok) return;
    els.stLine.textContent =
      s.accountLabel + ' | ' + (s.autoMode === 'full' ? '全自动' : '混合') +
      ' | 档' + s.tier + '(≤' + s.cap + ') | 今日 ' + s.sent + '/' + s.cap + ' | 队列 ' + s.queued;
    var runText;
    if (s.running && s.gateReason) {
      /* 触顶/出时段：后台保持 running 到点自动恢复，如实显示闸门原因而非裸秒数 */
      runText = s.gateReason === 'daily_cap'
        ? '⏸ 已达今日上限（明日 00:05 重置后自动继续）'
        : '⏸ 不在投递时段，到 ' + (s.windowStart || '活跃时段') + ' 自动继续';
    } else if (s.running) {
      runText = (s.current ? '投递中：' + (s.current.jobId || '').slice(0, 12) + '…' : '运行中，等待下一条') +
        (s.nextAt && s.nextAt > Date.now() ? '（' + fmtWait(s.nextAt - Date.now()) + '后）' : '');
    } else {
      runText = '未运行' + (s.pausedReason ? '（' + pauseText(s.pausedReason) + '）' : '');
    }
    els.runLine.textContent = runText +
      (lastStats.autoAdded || lastStats.grayNew ? ' | 本次扫描：自动+' + lastStats.autoAdded + ' 灰+' + lastStats.grayNew + ' 淘汰' + lastStats.dropped : '');
    els.runLine.className = (s.pausedReason === 'captcha' || s.pausedReason === 'fuse_blown') ? 'warn' : '';
  }

  function pauseText(r) {
    return {
      captcha: '出现验证码，已暂停！请人工处理后点开始',
      fuse_blown: '连续失败熔断，已暂停',
      manual: '已手动暂停',
      queue_empty: '队列已空',
      daily_cap: '已达今日上限'
    }[r] || r;
  }

  buildUI();
  setInterval(refreshState, 5000);
  refreshState();
})();
