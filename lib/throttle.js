/* 精投助手 - 频控闸门（纯函数，单测友好）
 * 这是本方案的核心层：参考扩展完全没有频控（它所有动作都是人逐条触发），必须自建。
 * 闸门判据：日上限（灰度档位）→ 活跃时段 → 熔断；均不通过时返回 waitMs 由编排层挂起。 */
'use strict';

function jtDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function jtParseHM(s, defMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return defMin;
  return (+m[1]) * 60 + (+m[2]);
}
function jtMinutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/* 有效日上限 = min(用户配置, 灰度档位)。100 是平台额度，不是首发值。 */
function jtEffectiveCap(settings) {
  const tier = Math.max(0, Math.min(settings.tier | 0, JT_TIERS.length - 1));
  const tierCap = JT_TIERS[tier];
  const userCap = settings.dailyCap > 0 ? settings.dailyCap : tierCap;
  return Math.min(userCap, tierCap);
}

/* daily: {date, sent, ...}  runState: {failStreak, ...}  now: Date */
function jtCanProceed(daily, runState, settings, now) {
  const cap = jtEffectiveCap(settings);
  const today = jtDateStr(now);
  const sentToday = daily && daily.date === today ? (daily.sent | 0) : 0;
  if (sentToday >= cap) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 5, 0, 0);
    return { ok: false, reason: 'daily_cap', waitMs: next.getTime() - now.getTime() };
  }
  const ws = jtParseHM(settings.windowStart, 10 * 60);
  const we = jtParseHM(settings.windowEnd, 19 * 60);
  const md = jtMinutesOfDay(now);
  if (md < ws || md >= we) {
    const next = new Date(now);
    if (md >= we) next.setDate(next.getDate() + 1);
    next.setHours(Math.floor(ws / 60), ws % 60, 0, 0);
    return { ok: false, reason: 'out_of_window', waitMs: next.getTime() - now.getTime() };
  }
  if ((runState.failStreak | 0) >= (settings.failStreakLimit | 0)) {
    return { ok: false, reason: 'fuse_blown', waitMs: 0 };
  }
  return { ok: true, reason: '', waitMs: 0 };
}

function jtRandInt(min, max) {
  min = Math.max(0, min | 0);
  max = Math.max(min, max | 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

/* 下一条等待：批次休息优先于条间间隔 */
function jtNextWaitMs(runState, settings) {
  if ((runState.sentSinceRest | 0) >= (settings.batchSize | 0)) {
    return { ms: jtRandInt(settings.restMinMin, settings.restMaxMin) * 60000, kind: 'rest' };
  }
  return { ms: jtRandInt(settings.intervalMinSec, settings.intervalMaxSec) * 1000, kind: 'interval' };
}
