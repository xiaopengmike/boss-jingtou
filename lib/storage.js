/* 精投助手 - storage 封装
 * 要点（沿袭参考扩展踩坑结论）：
 * 1. meta 类对象一律 Object.assign 合并写，绝不整体覆盖；
 * 2. 写操作串行化（防 SW 被回收时并发写丢数据）；
 * 3. 报告/状态一律落 storage，不依赖回 popup（popup 会关、SW 会被回收）。 */
'use strict';

let _jtWriteChain = Promise.resolve();

function jtSetLocal(patch) {
  _jtWriteChain = _jtWriteChain.then(
    () => new Promise((res) => chrome.storage.local.set(patch, res))
  );
  return _jtWriteChain;
}
function jtGetLocal(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, res));
}
function jtGetSession(keys) {
  return new Promise((res) => chrome.storage.session.get(keys, res));
}
function jtSetSession(patch) {
  return new Promise((res) => chrome.storage.session.set(patch, res));
}

async function jtGetSettings() {
  const o = await jtGetLocal([JT_KEYS.SETTINGS]);
  const stored = o[JT_KEYS.SETTINGS] || {};
  /* 版本迁移（每段只跑一次）：merge 是存量胜，只改 JT_DEFAULT_SETTINGS 对老用户无效，
   * 迁移必须写在读取路径上。v2：词表换向「兼职」；v3：强制招呼语走系统预置（template 实测发不出去）。 */
  let dirty = false;
  if ((stored._v | 0) < 2) {
    stored.kwWhitelist = ['兼职'];
    stored.highThreshold = 10;
    stored._v = 2;
    dirty = true;
  }
  if ((stored._v | 0) < 3) {
    stored.greetingMode = 'system';
    stored._v = 3;
    dirty = true;
  }
  if (dirty) await jtSetLocal({ [JT_KEYS.SETTINGS]: stored });
  return Object.assign({}, JT_DEFAULT_SETTINGS, stored);
}
async function jtGetRules() {
  const o = await jtGetLocal([JT_KEYS.RULES]);
  return Object.assign({}, JT_DEFAULT_RULES, o[JT_KEYS.RULES] || {});
}
async function jtMergeSettings(patch) {
  const cur = await jtGetSettings();
  await jtSetLocal({ [JT_KEYS.SETTINGS]: Object.assign({}, cur, patch) });
}
async function jtMergeRules(patch) {
  const cur = await jtGetRules();
  await jtSetLocal({ [JT_KEYS.RULES]: Object.assign({}, cur, patch) });
}
