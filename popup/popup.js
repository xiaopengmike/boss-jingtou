/* 精投助手 - popup 仪表盘：只读 storage 状态 + 发命令，不持有业务逻辑 */
(function () {
  'use strict';

  function send(msg) {
    return new Promise(function (res) {
      chrome.runtime.sendMessage(msg, function (r) {
        void chrome.runtime.lastError;
        res(r || null);
      });
    });
  }
  function $(id) { return document.getElementById(id); }

  function pauseText(r) {
    return {
      captcha: '⚠ 出现验证码，已自动暂停——请到页面人工通过后再点开始',
      fuse_blown: '⚠ 连续失败熔断，已暂停——检查登录态/网络后点开始',
      manual: '已手动暂停',
      queue_empty: '队列已投完',
      daily_cap: '已达今日上限，明日 00:05 重置'
    }[r] || r;
  }

  function fmtWait(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + ' 秒';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' 分钟';
    return (m / 60).toFixed(1) + ' 小时';
  }

  async function refresh() {
    var s = await send({ type: 'GET_STATE' });
    if (!s || !s.ok) return;
    $('acct').textContent = '· ' + s.accountLabel;
    $('modeLine').textContent =
      (s.autoMode === 'full' ? '纯全自动' : '白名单自动+灰名单人工') +
      ' · 灰度档 ' + s.tier + '（上限 ' + s.cap + ' 条/天）';
    $('sent').textContent = s.sent + '/' + s.cap;
    $('queued').textContent = s.queued;
    $('silent').textContent = s.suspectedSilent;
    $('failed').textContent = s.failed;
    $('barFill').style.width = Math.min(100, s.cap ? Math.round((s.sent / s.cap) * 100) : 0) + '%';

    var rl = $('runLine');
    if (s.running && s.gateReason) {
      /* 触顶/出时段：后台保持 running 到点自动恢复，这里如实显示而非"等待下一条 N 秒后" */
      rl.className = 'idle';
      rl.textContent = s.gateReason === 'daily_cap'
        ? '⏸ 已达今日上限（明日 00:05 重置后自动继续）'
        : '⏸ 当前不在投递时段，到 ' + (s.windowStart || '活跃时段') + ' 自动继续';
    } else if (s.running) {
      rl.className = '';
      rl.textContent = s.current
        ? '▶ 投递中（' + (s.current.stage === 'greet' ? '打开职位页' : '发送招呼语') + '）'
        : '▶ 运行中，等待下一条';
      if (s.nextAt && s.nextAt > Date.now()) {
        rl.textContent += '，' + fmtWait(s.nextAt - Date.now()) + '后';
      }
    } else {
      var warn = s.pausedReason === 'captcha' || s.pausedReason === 'fuse_blown';
      rl.className = warn ? 'warn' : 'idle';
      rl.textContent = s.pausedReason ? pauseText(s.pausedReason) : '未运行';
    }
  }

  $('go').addEventListener('click', async function () {
    await send({ type: 'QUEUE_GO' });
    refresh();
  });
  $('pause').addEventListener('click', async function () {
    await send({ type: 'QUEUE_PAUSE' });
    refresh();
  });
  $('exportCsv').addEventListener('click', function () {
    send({ type: 'EXPORT_CSV' });
  });
  $('exportBuf').addEventListener('click', function () {
    send({ type: 'EXPORT_BUFFER' });
  });
  $('openOptions').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });
  $('tierUp').addEventListener('click', async function () {
    var r = await send({ type: 'TIER_UP' });
    if (r && r.ok) refresh();
  });
  $('resetDaily').addEventListener('click', async function () {
    await send({ type: 'RESET_DAILY' });
    refresh();
  });
  $('clearQueue').addEventListener('click', async function () {
    if (!confirm('清空待投队列？\n\n· 队列条目全部删除，执行器一并停止\n· 台账不动（已投过的仍会被跳过，不会重复打扰）')) return;
    var r = await send({ type: 'QUEUE_CLEAR' });
    alert(r && r.ok ? '已清空 ' + r.cleared + ' 条' : '清空失败');
    refresh();
  });
  $('resetAll').addEventListener('click', async function () {
    if (!confirm('重置全部数据？\n\n· 清空队列 + 台账 + 今日计数\n· 台账一清，回复率历史与"疑似静默"记录都没了\n· 建议先「导出台账 CSV」留底')) return;
    if (!confirm('最后确认：台账将被永久清空，无法撤销。继续？')) return;
    var r = await send({ type: 'RESET_ALL' });
    alert(r && r.ok ? '已重置：队列 ' + r.queue + ' 条、台账 ' + r.ledger + ' 条' : '重置失败');
    refresh();
  });

  refresh();
  setInterval(refresh, 3000);
})();
