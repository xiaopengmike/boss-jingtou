/* 精投助手 - 常量（SW 侧唯一真源）
 * content 脚本无法 import 本文件，所需常量已在各 content 脚本顶部内联同值；
 * 修改此处必须同步修改 content/sniff-hook.js / sniff-relay.js / panel.js / greeter.js / chat-sender.js。 */
'use strict';

const JT_NS = '__jingtou__';
const JT_NS_VAL = 'v1';

const JT_KEYS = {
  SETTINGS: 'jt_settings',
  LEDGER: 'jt_ledger',
  DAILY: 'jt_daily',
  QUEUE: 'jt_queue',
  RULES: 'jt_rules',
  RUN: 'jt_run_state',
  SNIFF: 'jt_sniff_buffer',
  EXPORT: 'jt_export'
};

/* 嗅探环形缓冲参数（沿袭参考扩展 diag 参数） */
const JT_RING = {
  MAX_ITEMS: 400,
  MAX_BYTES: 4 * 1024 * 1024,
  ITEM_TRUNC: 256 * 1024,
  FLUSH_MS: 1500,
  SCAN_DEPTH: 7,
  SCAN_BUDGET: 1200,
  ARRAY_MAX: 60
};

/* 页面消息 type（MAIN <-> ISOLATED，经 window.postMessage） */
const JT_PMSG = {
  READY: 'SNIFF_READY',
  HIT: 'SNIFF_HIT',
  EXTRACT: 'EXTRACT',
  EXTRACT_RESULT: 'EXTRACT_RESULT',
  SET_RULES: 'SET_RULES',
  RULES_ACK: 'RULES_ACK'
};

/* 扩展消息 type（content/popup <-> SW，经 chrome.runtime.sendMessage） */
const JT_MSG = {
  HOOK_READY: 'SNIFF_HOOK_READY',
  SNIFF_HIT: 'SNIFF_HIT',
  GET_BUFFER: 'GET_BUFFER',
  CLEAR_BUFFER: 'CLEAR_BUFFER',
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  SAVE_RULES: 'SAVE_RULES',
  QUEUE_ADD: 'QUEUE_ADD',
  QUEUE_REMOVE: 'QUEUE_REMOVE',
  QUEUE_CLEAR: 'QUEUE_CLEAR',
  QUEUE_CLEAR_DONE: 'QUEUE_CLEAR_DONE',
  QUEUE_GO: 'QUEUE_GO',
  QUEUE_PAUSE: 'QUEUE_PAUSE',
  GREET_RESULT: 'GREET_RESULT',
  CHAT_RESULT: 'CHAT_RESULT',
  CAPTCHA_HIT: 'CAPTCHA_HIT',
  GET_STATE: 'GET_STATE',
  EXPORT_CSV: 'EXPORT_CSV',
  EXPORT_BUFFER: 'EXPORT_BUFFER',
  TIER_UP: 'TIER_UP',
  RESET_DAILY: 'RESET_DAILY',
  RESET_ALL: 'RESET_ALL'
};

const JT_ALARMS = { TICK: 'jt_tick', STEP: 'jt_step', DAILY_RESET: 'jt_daily_reset' };

/* 频控默认值（可被 jt_settings 覆盖）。dailyCap=100 为用户确认的平台额度上限。 */
const JT_THROTTLE_DEFAULTS = {
  dailyCap: 100,
  intervalMinSec: 45,
  intervalMaxSec: 180,
  windowStart: '10:00',
  windowEnd: '19:00',
  batchSize: 7,
  restMinMin: 8,
  restMaxMin: 15,
  failStreakLimit: 3
};

/* 灰度档位：effectiveCap = min(dailyCap, TIERS[tier])；升档必须人工，熔断自动降档 */
const JT_TIERS = [5, 20, 50, 100];

const JT_RE = {
  ENCRYPTED_ID: /^[0-9A-Za-z_~-]{16,64}$/,
  NUMERIC_ID: /^\d{4,20}$/
};

/* 埋点/噪音接口前缀：永不入库 */
const JT_NOISE_PREFIX = [
  '/wapi/zpCommon/actionLog/',
  '/wapi/zpApm/actionLog/',
  '/wapi/zpApm/httpMetrics/',
  '/wapi/zpCommon/log',
  '/wapi/zpgeek/actionlog'
];

/* 默认规则（可被 jt_rules 覆盖；M0 取证后校准，逻辑后置不发版可修） */
const JT_DEFAULT_RULES = {
  /* M0 取证校准：实际列表接口为 search/joblist 与 pc/recommend/job/list（原 job/recommend 路径不存在） */
  listUrlIncludes: ['/wapi/zpgeek/search/joblist', '/wapi/zpgeek/pc/recommend/job/list'],
  chatUrlIncludes: ['/web/chat'],
  detailUrlTpl: 'https://www.zhipin.com/job_detail/{jobId}.html',
  itemRequiredKeys: ['encryptJobId', 'jobName'],
  greetTexts: ['立即沟通', '打招呼'],
  greetedTexts: ['继续沟通'],
  captchaTexts: ['安全验证', '拖动下方滑块', '滑块', 'captcha'],
  /* M0 取证（2026-09-28）：打招呼弹框/编辑器/发送按钮真实结构（顶层 DOM，无 iframe/shadow） */
  chatDialogSelector: '.dialog-wrap.startchat-dialog',
  sendBtnClass: 'send-message',
  sendBtnDisabledClass: 'disable',
  sendBtnTexts: ['发送'],
  /* M0 取证（2026-09-28 晚）：点「立即沟通」后 BOSS 直接自动发出默认招呼语，并弹此标题的确认框
   *（框内含所发原文 + 「留在此页/继续沟通」按钮）——弹框本身即官方送达凭证，视为 verified */
  autoSentTexts: ['已向BOSS发送消息'],
  editorSelectors: ['[contenteditable="true"]', 'textarea'],
  labelArrayKeys: ['skills', 'labels', 'jobLabels', 'welfareList']
};

/* 默认设置（onInstalled 时合并写入）
 * _v 是设置版本号：老存量靠 jtGetSettings 里的迁移逻辑一次性升级（见 lib/storage.js）。
 * v2（2026-09-28）：目标换向「兼职」——旧默认白名单（数字化/IT经理/ITBP/研发效能/信息化/ALM/PLM）清零，
 * 白名单只留「兼职」；highThreshold 20→10，保证「标题含兼职（+10 分）」在 hybrid 模式下直接自动入队。
 * v3（2026-09-28）：强制 greetingMode='system'——自定义模板（清空+insertText）在 BOSS 侧实测发不出去，
 * 老存量若在设置页选过 template 会被存量胜压住，必须迁移强制回 system（只发 BOSS 预置默认招呼语）。 */
const JT_DEFAULT_SETTINGS = {
  _v: 3,
  accountLabel: '小号',
  autoMode: 'hybrid',   // 'hybrid' 白名单全自动+灰名单人工 | 'full' 纯全自动
  autoStart: false,     // full 模式下新增队列是否自动开跑
  pocMode: true,        // M0 取证期：记录全部非噪音 JSON；取证完关闭
  dailyCap: 100,
  tier: 0,              // 灰度档位 0..3 → 5/20/50/100
  intervalMinSec: 45,
  intervalMaxSec: 180,
  windowStart: '10:00',
  windowEnd: '19:00',
  batchSize: 7,
  restMinMin: 8,
  restMaxMin: 15,
  failStreakLimit: 3,
  kwWhitelist: ['兼职'],
  kwBlacklist: ['外包', '销售', '地推', '驻场'],
  requireActive: true,  // 硬门槛：只投 HR「刚刚活跃/今日活跃」的职位（其余直接淘汰，不再只是 +5 软加权）
  salaryMinK: 0,        // 0 = 不限制
  salaryMaxK: 0,
  cities: [],
  companyBlacklist: [],
  highThreshold: 10,    // 关键词得分 >= 此值 → 高置信（hybrid 模式下自动入队）；兼职命中即 10 分
  /* 招呼语模式：'system' 直发 BOSS 系统预置招呼语（friend/add 下发，实测自定义文本发不出去）；
   * 'template' 走旧路径：清空输入框后填入下面这个模板。 */
  greetingMode: 'system',
  greetingTemplate: '您好，我在{公司}的{职位名}里看到需要{JD关键词}。我负责研发数字化运营，落地过 ALM/禅道 与研发效能看板。方便聊聊吗？',
  closeTabAfter: true,
  stepTimeoutSec: 45
};
