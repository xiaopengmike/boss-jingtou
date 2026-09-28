/* 精投助手 - 台账
 * jt_ledger 是幂等去重的唯一真源：jobId → {status, title, company, salary, account, greeting, at, attempts, note}
 * 状态机：queued → greeting → verified / suspected_silent / failed_* / msged(此前已沟通)
 * 每条记录带 accountLabel（小号/主账号分区），防两个账号数据混表污染回复率统计。 */
'use strict';

const JT_LEDGER_ACTIVE = ['queued', 'greeting'];
const JT_LEDGER_DONE = ['msged', 'verified', 'suspected_silent'];

async function jtLedgerGet() {
  const o = await jtGetLocal([JT_KEYS.LEDGER]);
  return o[JT_KEYS.LEDGER] || {};
}
async function jtLedgerHas(jobId) {
  const l = await jtLedgerGet();
  const e = l[jobId];
  return !!(e && JT_LEDGER_ACTIVE.concat(JT_LEDGER_DONE).includes(e.status));
}
async function jtLedgerUpsert(jobId, patch) {
  const l = await jtLedgerGet();
  const cur = l[jobId] || { attempts: 0 };
  l[jobId] = Object.assign({}, cur, patch, { jobId });
  await jtSetLocal({ [JT_KEYS.LEDGER]: l });
}

async function jtDailyGet() {
  const o = await jtGetLocal([JT_KEYS.DAILY]);
  return o[JT_KEYS.DAILY] || { date: '', sent: 0, failed: 0, suspectedSilent: 0, paused: false, pauseReason: '' };
}
function jtDailyBase(cur) {
  const today = jtDateStr(new Date());
  return cur.date === today
    ? cur
    : { date: today, sent: 0, failed: 0, suspectedSilent: 0, paused: false, pauseReason: '' };
}
async function jtDailyPatch(patch) {
  const base = jtDailyBase(await jtDailyGet());
  await jtSetLocal({ [JT_KEYS.DAILY]: Object.assign({}, base, patch, { date: jtDateStr(new Date()) }) });
}
async function jtDailyInc(field, n) {
  const base = jtDailyBase(await jtDailyGet());
  base[field] = (base[field] | 0) + (n || 1);
  await jtSetLocal({ [JT_KEYS.DAILY]: base });
}

function jtCsvEsc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function jtLedgerCsv() {
  const l = await jtLedgerGet();
  const rows = [['jobId', '职位', '公司', '薪资', '账号', '状态', '招呼语', '时间', '尝试次数', '备注'].map(jtCsvEsc).join(',')];
  for (const id of Object.keys(l)) {
    const e = l[id];
    rows.push([
      id, e.title, e.company, e.salary, e.account, e.status, e.greeting,
      e.at ? new Date(e.at).toLocaleString('zh-CN') : '', e.attempts | 0, e.note
    ].map(jtCsvEsc).join(','));
  }
  return '﻿' + rows.join('\n');
}
