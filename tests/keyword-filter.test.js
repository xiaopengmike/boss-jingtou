/* 入队前标题关键字检查 - 单测（Node 直跑，无框架）
 * 跑法：node tests/keyword-filter.test.js
 * 测的是生产同一份逻辑 lib/scoring.js（content/panel.js 浏览器里用的也是它）。
 * 当前需求（v2 词表）：标题含「兼职」→ 进队列；旧默认白名单（数字化/IT经理/…）已清零。 */
'use strict';

var assert = require('assert');
var path = require('path');
var scoring = require(path.join(__dirname, '..', 'lib', 'scoring.js'));
var jtScoreItem = scoring.jtScoreItem;
var jtParseSalaryK = scoring.jtParseSalaryK;

/* 与 lib/constants.js 的 JT_DEFAULT_SETTINGS（_v:2）同值 */
var settings = {
  kwWhitelist: ['兼职'],
  kwBlacklist: ['外包', '销售', '地推', '驻场'],
  companyBlacklist: [],
  cities: [],
  salaryMinK: 0,
  salaryMaxK: 0,
  highThreshold: 10
};

function job(patch) {
  return Object.assign(
    { jobId: 'abc123def456ghi7', title: '', company: '某科技公司', salary: '20-35K', city: '深圳', labels: [], active: '' },
    patch
  );
}

var passed = 0;
var failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}
/* 模拟 scanBuffer 的分级动作：drop 之外按 highThreshold 分 auto/gray（hybrid 模式） */
function classify(it) {
  var sc = jtScoreItem(it, settings);
  if (sc.drop) return 'drop';
  return sc.score >= settings.highThreshold ? 'auto(分' + sc.score + ')' : 'gray(分' + sc.score + ')';
}

console.log('== 核心需求：标题含「兼职」→ 进队列 ==');

t('「兼职程序员（可远程）」→ 分10 ≥ 阈值10 → auto 自动入队', function () {
  assert.strictEqual(classify(job({ title: '兼职程序员（可远程）' })), 'auto(分10)');
});

t('「兼职设计师」也含「兼职」（子串语义）→ 同样 auto 入队', function () {
  assert.strictEqual(classify(job({ title: '兼职设计师' })), 'auto(分10)');
});

t('「兼职前端」+ 刚刚活跃 → 10+5=15 → auto 入队', function () {
  assert.strictEqual(classify(job({ title: '兼职前端', active: '刚刚活跃' })), 'auto(分15)');
});

console.log('== 边界与优先级 ==');

t('黑名单优先于白名单：「兼职销售代表」命中「销售」→ drop（含兼职也不进）', function () {
  assert.strictEqual(classify(job({ title: '兼职销售代表' })), 'drop');
});

t('标题不含「兼职」：「Java开发工程师」→ 分0 → gray 待人工（full 模式才会全入队）', function () {
  assert.strictEqual(classify(job({ title: 'Java开发工程师' })), 'gray(分0)');
});

console.log('== 旧默认白名单已清零 ==');

t('「数字化研发运营经理」→ 分0（数字化/研发效能 不再加分）→ gray', function () {
  assert.strictEqual(classify(job({ title: '数字化研发运营经理', active: '刚刚活跃' })), 'gray(分5)');
});

t('「研发效能平台 ITBP」→ 分0（ITBP/研发效能 不再加分）→ gray', function () {
  assert.strictEqual(classify(job({ title: '研发效能平台 ITBP' })), 'gray(分0)');
});

console.log('== 薪资解析顺带回归 ==');
assert.deepStrictEqual(jtParseSalaryK('20-35K·14薪'), [20, 35]);
assert.deepStrictEqual(jtParseSalaryK('2-3.5万'), [20, 35]);
console.log('  PASS  20-35K / 2-3.5万 解析一致');

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
