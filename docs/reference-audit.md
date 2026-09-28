# 「招聘发布助手」可复用工程细节施工图（只读分析报告）

> 来源：`/tmp/ext_inspect/extension/`（已解压 Chrome MV3 扩展）。行号为源码实际行号。常量/正则/超时均原样抄录。

---

## 1. MAIN ↔ ISOLATED ↔ SW 三段消息协议

### 1.1 岗位探针链路（job-probe → job-probe-relay → background）

**魔术字段**：postMessage 载荷里用动态键做命名空间，两端完全一致：

- `content/job-probe.js:37-38` / `content/job-probe-relay.js:34-35`

```js
const NS = '__recruit_job_probe';
const NS_VAL = 'v1';
// 发送：{ [NS]: NS_VAL, type: 'JOB_HINT', payload: {...} }
// 校验：if (!d || typeof d !== 'object' || d[NS] !== NS_VAL) return;
```

**postMessage type 清单**（MAIN 探针发出）— `content/job-probe.js`：

| type | 发出位置 | 含义 |
|---|---|---|
| `RECORD` | :157 | 录制条目（诊断） |
| `RECORD_LIMIT` | :154 | 页面侧条数到硬上限，主动停录 |
| `RECORD_STATE` | :596/:600 | 开关变更后的状态回报 |
| `JOB_HINT` | :299 | 扫到疑似岗位 ID |
| `JOB_PUBLISHED` | :377 | 发布接口成功信号（权威） |
| `STATUS_RESULT` | :592 | 状态查询应答 |
| `PROBE_READY` | :618 | 探针装载完成宣告 |

**下行指令**（ISOLATED→MAIN，同 namespace 广播）— `job-probe-relay.js:44-48`：
`RECORD_ON` / `RECORD_OFF`（幂等）；探针还响应 `STATUS`（job-probe.js:591）。

**ISOLATED→SW（chrome.runtime.sendMessage）type 清单**（job-probe-relay.js:78-89 → background.js:202-221）：

| postMessage type | runtime type |
|---|---|
| `RECORD` | `JOB_PROBE_RECORD` |
| `RECORD_LIMIT` | `JOB_PROBE_RECORD_LIMIT` |
| `RECORD_STATE` | `JOB_PROBE_RECORD_STATE` |
| `JOB_HINT` | `JOB_PROBE_HINT` |

**SW→ISOLATED 下行**：`chrome.tabs.sendMessage(tabId, { target: 'job-probe-relay', command: 'RECORD_OFF' })`（background.js:556-557）；relay 按 `msg.target !== 'job-probe-relay'` 过滤（job-probe-relay.js:112）。

**应答模式**：无 requestId；popup 控制面用原生 sendResponse + `return true` 异步应答：
- `DIAG_GET_FLAG`（background.js:224-229，先 `diagEnsureHydrated()` 再答）
- `DIAG_STATUS` / `DIAG_START` / `DIAG_STOP` / `DIAG_CLEAR` / `DIAG_EXPORT`（:230-249）

**采集链路**（collect-hook → collect-bridge → background，主代理已读，此处只列 runtime type）：`COLLECT_REQUEST`（background.js:182）、`COLLECT_HOOK_READY`（:193）、`COLLECT_SET_RULES`（:2166，SW→页）、`COLLECT_EXTRACT`（:1181，SW→页，**所有帧广播，应答聚合成数组**）。

**填充/中台链路 runtime type**：`startFill`、`RECRUIT_SESSION_DETECTED`、`FILL_REQUEST`、`SENTINEL_REPORT`（background.js:92/100/122/148）；SW→中台 tab：`FILL_PROGRESS`、`FILL_RESULT`、`PUBLISH_BACK`（消息体带 `source: 'recruit-extension'`）。

**超时值总表**：
- `FILL_WAIT_FRAME_MS = 12000`（background.js:64，轮询间隔 500ms）
- `FILL_WAIT_RESULT_MS = 25000`（:66，轮询间隔 400ms）
- `FILL_DEDUP_MS = 20000`（:69）
- `waitTabComplete` 默认 15000（:1091）
- 哨兵 `timeoutMs: successConfig.timeoutMs || 60000`（:971）
- popup 侧 `pollFillResult(tab.id, 30000)`，间隔 500ms（popup.js:184/211）
- `DIAG_FLUSH_MS = 1500`（:273）
- relay 开关补发重试 `600` ms（job-probe-relay.js:103）
- bridge 心跳 `HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000`（content/bridge.js:29）

---

## 2. 环形缓冲参数与 detectHit 键表匹配

### 2.1 background 侧（真正的环形缓冲）— background.js:266-273

```js
const DIAG_KEY = 'diag_records';
const DIAG_META_KEY = 'diag_meta';
const DIAG_MAX_ITEMS = 400;            // 条数上限
const DIAG_MAX_TOTAL = 4 * 1024 * 1024; // body 长度合计上限（防撑爆 storage.session 配额）
const DIAG_FLUSH_MS = 1500;            // 写盘节流：内存攒批，避免每条都写
```

超限丢**最旧**（`merged.shift()`），`meta.trimmed` 计数累计（:366-371）。`diagAppend` 入队不 await 落盘，`diagScheduleFlush` 用单 timer 合并（:338-353）。

### 2.2 页面探针侧（只计数不囤数据）— content/job-probe.js:52-55, 124-125

```js
const BODY_MAX = 256 * 1024;   // 只解析 ≤256KB 的 JSON
const BIG_BODY = 5 * 1024 * 1024; // content-length 超 5MB 直接不读
const SCAN_DEPTH = 6;          // scanForJob 递归深度
const SCAN_BUDGET = 800;       // 节点访问预算
const REC_MAX_ITEMS = 3000;    // 页面侧硬上限（到顶主动停录并上报 RECORD_LIMIT）
const REC_MAX_BODY = 128 * 1024; // 单条录制 body 截断
// clipBody：>128KB 截断并标 truncated:true、chars: 原长（:161-165）
// reqBody 录制截断 4096 字符（:482）
```

刻意设计：页面侧上限(3000)比 background(400)宽，让「超额丢最旧」由 background 统一处理（:121-123 注释）。

### 2.3 detectHit 键表匹配（scanForJob, job-probe.js:225-274）

- 迭代 DFS：`stack=[[root,0]]`，`budget=SCAN_BUDGET`，`depth ≤ SCAN_DEPTH`，`seen` Set 防环，数组每层最多 20 项。
- 每节点单趟扫 keys：`rules.jobIdKeys.indexOf(k) >= 0 && isPlausibleJobId(v)` 取 jobId；`jobHintKeys` 取 hint；`JOB_CONTEXT_KEYS` 置 `hasContext`。
- **强证据**（同节点带旁证键）立即返回；**弱证据**先存 `weak` 继续找；最终 `return weak`。
- `JOB_CONTEXT_KEYS = ['jobName','jobTitle','positionName','jobStatus','encryptJobId','jobSalary','jobDescription','brandName','bossName']`（:74-77）。
- 读出后两级过滤（readJson :330-337）：`JOB_HINT_DENY_RE.test(url)` 丢弃；弱证据且 URL 不含 `/job`（`/\/job/i`）也丢弃——「宁可漏，不可错」。

---

## 3. chrome.storage key 清单

### 3.1 storage.local（持久）

| key | 写入位置 | 内容 / TTL |
|---|---|---|
| `baseUrl` | options.js:39 | 后端地址；无 TTL；background 有内存缓存 `cachedApiBase` 并用 `chrome.storage.onChanged` 失效（background.js:30,56-61） |
| `ext_token` | background.js:682 | 零配置授权换得的扩展 token（与 options 的 `extToken` 是**两套并存**的机制：options 手动粘贴走 session，自动换权走 local） |
| `lastFillReport` | background.js:1082 | 最近一次填充报告 `{recordId, requestNo, title, at, tabId, result}`；无 TTL，覆盖式 |
| `collect_self_uid` | background.js:1968, :2192 | HR 自己的 uid（排除自己），无 TTL |
| `collect_last_identity` | background.js:2500 | 最近采集身份槽 `{platformUserId, secondary, name, platformJobId, platformJobHint, ts}`；**TTL 5 分钟**：`COLLECT_LAST_IDENTITY_TTL_MS = 5 * 60 * 1000`（:1933-1934），读取时判过期返回 null（:1942） |

### 3.2 storage.session（会话级，关浏览器即清）

| key | 位置 | 内容 / TTL |
|---|---|---|
| `extToken` | options.js:41, popup.js:49 | 手动粘贴的 token（有意不落盘，安全设计） |
| `diag_recording` | background.js:311, :328 | 录制开关权威值（worker 重启水合） |
| `diag_records` | background.js:372 | 录制条目数组（环形缓冲，见 §2.1） |
| `diag_meta` | background.js:372 | `{count, bytes, trimmed, updatedAt, startedAt, tabId, registered, lastHint*, pageLimitHit*}`；**所有写都用 Object.assign 合并，绝不整体覆盖**（:531-534 实测踩坑注释） |
| `collect_recent_attachments` | background.js:1809, :1833 | webRequest 观察到的附件请求 `[{url, tabId, ts}]`；`ATTACH_TTL_MS = 30*60*1000`（:1405）、`ATTACH_CACHE_MAX = 40`（:1406）；兜底认领窗口 `ATTACH_TAB_FRESH_MS = 2*60*1000`（:1415） |

内存-only（不落 storage）：`fillRecent`（FILL 去重 Map）、`collectHookFrames`（hook 就绪时间戳）、`diagPending`/`diagFlushTimer`/`diagReady`/`diagExplicit`、`attachCache`（session 的内存镜像）、`cachedApiBase`。

---

## 4. background 编排模式（runFillTask, background.js:1010-1084）

**完整流水线**：开 tab → waitTabComplete → 轮询 frame 就绪 → 两步注入 → 轮询择优 → 落 storage。

1. **前台开 tab**（:1020）：`chrome.tabs.create({ url: entryUrl, active: true })` — 注释明确：后台 tab 会被 Chrome 定时器节流（隐藏 5 分钟后每分钟仅 1 次），填充引擎依赖 setTimeout，必须前台。

2. **waitTabComplete**（:1090-1110）：listener + timer 双保险 + `chrome.tabs.get` 立即查一次（防「监听挂上之前已 complete」）。`finish()` 幂等（`done` 标志 + removeListener + clearTimeout）。默认超时 15000。

3. **轮询等 frame 出表单控件**（:1024-1032）：`allFrames:true` 跑 `!!document.querySelector('input:not([type=hidden]), textarea, select')`，任一 frame true 即 break，500ms 间隔，上限 12s。

4. **两步注入**（:1041-1052）：
```js
// 第一步：executeScript 传配置（func + args，同 world 写入 window）
await chrome.scripting.executeScript({
  target: { tabId: tab.id, allFrames: true },
  func: (c) => { window.__RECRUIT_FILL_CONFIG__ = c; window.__RECRUIT_FILL_RESULT__ = null; },
  args: [config],
});
// 第二步：注引擎文件（每帧 IIFE 自动执行，检测到 config 即跑）
await chrome.scripting.executeScript({
  target: { tabId: tab.id, allFrames: true },
  files: ['content/fill-engine.js'],
});
```

5. **轮询择优**（:1054-1071）：每 400ms 全帧读 `window.__RECRUIT_FILL_RESULT__`，取 `summary.total>0` 中 `filled` 最多者（表单所在 frame）；完成判据 `s.filled > 0 && s.filled + s.skipped + s.failed >= s.total` 可提前 break，上限 25s。

6. **报告落 storage**：`chrome.storage.local.set({ lastFillReport: report })`（:1082），同时 return 给调用方。

**FILL 去重**（:69-80）：`FILL_DEDUP_MS = 20000`，`fillRecent: Map<recordId, ts>`；`isDuplicateFill` 每次先惰性清理过期项，命中即 `{ ok:true, deduped:true }` 不再开 tab（防消息重复转发开双 tab）。

**探针注入也是三步**（diagInjectProbe, :590-634）：① `func` 写 `__RECRUIT_JOB_PROBE_RULES__` + `__RECRUIT_JOB_PROBE_RECORD__`（world:'MAIN', allFrames）；② `files:['content/job-probe.js']`（MAIN, allFrames）；③ `files:['content/job-probe-relay.js']`（ISOLATED, allFrames，每帧各一份、只上报本帧）。每步独立 try/catch，任一失败 `ok=false` 但不抛。

**录制会话另有两层机制**（:451-561）：
- `chrome.scripting.registerContentScripts` 动态注册（`runAt:'document_start', allFrames:true, persistAcrossSessions:false`），注册前**先注销同 id**（否则 register 直接抛错）；
- `chrome.tabs.onUpdated` 导航兜底：`status==='complete'` 且 URL 匹配 `/^https?:\/\/([^/]*\.)?zhipin\.com\//` 就补注一次（注册对 MAIN world 的支持随 Chrome 版本而异、失败是静默的，不能押注）。

---

## 5. popup 与 background 的分工

**popup 只做**（popup.js）：
- 拉草稿列表渲染卡片（fetchDrafts → renderDrafts → draftCard，:62-149）；纯 DOM 拼装（createElement，不 innerHTML 注入数据）。
- 「标记已发布/失败」表单 + 直接 fetch 中台回填接口（submitReport :315-357）——popup 直连后端用的是 `storage.session.extToken`（手动粘贴那套）。
- 诊断录制控制面：全部转发给 background（`DIAG_START/STOP/CLEAR/EXPORT/STATUS`，:418-532），自己只渲染状态与做导出文件下载（Blob + a.click，:484-494；剪贴板兜底 :515-532）；开着时 `setInterval(diagRefresh, 2000)`（:504）。
- 遗留一套独立的两步注入填充（fillDraft :153-196，单帧 `target:{tabId}` 无 allFrames）——与 background 的 runFillTask 并存。

**background 只做**（无 UI）：全部跨帧编排、中台 API 调用（worker 有 host_permissions 且不受 CORS/页面跳转影响）、storage 读写、webRequest 观察、动态脚本注册。

**为什么报告落 storage 而不是只回 popup**（background.js:3-6 头注释原话）：popup 中途失焦关闭不影响流程；结果写 `lastFillReport`，popup 重开后仍可渲染最近一次报告。同理：录制数据落 `storage.session`（:201「人能导出、worker 重启也不丢」），因为 popup 是会关闭的、SW 是会被回收的，storage 是唯一稳定交接点。

---

## 6. 防护性工程模式清单

1. **重复注入守卫**：每支注入脚本顶层查 window 标志位。
   - job-probe.js:39,47-50：`GUARD='__recruit_job_probe_active'`，已注入则只调 `window[GUARD].setRecording(...)` 同步开关后 return；守卫值是对象 `{setRecording, status}`（:609-614）而非 true。
   - job-probe-relay.js:36-41：`GUARD='__recruit_job_probe_relay_active'`，值为 `true`，命中即 return。
   - background 侧注释（:506）：重复注入安全，因为探针有守卫。

2. **IIFE 包裹**：所有注入脚本 `(()) => { 'use strict'; ... })()`。理由原话（job-probe-relay.js:28-29）：「与其它注入脚本共享顶层作用域，裸写 let/const 会在同名时抛 SyntaxError 并让整支脚本不运行（见 bridge.js 事故）」。

3. **Extension context invalidated 处理**：
   - relay 的 toBackground（job-probe-relay.js:51-61）：`chrome.runtime.sendMessage` 回调里 `void chrome.runtime.lastError;`（吞掉 worker 休眠的 "Unchecked runtime.lastError" 噪声），整个调用 try/catch（重载扩展时必抛，咽掉）。
   - message-relay.js:80-81：`isInvalidationError = /context invalidated|extension context/i.test(...)`，判定后停止转发并广播提示页面刷新。
   - DIAG_GET_FLAG 水合（background.js:291-320）：SW 重启后内存标志空白，`diagReady` 进程内单例 Promise 保证只水合一次；`diagExplicit` 标志防水合结果覆盖用户显式操作（:301-317）。

4. **noise URL 过滤**（content/collect-hook.js:72-76, 127-135）：
```js
noisePathPrefixes: [
  '/wapi/zpCommon/actionLog/',
  '/wapi/zpApm/actionLog/',
  '/wapi/zpApm/httpMetrics/'
]
// isNoise(url)：indexOf(p) >= 0 即噪声；在进入环形缓冲的 3 个入口过滤（:344/:438/:526）
```
   另外有 `noisyKeys: ['jobStatus','status','name','position']`（:69）——命中键计数时这些「太泛」的键不计分。

5. **按值形态判定 ID 的正则**（background.js:1673-1683）：
```js
function looksEncryptedId(v) {
  const s = String(v);
  if (!/^[0-9A-Za-z_~-]{16,64}$/.test(s)) return false;
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  return true;
}
function looksNumericId(v) { return /^\d{6,}$/.test(String(v)); }
```
   job-probe.js 内联版 `isPlausibleJobId`（:201-219）：数字 `Number.isInteger && >0 && ≤12 位`；字符串 `/^\d{1,12}$/` 或 16-64 位且必须同时含数字与字母（允许 `_ ~ -`）。
   设计原则（background.js:1257-1261）：「键名遍历顺序不代表可信度……形态判定一律交给值的形状」——BOSS 同名键 `jobId` 在不同接口装不同形态。

6. **其它防御模式**：
   - 发布信号双标志（job-probe.js:349-355）：`body.code !== 0` 且 `zpData.rescode !== 1` 双成功才认，防「接口 200 但业务失败」占位式错误。
   - 污染黑名单正则（:101-102）：`JOB_HINT_DENY_RE = /\/(zpjob\/chat\/|zpjob\/view\/geek|zprelation\/friend\/|zpjob\/job\/save)/i`。
   - 发布接口识别（:90）：`PUBLISH_URL_RE = /\/wapi\/zpjob\/job\/save(\?|$|\/)/i`。
   - 附件 URL 识别（background.js:1403）：`ATTACH_URL_RE = /\/wflow\/[^/]+\/download\//i`。
   - 多人响应拦截（selectSources :1295-1303）：`distinctEncryptedIds(body).length > 1` 的响应既不能当字段来源也不能当身份来源（budget 2000、数组每层 60、background.js:1881-1901）。
   - 排除自己：`collect_self_uid` 学习自 `userBaseInfo.id`（learnSelfUid, budget 600, :1950-1978）。
   - 深度扫描统一模式：`budget` 递减 + `seen/visited` Set 防环 + 数组每层限项（20/30/50/60 各处不同，见 scanForKeys:1984-2006 budget 800 / extractFields:2014 budget 900 / collectIdentityHints:1635 budget 900 / bridgeIdentityIds:1707 budget 1500）。
   - 幂等键刻意不含 query（buildPlatformFileId :1424-1441）：`<kind>:<lastPathSeg>`，同一份文件的重定向形态算同一个键。
   - 缓存顺序显式排序（pruneAttachCache :1766-1787）：`sort((a,b)=>(b.ts||0)-(a.ts||0))`，注释记录过「倒序取近似最新会反转两次」的实测 bug。
   - PDF 魔数嗅探（:1573-1576）：前 4 字节 `0x25 0x50 0x44 0x46`（%PDF），content-type 不可信。
   - meta 合并写（:531-542）：`Object.assign({}, meta, {...})`，绝不整体覆盖。
   - 身份归并候选白名单（counterpartIdOf :1530-1540）：只允许 sel.secondary / expectedGeekId / bridgedIds 三个「同一人」来源，刻意不含口径更宽的 idHints。
   - URL 身份匹配（urlIdentityMatch :1598-1625）：路径段 + query 值 token 精确相等优先；`s.length < 6` 不做子串兜底；兜底正则 `'(?:^|[^0-9A-Za-z])' + esc + '(?:$|[^0-9A-Za-z])'`。

---

## 7. 频控/延迟/随机化：确认没有；附件串行下载的理由

**结论：全扩展没有任何频控、限速、随机化（jitter）代码。** background.js 里全部 setTimeout/setInterval 只有 4 处，全部是工程超时而非节流（grep 验证）：
- :349 diagFlush 批写节流（1500ms，攒批防抖，不是限速）
- :1087 sleep 工具（轮询间隔用）
- :1104 waitTabComplete 超时
- :1018 只是注释（解释为何前台开 tab）

popup.js 的 `setInterval(diagRefresh, 2000)`（:504）与 `setTimeout(fetchDrafts, 800)`（:356）同理是 UI 刷新。job-probe.js:553 的 `setTimeout(...,0)` 是把 JSON 解析推下一轮宏任务避免卡主线程。唯一的周期性网络动作是 bridge.js:29 的 5 分钟登录态心跳（`HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000`）。

原因可推断：该扩展所有动作都是**人逐条触发**（HR 点按钮才采集、中台页面人点触发才填充），天然低速，无需限速。对新扩展（自动打招呼投递）这恰恰是**需要自己新增的部分**。

**附件串行下载的注释理由**（background.js:2483-2486，原样）：
```js
for (let i = 0; i < needIds.length && i < allAttachments.length; i += 1) {
  // 串行：并发下载大文件容易触发平台风控，也让失败归因更难
  // eslint-disable-next-line no-await-in-loop
  const okOne = await downloadAndUploadAttachment(needIds[i], allAttachments[i], token);
```
另有两处「少打一次平台请求」的克制设计可借鉴：探测命中后 `prefetchedBlob` 直接复用不再二次请求（:2109-2110）；主动探测只在「观察路径一份都没拿到」时才启动（:2380-2382，「多打一次平台请求 = 多一分风控暴露面」）。

---

## 附：对新扩展（求职者侧）的直接借鉴清单

1. 三段协议照搬：MAIN hook（守卫+IIFE+`[NS]:NS_VAL` 命名空间）→ ISOLATED relay（`ev.source===window` 恰好一次）→ SW（storage 权威 + 应答 `return true`）。
2. 职位列表抓取可复用 scanForJob 骨架：budget/depth/seen 三件套 + 强/弱证据分级 + URL 白/黑名单二级过滤；键表换成列表接口字段（`encryptJobId/jobName/salaryDesc/brandName` 等，JOB_CONTEXT_KEYS 已含大半）。
3. 列表型响应恰是该扩展**拦掉**的「多人响应」——新扩展反过来要把 `distinctEncryptedIds > 1` 当作列表信号，参考 bridgeIdentityIds 的同节点配对思路按行拆出职位条目。
4. 自动打招呼必须新增频控层（本扩展没有）：建议放 SW（生命周期独立于页面跳转），台账落 storage.local（参考 `collect_last_identity` 的 {value, ts} + TTL 模式），去重窗口参考 `isDuplicateFill` 的 Map + 惰性清理。
5. 报告/状态交接一律落 storage（popup 会关、SW 会被回收）；任务队列可仿 diag 环形缓冲（条数+字节双上限、丢最旧、trimmed 计数、合并写 meta）。
6. 注入编排照搬 runFillTask：前台 tab → waitTabComplete(15s) → frame 轮询 → func 传配置 → files 注引擎 → 轮询 `window.__RESULT__` 择优。
