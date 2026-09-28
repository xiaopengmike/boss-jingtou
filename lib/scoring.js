/* 精投助手 - 筛选打分（纯函数，零 chrome/DOM 依赖）
 * 加载方式有二，改逻辑时两边自动一致：
 * 1. 浏览器：manifest 里作为 content script 排在 content/panel.js 之前（同一 ISOLATED world，共享顶层函数）；
 * 2. Node 单测：tests/keyword-filter.test.js 直接 require（走底部 module.exports 出口）。
 * 入队前检查链：黑名单(标题+技能标签) → 公司黑名单 → 城市 → 薪资区间 → 白名单加分 → HR活跃加分。
 * 任何一环 drop=true，职位根本不会进 jt_queue。 */
'use strict';

function jtParseSalaryK(desc) {
  var m = /(\d+)\s*[-~]\s*(\d+)\s*[kK]/.exec(desc || '');
  if (m) return [+m[1], +m[2]];
  var w = /(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*万/.exec(desc || '');
  if (w) return [Math.round(+w[1] * 10), Math.round(+w[2] * 10)];
  return null;
}

/* it: {title, company, salary, city, labels[], active}
 * st: settings（kwBlacklist/kwWhitelist/companyBlacklist/cities/salaryMinK/salaryMaxK/requireActive）
 * 返回 {drop:true} 或 {drop:false, score, keywords}
 * 注意匹配语义：indexOf 子串匹配——「兼职程序员」只能拦标题含这 5 个字的岗位，
 * 拦不住「兼职设计师」；要拦一切兼职岗请直接加「兼职」。
 * requireActive（默认开）是硬门槛：HR 活跃度非「刚刚活跃/今日活跃」直接淘汰，
 * 与黑名单同级，不进队列——区别于活跃加分的 +5 软加权。 */
function jtScoreItem(it, st) {
  var text = it.title + ' ' + (it.labels || []).join(' ');
  var i;
  for (i = 0; i < st.kwBlacklist.length; i++) {
    if (st.kwBlacklist[i] && text.indexOf(st.kwBlacklist[i]) !== -1) return { drop: true };
  }
  for (i = 0; i < st.companyBlacklist.length; i++) {
    if (st.companyBlacklist[i] && it.company.indexOf(st.companyBlacklist[i]) !== -1) return { drop: true };
  }
  if (st.cities.length && it.city && st.cities.indexOf(it.city) === -1) return { drop: true };
  var sal = jtParseSalaryK(it.salary);
  if (sal && st.salaryMinK > 0 && sal[1] < st.salaryMinK) return { drop: true };
  if (sal && st.salaryMaxK > 0 && sal[0] > st.salaryMaxK) return { drop: true };
  /* HR 活跃度硬门槛（默认开）：只要 刚刚活跃/今日活跃，本周活跃及更久一律淘汰 */
  if (st.requireActive && !/刚刚活跃|今日活跃/.test(it.active || '')) return { drop: true };
  var hits = [];
  var score = 0;
  for (i = 0; i < st.kwWhitelist.length; i++) {
    var kw = st.kwWhitelist[i];
    if (kw && text.indexOf(kw) !== -1) {
      hits.push(kw);
      score += 10;
    }
  }
  if (/刚刚活跃|今日活跃|本周活跃/.test(it.active || '')) score += 5;
  return { drop: false, score: score, keywords: hits };
}

/* Node 单测出口；浏览器里 module 未定义，此块自动跳过 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { jtParseSalaryK: jtParseSalaryK, jtScoreItem: jtScoreItem };
}
