/* 精投助手 Service Worker：嗅探缓冲 / 队列状态机 / 频控 / tab 编排与两步注入 / 台账
 *
 * MV3 生存约束（本文件的根本设计依据）：
 * - SW 30s 无活动即被回收，绝不用 setTimeout 跨长等待驱动流程；
 *   一切等待都落 jt_run_state + chrome.alarms（TICK 步进 / STEP 步骤超时 / DAILY_RESET 日重置）。
 * - 长步骤（点沟通/发消息）由 content 脚本完成后**新发消息**回报（GREET_RESULT/CHAT_RESULT），
 *   SW 不挂起 sendResponse 傻等（沿袭参考扩展"报告落 storage、轮询择优"哲学）。
 * - 队列串行执行：参考扩展原话"并发容易触发平台风控，也让失败归因更难"。
 */
'use strict';

importScripts('lib/constants.js', 'lib/storage.js', 'lib/throttle.js', 'lib/ledger.js');

/* ================= 安装与初始化 ================= */
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await jtGetLocal([JT_KEYS.SETTINGS, JT_KEYS.RULES]);
  const patch = {};
  if (!cur[JT_KEYS.SETTINGS]) patch[JT_KEYS.SETTINGS] = JT_DEFAULT_SETTINGS;
  if (!cur[JT_KEYS.RULES]) patch[JT_KEYS.RULES] = JT_DEFAULT_RULES;
  if (Object.keys(patch).length) await jtSetLocal(patch);
  jtScheduleDailyReset();
});
chrome.runtime.onStartup.addListener(() => jtScheduleDailyReset());

function jtScheduleDailyReset() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(0, 5, 0, 0);
  chrome.alarms.create(JT_ALARMS.DAILY_RESET, { when: next.getTime() });
}

/* ================= 嗅探环形缓冲（内存 + session 节流落盘） ================= */
const jtSniff = { items: [], bytes: 0, dropped: 0, dirty: false, timer: null };
jtSniffLoad();

async function jtSniffLoad() {
  try {
    const o = await jtGetSession([JT_KEYS.SNIFF]);
    const b = o[JT_KEYS.SNIFF];
    if (b && Array.isArray(b.items)) {
      jtSniff.items = b.items;
      jtSniff.bytes = b.bytes | 0;
      jtSniff.dropped = b.dropped | 0;
    }
  } catch (e) { /* session 不可用时静默降级为纯内存 */ }
}
function jtSniffPush(item) {
  if (!item || typeof item.url !== 'string') return;
  let size = item.text ? item.text.length : 0;
  if (size > JT_RING.ITEM_TRUNC) {
    item.text = item.text.slice(0, JT_RING.ITEM_TRUNC);
    item.trimmed = true;
    size = JT_RING.ITEM_TRUNC;
  }
  jtSniff.items.push(item);
  jtSniff.bytes += size;
  while (jtSniff.items.length > JT_RING.MAX_ITEMS || jtSniff.bytes > JT_RING.MAX_BYTES) {
    const old = jtSniff.items.shift();
    if (!old) break;
    jtSniff.bytes -= old.text ? old.text.length : 0;
    jtSniff.dropped++;
  }
  jtSniff.dirty = true;
  if (!jtSniff.timer) jtSniff.timer = setTimeout(jtSniffFlush, JT_RING.FLUSH_MS);
}
async function jtSniffFlush() {
  jtSniff.timer = null;
  if (!jtSniff.dirty) return;
  jtSniff.dirty = false;
  try {
    await jtSetSession({ [JT_KEYS.SNIFF]: { items: jtSniff.items, bytes: jtSniff.bytes, dropped: jtSniff.dropped } });
  } catch (e) { /* 忽略 */ }
}

/* ================= 运行状态 / 队列 ================= */
async function jtRunGet() {
  const o = await jtGetSession([JT_KEYS.RUN]);
  return o[JT_KEYS.RUN] || { running: false, current: null, failStreak: 0, sentSinceRest: 0, nextAt: 0, pausedReason: '', gateReason: '' };
}
async function jtRunSet(patch) {
  const cur = await jtRunGet();
  await jtSetSession({ [JT_KEYS.RUN]: Object.assign({}, cur, patch) });
}
async function jtQueueGet() {
  const o = await jtGetLocal([JT_KEYS.QUEUE]);
  return o[JT_KEYS.QUEUE] || [];
}
async function jtQueueSet(q) {
  await jtSetLocal({ [JT_KEYS.QUEUE]: q });
}

/* ================= 主循环（状态机，由消息/闹钟驱动） ================= */
let jtBusy = false;

async function jtTick() {
  if (jtBusy) return;
  jtBusy = true;
  try {
    const run = await jtRunGet();
    if (!run.running) return;
    if (run.current) return; // 有进行中的步骤：等 GREET/CHAT_RESULT 或 STEP 超时
    const now = Date.now();
    if (run.nextAt && now < run.nextAt) {
      jtScheduleTick(run.nextAt);
      return;
    }
    const settings = await jtGetSettings();
    const daily = await jtDailyGet();
    const gate = jtCanProceed(daily, run, settings, new Date());
    if (!gate.ok) {
      if (gate.reason === 'fuse_blown') {
        await jtRunSet({ running: false, pausedReason: 'fuse_blown', gateReason: '' });
      } else {
        /* 触顶/出时段：保持 running 以便到点自动恢复（纯全自动语义），
         * 但记 gateReason 让 popup 如实显示"已达上限/不在时段"，而非误导性的"等待下一条" */
        await jtRunSet({ nextAt: now + gate.waitMs, gateReason: gate.reason });
        jtScheduleTick(now + gate.waitMs);
      }
      return;
    }
    if (run.gateReason) await jtRunSet({ gateReason: '' });
    const queue = await jtQueueGet();
    const nextItem = queue.find((it) => it.status === 'queued');
    if (!nextItem) {
      await jtRunSet({ running: false, pausedReason: 'queue_empty' });
      return;
    }
    /* 幂等复核：台账是唯一真源 */
    if (await jtLedgerHas(nextItem.jobId)) {
      nextItem.status = 'skipped_dup';
      await jtQueueSet(queue);
      setTimeout(() => jtTick(), 300);
      return;
    }
    nextItem.status = 'greeting';
    await jtQueueSet(queue);
    const rules = await jtGetRules();
    const url = rules.detailUrlTpl.replace('{jobId}', encodeURIComponent(nextItem.jobId));
    /* system 模式不生成文本：实际发送内容由 chat-sender 读页面预置招呼语后回报（台账记真实文本） */
    const greeting = settings.greetingMode === 'template' ? jtRenderGreeting(settings.greetingTemplate, nextItem) : '';
    /* 必须前台 tab：后台 tab 会被 Chrome 定时器节流，而页面内流程依赖 setTimeout（参考扩展踩坑） */
    const tab = await new Promise((res) => chrome.tabs.create({ url, active: true }, res));
    await jtRunSet({ current: { jobId: nextItem.jobId, stage: 'greet', tabId: tab.id, since: now, greeting } });
    jtScheduleStepTimeout(settings.stepTimeoutSec || 45);
    /* 加载完成后由 tabs.onUpdated 触发两步注入 */
  } finally {
    jtBusy = false;
  }
}

function jtScheduleTick(when) {
  chrome.alarms.create(JT_ALARMS.TICK, { when: Math.max(when, Date.now() + 1000) });
}
function jtScheduleStepTimeout(sec) {
  chrome.alarms.create(JT_ALARMS.STEP, { when: Date.now() + sec * 1000 });
}

function jtRenderGreeting(tpl, item) {
  const kw = (item.keywords && item.keywords[0]) || item.title || '';
  return String(tpl || '')
    .replaceAll('{公司}', item.company || '')
    .replaceAll('{职位名}', item.title || '')
    .replaceAll('{JD关键词}', kw)
    .replaceAll('{我的量化匹配点}', '')
    .replaceAll('{N}', '');
}

/* ================= tab 加载完成 → 两步注入（先写 config，再注脚本） ================= */
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const run = await jtRunGet();
  if (!run.running || !run.current || run.current.tabId !== tabId) return;
  const rules = await jtGetRules(); /* 注入带上规则：BOSS 改版时改设置页规则 JSON 即生效，不用改代码 */
  if (run.current.stage === 'greet') {
    await jtInject(tabId, 'window.__JT_GREET_CONFIG__', { jobId: run.current.jobId, rules }, 'content/greeter.js');
  } else if (run.current.stage === 'chat') {
    const settings = await jtGetSettings();
    await jtInject(tabId, 'window.__JT_CHAT_CONFIG__', {
      greeting: run.current.greeting,
      greetingMode: settings.greetingMode,
      jobId: run.current.jobId,
      rules
    }, 'content/chat-sender.js');
  }
});

async function jtInject(tabId, assignExpr, cfg, file) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (expr, c) => {
        // expr 形如 'window.__JT_GREET_CONFIG__'
        const key = expr.replace('window.', '');
        window[key] = c;
      },
      args: [assignExpr, cfg]
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  } catch (e) { /* 页面可能已跳转/关闭，由 STEP 超时兜底 */ }
}

/* ================= 步骤结果处理 ================= */
async function jtFinishItem(jobId, status, note) {
  const queue = await jtQueueGet();
  const it = queue.find((q) => q.jobId === jobId);
  if (it) it.status = status;
  await jtQueueSet(queue);
  const settings = await jtGetSettings();
  const run = await jtRunGet();
  const ledger = await jtLedgerGet();
  const cur = ledger[jobId] || { attempts: 0 };
  ledger[jobId] = Object.assign({}, cur, {
    jobId,
    status,
    title: it ? it.title : cur.title || '',
    company: it ? it.company : cur.company || '',
    salary: it ? it.salary : cur.salary || '',
    account: settings.accountLabel,
    greeting: run.current && run.current.jobId === jobId ? run.current.greeting : cur.greeting || '',
    at: Date.now(),
    attempts: (cur.attempts | 0) + 1,
    note: note || cur.note || ''
  });
  await jtSetLocal({ [JT_KEYS.LEDGER]: ledger });
}

/* 一条结束后的收尾：关 tab、算失败 streak、算下一条等待、调度 */
async function jtAdvanceAfterItem(run, success, countRest) {
  const settings = await jtGetSettings();
  const failStreak = success ? 0 : (run.failStreak | 0) + 1;
  const sentSinceRest = countRest ? (run.sentSinceRest | 0) + 1 : (run.sentSinceRest | 0);
  if (settings.closeTabAfter && run.current && run.current.tabId != null) {
    try { chrome.tabs.remove(run.current.tabId, () => void chrome.runtime.lastError); } catch (e) { /* 忽略 */ }
  }
  if (failStreak >= (settings.failStreakLimit | 0)) {
    await jtRunSet({ running: false, pausedReason: 'fuse_blown', current: null, failStreak, gateReason: '' });
    return;
  }
  const wait = jtNextWaitMs({ sentSinceRest }, settings);
  const nextAt = Date.now() + wait.ms;
  await jtRunSet({
    current: null,
    failStreak,
    sentSinceRest: wait.kind === 'rest' ? 0 : sentSinceRest,
    nextAt,
    gateReason: ''
  });
  jtScheduleTick(nextAt);
}

async function jtHandleGreetResult(p) {
  const run = await jtRunGet();
  if (!run.current || run.current.jobId !== p.jobId) return;
  if (p.branch === 'captcha') {
    await jtRunSet({ running: false, pausedReason: 'captcha' });
    await jtFinishItem(p.jobId, 'failed_captcha');
    return;
  }
  if (p.branch === 'already') {
    /* 此前已沟通过：不重复发，不计今日发送数，但记台账防日后再撞 */
    await jtFinishItem(p.jobId, 'msged', '此前已沟通');
    await jtAdvanceAfterItem(run, true, false);
    return;
  }
  if (p.branch === 'auto_sent') {
    /* M0(晚)：点「立即沟通」即被 BOSS 自动发出默认招呼语并弹确认框——
     * 弹框即官方送达凭证：直接记 verified、计今日发送、跳过 chat 阶段。
     * 若漏识此框会报 post_click_timeout → failed_click → 该职位会被重新入队重复打招呼 */
    if (p.sentText) await jtRunSet({ current: Object.assign({}, run.current, { greeting: p.sentText }) });
    await jtFinishItem(p.jobId, 'verified', 'BOSS自动发送+确认弹框');
    await jtDailyInc('sent');
    await jtAdvanceAfterItem(run, true, true);
    return;
  }
  if (!p.ok) {
    await jtFinishItem(p.jobId, 'failed_click');
    await jtDailyInc('failed');
    await jtAdvanceAfterItem(run, false, false);
    return;
  }
  /* 点击成功：进入聊天阶段。navigate 分支等 onUpdated 注入；same_page 分支立即注入 */
  await jtRunSet({ current: Object.assign({}, run.current, { stage: 'chat' }) });
  const settings = await jtGetSettings();
  if (p.branch === 'same_page_chat') {
    const rules = await jtGetRules();
    await jtInject(run.current.tabId, 'window.__JT_CHAT_CONFIG__', {
      greeting: run.current.greeting,
      greetingMode: settings.greetingMode,
      jobId: p.jobId,
      rules
    }, 'content/chat-sender.js');
  }
  jtScheduleStepTimeout(settings.stepTimeoutSec || 45);
}

async function jtHandleChatResult(p) {
  const run = await jtRunGet();
  if (!run.current || run.current.jobId !== p.jobId) return;
  /* system 模式：台账记 chat-sender 回报的**实际发出文本**（页面预置招呼语），而不是模板 */
  if (p.sentText) await jtRunSet({ current: Object.assign({}, run.current, { greeting: p.sentText }) });
  if (p.captcha) {
    await jtRunSet({ running: false, pausedReason: 'captcha' });
    await jtFinishItem(p.jobId, 'failed_captcha');
    return;
  }
  if (!p.sent) {
    await jtFinishItem(p.jobId, 'failed_send', p.err || '');
    await jtDailyInc('failed');
    await jtAdvanceAfterItem(run, false, false);
    return;
  }
  /* 防静默失效：发送成功但聊天区没出现刚发的文本 → suspected_silent，计入熔断 */
  const verified = !!p.verified;
  await jtFinishItem(p.jobId, verified ? 'verified' : 'suspected_silent');
  await jtDailyInc('sent');
  if (!verified) await jtDailyInc('suspectedSilent');
  await jtAdvanceAfterItem(run, verified, true);
}

/* ================= 消息路由 ================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const t = msg.type;

  if (t === JT_MSG.SNIFF_HIT) {
    jtSniffPush(msg.payload);
    sendResponse({ ok: true });
    return;
  }
  if (t === JT_MSG.GET_BUFFER) {
    (async () => {
      await jtSniffFlush();
      sendResponse({ ok: true, items: jtSniff.items, dropped: jtSniff.dropped });
    })();
    return true;
  }
  if (t === JT_MSG.CLEAR_BUFFER) {
    jtSniff.items = [];
    jtSniff.bytes = 0;
    jtSniff.dirty = true;
    jtSniffFlush().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.GET_SETTINGS) {
    Promise.all([jtGetSettings(), jtGetRules()]).then(([settings, rules]) => sendResponse({ ok: true, settings, rules }));
    return true;
  }
  if (t === JT_MSG.SAVE_SETTINGS) {
    jtSetLocal({ [JT_KEYS.SETTINGS]: Object.assign({}, JT_DEFAULT_SETTINGS, msg.settings || {}) })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.SAVE_RULES) {
    jtSetLocal({ [JT_KEYS.RULES]: Object.assign({}, JT_DEFAULT_RULES, msg.rules || {}) })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.QUEUE_ADD) {
    jtHandleQueueAdd(msg.items || [], !!msg.auto).then((r) => sendResponse(r));
    return true;
  }
  if (t === JT_MSG.QUEUE_REMOVE) {
    (async () => {
      const q = await jtQueueGet();
      await jtQueueSet(q.filter((it) => it.jobId !== msg.jobId));
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (t === JT_MSG.QUEUE_CLEAR_DONE) {
    (async () => {
      const q = await jtQueueGet();
      await jtQueueSet(q.filter((it) => it.status === 'queued' || it.status === 'greeting'));
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (t === JT_MSG.QUEUE_CLEAR) {
    (async () => {
      const q = await jtQueueGet();
      await jtQueueSet([]);
      /* 连运行态一起复位：否则正在跑的 current 会留下悬挂 tab，TICK 还会继续推进 */
      await jtRunSet({ running: false, pausedReason: 'manual', current: null, nextAt: 0, gateReason: '', failStreak: 0 });
      sendResponse({ ok: true, cleared: q.length });
    })();
    return true;
  }
  if (t === JT_MSG.RESET_ALL) {
    (async () => {
      const [q, l] = await Promise.all([jtQueueGet(), jtLedgerGet()]);
      await jtSetLocal({ [JT_KEYS.QUEUE]: [], [JT_KEYS.LEDGER]: {} });
      await jtDailyPatch({ sent: 0, failed: 0, suspectedSilent: 0, paused: false, pauseReason: '' });
      await jtRunSet({ running: false, pausedReason: 'manual', current: null, nextAt: 0, gateReason: '', failStreak: 0, sentSinceRest: 0 });
      sendResponse({ ok: true, queue: q.length, ledger: Object.keys(l).length });
    })();
    return true;
  }
  if (t === JT_MSG.QUEUE_GO) {
    jtRunSet({ running: true, pausedReason: '', nextAt: 0, failStreak: 0, gateReason: '' })
      .then(() => { jtTick(); sendResponse({ ok: true }); });
    return true;
  }
  if (t === JT_MSG.QUEUE_PAUSE) {
    jtRunSet({ running: false, pausedReason: 'manual' }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.GREET_RESULT) {
    jtHandleGreetResult(msg.payload || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.CHAT_RESULT) {
    jtHandleChatResult(msg.payload || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.CAPTCHA_HIT) {
    jtRunSet({ running: false, pausedReason: 'captcha' })
      .then(() => jtDailyPatch({ paused: true, pauseReason: 'captcha' }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.GET_STATE) {
    jtBuildState().then((s) => sendResponse(s));
    return true;
  }
  if (t === JT_MSG.EXPORT_CSV) {
    jtLedgerCsv().then((csv) => jtOpenExportTab(csv, 'jingtou-ledger.csv', 'text/csv'))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (t === JT_MSG.EXPORT_BUFFER) {
    (async () => {
      await jtSniffFlush();
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), dropped: jtSniff.dropped, items: jtSniff.items }, null, 2);
      await jtOpenExportTab(json, 'jingtou-sniff-buffer.json', 'application/json');
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (t === JT_MSG.TIER_UP) {
    (async () => {
      const s = await jtGetSettings();
      const nt = Math.min((s.tier | 0) + 1, JT_TIERS.length - 1);
      await jtMergeSettings({ tier: nt });
      sendResponse({ ok: true, tier: nt, cap: jtEffectiveCap(Object.assign({}, s, { tier: nt })) });
    })();
    return true;
  }
  if (t === JT_MSG.RESET_DAILY) {
    jtDailyPatch({ sent: 0, failed: 0, suspectedSilent: 0, paused: false, pauseReason: '' })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

/* 导出统一走 options 页下载：popup 会被关闭打断，Blob URL 随页面销毁失效（参考扩展踩坑） */
async function jtOpenExportTab(content, filename, mime) {
  await jtSetSession({ [JT_KEYS.EXPORT]: { content, filename, mime, at: Date.now() } });
  await new Promise((res) => chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html') + '#export', active: true }, res));
}

async function jtHandleQueueAdd(items, auto) {
  const queue = await jtQueueGet();
  const ledger = await jtLedgerGet();
  const settings = await jtGetSettings();
  let added = 0;
  for (const it of items) {
    if (!it || !it.jobId) continue;
    if (queue.some((q) => q.jobId === it.jobId && (q.status === 'queued' || q.status === 'greeting'))) continue;
    const le = ledger[it.jobId];
    if (le && JT_LEDGER_DONE.includes(le.status)) continue;
    queue.push({
      jobId: it.jobId,
      title: it.title || '',
      company: it.company || '',
      salary: it.salary || '',
      score: it.score | 0,
      tier: it.tier || 'gray',
      keywords: it.keywords || [],
      status: 'queued',
      source: auto ? 'auto' : 'manual',
      addedAt: Date.now()
    });
    added++;
  }
  await jtQueueSet(queue);
  /* 纯全自动：新增即开跑（autoMode='full' 且 autoStart 开） */
  if (added && settings.autoMode === 'full' && settings.autoStart) {
    const run = await jtRunGet();
    if (!run.running) {
      await jtRunSet({ running: true, pausedReason: '', nextAt: 0, gateReason: '' });
      jtTick();
    }
  }
  return { ok: true, added };
}

async function jtBuildState() {
  const [settings, daily, run, queue] = await Promise.all([jtGetSettings(), jtDailyGet(), jtRunGet(), jtQueueGet()]);
  const cap = jtEffectiveCap(settings);
  const today = jtDateStr(new Date());
  const sent = daily.date === today ? daily.sent | 0 : 0;
  return {
    ok: true,
    accountLabel: settings.accountLabel,
    autoMode: settings.autoMode,
    tier: settings.tier | 0,
    cap,
    sent,
    failed: daily.date === today ? daily.failed | 0 : 0,
    suspectedSilent: daily.date === today ? daily.suspectedSilent | 0 : 0,
    queued: queue.filter((q) => q.status === 'queued').length,
    running: !!run.running,
    pausedReason: run.pausedReason || '',
    gateReason: run.gateReason || '',
    windowStart: settings.windowStart,
    failStreak: run.failStreak | 0,
    current: run.current,
    nextAt: run.nextAt || 0,
    queue: queue.slice(-200)
  };
}

/* ================= 闹钟 ================= */
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === JT_ALARMS.TICK) {
    jtTick();
    return;
  }
  if (a.name === JT_ALARMS.DAILY_RESET) {
    await jtDailyPatch({ sent: 0, failed: 0, suspectedSilent: 0, paused: false, pauseReason: '' });
    jtScheduleDailyReset();
    return;
  }
  if (a.name === JT_ALARMS.STEP) {
    /* 步骤超时：DOM 超时不轻易落终态（参考扩展哲学），标 failed_timeout 可复查，但队列必须前进 */
    const run = await jtRunGet();
    if (run.running && run.current) {
      const jobId = run.current.jobId;
      await jtFinishItem(jobId, 'failed_timeout');
      await jtDailyInc('failed');
      await jtAdvanceAfterItem(run, false, false);
    }
    return;
  }
});
