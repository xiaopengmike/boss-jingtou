# 方案：BOSS直聘「精投加速器」浏览器扩展

> 目标：在 BOSS 直聘**求职者侧**网页端做批量投递，参考已审计的 HR 侧扩展（`/tmp/ext_inspect/extension/`）的「简历采集」架构。
> 施工参考笔记（含全部原样常量/正则/行号）：`docs/reference-audit.md`（同目录）

---

## 0. 定位（先纠正一个前提）

**不做纯海投，做"精投加速器"。** 理由不是道德，是工程现实：

| 事实 | 来源 | 后果 |
| --- | --- | --- |
| 每日打招呼有硬上限 | BOSS 求职者端规则 | **天花板 = 100 条/天（用户 2026-09-27 确认）**，投再多也发不出去 |
| 触顶后**招呼静默失效** | 界面正常、对方收不到 | 台账会虚高——尤其贴顶跑时，你以为发了 100，实际送达可能只有 30 |
| 等距毫秒级点击极易识别 | 时序指纹 | 暴力脚本 → 限流 → 限功能 → 封号 |
| 投递定位错误不可逆 | 同公司冷却期 | 旧版简历海投会把错标签放大 100 倍 |


**产品定义**：抓列表 → 本地筛选打分 → **人工确认队列** → **低速**自动打招呼 → 台账追踪回复率。

日上限按 **100 条/天（平台额度）** 设计，`DAILY_CAP` 可配 5–100；**首次上线的实际值由灰度爬坡决定（5 → 20 → 50 → 100），不是一上来就 100**（见 §7.2）。
**参考扩展能活得滋润，是因为它做的是平台鼓励的事（HR 发岗位）；我们做的是平台专门防的事，所以限速层是本方案的核心，不是附属。**

---

## 1. 参考架构 → 新架构映射

| 参考扩展的部件 | 新扩展怎么用 |
| --- | --- |
| `collect-hook.js`（MAIN 世界 hook fetch/XHR/WS，clone 响应写内存环形缓冲，键表递归扫描判命中） | **直接改造为 `sniff-hook.js`**：键表从简历字段换成职位列表字段。这样拿到的是**结构化 JSON**，不用刮混淆过的 DOM class |
| `collect-bridge.js`（ISOLATED 中转，魔术字段校验 + requestId 应答 + 1.5s 超时） | **照搬为 `sniff-relay.js`** |
| `collect-button.js`（Shadow DOM 浮层按钮，右下角，只在顶层帧渲染） | **升级为 `panel.js`**：从"一个采集按钮"升级成"筛选 + 确认队列 + 开始投递"面板 |
| `fill-engine.js`（三级匹配：文本线索 → `data-*`/`title` → 选择器兜底；顺序执行；每操作重建 DOM 候选） | **借用其匹配思路**写 `greeter.js` / `chat-sender.js`——BOSS class 名混淆，只能靠文本定位 |
| `sentinel.js`（URL 通配 + 选择器保守双命中；超时**刻意不上报 failed**） | **借用其判据哲学**：打招呼成功靠接口信号（权威），DOM 信号只作辅助；失败不轻易落终态 |
| `job-probe.js` 的 `scanForJob`（budget/depth/seen 三件套 + 强/弱证据分级 + URL 黑名单二级过滤） | **复用骨架**抓职位条目；键表换成 `encryptJobId/jobName/salaryDesc/brandName/bossName` |
| 「多人响应拦截」（`distinctEncryptedIds > 1` 的响应被拦掉） | **反过来用**：列表型响应的特征就是"多个加密 ID 同框"，把它当**列表信号**，按行拆出职位条目 |
| `runFillTask` 编排（前台开 tab → `waitTabComplete` 15s → frame 轮询 → 两步注入 → 轮询结果择优 → 落 storage） | **照搬**为投递执行器的编排骨架 |
| 防护模式（window 守卫、全体 IIFE、context invalidated 检测、noise URL 过滤、按值形态判 ID） | **全盘照搬** |
| **频控 / 延迟 / 随机化** | ⚠️ **参考扩展完全没有**（已 grep 验证：全部 timer 都是工程超时）。原因：它所有动作都是人逐条触发，天然低速。**这部分必须自建** |


---

## 2. 项目结构

根目录：`/Users/ZhuanZ11/WorkBuddy/2026-09-27-15-08-02/boss-jingtou/`

```
boss-jingtou/
├── manifest.json
├── background.js              # SW：任务队列 / 频控闸门 / 台账 / tab 编排 / 注入
├── lib/
│   ├── constants.js           # 协议常量、storage key、键表、正则（SW 侧唯一真源）
│   ├── storage.js             # storage 读写封装：合并写、TTL、串行化
│   ├── ledger.js              # 台账：幂等去重、状态流转、日报表、CSV 导出
│   └── throttle.js            # 频控闸门：日上限 / 间隔 / 时段 / 熔断（新增模块）
├── content/
│   ├── sniff-hook.js          # MAIN world：hook fetch/XHR → 内存环形缓冲 → 按需 EXTRACT
│   ├── sniff-relay.js         # ISOLATED：MAIN ↔ SW 中转
│   ├── panel.js               # ISOLATED：Shadow DOM 浮层面板（筛选 / 队列 / 启停）
│   ├── greeter.js             # ISOLATED：详情页——定位并点击「立即沟通」（按需注入）
│   └── chat-sender.js         # ISOLATED：聊天页——填招呼语 / 发送 / 校验落库（按需注入）
├── popup/
│   ├── popup.html
│   └── popup.js               # 仪表盘：今日进度 / 队列 / 熔断状态 / 台账导出
├── options/
│   ├── index.html
│   └── options.js             # 关键词 / 薪资 / 城市 / 日上限 / 间隔 / 时段 / 招呼语 / LLM
├── fixtures/                  # 离线联调，不碰真实 BOSS
│   ├── mock-joblist.html      # 假列表接口 + 假卡片
│   ├── mock-detail.html       # 假详情页 + 「立即沟通」按钮
│   └── mock-chat.html         # 假聊天页 + 输入框 + 发送按钮
└── tools/
    └── recon.md               # M0 取证操作手册 + 待回答清单
```

**设计取舍**：

- `greeter.js` / `chat-sender.js` **按需注入**（`chrome.scripting.executeScript`），不做声明式常驻 —— 沿袭参考扩展"避免在每个 zhipin 页面常驻"的克制原则，少一分暴露面。
- content 脚本**不共享常量文件**，各自内联同值 + 注释「必须与 lib/constants.js 同步」——参考扩展踩过"同 `js` 数组内顶层作用域冲突导致整支脚本不执行"的事故（`bridge.js`）。所有注入脚本一律 IIFE。

---

## 3. manifest.json 设计

```
{
  "manifest_version": 3,
  "name": "精投助手",
  "version": "0.1.0",
  "permissions": ["storage", "scripting", "activeTab", "alarms", "webRequest"],
  "host_permissions": [
    "https://www.zhipin.com/*",
    "https://*.zhipin.com/*",
    "http://*.zhipin.com/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["https://www.zhipin.com/web/geek/*", "https://www.zhipin.com/job_detail/*"],
      "js": ["content/sniff-relay.js"],
      "run_at": "document_start", "all_frames": true, "world": "ISOLATED"
    },
    {
      "matches": ["https://www.zhipin.com/web/geek/*", "https://www.zhipin.com/job_detail/*"],
      "js": ["content/sniff-hook.js"],
      "run_at": "document_start", "all_frames": true, "world": "MAIN"
    },
    {
      "matches": ["https://www.zhipin.com/web/geek/*"],
      "js": ["content/panel.js"],
      "run_at": "document_idle"
    }
  ],
  "options_ui": { "page": "options/index.html", "open_in_tab": true },
  "action": { "default_popup": "popup/popup.html", "default_title": "精投助手" }
}
```

要点：

- `webRequest` 只 **observe**（`onCompleted`）做旁路观察，MV3 本来也不给拦。
- **不申请** `cookies` / `history` / `tabs.captureVisibleTab` / `debugger`。
- `alarms` 用于每日 00:05 重置日计数、以及批次休息定时。
- **兼容性兜底**：MAIN world 的声明式注册在低版本 Chrome 上会静默失败。参考扩展的做法是 `chrome.scripting.registerContentScripts` + `chrome.tabs.onUpdated` 导航兜底补注 —— 我们也加这条兜底。

---

## 4. 协议与存储

### 4.1 三段消息协议（照搬参考扩展形态）

命名空间魔术字段：`const NS = '__jingtou__'; const NS_VAL = 'v1';`

| 方向 | type | 说明 |
| --- | --- | --- |
| MAIN → ISOLATED | `SNIFF_READY` / `SNIFF_RECORD_LIMIT` | 装载宣告 / 到顶停录 |
| ISOLATED → MAIN（下行） | `EXTRACT` / `SET_RULES` / `SNIFF_ON` / `SNIFF_OFF` | 带 `requestId`，1.5s 超时 |
| MAIN → ISOLATED（应答） | `EXTRACT_RESULT` / `RULES_ACK` | 同上 |
| ISOLATED → SW | `SNIFF_HOOK_READY` / `SNIFF_EXTRACT_BATCH` | 跨帧聚合成数组 |
| SW → 页（`chrome.tabs.sendMessage`） | `GREET_START` / `CHAT_SEND` / `PANEL_REFRESH` | 带 `target` 字段过滤（学 `job-probe-relay` 的 `msg.target !== 'xxx'`） |
| 页 → SW | `GREET_RESULT` / `CHAT_RESULT` / `QUEUE_ADD` / `QUEUE_GO` | `sendResponse + return true` 异步应答 |


### 4.2 storage key 清单

**`storage.local`（持久）**

| key | 内容 |
| --- | --- |
| `jt_settings` | 关键词黑白名单、薪资区间、城市、日上限、间隔区间、活跃时段、招呼语模板、LLM 配置 |
| `jt_ledger` | `jobId → { status, title, company, salary, at, greeting, attempts, lastErrTs, verifiedAt }`，幂等去重真源 |
| `jt_daily` | `{ date, sent, failed, suspectedSilent, paused, pauseReason }` |
| `jt_queue` | 确认队列 `[{ jobId, title, company, salary, jdSnippet, score }]` |
| `jt_rules` | sniff 键表（逻辑后置，平台改版不用发版扩展） |


**`storage.session`（会话级）**

| key | 内容 |
| --- | --- |
| `jt_run_state` | 执行器状态：`{ running, curIdx, failStreak, lastSendAt }` |
| `jt_sniff_buffer` | 环形缓冲（**照搬 diag 参数**：400 条 / 4MB / 丢最旧 / `trimmed` 计数） |


**关键工程约定（照搬参考扩展踩坑结论）**：

- 环形缓冲写盘**节流**：内存攒批，单 timer 合并，`DIAG_FLUSH_MS = 1500` 同量级。
- `meta` 类对象**一律 `Object.assign` 合并写**，绝不整体覆盖（参考扩展实测踩坑）。
- 台账读写串行化（避免 SW 被回收时并发写丢数据）。
- **报告/状态一律落 storage**，不依赖回 popup —— popup 会关、SW 会被回收，storage 是唯一稳定交接点。

---

## 5. M0 取证阶段（必做，最高优先级）

镜像参考扩展自己的 "Phase 0 POC 接口考古"。**这一步没做完，后面全是猜。**

**做法**：只装 `sniff-hook.js` + `sniff-relay.js`，切成**持续上报（POC）模式**（命中即存），人工完成一次全流程操作，导出环形缓冲 JSON。取证完再切成**主动触发模式**（只在人点击时才外发）—— 与参考扩展的合规形态演进路径一致。

**必须回答的 9 个问题**：

1. **列表接口**：路径、响应结构、分页参数、每页条数、职位卡片字段名（`encryptJobId` / `jobName` / `salaryDesc` / `brandName` / `bossName` / `bossActiveDesc` / `labels`）
2. **「立即沟通」按钮的 DOM 特征**：class / 文本 / 嵌套层级；未沟通 vs 已沟通两种状态的文案与类名差异
3. **点击后走哪条分支**：(a) 直接进聊天 SPA？(b) 弹窗确认？(c) 弹招呼语编辑框？三者交互路径完全不同
4. **首次沟通是否强制弹窗**、能否跳过、是否预置默认招呼语文本
5. **聊天页**：输入框选择器（`contenteditable` 还是 `textarea`）、发送按钮选择器、发送走哪个接口、成功响应形态
6. **发送成功的权威信号**：接口 `code !== 0` 还是 `zpData.rescode !== 1`（学参考扩展的**双成功判定**，防"HTTP 200 但业务失败"）
7. **静默失效的可观测特征**：消息是否落聊天历史接口、是否出现"操作过于频繁"类提示、按钮是否变灰
8. **是否依赖签名参数**（如 `__zp_stoken__`）：若接口需签名，**放弃接口重放，坚持 DOM 驱动**
9. **额度有没有接口可读**（100 条这个数字从哪来）：BOSS 网页端/App 个人中心或聊天页是否暴露"今日剩余沟通次数"类字段（关键词候选：`remain` / `quota` / `chatLimit` / `greetLimit` / `leftCount` / `dailyLimit`）。**能读到就接进来，让闸门用真实剩余额度而不是我们本地计数**——本地计数只知道自己发了多少，不知道平台扣了多少（失败重试、静默失效都在偷偷扣额度）。

**附**：若无额度接口，日上限边界只能人工谨慎试探（手动连续打招呼，观察何时出现限制），这一步不自动化。用户口径 **100 条/天**，需在 M0 确认它是"额度上限"还是"安全阈值"——这两个含义完全不同。

---

## 6. 四大运行链路

### (a) 列表采集 `sniff-hook.js`

复用 `scanForJob` 骨架：迭代 DFS + `budget` 递减 + `seen` 防环 + 数组每层限项 + 深度上限。

- 键表换成职位字段；沿用**强/弱证据分级**（同节点带旁证键 = 强证据）。
- 沿用 **URL 黑/白名单二级过滤**（"宁可漏，不可错"）。
- 沿用 noise 前缀过滤，避免埋点接口污染缓冲：
`/wapi/zpCommon/actionLog/`、`/wapi/zpApm/actionLog/`、`/wapi/zpApm/httpMetrics/`
- **反用「多人响应拦截」**：列表响应天然含多个加密 ID → 当作"这是列表"的正信号，按行拆条目。
- 翻转页由 `panel.js` 驱动（点击翻页按钮），hook 自动捕获新一批响应。

**本地筛选**（`panel.js` 内跑，不联网）：

- 关键词白名单（默认预置用户定位词：`数字化` / `IT经理` / `ITBP` / `研发效能` / `信息化` / `ALM` / `PLM`）
- 关键词黑名单（`外包` / `销售` / `地推` / `驻场` …）
- 薪资区间解析（BOSS 文案形如 `20-35K·14薪`，需正则解析并处理 `K`/`万`/面议）
- 城市、公司黑名单、HR 活跃度（`bossActiveDesc` 含"刚刚活跃"/"今日活跃"加权）

### (b) 确认队列 `panel.js`

Shadow DOM 浮层（`z-index: 2147483647`，`all:initial` 隔离 BOSS 全局样式，只在顶层帧渲染 —— 照搬 `collect-button.js`）。

状态机：

```
seen → filtered_out（被规则淘汰）
     → queued（入确认队列，等人工勾选）
     → greeting（执行中）
     → msged（消息已发出）
     → verified（已在聊天记录中确认落库）／ suspected_silent（发了但没落库）
失败分支：failed_click / failed_input / failed_send / failed_verify
```

面板内容：筛选后列表 + 勾选框 + 招呼语预览（可逐条编辑）+「加入投递队列」+「开始投递」/「暂停」+ 今日计数 + 熔断状态红条。

### (c) 打招呼执行器（编排在 `background.js`，动作在 `greeter.js` / `chat-sender.js`）

每个职位一轮：

1. **幂等复核**：查 `jt_ledger`，已 `msged`/`verified` 直接跳过
2. **过频控闸门**（见 §7）：不通过则挂起并等待
3. **开/复用 tab** → 导航到详情页 URL（**必须前台 tab**：后台 tab 会被 Chrome 定时器节流，而流程依赖 `setTimeout` —— 参考扩展踩过）
4. `waitTabComplete`（15s，listener + timer + 立即 `tabs.get` 三保险，`finish()` 幂等）
5. **两步注入**：`executeScript(func)` 先写 `window.__JT_GREET_CONFIG__`，再 `executeScript(files:['content/greeter.js'])`
6. `greeter.js`：三级匹配定位「立即沟通」（文本优先：`立即沟通` / `继续沟通` / `打招呼`）→ 先判是否已沟通 → 再 click → 记录入口分支类型
7. 按 M0 取证的**分支**处理后续（等弹窗 / 等 SPA 跳转 / 等编辑框）
8. 等聊天页就绪（URL 变到 `/web/chat/` 或输入框出现）
9. 注入 `chat-sender.js` + 招呼语 → 定位输入框 → 填充（参照 `setValuish`：赋值 + 派发 `input`/`change`；`contenteditable` 走 `execCommand('insertText')`）→ 点击发送
10. **校验落库**（防静默失效，本方案最关键的一步）：从 `sniff-hook` 抓到的聊天历史响应里找刚发的文本；找不到 → 标 `suspected_silent` 并**计入熔断**
11. 写台账 + `jt_daily.sent++`
12. **随机 sleep** → 下一条

失败判据沿用参考扩展哲学：**DOM 超时不上报终态**（标记失败会终结记录、堵死后续正确信号），只标"待复查"。

### (d) 台账 `lib/ledger.js`

- 幂等键：`encryptJobId`（加密形态）；若只能拿到数字 ID，**按值形态判定**并标注，参考 `looksEncryptedId = /^[0-9A-Za-z_~-]{16,64}$/` 且必须同时含数字与字母。
- 去重窗口：学 `isDuplicateFill` 的 `Map + 惰性清理` 模式。
- 状态流转留痕（`at` / `lastErrTs`），供"7 天无回音触发跟进"。
- CSV 导出（popup 里做，Blob + `a.click`；**剪贴板兜底** —— popup 会被关闭打断下载，参考扩展踩过）。

---

## 7. 频控层 `lib/throttle.js`（新增，本方案核心）

| 闸门 | 默认值 | 可配范围 |
| --- | --- | --- |
| 每日上限 `DAILY_CAP` | **100**（对齐平台额度） | 5–100 |
| 投递间隔 | **45–180s 随机**（区间内均匀分布） | 30–600 |
| 活跃时段 `ACTIVE_WINDOW` | **10:00–19:00** | 自定义 |
| 批次休息 | 每 **7** 条 → 休息 **8–15 分钟** | 自定义 |
| 连续失败熔断 `FAIL_STREAK_LIMIT` | **3** 次 → 暂停 + popup 红点告警 | 2–5 |
| 验证码即停 `CAPTCHA_RE` | 命中 `captcha` / `验证` / `滑块` 类选择器 → **立即暂停** | 硬编码 |
| 日重置 | `chrome.alarms` 每日 `00:05` 重置 `jt_daily` | 硬编码 |


**闸门是纯函数 + 状态**：`canProceed(ledger, daily, settings, now) → { ok, reason, waitMs }`，单测友好。

若 M0 第 9 题拿到额度接口，闸门判据换成 `min(本地计数, 平台剩余额度)`——**取更保守的那个**。

### 7.2 时间预算核算（100 条/天到底跑不跑得完）

按默认参数实算：

| 项 | 算式 | 耗时 |
| --- | --- | --- |
| 条间等待 | 100 × 平均 112.5s | 3.13 h |
| 批次休息 | ⌊100/7⌋ = 14 次 × 平均 11.5 min | 2.68 h |
| 单条页面操作（开 tab/等加载/点击/发送/校验） | 100 × ~12.5s | 0.35 h |
| **合计** | | **≈ 6.2 h** |

活跃时段 9 h（10:00–19:00）→ **余量约 2.8 h（31%）**。结论：**100 条在时段内跑得完，但余量不算宽**。任何一次页面卡顿、重试、回退都会吃掉余量，所以：

- 100 条档位开启时，`ACTIVE_WINDOW` **不要压到 8 h 以内**。
- 需要更大余量时，按此顺序压缩：**先拉长时段（起点前移到 9:00）→ 再放宽批次休息间隔（每 7 条改每 10 条，可省约 45 min）→ 最后才动条间间隔**。条间间隔是风控最敏感的参数，**排在最后动**。

### 7.3 灰度档位（100 是上限，不是首发值）

| 档位 | DAILY_CAP | 进入下一档的条件 |
| --- | --- | --- |
| 档 0 | 5 | 连跑 3 天：无验证码、无 `suspected_silent`、无失败熔断 |
| 档 1 | 20 | 连跑 3 天同上 |
| 档 2 | 50 | 连跑 3 天同上，且回复率没有明显下滑 |
| 档 3 | 100 | 用户手动放行 |

档位用 `jt_settings.dailyCapTier` 记录，**升档必须人工点一下**（扩展不自己爬），降档自动（熔断即回退一档）。

---

## 8. 招呼语生成

**本次只交付第一档（已确认）。** 第二、三档仅在 `jt_settings` 预留字段结构，不实现逻辑。

1. **模板变量**（✅ 本次实现，默认开）：`{职位名}` `{公司}` `{JD关键词}` `{我的量化匹配点}`

- 例：`您好，我在{公司}的{职位名}里看到需要{JD关键词}。我在云鲸智能负责研发数字化运营，落地过 ALM/禅道 与研发效能看板，覆盖 {N} 人团队。方便聊聊吗？`
- 留白处由用户在 options 里维护
- **模板随账号定位走**：`jt_settings.greetingTemplate` 与 `accountLabel` 绑定（小号验证阶段可能需要与主账号不同的定位词）

2. ~~OpenAI 兼容 API~~（Phase 2 可选，本次不做）
3. ~~WorkBuddy 离线批量生成后导入~~（Phase 2 可选，本次不做）

---

## 9. 风控：能做的与做不到的

**能做**：低速 + 随机间隔 + 活跃时段 + 批次休息 + 人工确认 + 静默失效检测 + 失败熔断 + 验证码即停 + 幂等去重 + 串行执行（参考扩展原话："并发容易触发平台风控，也让失败归因更难"）。

**做不到**：

- 真实的**人类行为特征**——浏览轨迹、停留时长分布、鼠标移动路径。我们的点击是合成的。
- **账号画像**——新号 / 无历史行为的号触发更早。
- **平台模型迭代**——BOSS 是主动对抗方，今天能跑不代表下月能跑。
- 网页端的本质劣势：App 端自动化检测远弱于网页端。**如果日后真要冲量，路线是 ADB 真机（牺牲速度和稳定性），不是把网页脚本调快。**

**诚实结论：做不到 100% 防封。这套东西只能把"作死"降级成"试探"。**

---

## 10. 合规红线（写进代码注释与 README）

1. **只操作用户自己的账号**——不代登录、不存密码。**允许**「先小号验证、后切主账号」这种顺序使用；**禁止**同时持有多个账号轮流投递以绕过日限额（那是规避风控，会把风险从一人扩到多人，性质就变了）。
2. **不规模化采集他人 PII**——职位广告是公开信息，可以抓；候选人/HR 的个人信息不碰（参考扩展的简历采集能力**不迁移**）。
3. **遇到验证码 / 滑块立即停止并告警，绝不尝试绕过**，不接打码平台。
4. **明确告知**：本工具违反 BOSS 直聘用户协议，存在限流、招呼静默失效、封号风险，后果由使用者承担。
5. 工具**自用**，不对外分发。

---

## 11. 里程碑与验收标准

| 阶段 | 内容 | 验收标准 | 预估 |
| --- | --- | --- | --- |
| **M0** | 取证 | 9 个问题全部有答案 + 一份环形缓冲 JSON 导出样本 | 0.5 天（需用户配合） |
| **M1** | 列表采集 + 本地筛选 | 在真实搜索页抓到 ≥50 条职位，字段完整；筛选规则生效可核对 | 1 天 |
| **M2** | 确认队列面板 | mock 页上跑通：抓取 → 筛选 → 勾选 → 入队；真实页样式不串 | 0.5 天 |
| **M3** | 打招呼执行器 | 在**小号**上跑通 **1 个**真实职位全链路：点击 → 聊天页 → 发出招呼语 → 校验落库 | 1.5 天（波动最大，取决于 M0） |
| **M4** | 台账 + 频控 | 闸门单测通过；日上限/间隔/熔断/日重置全部生效；CSV 导出可用；`accountLabel` 分区生效 | 0.5 天 |
| **M5** | 联调灰度 | 按 §7.3 档位逐级爬坡（5 → 20 → 50 → 100），每档连跑 3 天无异常、无验证码、无 `suspected_silent` | 0.5 天 + 观察期 |


**合计约 4.5 天**，其中 M3 是最大不确定项。

---

## 12. 测试策略

- **离线 mock**：`fixtures/` 三个假页面（假列表接口 / 假详情页 / 假聊天页），让 M2/M3 的执行器不碰真实 BOSS 就能跑通。「加载已解压的扩展程序」直接指向 `fixtures/` 做联调 —— 沿袭参考扩展 `fixtures/publish-mock.html` 的做法。
- **语法校验**：每个 JS 文件交付前 `node --check`（参考扩展注释里记过一类只在运行时炸、`node --check` 查不出的坑，所以还要加一条：**块注释里禁止书写含 `**/` 的通配符示例**）。
- **真机灰度**：先 1 个职位 → 再按 §7.3 档位逐级爬坡（5 → 20 → 50 → 100），每档连跑 3 天，升档人工放行。

---

## 13. 已确认决策（2026-09-27 用户拍板）

| # | 决策 | 落地影响 |
| --- | --- | --- |
| 1 | **白名单全自动 + 灰名单人工**（2026-09-27 用户由"半自动"改为此档） | 高置信职位（得分 ≥ `highThreshold`）自动入队；灰名单面板人工勾选；`autoMode:'full'` 纯全自动留开关默认关。点「开始投递」后执行器自动低速跑完，可随时暂停 |
| 2 | **招呼语先做模板变量档** | §8 的第一档为本次唯一交付；LLM 档与离线导入档**本次不实现**，仅在 `jt_settings` 里预留字段结构，Phase 2 再接 |
| 3 | **小号先行验证链路** | M3 的真实链路验收、M5 的灰度全部在**小号**上做；**主账号在 M5 通过前不接入**。M5 通过后由用户另行决定是否切主账号 |
| 4 | **日上限按 100 条/天设计**（用户确认平台额度，推翻此前默认 20） | `dailyCap` 默认 100 可配 5–100；**灰度档位决定实际上限**（档0=5→档3=100），升档人工、熔断暂停；§7.2 时间预算核算：100 条 ≈ 6.2h，时段内可跑完 |
| 5 | **队列分级制** | 高匹配自动投 + 中匹配人工确认（与决策 1 配套），不追求喂满 100，额度花在刀刃上 |

**v0.1.0 已交付**（2026-09-27）：`/Users/ZhuanZ11/WorkBuddy/2026-09-27-15-08-02/boss-jingtou/`，20 个文件，12 个 JS 全部 `node --check` 通过。下一步：M0 取证（tools/recon.md）→ 校准 `jt_rules` → 关 pocMode → 小号灰度爬坡。


**基于第 3 条追加的工程要求**：

- `jt_settings` 增加 `accountLabel` 字段（如「小号」/「主账号」），台账 `jt_ledger` 每条记录带上该标签 —— 防止两个账号的数据混在一张表里污染回复率统计。
- 面板与 popup 顶部常驻显示当前账号标签，**避免误在错误的账号上启动投递**。
- 切账号时 `jt_daily` 与 `jt_run_state` 必须重置（不共享日计数），但 `jt_ledger` 保留并按 `accountLabel` 分区查询。

---

## 14. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| M0 取证发现接口需签名 | 不能走接口，只能 DOM 驱动，M3 工期 +50% | M0 优先做，早暴露 |
| BOSS 页面改版 | 选择器/文本线索失效 | 键表与匹配词全部放 `jt_rules` / options，逻辑后置，不发版可修 |
| 静默失效导致台账虚高 | 误判投放效果 | 强制落库校验 + `suspected_silent` 状态 + 熔断 |
| 账号被限流/封禁 | 求职进度受损 | **小号先行**（已确认）+ 日上限按 §7.3 档位爬坡（100 为上限而非首发值）+ 随机间隔；主账号在 M5 通过前不接入 |
| SW 被回收导致队列中断 | 任务半途丢失 | 状态全落 storage；`alarms` 唤醒续跑；断点续投 |
