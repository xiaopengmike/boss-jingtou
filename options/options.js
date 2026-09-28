/* 精投助手 - 设置页
 * 另兼导出下载页（#export）：popup 会被关闭打断下载、Blob URL 随页面销毁失效（参考扩展踩坑），
 * 所以导出统一由 SW 把内容写进 storage.session 后打开本页，本页读出来触发下载。
 */
(function () {
  'use strict';

  var TIERS = [5, 20, 50, 100];

  function send(msg) {
    return new Promise(function (res) {
      chrome.runtime.sendMessage(msg, function (r) {
        void chrome.runtime.lastError;
        res(r || null);
      });
    });
  }
  function $(id) { return document.getElementById(id); }
  function toList(s) {
    return String(s || '').split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function toText(arr) { return (arr || []).join(','); }

  /* ---------- 导出通道 ---------- */
  async function handleExport() {
    if (location.hash !== '#export') return false;
    var o = await new Promise(function (res) { chrome.storage.session.get(['jt_export'], res); });
    var ex = o.jt_export;
    if (!ex || !ex.content) {
      document.body.innerHTML = '<p style="font:14px sans-serif;padding:40px">没有待导出的内容，请从 popup 重新发起导出。</p>';
      return true;
    }
    var blob = new Blob([ex.content], { type: (ex.mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = ex.filename || 'jingtou-export.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    document.body.innerHTML =
      '<p style="font:14px sans-serif;padding:40px">已下载 <b>' +
      String(ex.filename || '').replace(/[<>&]/g, '') +
      '</b>。本页可关闭。</p>';
    chrome.storage.session.remove(['jt_export']);
    return true;
  }

  /* ---------- 设置读写 ---------- */
  async function load() {
    var r = await send({ type: 'GET_SETTINGS' });
    if (!r || !r.ok) return;
    var s = r.settings;
    $('accountLabel').value = s.accountLabel;
    $('autoMode').value = s.autoMode;
    $('autoStart').checked = !!s.autoStart;
    $('pocMode').checked = !!s.pocMode;
    $('dailyCap').value = s.dailyCap;
    $('intervalMinSec').value = s.intervalMinSec;
    $('intervalMaxSec').value = s.intervalMaxSec;
    $('windowStart').value = s.windowStart;
    $('windowEnd').value = s.windowEnd;
    $('batchSize').value = s.batchSize;
    $('restMinMin').value = s.restMinMin;
    $('restMaxMin').value = s.restMaxMin;
    $('failStreakLimit').value = s.failStreakLimit;
    $('highThreshold').value = s.highThreshold;
    $('requireActive').checked = s.requireActive !== false;
    $('kwWhitelist').value = toText(s.kwWhitelist);
    $('kwBlacklist').value = toText(s.kwBlacklist);
    $('companyBlacklist').value = toText(s.companyBlacklist);
    $('salaryMinK').value = s.salaryMinK;
    $('salaryMaxK').value = s.salaryMaxK;
    $('cities').value = toText(s.cities);
    $('greetingMode').value = s.greetingMode === 'template' ? 'template' : 'system';
    $('greetingTemplate').value = s.greetingTemplate;
    $('rulesJson').value = JSON.stringify(r.rules, null, 2);
    lastTier = s.tier | 0;
    renderTier(lastTier);
    renderCapHint();
  }

  function renderTier(tier) {
    tier = Math.max(0, Math.min(tier, TIERS.length - 1));
    $('tierText').textContent = '档' + tier + '（' + TIERS[tier] + '条）';
    $('tierUp').disabled = tier >= TIERS.length - 1;
  }

  /* 生效上限提示：日上限受双重钳制（灰度档 + 平台硬上限 100），
   * 输入超出时明说，避免"设置了 200 但 popup 仍 100"的困惑 */
  function renderCapHint() {
    var el = $('capHint');
    if (!el) return;
    var tier = Math.max(0, Math.min(lastTier, TIERS.length - 1));
    var tierCap = TIERS[tier];
    var raw = +$('dailyCap').value || 0;
    var eff = Math.min(raw > 0 ? raw : tierCap, tierCap);
    if (raw > 100) {
      el.textContent = '⚠ 平台硬上限 100 条/天：超出部分不可能生效，且第 101 条起会静默失效、污染台账并触发熔断。保存时将钳到 100。';
      el.className = 'warn';
    } else if (raw > tierCap) {
      el.textContent = '⚠ 受灰度档 ' + tier + ' 限制，当前生效上限 = ' + eff + ' 条/天（升档后才可提高）';
      el.className = 'warn';
    } else {
      el.textContent = '当前生效上限 = ' + eff + ' 条/天';
      el.className = 'hint';
    }
  }
  var lastTier = 0;

  async function save() {
    var rules = null;
    try {
      rules = JSON.parse($('rulesJson').value);
    } catch (e) {
      $('savedMsg').textContent = '规则 JSON 格式错误，未保存规则（其余配置已保存）';
      $('savedMsg').style.color = '#c41d7f';
    }
    var settings = {
      accountLabel: $('accountLabel').value.trim() || '小号',
      autoMode: $('autoMode').value,
      autoStart: $('autoStart').checked,
      pocMode: $('pocMode').checked,
      dailyCap: Math.max(5, Math.min(100, +$('dailyCap').value || 100)),
      intervalMinSec: +$('intervalMinSec').value || 45,
      intervalMaxSec: +$('intervalMaxSec').value || 180,
      windowStart: $('windowStart').value.trim() || '10:00',
      windowEnd: $('windowEnd').value.trim() || '19:00',
      batchSize: +$('batchSize').value || 7,
      restMinMin: +$('restMinMin').value || 8,
      restMaxMin: +$('restMaxMin').value || 15,
      failStreakLimit: +$('failStreakLimit').value || 3,
      highThreshold: +$('highThreshold').value || 20,
      requireActive: $('requireActive').checked,
      kwWhitelist: toList($('kwWhitelist').value),
      kwBlacklist: toList($('kwBlacklist').value),
      companyBlacklist: toList($('companyBlacklist').value),
      salaryMinK: +$('salaryMinK').value || 0,
      salaryMaxK: +$('salaryMaxK').value || 0,
      cities: toList($('cities').value),
      greetingMode: $('greetingMode').value === 'template' ? 'template' : 'system',
      greetingTemplate: $('greetingTemplate').value,
      closeTabAfter: true
    };
    /* tier 不在表单里改（只能经升档按钮），保存时带上当前值防丢失；
     * _v 同样必须带回——丢掉它会让 jtGetSettings 的版本迁移重跑，把自定义词表冲掉 */
    var cur = await send({ type: 'GET_SETTINGS' });
    settings.tier = cur && cur.settings ? cur.settings.tier | 0 : 0;
    settings._v = cur && cur.settings ? Math.max(3, cur.settings._v | 0) : 3;
    await send({ type: 'SAVE_SETTINGS', settings: settings });
    if (rules) await send({ type: 'SAVE_RULES', rules: rules });
    renderCapHint();
    $('savedMsg').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN');
    $('savedMsg').style.color = '#52c41a';
  }

  $('save').addEventListener('click', save);
  $('dailyCap').addEventListener('input', renderCapHint);
  $('tierUp').addEventListener('click', async function () {
    var r = await send({ type: 'TIER_UP' });
    if (r && r.ok) { lastTier = r.tier | 0; renderTier(lastTier); renderCapHint(); }
  });

  handleExport().then(function (handled) {
    if (!handled) load();
  });
})();
