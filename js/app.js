/* ==========================================================
 * app.js —— GoalFlow 主逻辑
 * 五页渲染（今日/目标/计划/看板/设置）+ 目标详情 + 弹窗表单
 * + AI 流程编排（大纲 / 周计划 / 调整预览-应用-拒绝-撤销）
 * 约定：所有用户数据经 esc() 转义后再拼 HTML；事件统一委托
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store, Rules = global.Rules, Agg = global.Agg,
      AI = global.AI, Adjust = global.Adjust, Chart = global.Chart;

  /* ---------------- 小工具 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtMin(m) {
    m = Math.round(+m || 0);
    return m >= 60 ? (Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '')) : m + '分钟';
  }
  function fmtDeadline(deadline) {
    var n = Store.daysBetween(Store.todayStr(), deadline);
    if (n < 0) return '已过期';
    if (n === 0) return '今天截止';
    return '剩 ' + n + ' 天';
  }
  function emptyHtml(icon, text, extra) {
    return '<div class="empty"><span class="big">' + icon + '</span>' + esc(text) + (extra || '') + '</div>';
  }

  var state = {
    page: 'today',
    goalFilter: 'active',
    detailId: null,
    planDate: Store.todayStr(),
    planView: 'day',
    planFilter: { goalId: '', type: '', energy: '' },
    statsRange: 14,
    editingGoalId: null,
    editingTaskId: null,
    lastPreview: null,   // {scope, goalId, trigger, summary, changes}
    lastOutline: null,   // AI 生成的大纲预览
    lastPlan: null       // AI 生成的周计划预览
  };

  /* ---------------- 弹窗 / 提示 ---------------- */

  function openModal(html) {
    $('#modal-box').innerHTML = '<button class="close-x" data-action="close-modal">×</button>' + html;
    $('#modal-mask').classList.remove('hidden');
    var box = $('#modal-box');
    box.scrollTop = 0;
  }
  function closeModal() {
    $('#modal-mask').classList.add('hidden');
    $('#modal-box').innerHTML = '';
  }
  var confirmCb = null;
  function confirmBox(title, msg, okText, cb) {
    confirmCb = cb;
    openModal('<h2>' + esc(title) + '</h2><p style="color:var(--muted);font-size:13.5px">' + esc(msg) + '</p>' +
      '<div class="btn-row"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn danger" data-action="confirm-ok">' + esc(okText || '确定') + '</button></div>');
  }
  function showLoading(text) {
    openModal('<div class="empty"><span class="big">⏳</span>' + esc(text) + '<br><span style="font-size:11px">AI 正在思考，请稍候…</span></div>');
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2400);
  }

  /* ---------------- 总渲染入口 ---------------- */

  function render() {
    Rules.ensureRange(Store.todayStr(), 7); // 幂等补齐固定任务（今日+未来6天）
    if (state.page === 'today') renderToday();
    else if (state.page === 'goals') renderGoals();
    else if (state.page === 'plan') renderPlan();
    else if (state.page === 'stats') renderStats();
    else if (state.page === 'settings') renderSettings();
    if (state.detailId) renderDetail();
  }

  function switchPage(page) {
    // 切换 tab 时关闭目标详情覆盖层
    if (state.detailId) {
      state.detailId = null;
      var d = $('#goal-detail');
      d.classList.add('hidden');
      d.classList.remove('show');
    }
    state.page = page;
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.page === page); });
    $$('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + page); });
    render();
  }

  /* ==========================================================
   * 今日页
   * ========================================================== */

  /** 演示模式横幅（无 API Key 时的降级提示） */
  function mockBanner() {
    var s = Store.loadSettings();
    if (!AI.useMock() || s.mockNoticeDismissed) return '';
    return '<div class="notice info"><span>🎭 演示模式：AI 功能使用模拟数据跑通全流程。在「设置 → API 配置」填入 Key 后即用真实 AI。</span>' +
      '<button class="btn sm ghost" data-action="dismiss-mock">知道了</button></div>';
  }

  function renderToday() {
    var today = Store.todayStr();
    $('#today-sub').textContent = Store.parseDate(today).getMonth() + 1 + '月' + Store.parseDate(today).getDate() + '日 · 周' + Store.weekdayCN(today);
    var el = $('#today-body');
    var goals = Store.activeGoals();

    if (!goals.length) {
      el.innerHTML = mockBanner() +
        '<div class="card">' + emptyHtml('🎯', '还没有目标。先创建一个目标，AI 帮你拆解成每日任务。',
          '<div style="margin-top:12px"><button class="btn primary" data-action="tab" data-page="goals">去创建目标</button></div>') + '</div>' +
        (Store.getGoals().length ? '' :
          '<button class="btn ghost block" data-action="load-demo">载入演示数据（含学习/健身/口语三个目标）</button>');
      return;
    }

    var st = Agg.dayStats(today);
    var view = Store.loadSettings().todayView || 'smart';
    var html = mockBanner();

    // 预算条
    var pct = st.budget ? Math.min(100, Math.round(st.plannedMin / st.budget * 100)) : 0;
    var cls = st.over ? 'danger' : (pct >= 85 ? 'warn' : 'ok');
    html += '<div class="card budget-bar">' +
      '<div class="budget-head"><span>今日预算 <b>' + st.budget + '</b> 分钟</span>' +
      '<span' + (st.over ? ' style="color:var(--danger);font-weight:700"' : '') + '>' +
      (st.over ? '⚠️ 超载 ' + st.over + ' 分钟' : '已排 ' + st.plannedMin + ' 分钟') + '</span></div>' +
      '<div class="bar ' + cls + '"><i style="width:' + pct + '%"></i></div></div>';

    // 过载提示
    if (st.over > 0) {
      html += '<div class="notice danger"><span>⚠️ 今日任务超出预算 ' + st.over + ' 分钟，可让 AI 协调或手动取舍</span>' +
        '<button class="btn sm danger" data-action="ai-rebalance" data-scope="global" data-trigger="overload">AI 协调</button></div>';
    }

    // 顶部统计：进首页即见今日总进度
    var remain = st.todo;
    html += '<div class="card sum-bar">' +
      '<div><b>' + st.count + '</b><span>总任务</span></div>' +
      '<div><b>' + st.plannedMin + '</b><span>预计分钟</span></div>' +
      '<div><b style="color:var(--ok)">' + (st.done + st.partial) + '</b><span>已完成</span></div>' +
      '<div><b>' + Math.round(st.rate * 100) + '%</b><span>完成率</span></div>' +
      '<div><b style="color:var(--brand)">' + remain + '</b><span>剩余</span></div></div>';

    // 视图切换
    html += '<div class="chip-row">' +
      '<button class="chip ' + (view === 'smart' ? 'active' : '') + '" data-action="set-view" data-view="smart">⚡ 智能排序</button>' +
      '<button class="chip ' + (view === 'byGoal' ? 'active' : '') + '" data-action="set-view" data-view="byGoal">📂 按目标</button>' +
      '<button class="chip ' + (view === 'byTime' ? 'active' : '') + '" data-action="set-view" data-view="byTime">⏱ 按时长</button></div>';

    // 任务列表
    html += taskListHtml(today, view);

    // 复盘卡（今日收尾动作）
    var rv = Store.reviewByDate(today);
    if (rv) {
      html += '<div class="card"><h3>🌙 今日复盘已记录</h3><div class="review-sum">' + reviewSummaryText(rv) + '</div>' +
        (rv.aiReply ? '<div class="ai-reply"><b>🤖 AI 回应：</b>' + esc(rv.aiReply) + '</div>' : '') +
        '<div class="btn-row" style="margin-top:9px">' +
        '<button class="btn ghost sm" data-action="open-review">编辑复盘</button>' +
        '<button class="btn primary sm" data-action="ai-rebalance" data-scope="global" data-trigger="review">✨ 让 AI 调整计划</button></div></div>';
    } else {
      html += '<div class="card" style="border:1.5px solid var(--brand)"><h3>🌙 今日收尾：1 分钟复盘</h3>' +
        '<p class="card-sub">记录卡点与明日期望，AI 立即据此调整未来计划 —— 这是你变强的关键一步</p>' +
        '<button class="btn primary block" data-action="open-review">完成今日复盘 → 自动触发 AI 调整</button></div>';
    }

    el.innerHTML = html;
  }

  function reviewSummaryText(rv) {
    var parts = [];
    if ((rv.smoothTasks || []).length) parts.push('顺利：<b>' + esc(rv.smoothTasks.join('、').slice(0, 30)) + '</b>');
    if (rv.blocked) parts.push('卡点：<b>' + esc(rv.blocked) + '</b>');
    if (rv.cause && rv.cause !== 'none') {
      if (rv.cause === 'custom') parts.push('原因：<b>' + esc(rv.causeCustom || '自定义') + '</b>');
      else {
        var name = { time: '时间不够', difficulty: '难度超预期', mixed: '时间+难度' }[rv.cause];
        if (name) parts.push('主要原因：' + name);
      }
    }
    var loadTxt = { more: '明天想加量', same: '明日期望保持', less: '明天想减负' }[rv.tomorrowLoad];
    if (loadTxt) parts.push(loadTxt);
    if ((rv.perGoalNotes || []).length) parts.push('目标备注 ' + rv.perGoalNotes.length + ' 条');
    return parts.length ? parts.join(' · ') : '已记录';
  }

  function taskListHtml(date, view) {
    var tasks = Agg.tasksFor(date);
    if (!tasks.length) return emptyHtml('🌤', '今天暂无任务。可去计划页手动添加，或在目标详情里让 AI 展开未来 7 天。');
    var html = '';
    if (view === 'byGoal') {
      Agg.groupByGoal(tasks).forEach(function (grp) {
        var g = grp.goal, c = Store.typeOf(g.type).color;
        html += '<div class="group-title"><span class="dot" style="background:' + c + '"></span>' +
          esc(g.title) + (g.isCore ? ' ★' : '') + ' · ' + grp.tasks.length + ' 个任务</div>';
        grp.tasks.forEach(function (t) { html += taskCard(t); });
      });
    } else {
      (view === 'byTime' ? Agg.byTimeSort(tasks) : Agg.smartSort(tasks)).forEach(function (t) { html += taskCard(t); });
    }
    return html;
  }

  function taskCard(t) {
    var goal = Store.goalById(t.goalId) || { title: '已删除目标', type: 'other', isCore: false };
    var ty = Store.typeOf(goal.type), en = Store.energyOf(t.energy);
    var doneCls = (t.status === 'done') ? ' done-state' : '';
    // 打卡状态与卡片外观联动：角标 + 左侧色条
    var stCls = t.status === 'partial' ? ' st-partial' : t.status === 'missed' ? ' st-missed' : '';
    var badge = '';
    if (t.status === 'done') badge = '<span class="task-badge ok">✓ 已完成</span>';
    else if (t.status === 'partial') badge = '<span class="task-badge warn">⚠️ 部分完成</span>';
    else if (t.status === 'missed') badge = '<span class="task-badge miss">❌ 未完成</span>';
    return '<div class="task-card' + doneCls + stCls + '" data-action="open-task-detail" data-id="' + t.id + '">' + badge +
      '<div class="task-top">' +
      '<span class="goal-name"><span class="dot" style="background:' + ty.color + '"></span>' + esc(goal.title) + (goal.isCore ? ' ★' : '') + '</span>' +
      '<span class="tag">' + ty.name + '</span>' +
      '<span class="tag" style="color:' + en.color + '">' + en.name + '</span>' +
      '<span class="tag">⏱ ' + t.estimateMin + ' 分钟</span>' +
      (t.source === 'rule' || t.locked ? '<span class="tag lock-tag">🔒 固定</span>' : '') +
      (t.status === 'skipped' ? '<span class="tag">⏭️ 已跳过</span>' : '') +
      '</div>' +
      '<p class="task-title">' + esc(t.title) + '</p>' +
      (t.desc ? '<p class="task-desc">' + esc(t.desc) + '</p>' : '') +
      '<div class="task-status">' +
      '<button class="st-btn done-main' + (t.status === 'done' ? ' on-done' : '') + '" data-action="task-done" data-id="' + t.id + '">' +
      (t.status === 'done' ? '✓ 已完成（点击撤销）' : '✓ 完成') + '</button>' +
      '<button class="st-btn more-btn" data-action="open-task-detail" data-id="' + t.id + '">详情 ▸</button>' +
      '</div></div>';
  }

  /** 一键完成 / 撤销完成 */
  function taskQuickDone(id) {
    var t = Store.taskById(id);
    if (!t) return;
    Store.updateTask(id, { status: t.status === 'done' ? 'todo' : 'done', missReason: '' });
    render();
  }

  /** 任务详情弹窗（显式保存模式）：三态 + 原因（预设/自定义）→ 保存才写入 Storage */
  function openTaskDetailModal(id) {
    var t = Store.taskById(id);
    if (!t) return;
    state.taskDraft = {
      id: id,
      status: t.status,
      missReason: t.missReason || '',
      missNote: t.missNote || '',
      reasonMode: t.missReason === 'custom' ? 'custom' : (t.missReason ? 'preset' : '')
    };
    renderTaskDetailModal();
  }

  function renderTaskDetailModal() {
    var d = state.taskDraft;
    if (!d) return;
    var t = Store.taskById(d.id);
    if (!t) { closeModal(); return; }
    var goal = Store.goalById(t.goalId) || { title: '?', type: 'other' };
    // 三个核心状态（未开始 = 未打卡的默认态，不再单列）
    var statuses = [['done', '✅ 完成'], ['partial', '⚠️ 部分完成'], ['missed', '❌ 未完成']];
    var statusRow = statuses.map(function (s) {
      return '<button class="chip ' + (d.status === s[0] ? 'active' : '') + '" data-action="detail-pick" data-status="' + s[0] + '">' + s[1] + '</button>';
    }).join('');
    // 状态联动：部分完成 / 未完成 → 显示原因（预设三个 + 自定义输入）；完成 → 隐藏
    var needReason = d.status === 'partial' || d.status === 'missed';
    var reasonRow = '';
    if (needReason) {
      var presetChips = Store.MISS_REASONS.map(function (r) {
        return '<button class="chip ' + (d.reasonMode === 'preset' && d.missReason === r.id ? 'active' : '') + '" data-action="detail-reason" data-reason="' + r.id + '">' + r.name + '</button>';
      }).join('');
      var customChip = '<button class="chip ' + (d.reasonMode === 'custom' ? 'active' : '') + '" data-action="detail-reason-custom">＋ 自定义</button>';
      var customBox = d.reasonMode === 'custom'
        ? '<input id="detail-reason-input" value="' + esc(d.missNote || '') + '" placeholder="用自己的话写下真实原因">'
        : '';
      reasonRow = '<div class="form-item" id="detail-reason-box"><label>' + (d.status === 'partial' ? '卡在哪里了？（部分完成原因）' : '未完成原因（帮助 AI 更准地调整）') + '</label>' +
        '<div class="radio-row">' + presetChips + customChip + '</div>' + customBox + '</div>';
    }
    openModal('<h2>' + esc(t.title) + '</h2>' +
      '<p class="card-sub"><span class="dot" style="background:' + Store.typeOf(goal.type).color + '"></span>' + esc(goal.title) +
      ' · ' + t.date + ' 周' + Store.weekdayCN(t.date) + ' · ⏱ ' + t.estimateMin + ' 分钟' +
      ((t.source === 'rule' || t.locked) ? ' · 🔒 固定任务（AI 不可修改）' : '') + '</p>' +
      (t.desc ? '<p style="font-size:13.5px;color:var(--muted);margin:0 0 12px">' + esc(t.desc) + '</p>' : '') +
      '<div class="form-item"><label>标记状态</label><div class="detail-status-row">' + statusRow + '</div></div>' +
      reasonRow +
      '<div class="btn-row" style="margin-top:12px">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      (t.source === 'rule' ? '' : '<button class="btn danger" data-action="del-task" data-id="' + t.id + '">删除</button>') +
      '<button class="btn primary" data-action="detail-save">保存</button></div>');
  }

  /* ---------- 复盘弹窗 ---------- */

  function openReviewModal() {
    var today = Store.todayStr();
    var rv = Store.reviewByDate(today) || {};
    var goals = Store.activeGoals();
    var causeVal = rv.cause || 'none';
    var causeCustom = rv.causeCustom || '';
    var loadVal = rv.tomorrowLoad || 'same';
    var smoothTasks = rv.smoothTasks || [];
    var todayTasks = Store.tasksByDate(today);

    // 先肯定成果：顺利推进的任务（今日任务，可多选）
    var smoothChips = todayTasks.length ? todayTasks.map(function (t) {
      return '<button class="chip ' + (smoothTasks.indexOf(t.title) >= 0 ? 'active' : '') + '" data-action="rv-smooth" data-title="' + esc(t.title) + '">' + esc(t.title.slice(0, 14)) + '</button>';
    }).join('') : '<p class="form-hint">今天还没有任务</p>';
    // 再分析问题：卡住的任务（点选填入下方文本）
    var stuckTasks = todayTasks.filter(function (t) {
      return t.status === 'missed' || t.status === 'partial' || t.status === 'todo';
    }).slice(0, 6);
    var stuckChips = stuckTasks.length ? stuckTasks.map(function (t) {
      return '<button class="chip" data-action="rv-pick" data-title="' + esc(t.title) + '">' + esc(t.title.slice(0, 12)) + '</button>';
    }).join('') : '<p class="form-hint">今天没有待处理的任务</p>';

    var causeChips = [['none', '没有卡点'], ['time', '时间不够'], ['difficulty', '难度超预期'], ['mixed', '时间+难度都有']]
      .map(function (c) {
        return '<button class="chip ' + (causeVal === c[0] ? 'active' : '') + '" data-action="chip-pick" data-group="cause" data-val="' + c[0] + '">' + c[1] + '</button>';
      }).join('') +
      '<button class="chip ' + (causeVal === 'custom' ? 'active' : '') + '" data-action="rv-cause-custom">＋ 自定义</button>';
    var customCauseBox = causeVal === 'custom'
      ? '<input id="rv-cause-custom" value="' + esc(causeCustom) + '" placeholder="用自己的话描述原因（选填）" style="margin-top:7px">'
      : '';
    var loadChips = [['more', '多一点'], ['same', '保持'], ['less', '少一点']]
      .map(function (c) {
        return '<button class="chip ' + (loadVal === c[0] ? 'active' : '') + '" data-action="chip-pick" data-group="tomorrow" data-val="' + c[0] + '">' + c[1] + '</button>';
      }).join('');
    var notes = goals.map(function (g) {
      var prev = ((rv.perGoalNotes || []).filter(function (n) { return n.goalId === g.id; })[0]) || {};
      return '<div class="form-item"><label>' + (g.isCore ? '★ ' : '') + esc(g.title) + '（选填）</label>' +
        '<input class="js-review-note" data-goal="' + g.id + '" value="' + esc(prev.note || '') + '" placeholder="这个目标今天推进如何？"></div>';
    }).join('');

    openModal('<h2>🌙 今日复盘</h2>' +
      '<div class="form-item"><label>✅ 今天哪些任务推进顺利？（点选，可多选）</label><div class="radio-row">' + smoothChips + '</div></div>' +
      '<div class="form-item"><label>⚠️ 哪些任务卡住了？（点选快速填入）</label><div class="radio-row">' + stuckChips + '</div></div>' +
      '<div class="form-item"><label>卡点补充（选填，3 句内即可）</label>' +
      '<textarea id="rv-blocked" placeholder="例：建模的对偶推导卡了 40 分钟">' + esc(rv.blocked || '') + '</textarea></div>' +
      '<div class="form-item"><label>主要原因是？</label><div class="radio-row" data-pick-group="cause">' + causeChips + '</div>' + customCauseBox + '</div>' +
      '<div class="form-item"><label>明天的任务量希望？</label><div class="radio-row" data-pick-group="tomorrow">' + loadChips + '</div></div>' +
      '<details><summary style="font-size:12.5px;color:var(--brand);cursor:pointer;margin-bottom:8px">展开：按目标补充备注（选填）</summary>' + notes + '</details>' +
      '<div class="btn-row"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-review">保存复盘</button></div>');
  }

  function saveReviewFromModal() {
    var today = Store.todayStr();
    var smoothTasks = $$('#modal-box [data-action="rv-smooth"].active').map(function (el) { return el.dataset.title; });
    var notes = $$('#modal-box .js-review-note').map(function (inp) {
      return { goalId: inp.dataset.goal, note: inp.value.trim() };
    }).filter(function (n) { return n.note; });
    var causeEl = $('#modal-box [data-pick-group="cause"]');
    var loadEl = $('#modal-box [data-pick-group="tomorrow"]');
    var cause = (causeEl && causeEl.dataset.val) || 'none';
    var causeCustom = cause === 'custom' && $('#rv-cause-custom') ? $('#rv-cause-custom').value.trim() : '';
    if (cause === 'custom' && !causeCustom) { toast('请填写自定义原因，或改选预设选项', true); return; }
    var blocked = ($('#rv-blocked') ? $('#rv-blocked').value.trim() : '');
    var tomorrowLoad = (loadEl && loadEl.dataset.val) || 'same';
    Store.saveReview({
      date: today,
      blocked: blocked,
      cause: cause,
      causeCustom: causeCustom,
      tomorrowLoad: tomorrowLoad,
      smoothGoalIds: [],
      smoothTasks: smoothTasks,
      perGoalNotes: notes
    });
    closeModal();
    render();
    // 闭环 1：AI 即时反馈（2-3 句短输出，失败静默不阻塞调整）
    var stats = Agg.dayStats(today);
    var causeName = cause === 'custom' ? (causeCustom || '自定义')
      : ({ time: '时间不够', difficulty: '难度超预期', mixed: '时间+难度' }[cause] || '');
    AI.genReviewFeedback({
      smoothTasks: smoothTasks,
      blocked: blocked,
      causeName: cause === 'none' ? '' : causeName,
      tomorrowLoad: tomorrowLoad,
      loadName: tomorrowLoad === 'more' ? '多一点' : tomorrowLoad === 'less' ? '少一点' : '保持',
      statsText: '完成率 ' + Math.round(stats.rate * 100) + '%' + (stats.over ? '，超载 ' + stats.over + ' 分钟' : ''),
      goalsText: Store.activeGoals().map(function (g) { return g.title; }).join('、') || '无'
    }).then(function (res) {
      var rv = Store.reviewByDate(today);
      if (rv) { rv.aiReply = res.reply; Store.saveReview(rv); }
      if (state.page === 'today') renderToday();
    }).catch(function () { /* 反馈生成失败静默 */ });
    // 闭环 2：基于复盘的调整建议（预览-确认）
    toast('复盘已保存，AI 正在生成反馈与调整建议…');
    runAdjust('global', '', 'review');
  }

  /* ==========================================================
   * 目标页
   * ========================================================== */

  function renderGoals() {
    var segs = [['active', '进行中'], ['paused', '已暂停'], ['done', '已完成'], ['archived', '已归档']];
    $('#goal-seg').innerHTML = segs.map(function (s) {
      return '<button class="' + (state.goalFilter === s[0] ? 'active' : '') + '" data-action="goal-filter" data-id="' + s[0] + '">' + s[1] + '</button>';
    }).join('');

    var list = Store.getGoals().filter(function (g) { return g.status === state.goalFilter; })
      .sort(function (a, b) {
        var core = (b.isCore ? 1 : 0) - (a.isCore ? 1 : 0);
        if (core) return core;
        var prio = Store.prioOf(b.priority).weight - Store.prioOf(a.priority).weight;
        if (prio) return prio;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    var html = '';

    // 预算分配概览（进行中视图）
    if (state.goalFilter === 'active' && list.length) {
      var s = Store.loadSettings();
      var wd = 0, we = 0;
      list.forEach(function (g) { wd += (+g.weekdayMinutes || 0); we += (+g.weekendMinutes || 0); });
      var overWd = wd > s.dailyBudget.weekday, overWe = we > s.dailyBudget.weekend;
      html += '<div class="card"><h3>每日预算分配</h3>' +
        '<div class="bar-row" style="margin-bottom:6px"><span style="min-width:44px">工作日</span>' +
        '<div class="bar ' + (overWd ? 'danger' : '') + '"><i style="width:' + Math.min(100, wd / Math.max(1, s.dailyBudget.weekday) * 100) + '%"></i></div>' +
        '<span class="val"' + (overWd ? ' style="color:var(--danger);font-weight:700"' : '') + '>' + (overWd ? '⚠️ 超载 ' + (wd - s.dailyBudget.weekday) + '分' : wd + '/' + s.dailyBudget.weekday + '分') + '</span></div>' +
        '<div class="bar-row"><span style="min-width:44px">周末</span>' +
        '<div class="bar ' + (overWe ? 'danger' : '') + '"><i style="width:' + Math.min(100, we / Math.max(1, s.dailyBudget.weekend) * 100) + '%"></i></div>' +
        '<span class="val"' + (overWe ? ' style="color:var(--danger);font-weight:700"' : '') + '>' + (overWe ? '⚠️ 超载 ' + (we - s.dailyBudget.weekend) + '分' : we + '/' + s.dailyBudget.weekend + '分') + '</span></div>' +
        ((overWd || overWe) ? '<p class="form-hint warn" style="margin-top:7px">⚠️ 目标预算之和超出全局预算，任务可能过载；可在编辑目标中调低，或到设置页上调全局预算</p>' : '') +
        '</div>';
    }

    if (!list.length) {
      html += emptyHtml('🎯', state.goalFilter === 'active' ? '还没有进行中的目标' : '这里还没有内容',
        state.goalFilter === 'active' ? '<div style="margin-top:12px"><button class="btn primary block" data-action="new-goal">＋ 新建目标</button></div>' : '');
    } else {
      html += list.map(goalCard).join('');
    }
    if (state.goalFilter === 'active' && list.length >= Store.loadSettings().goalLimit) {
      html += '<div class="notice warn">💡 活跃目标已有 ' + list.length + ' 个（建议不超过 ' + Store.loadSettings().goalLimit + ' 个）。目标太多容易过载，专注更少的目标完成率更高。</div>';
    }
    $('#goals-body').innerHTML = html;
  }

  function goalCard(g) {
    var tasks = Store.tasksWhere(function (t) { return t.goalId === g.id; });
    var prog = Rules.milestoneProgress(g, tasks);
    var pct = Math.round(prog.overall * 100); // 整体进度（与详情页一致）
    var ty = Store.typeOf(g.type), pr = Store.prioOf(g.priority);
    var today = Store.todayStr();
    // 当前阶段信息（阶段名 / 剩余任务 / 预计结束 / 阶段内进度）
    var stage = Rules.currentStageInfo(g, tasks);
    var stageMeta = '', stageBar = '';
    if (stage) {
      stageMeta = '<span>🧭 当前阶段：' + esc(stage.name) + ' · 剩余 ' + stage.remaining + ' 任务 · 预计 ' + stage.targetDate.slice(5) + ' 结束</span>';
      stageBar = '<div class="bar-row" style="margin-top:5px">' +
        '<span style="min-width:56px;white-space:nowrap">本阶段</span>' +
        '<div class="bar"><i style="width:' + stage.stagePct + '%;background:' + ty.color + '"></i></div>' +
        '<span class="val">' + stage.stagePct + '%</span></div>';
    } else {
      var futureCount = tasks.filter(function (t) { return t.date >= today && t.status === 'todo'; }).length;
      stageMeta = futureCount ? '<span>📋 未来 ' + futureCount + ' 个任务</span>' : '<span style="color:var(--faint)">暂无排期</span>';
      var eta = Agg.goalStats(g).eta;
      if (eta && eta >= today) stageMeta += '<span>🏁 预计 ' + eta.slice(5) + ' 完成</span>';
    }
    return '<div class="card goal-card" data-action="open-detail" data-id="' + g.id + '">' +
      '<div class="goal-ring" style="background:conic-gradient(' + ty.color + ' ' + pct + '%, #e9edf7 0)">' +
      '<i style="background:#fff;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center">' + pct + '%</i></div>' +
      '<div class="goal-main">' +
      '<p class="goal-title">' + (g.isCore ? '★ ' : '') + esc(g.title) + '</p>' +
      '<div class="goal-meta">' +
      '<span><span class="dot" style="background:' + ty.color + '"></span>' + ty.name + '</span>' +
      '<span style="color:' + pr.color + '">优先级 ' + pr.name + '</span>' +
      '<span>📅 ' + fmtDeadline(g.deadline) + '</span>' +
      stageMeta +
      (g.status !== 'active' ? '<span class="tag">' + Store.GOAL_STATUS[g.status].name + '</span>' : '') +
      '</div>' + stageBar +
      '</div></div>';
  }

  /* ---------- 目标表单 ---------- */

  function goalBudgetHint() {
    var s = Store.loadSettings();
    var wd = +$('#gf-weekday').value || 0, we = +$('#gf-weekend').value || 0;
    var editingId = state.editingGoalId;
    Store.activeGoals().forEach(function (g) {
      if (g.id === editingId) return;
      wd += (+g.weekdayMinutes || 0);
      we += (+g.weekendMinutes || 0);
    });
    var el = $('#gf-budget-hint');
    if (!el) return;
    if (wd > s.dailyBudget.weekday || we > s.dailyBudget.weekend) {
      el.textContent = '⚠️ 与其他目标合计：工作日 ' + wd + ' / 周末 ' + we + ' 分钟，已超出全局预算（' + s.dailyBudget.weekday + '/' + s.dailyBudget.weekend + '），建议调低或上调全局预算';
      el.className = 'form-hint warn';
    } else {
      el.textContent = '与其他目标合计：工作日 ' + wd + ' / 周末 ' + we + ' 分钟（全局预算 ' + s.dailyBudget.weekday + '/' + s.dailyBudget.weekend + '）';
      el.className = 'form-hint';
    }
  }

  /**
   * 新建目标两步引导：第 1 步「目标是什么」→ 第 2 步「投入与约束」
   * 编辑模式直接进入第 2 步（全字段）
   */
  function openGoalModal(goal) {
    state.editingGoalId = goal ? goal.id : null;
    state.goalDraft = goal ? {
      title: goal.title, type: goal.type, deadline: goal.deadline
    } : { title: '', type: '', deadline: Store.addDays(Store.todayStr(), 60) };
    renderGoalForm(goal ? 2 : 1, goal);
  }

  /** 非必填字段的示例文案（按目标类型） */
  var GOAL_EXAMPLES = {
    study: { base: '会 Python 基础，没系统学过建模', pref: '喜欢视频课+动手练习，晚上效率高' },
    fitness: { base: '有一定运动习惯，最近停了', pref: '喜欢跑步+力量，早上有空' },
    skill: { base: '能看懂，开口难，没系统练过', pref: '通勤时间可以练，喜欢跟读' },
    reading: { base: '平时偶尔看书，一个月不到一本', pref: '喜欢纸质书，睡前阅读半小时' },
    other: { base: '刚起步，还没头绪', pref: '碎片时间为主，周末更充裕' }
  };

  function renderGoalForm(step, goal) {
    state.goalFormStep = step;
    var g = goal || {};
    var d = state.goalDraft || {};
    var typeOpts = function (selected) {
      return '<option value=""' + (selected ? '' : ' hidden') + '>请选择</option>' +
        Store.GOAL_TYPES.map(function (t) {
          return '<option value="' + t.id + '"' + (selected === t.id ? ' selected' : '') + '>' + t.name + '</option>';
        }).join('');
    };
    // 第 1 步字段（目标是什么）——唯一的目标描述输入框
    var step1Fields =
      '<div class="form-item"><label>目标描述 *</label>' +
      '<input id="gf-title" value="' + esc(d.title || '') + '" placeholder="例：两个月准备数学建模竞赛"></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>目标类型 *</label><select id="gf-type">' + typeOpts(d.type || '') + '</select></div>' +
      '<div class="form-item"><label>截止时间 *</label><input type="date" id="gf-deadline" value="' + esc(d.deadline || Store.addDays(Store.todayStr(), 60)) + '"></div>' +
      '</div>';
    var step1 =
      '<div class="step-ind">第 1 步 / 共 2 步 · 先告诉 AI 目标是什么</div>' +
      step1Fields +
      '<button class="btn primary block" data-action="goal-step-next">下一步：投入与约束 →</button>';
    var prChips = Store.PRIORITIES.map(function (p) {
      return '<button class="chip ' + ((g.priority || Store.loadSettings().defaultPriority) === p.id ? 'active' : '') + '" data-action="chip-pick" data-group="prio" data-val="' + p.id + '">' + p.name + '</button>';
    }).join('');
    var step2 =
      '<div class="step-ind">第 2 步 / 共 2 步 · 每天能投入多少时间</div>' +
      step1Fields +
      '<div class="form-2col">' +
      '<div class="form-item"><label>工作日可用（分钟）</label><input type="number" id="gf-weekday" class="js-goal-min" min="0" step="10" value="' + (g.weekdayMinutes != null ? g.weekdayMinutes : 60) + '"></div>' +
      '<div class="form-item"><label>周末可用（分钟）</label><input type="number" id="gf-weekend" class="js-goal-min" min="0" step="10" value="' + (g.weekendMinutes != null ? g.weekendMinutes : 90) + '"></div>' +
      '</div>' +
      '<p class="form-hint" id="gf-budget-hint"></p>' +
      '<div class="form-item"><div class="label-row"><label>当前基础 (选填)</label>' +
      '<button class="chip xs" data-action="gf-example" data-target="gf-base">💡 示例</button></div>' +
      '<textarea id="gf-base" placeholder="例：会 Python 基础，没系统学过建模">' + esc(g.base || '') + '</textarea></div>' +
      '<div class="form-item"><div class="label-row"><label>个人偏好 (选填)</label>' +
      '<button class="chip xs" data-action="gf-example" data-target="gf-pref">💡 示例</button></div>' +
      '<textarea id="gf-pref" placeholder="例：喜欢视频课+动手练习，晚上效率高">' + esc(g.preferences || '') + '</textarea></div>' +
      '<div class="form-item"><label>优先级</label><div class="radio-row" data-pick-group="prio">' + prChips + '</div></div>' +
      '<div class="form-item check-row"><input type="checkbox" id="gf-core"' + (g.isCore ? ' checked' : '') + '>' +
      '<label for="gf-core" style="margin:0">设为核心目标 ★（最多 2 个，资源冲突时优先保障）</label></div>' +
      '<div class="btn-row">' +
      (goal ? '' : '<button class="btn ghost" data-action="goal-step-back">← 上一步</button>') +
      '<button class="btn primary" data-action="save-goal">' + (goal ? '保存修改' : '创建目标') + '</button></div>';
    openModal('<h2>' + (goal ? '编辑目标' : '新建目标') + '</h2>' +
      (step === 1 ? step1 : step2));
    if (step === 2) goalBudgetHint();
  }

  /** 💡示例：按当前所选目标类型填入示例文案 */
  function fillGoalExample(target) {
    var type = ($('#gf-type') && $('#gf-type').value) || (state.goalDraft && state.goalDraft.type) || 'other';
    var ex = GOAL_EXAMPLES[type] || GOAL_EXAMPLES.other;
    var input = $('#' + target);
    if (!input) return;
    input.value = target === 'gf-base' ? ex.base : ex.pref;
    toast('已填入示例，可自由修改');
  }

  /** 在步骤切换前把当前表单值收进草稿，避免丢失 */
  function stashGoalDraft() {
    var d = state.goalDraft || (state.goalDraft = {});
    if ($('#gf-title')) d.title = $('#gf-title').value.trim();
    if ($('#gf-type')) d.type = $('#gf-type').value;
    if ($('#gf-deadline')) d.deadline = $('#gf-deadline').value;
    return d;
  }

  function saveGoalFromModal() {
    var draft = stashGoalDraft();
    var title = draft.title;
    var deadline = draft.deadline;
    if (!title) { toast('请填写目标描述', true); return; }
    if (!draft.type) { toast('请选择目标类型', true); return; }
    if (!deadline) { toast('请选择截止时间', true); return; }
    var isCore = $('#gf-core').checked;
    var coreCount = Store.activeGoals().filter(function (g) { return g.isCore && g.id !== state.editingGoalId; }).length;
    if (isCore && coreCount >= 2) { toast('核心目标最多 2 个，请先取消其他核心标记', true); return; }
    var prioEl = $('#modal-box [data-pick-group="prio"]');
    var fields = {
      title: title,
      description: title,
      type: draft.type,
      deadline: deadline,
      weekdayMinutes: Store.clamp(+$('#gf-weekday').value || 0, 0, 720),
      weekendMinutes: Store.clamp(+$('#gf-weekend').value || 0, 0, 720),
      base: $('#gf-base').value.trim(),
      preferences: $('#gf-pref').value.trim(),
      priority: (prioEl && prioEl.dataset.val) || 'mid',
      isCore: isCore
    };
    if (state.editingGoalId) {
      Store.updateGoal(state.editingGoalId, fields);
      toast('目标已更新');
    } else {
      var g = Store.addGoal(Store.newGoal(fields));
      state.editingGoalId = g.id;
      toast('目标已创建，可在详情页生成 AI 大纲');
    }
    state.goalDraft = null;
    closeModal();
    render();
  }

  /* ==========================================================
   * 目标详情（覆盖层）
   * ========================================================== */

  function openDetail(id) {
    state.detailId = id;
    var el = $('#goal-detail');
    el.classList.remove('hidden');
    el.classList.add('show');
    renderDetail();
  }
  function closeDetail() {
    state.detailId = null;
    var el = $('#goal-detail');
    el.classList.add('hidden');
    el.classList.remove('show');
    render();
  }

  function renderDetail() {
    var g = Store.goalById(state.detailId);
    if (!g) { closeDetail(); return; }
    var el = $('#detail-body');
    var tasks = Store.tasksWhere(function (t) { return t.goalId === g.id; });
    var prog = Rules.milestoneProgress(g, tasks);
    var ty = Store.typeOf(g.type), pr = Store.prioOf(g.priority);
    var html = '';

    // 头部信息
    html += '<div class="card"><p class="goal-title" style="font-size:16.5px;white-space:normal">' +
      '<span class="dot" style="background:' + ty.color + '"></span>' + (g.isCore ? '★ ' : '') + esc(g.title) + '</p>' +
      '<div class="goal-meta" style="margin-bottom:8px">' +
      '<span class="tag">' + ty.name + '</span>' +
      '<span class="tag" style="color:' + pr.color + '">优先级 ' + pr.name + '</span>' +
      '<span class="tag">📅 ' + g.deadline + ' · ' + fmtDeadline(g.deadline) + '</span>' +
      '<span class="tag">' + Store.GOAL_STATUS[g.status].name + '</span></div>' +
      '<div class="stat-grid">' +
      '<div class="cell" style="box-shadow:none;background:var(--bg)"><b>' + Math.round(prog.taskRate * 100) + '%<span class="info-i" data-action="info-rate">ⓘ</span></b><span>任务完成率</span></div>' +
      '<div class="cell" style="box-shadow:none;background:var(--bg)"><b>' + Math.round(prog.overall * 100) + '%<span class="info-i" data-action="info-overall">ⓘ</span></b><span>整体进度</span></div>' +
      '<div class="cell" style="box-shadow:none;background:var(--bg)"><b>' + Math.max(0, Store.daysBetween(Store.todayStr(), g.deadline)) + '</b><span>剩余天数</span></div>' +
      '</div></div>';

    // 约束条件
    html += '<div class="card"><h3>约束条件</h3><div class="review-sum">' +
      '每天投入：<b>' + fmtMin(g.weekdayMinutes) + '</b>（工作日）/ <b>' + fmtMin(g.weekendMinutes) + '</b>（周末）<br>' +
      '当前基础：' + (g.base ? esc(g.base) : '<span style="color:var(--faint)">未填写</span>') + '<br>' +
      '个人偏好：' + (g.preferences ? esc(g.preferences) : '<span style="color:var(--faint)">未填写</span>') + '</div></div>';

    // 阷段大纲（里程碑：阶段名称 + 关键节点目标 + 起止时间 + 进度勾选）
    html += '<div class="card"><h3>阶段大纲</h3>';
    if ((g.milestones || []).length) {
      var curMs = Rules.currentMilestone(g);
      g.milestones.forEach(function (m, i) {
        var start = m.startDate || (i === 0
          ? Store.fmtDate(new Date(g.createdAt || Date.now()))
          : Store.addDays(g.milestones[i - 1].targetDate, 1));
        var isCur = curMs === m;
        html += '<div class="milestone ' + (m.done ? 'done' : '') + (isCur ? ' current' : '') + '">' +
          '<div class="ms-check" data-action="toggle-milestone" data-index="' + i + '">' + (m.done ? '✓' : '') + '</div>' +
          '<div style="flex:1;min-width:0"><p class="ms-title">' + esc(m.title) +
          (isCur ? ' <span class="tag" style="background:var(--brand-weak);color:var(--brand)">进行中</span>' : '') + '</p>' +
          (m.detail ? '<p class="ms-detail">🎯 ' + esc(m.detail) + '</p>' : '') +
          '<span class="ms-date">' + start.slice(5) + ' – ' + m.targetDate.slice(5) + '</span></div></div>';
      });
      html += '<button class="btn ghost sm" data-action="gen-outline" data-id="' + g.id + '" style="margin-top:8px">🔄 让 AI 重新生成大纲</button>';
    } else {
      html += '<p class="card-sub">还没有阶段大纲。AI 会先把目标拆成 3-6 个阶段（含起止时间与关键节点目标），再逐周展开成每日任务（省 Token 且灵活）。</p>' +
        '<button class="btn primary sm" data-action="gen-outline" data-id="' + g.id + '">✨ AI 生成阶段大纲</button>';
    }
    html += '</div>';

    // 自定义日常任务（RepeatRule 本地生成，不耗 AI）
    html += '<div class="card"><h3>自定义日常任务 <span class="tag">本地生成 · 不耗 AI</span></h3>';
    if ((g.repeatRules || []).length) {
      g.repeatRules.forEach(function (r, i) {
        html += '<div class="log-item"><div class="log-head"><span>🔒 ' + esc(r.titleTpl || '固定任务') +
          ' · ' + fmtMin(r.minutes) + '</span>' +
          '<button class="icon-btn" style="color:var(--danger)" data-action="del-rule" data-goal="' + g.id + '" data-index="' + i + '">删除</button></div>' +
          '<p class="log-summary">' + ruleDesc(r) + '</p></div>';
      });
    } else {
      html += '<p class="card-sub">如「每天练 30 分钟口语」这类每天都要做的任务，在这里定义规则后每天自动生成，不消耗 AI Token。</p>';
    }
    html += '<button class="btn ghost sm" data-action="add-rule" data-id="' + g.id + '" style="margin-top:6px">＋ 添加日常任务</button></div>';

    // 每日任务（按日期倒序 + 逐条可编辑 + AI 规划/调整整合入口）
    var futureTodo = tasks.filter(function (t) {
      return t.date >= Store.todayStr() && t.status === 'todo';
    }).length;
    html += '<div class="card"><div class="card-head-row"><h3>每日任务</h3>' +
      '<button class="btn primary sm" data-action="ai-plan-or-adjust" data-id="' + g.id + '">' +
      (futureTodo ? '✨ AI 规划/调整' : '✨ AI 生成任务') + '</button></div>' +
      '<p class="form-hint" style="margin:-2px 0 8px">' + (futureTodo
        ? '已有 ' + futureTodo + ' 个未来任务，点右上角可让 AI 结合负荷优化重排'
        : '当前没有未来任务，点右上角让 AI 生成未来 7 天的每日任务') + '</p>';
    var byDate = {};
    tasks.forEach(function (t) { (byDate[t.date] = byDate[t.date] || []).push(t); });
    var dates = Object.keys(byDate).sort().reverse().slice(0, 14);
    if (!dates.length) {
      html += '<p class="card-sub">还没有任务。</p>';
    } else {
      dates.forEach(function (d) {
        html += '<div class="group-title">' + d + ' 周' + Store.weekdayCN(d) + (d === Store.todayStr() ? ' · 今天' : '') + '</div>';
        byDate[d].forEach(function (t) {
          html += '<div class="log-item"><div class="log-head">' +
            '<span>' + (t.source === 'rule' || t.locked ? '🔒 ' : '') + esc(t.title) + '</span>' +
            '<span class="scope"><span class="tag">' + Store.TASK_STATUS[t.status].name + '</span> ' + t.estimateMin + '分钟 ' +
            '<a href="javascript:void(0)" data-action="task-menu" data-id="' + t.id + '" style="color:var(--brand);font-weight:700">⋯</a></span></div></div>';
        });
      });
      var futureCount = tasks.filter(function (t) { return t.date > dates[0]; }).length;
      if (futureCount > 0) html += '<p class="form-hint">仅显示最近 14 天，更早/更晚的任务见计划页；点任务右侧 ⋓ 可修改名称、时长、日期或删除</p>';
    }
    html += '</div>';

    // AI 调整历史（该目标）
    var logs = Store.getLogs().filter(function (l) { return l.scope === 'goal' && l.goalId === g.id; }).slice(0, 5);
    html += '<div class="card"><h3>AI 调整历史</h3>' + logsHtml(logs, true) + '</div>';

    // 操作按钮（编辑统一走右上角入口；AI 生成/调整整合进「每日任务」卡右上角）
    html += '<div class="btn-row">' + (g.status === 'paused'
      ? '<button class="btn ok" data-action="resume-goal">恢复目标</button>'
      : '<button class="btn ghost" data-action="pause-goal">暂停</button>') +
      '<button class="btn ghost" data-action="archive-goal">' + (g.status === 'archived' ? '取消归档' : '归档') + '</button>' +
      '<button class="btn danger" data-action="delete-goal">删除</button></div>';

    el.innerHTML = html;
  }

  function ruleDesc(r) {
    if (r.freq === 'daily') return '每天';
    if (r.freq === 'everyN') return '每 ' + (r.n || 2) + ' 天';
    if (r.freq === 'weekly') {
      var names = ['日', '一', '二', '三', '四', '五', '六'];
      var wd = (r.weekdays || []).map(function (w) { return names[w]; }).join('、');
      return '每周' + (wd || '—');
    }
    return '';
  }

  function logsHtml(logs, compact) {
    if (!logs.length) return '<p class="card-sub">暂无记录</p>';
    return logs.map(function (l) {
      var stateTxt = l.undone ? '<span class="log-state undone">已撤销</span>'
        : l.status === 'applied' ? '<span class="log-state applied">已应用</span>'
          : '<span class="log-state rejected">已拒绝</span>';
      var scopeTxt = l.scope === 'global' ? '全局协调' : '目标调整';
      return '<div class="log-item"><div class="log-head" data-action="log-detail" data-id="' + l.id + '" style="cursor:pointer">' +
        '<span>' + scopeTxt + (l.changes && l.changes.length ? ' · ' + l.changes.length + ' 项变更' : '') + '</span>' +
        '<span>' + stateTxt +
        (l.changes && l.changes.length ? ' · <a href="javascript:void(0)" data-action="log-detail" data-id="' + l.id + '" style="color:var(--brand)">查看详情</a>' : '') +
        '</span></div>' +
        (l.summary ? '<p class="log-summary">' + esc(l.summary) + '</p>' : '') +
        '<p class="form-hint">' + new Date(l.ts).toLocaleString('zh-CN') +
        (l.status === 'applied' && !l.undone ? ' · <a href="javascript:void(0)" data-action="undo-log" data-id="' + l.id + '" style="color:var(--brand)">一键撤销</a>' : '') +
        '</p></div>';
    }).join('');
  }

  /** 调整明细弹窗：逐条 Diff + 撤销入口 */
  function openLogDetailModal(id) {
    var log = Store.logById(id);
    if (!log) return;
    var items = (log.changes || []).map(function (ch) {
      var h = Adjust.humanChange(ch);
      return '<div class="preview-item"><span class="p-icon">' + h.icon + '</span><div>' +
        '<p class="p-text">' + esc(h.text) + '</p>' +
        (h.detail ? '<p class="p-detail">' + esc(h.detail) + '</p>' : '') +
        (ch.reason ? '<p class="p-reason">理由：' + esc(ch.reason) + '</p>' : '') + '</div></div>';
    }).join('') || '<p class="card-sub">无变更明细</p>';
    openModal('<h2>调整明细</h2>' +
      '<p class="card-sub">' + (log.scope === 'global' ? '全局协调' : '目标调整') +
      ' · ' + new Date(log.ts).toLocaleString('zh-CN') + (log.summary ? '<br>' + esc(log.summary) : '') + '</p>' +
      items +
      (log.status === 'rejected' ? '<p class="form-hint">该批建议已被你拒绝，未做任何改动</p>' : '') +
      (log.status === 'applied' && !log.undone
        ? '<button class="btn warn block" style="background:#fdf3e0;color:#92600a;margin-top:8px" data-action="undo-log" data-id="' + log.id + '">↩️ 撤销这批调整（任务恢复到调整前）</button>'
        : '') +
      '<button class="btn ghost block" style="margin-top:8px" data-action="close-modal">关闭</button>');
  }

  /* ---------- 固定任务规则表单 ---------- */

  function openRuleModal(goalId) {
    var g = Store.goalById(goalId);
    if (!g) return;
    var wdChips = [1, 2, 3, 4, 5, 6, 0].map(function (w) {
      return '<button class="chip" data-action="chip-multi" data-multi="wd' + w + '">周' + '日一二三四五六'[w] + '</button>';
    }).join('');
    openModal('<h2>添加固定任务</h2>' +
      '<p class="card-sub">属于目标「' + esc(g.title) + '」，按规则每天自动生成，不消耗 AI Token</p>' +
      '<div class="form-item"><label>任务标题</label><input id="rf-title" placeholder="例：英语口语跟读练习"></div>' +
      '<div class="form-item"><label>频率</label><div class="radio-row" data-pick-group="rfreq">' +
      '<button class="chip active" data-action="chip-pick" data-group="rfreq" data-val="daily">每天</button>' +
      '<button class="chip" data-action="chip-pick" data-group="rfreq" data-val="weekly">每周固定几天</button>' +
      '</div></div>' +
      '<div class="form-item" id="rf-weekdays-box" style="display:none"><label>选择星期</label><div class="radio-row">' + wdChips + '</div></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>时长（分钟）</label><input type="number" id="rf-minutes" value="30" min="5" step="5"></div>' +
      '<div class="form-item"><label>精力</label><select id="rf-energy"><option value="low">低精力</option><option value="mid" selected>中精力</option><option value="high">高精力</option></select></div>' +
      '</div>' +
      '<div class="btn-row"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-rule" data-id="' + goalId + '">保存</button></div>');
  }

  function saveRuleFromModal(goalId) {
    var g = Store.goalById(goalId);
    if (!g) return;
    var title = $('#rf-title').value.trim();
    if (!title) { toast('请填写任务标题', true); return; }
    var freqEl = $('#modal-box [data-pick-group="rfreq"]');
    var freq = (freqEl && freqEl.dataset.val) || 'daily';
    var weekdays = $$('#modal-box [data-multi]').filter(function (el) {
      return el.dataset.multi.indexOf('wd') === 0 && el.classList.contains('active');
    }).map(function (el) { return +el.dataset.multi.slice(2); });
    if (freq === 'weekly' && !weekdays.length) { toast('请选择星期', true); return; }
    var rule = {
      id: Store.uid('rule'),
      freq: freq,
      weekdays: weekdays,
      minutes: Store.clamp(+$('#rf-minutes').value || 30, 5, 300),
      energy: $('#rf-energy').value,
      titleTpl: title,
      descTpl: '',
      startDate: Store.todayStr()
    };
    var rules = (g.repeatRules || []).concat([rule]);
    Store.updateGoal(goalId, { repeatRules: rules });
    Rules.ensureRange(Store.todayStr(), 7);
    closeModal();
    toast('固定任务已添加，今天起的计划会自动生成');
    render();
  }

  /* ==========================================================
   * AI 流程：大纲 / 周计划 / 调整
   * ========================================================== */

  function genOutlineFor(goalId) {
    var g = Store.goalById(goalId);
    if (!g) return;
    if (AI.useMock()) toast('当前为 Mock 演示模式');
    showLoading('正在为「' + g.title + '」生成阶段大纲…');
    AI.genOutline(g).then(function (res) {
      state.lastOutline = { goalId: goalId, milestones: res.milestones, advice: res.advice };
      var items = res.milestones.map(function (m, i) {
        return '<div class="preview-item"><span class="p-icon">' + (i + 1) + '</span><div>' +
          '<p class="p-text">' + esc(m.title) + ' <span class="ms-date">至 ' + m.targetDate + '</span></p>' +
          (m.detail ? '<p class="p-detail">' + esc(m.detail) + '</p>' : '') + '</div></div>';
      }).join('');
      openModal('<h2>✨ 阶段大纲预览</h2>' +
        (res.advice ? '<p class="card-sub">AI 建议：' + esc(res.advice) + '</p>' : '') +
        items +
        '<p class="form-hint" style="margin:8px 0">应用后会替换现有大纲；每日任务还需「展开未来 7 天」生成。</p>' +
        '<div class="btn-row"><button class="btn ghost" data-action="close-modal">取消</button>' +
        '<button class="btn primary" data-action="apply-outline">应用大纲</button></div>');
    }).catch(function (e) {
      closeModal();
      toast(AI.humanizeError(e), true);
    });
  }

  function applyOutline() {
    var o = state.lastOutline;
    if (!o) return;
    Store.updateGoal(o.goalId, { milestones: o.milestones, outlineConfirmed: true });
    state.lastOutline = null;
    closeModal();
    toast('大纲已应用，可继续「展开未来 7 天」');
    render();
  }

  function expandWeekFor(goalId) {
    var g = Store.goalById(goalId);
    if (!g) return;
    showLoading('正在为「' + g.title + '」规划未来 7 天…');
    AI.genWeekPlan(g, { days: 7 }).then(function (res) {
      state.lastPlan = { goalId: goalId, tasks: res.tasks };
      var items = res.tasks.map(function (t, i) {
        return '<div class="preview-item"><input type="checkbox" checked data-idx="' + i + '">' +
          '<div><p class="p-text">' + esc(t.title) + '</p>' +
          '<p class="p-detail">' + t.date + ' · ' + t.estimateMin + ' 分钟 · ' + Store.energyOf(t.energy).name + '</p>' +
          (t.desc ? '<p class="p-detail">' + esc(t.desc) + '</p>' : '') + '</div></div>';
      }).join('');
      openModal('<h2>📅 未来 7 天计划预览（' + res.tasks.length + ' 个任务）</h2>' +
        '<p class="card-sub">勾选要加入的任务；应用后会替换该目标未来 7 天内未完成的 AI 任务</p>' +
        (items || '<p class="card-sub">AI 认为近期没有空余时间，未生成任务</p>') +
        '<div class="btn-row"><button class="btn ghost" data-action="close-modal">取消</button>' +
        '<button class="btn primary" data-action="apply-plan"' + (res.tasks.length ? '' : ' disabled') + '>加入计划</button></div>');
    }).catch(function (e) {
      closeModal();
      toast(AI.humanizeError(e), true);
    });
  }

  function applyPlan() {
    var p = state.lastPlan;
    if (!p) return;
    var checked = $$('#modal-box input[data-idx]').filter(function (c) { return c.checked; })
      .map(function (c) { return +c.dataset.idx; });
    var tasks = p.tasks.filter(function (t, i) { return checked.indexOf(i) >= 0; });
    if (!tasks.length) { toast('未勾选任何任务', true); return; }
    // 替换该目标未来 7 天内未完成的 AI 任务，避免重复堆积
    var from = Store.todayStr(), to = Store.addDays(from, 6);
    Store.getTasks().filter(function (t) {
      return t.goalId === p.goalId && t.source === 'ai' && t.status === 'todo' &&
        t.date >= from && t.date <= to;
    }).forEach(function (t) { Store.removeTask(t.id); });
    // 防重复：同目标同日已有同名任务（任何状态，含未完成/失败）则不再新增
    var existing = {};
    Store.getTasks().forEach(function (t) {
      if (t.goalId !== p.goalId) return;
      existing[t.date + '|' + t.title] = true;
    });
    var skipped = 0;
    var fresh = [];
    tasks.forEach(function (t) {
      if (existing[t.date + '|' + t.title]) { skipped++; return; }
      existing[t.date + '|' + t.title] = true;
      fresh.push(t);
    });
    var batchId = Store.uid('batch');
    Store.addTasks(fresh.map(function (t) {
      return Store.newTask(Object.assign({}, t, { goalId: p.goalId, source: 'ai', batchId: batchId }));
    }));
    state.lastPlan = null;
    closeModal();
    toast('已加入 ' + fresh.length + ' 个任务' + (skipped ? '（' + skipped + ' 个同名任务已在进行中，未重复添加）' : ''));
    render();
  }

  /** AI 调整：scope = 'goal' | 'global' */
  function runAdjust(scope, goalId, trigger) {
    if (scope === 'global' && !Store.activeGoals().length) { toast('还没有活跃目标', true); return; }
    if (AI.useMock()) toast('当前为 Mock 演示模式');
    showLoading(scope === 'global' ? '正在全局协调所有目标…' : '正在分析该目标的任务…');
    AI.genAdjust(scope, { goalId: goalId, trigger: trigger }).then(function (res) {
      if (!res.changes || !res.changes.length) {
        closeModal();
        toast(res.summary || '当前计划负荷合理，无需调整');
        return;
      }
      var norm = Adjust.normalize(res.changes, scope, goalId);
      if (!norm.changes.length) {
        closeModal();
        var prefix = trigger === 'review' ? 'AI 看过你的复盘：' : '';
        toast(prefix + (res.summary || '当前计划负荷合理，无需调整'));
        return;
      }
      state.lastPreview = { scope: scope, goalId: goalId || '', trigger: trigger || 'manual', summary: res.summary, context: res.context || '', changes: norm.changes };
      closeModal();
      showAdjustPreview(norm.invalid);
    }).catch(function (e) {
      closeModal();
      toast(AI.humanizeError(e), true);
    });
  }

  /** 打开 / 关闭 AI 调整预览页（全屏覆盖层） */
  function showAdjustPreview() {
    var el = $('#adjust-preview');
    el.classList.remove('hidden');
    el.classList.add('show');
    renderAdjustPreviewPage();
  }
  function closeAdjustPreview() {
    var el = $('#adjust-preview');
    el.classList.add('hidden');
    el.classList.remove('show');
    state.lastPreview = null;
    render();
  }

  /** AI 调整预览页：顶部醒目提示 + 触发背景 + 逐条前→后对比 + 三按钮 */
  function renderAdjustPreviewPage(invalidList) {
    var p = state.lastPreview;
    if (!p) return;
    var el = $('#ap-body');
    var items = p.changes.map(function (ch, i) {
      var h = Adjust.humanChange(ch);
      return '<div class="ap-change">' +
        '<div class="task-top" style="margin-bottom:6px">' +
        '<input type="checkbox" checked data-idx="' + i + '" class="js-ap-check">' +
        '<span class="p-icon">' + h.icon + '</span>' +
        '<span class="ap-change-type">' + (Adjust.OP_NAMES[ch.op] || ch.op) + (ch.kind === 'advance' ? '·进阶' : ch.kind === 'buffer' ? '·缓冲' : '') + '</span></div>' +
        '<p class="p-text" style="font-size:14.5px;font-weight:600;margin:0">' + esc(h.text) + '</p>' +
        (h.detail ? '<p class="p-detail">' + esc(h.detail) + '</p>' : '') +
        (ch.reason ? '<p class="p-reason">🤖 AI 理由：' + esc(ch.reason) + '</p>' : '') + '</div>';
    }).join('');
    el.innerHTML =
      '<div class="ap-banner">🛡️ <b>AI 仅建议，不会自动修改</b>：过去和已完成的任务、🔒锁定任务都不会被改动；勾选后点「接受」才真正生效，拒绝则一切保持原样。</div>' +
      (p.context ? '<div class="notice info" style="margin-top:10px">📊 触发背景：' + esc(p.context) + '</div>' : '') +
      (p.summary ? '<div class="card" style="margin-top:10px"><h3>调整摘要</h3><div class="review-sum">' + esc(p.summary) + '</div></div>' : '') +
      '<div class="group-title">本次共 ' + p.changes.length + ' 项变更（勾选要接受的部分）</div>' +
      items +
      ((invalidList && invalidList.length) ? '<div class="notice warn" style="margin-top:10px">已忽略 ' + invalidList.length + ' 条无效建议（' + esc(invalidList[0]) + ' 等）</div>' : '') +
      '<div style="height:80px"></div>';
    $('#ap-footer').innerHTML =
      '<div class="btn-row">' +
      '<button class="btn danger" data-action="ap-reject-all">全部拒绝</button>' +
      '<button class="btn ghost" data-action="ap-accept-checked">选择性接受</button>' +
      '<button class="btn primary" data-action="ap-accept-all">全部接受</button></div>';
  }

  function apAccept(onlyChecked) {
    var p = state.lastPreview;
    if (!p) return;
    var idxs = null;
    if (onlyChecked) {
      idxs = $$('#ap-body .js-ap-check').filter(function (c) { return c.checked; })
        .map(function (c) { return +c.dataset.idx; });
      if (!idxs.length) { toast('请先勾选要接受的变更', true); return; }
    }
    var log = Adjust.apply(p, idxs);
    var n = log.changes.length;
    closeAdjustPreview();
    toast('已接受 ' + n + ' 项调整，可在计划页调整历史中撤销');
    render();
  }

  function apRejectAll() {
    var p = state.lastPreview;
    if (p) Adjust.reject(p);
    closeAdjustPreview();
    toast('已拒绝全部 AI 建议（已留痕，未做任何改动）');
  }

  /* ==========================================================
   * 计划页
   * ========================================================== */

  function renderPlan() {
    var f = state.planFilter;
    var goalOpts = '<option value="">全部目标</option>' + Store.getGoals().filter(function (g) {
      return g.status === 'active' || g.status === 'paused';
    }).map(function (g) {
      return '<option value="' + g.id + '"' + (f.goalId === g.id ? ' selected' : '') + '>' + esc(g.title) + '</option>';
    }).join('');
    var typeOpts = '<option value="">全部类型</option>' + Store.GOAL_TYPES.map(function (t) {
      return '<option value="' + t.id + '"' + (f.type === t.id ? ' selected' : '') + '>' + t.name + '</option>';
    }).join('');
    var enOpts = '<option value="">全部精力</option>' + Store.ENERGIES.map(function (e) {
      return '<option value="' + e.id + '"' + (f.energy === e.id ? ' selected' : '') + '>' + e.name + '</option>';
    }).join('');

    $('#plan-nav').innerHTML =
      '<div class="plan-nav">' +
      (state.planView === 'range'
        ? '<span class="date" style="cursor:default">📅 ' + ((state.rangeDays || 7) === 0 ? '全部任务' : '未来 ' + (state.rangeDays || 7) + ' 天全部任务') + '</span>'
        : '<button class="icon-btn" data-action="plan-prev">‹</button>' +
          '<span class="date" data-action="plan-today">' + planDateLabel() + '</span>' +
          '<button class="icon-btn" data-action="plan-next">›</button>') +
      '<button class="chip ' + (state.planView === 'day' ? 'active' : '') + '" data-action="plan-view" data-view="day">日</button>' +
      '<button class="chip ' + (state.planView === 'week' ? 'active' : '') + '" data-action="plan-view" data-view="week">周</button>' +
      '<button class="chip ' + (state.planView === 'range' ? 'active' : '') + '" data-action="plan-view" data-view="range">未来</button>' +
      '</div>' +
      (state.planView === 'range'
        ? '<div class="chip-row" style="margin-bottom:10px">' +
          '<button class="chip ' + ((state.rangeDays || 7) === 7 ? 'active' : '') + '" data-action="set-range" data-n="7">未来 7 天</button>' +
          '<button class="chip ' + ((state.rangeDays || 7) === 30 ? 'active' : '') + '" data-action="set-range" data-n="30">未来 30 天</button>' +
          '<button class="chip ' + ((state.rangeDays || 7) === 0 ? 'active' : '') + '" data-action="set-range" data-n="0">全部</button></div>'
        : '') +
      '<div class="chip-row" style="margin-bottom:10px">' +
      '<select data-filter="goalId" style="border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:12px;color:var(--muted);background:#fff">' + goalOpts + '</select>' +
      '<select data-filter="type" style="border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:12px;color:var(--muted);background:#fff">' + typeOpts + '</select>' +
      '<select data-filter="energy" style="border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:12px;color:var(--muted);background:#fff">' + enOpts + '</select>' +
      '</div>';

    var html = mockBanner();
    if (state.planView === 'day') {
      html += renderPlanDay(state.planDate);
    } else {
      var dates = state.planView === 'range'
        ? (function () {
          if ((state.rangeDays || 7) === 0) {
            // 全部：历史所有出现任务的日期 ∪ 未来 7 天，升序
            var set = {};
            Store.getTasks().forEach(function (t) { set[t.date] = true; });
            for (var i = 0; i < 7; i++) set[Store.addDays(Store.todayStr(), i)] = true;
            return Object.keys(set).sort();
          }
          var arr = [];
          for (var j = 0; j < (state.rangeDays || 7); j++) arr.push(Store.addDays(Store.todayStr(), j));
          return arr;
        })()
        : Agg.weekDates(state.planDate);
      if (state.planView === 'week') {
        html += '<div class="week-head">' + dates.map(function (d) {
          var act = d === state.planDate;
          return '<button data-action="plan-pick-weekday" data-date="' + d + '"' + (act ? ' class="active"' : '') + '>周' + Store.weekdayCN(d) + '<b>' + Store.parseDate(d).getDate() + '</b></button>';
        }).join('') + '</div>';
      }
      dates.forEach(function (d) {
        html += '<div id="day-' + d + '">';
        html += '<div class="group-title">' + d + ' 周' + Store.weekdayCN(d) + (d === Store.todayStr() ? ' · 今天' : d < Store.todayStr() ? ' · 已过期' : '') + '</div>';
        html += renderPlanDay(d, true) + '</div>';
      });
    }

    // AI 优化入口（单一入口 + 范围选择弹窗）
    html += '<div class="card"><h3>✨ 让 AI 优化未来计划</h3>' +
      '<p class="card-sub">AI 通读目标与任务负荷，给出延后/拆分/新增等建议；全部需预览确认，可拒绝、可撤销</p>' +
      '<button class="btn primary block" data-action="open-ai-optimize">✨ 优化未来 7 天</button></div>';

    // 调整历史
    html += '<div class="card"><h3>AI 调整历史</h3>' + logsHtml(Store.getLogs().slice(0, 12), false) + '</div>';

    $('#plan-body').innerHTML = html;
  }

  function planDateLabel() {
    var d = state.planDate;
    if (state.planView === 'week') {
      var wk = Agg.weekDates(d);
      var isThis = wk.indexOf(Store.todayStr()) >= 0;
      var range = Store.parseDate(wk[0]).getMonth() + 1 + '月' + Store.parseDate(wk[0]).getDate() + '日 – ' +
        (Store.parseDate(wk[6]).getMonth() + 1) + '月' + Store.parseDate(wk[6]).getDate() + '日';
      return (isThis ? '本周 · ' : '周 · ') + range;
    }
    var txt = Store.parseDate(d).getMonth() + 1 + '月' + Store.parseDate(d).getDate() + '日 周' + Store.weekdayCN(d);
    if (d === Store.todayStr()) txt = '今天 · ' + txt;
    return txt;
  }

  function planFilteredTasks(date) {
    var f = state.planFilter;
    return Agg.tasksFor(date).filter(function (t) {
      if (f.goalId && t.goalId !== f.goalId) return false;
      if (f.energy && t.energy !== f.energy) return false;
      if (f.type) {
        var g = Store.goalById(t.goalId);
        if (!g || g.type !== f.type) return false;
      }
      return true;
    });
  }

  function renderPlanDay(date, compact) {
    var tasks = planFilteredTasks(date);
    var st = Agg.dayStats(date);
    var html = '';
    if (!compact && st.over > 0) {
      html += '<div class="notice danger"><span>⚠️ 该日超预算 ' + st.over + ' 分钟</span>' +
        '<button class="btn sm danger" data-action="ai-rebalance" data-scope="global" data-trigger="overload">AI 协调</button></div>';
    }
    if (!tasks.length) {
      html += emptyHtml('🗒', '无任务');
      return html;
    }
    tasks.forEach(function (t) {
      var goal = Store.goalById(t.goalId) || { title: '?', type: 'other' };
      var ty = Store.typeOf(goal.type);
      html += '<div class="task-row">' +
        '<div class="task-card' + (t.status === 'done' ? ' done-state' : '') + '">' +
        '<div class="task-top"><span class="goal-name"><span class="dot" style="background:' + ty.color + '"></span>' + esc(goal.title) + '</span>' +
        '<span class="tag">' + Store.TASK_STATUS[t.status].icon + Store.TASK_STATUS[t.status].name + '</span>' +
        '<span class="tag" style="color:' + Store.energyOf(t.energy).color + '">' + Store.energyOf(t.energy).name + '</span>' +
        '<span class="tag">⏱ ' + t.estimateMin + '分钟</span>' +
        (t.source === 'rule' || t.locked ? '<span class="tag lock-tag">🔒 固定</span>' : '<span class="tag">' + (t.source === 'ai' ? 'AI' : '手动') + '</span>') + '</div>' +
        '<p class="task-title">' + esc(t.title) + '</p>' +
        (t.desc ? '<p class="task-desc">' + esc(t.desc) + '</p>' : '') + '</div>' +
        '<div class="row-ops">' +
        '<button data-action="task-menu" data-id="' + t.id + '">⋯</button>' +
        '</div></div>';
    });
    return html;
  }

  /** 计划页任务操作菜单（action sheet）：专注管理（编辑/锁定/删除） */
  function openTaskMenuModal(id) {
    var t = Store.taskById(id);
    if (!t) return;
    var isRule = t.source === 'rule';
    var lockItem;
    if (isRule) {
      lockItem = '<button class="as-item" style="color:var(--muted)" data-action="menu-goto-goal" data-goal="' + t.goalId + '">🔒 固定任务（AI 不可修改）</button>' +
        '<button class="as-item" data-action="menu-goto-goal" data-goal="' + t.goalId + '">⤴ 前往目标详情（管理此规则）</button>';
    } else if (t.locked) {
      lockItem = '<button class="as-item" data-action="menu-lock" data-id="' + t.id + '">🔓 取消锁定（允许 AI 调整）</button>';
    } else {
      lockItem = '<button class="as-item" data-action="menu-lock" data-id="' + t.id + '">🔒 锁定（设为固定，AI 不可修改）</button>';
    }
    openModal('<div class="action-sheet">' +
      '<p class="card-sub" style="margin-bottom:6px">' + (t.locked || isRule ? '🔒 ' : '') + esc(t.title) + ' · ' + t.date + '</p>' +
      '<button class="as-item" data-action="menu-edit" data-id="' + t.id + '">✎ 编辑任务</button>' +
      lockItem +
      '<button class="as-item danger" data-action="del-task" data-id="' + t.id + '">🗑 删除任务</button>' +
      '<button class="as-item" data-action="close-modal" style="text-align:center;color:var(--muted)">取消</button>' +
      '</div>');
  }

  /** 重复任务生成：按规则返回日期数组（上限 30 条，截止到目标 deadline 或 90 天） */
  function repeatDates(goalId, startDate, mode, opts) {
    var goal = Store.goalById(goalId);
    var end = goal && goal.deadline && goal.deadline > startDate ? goal.deadline : Store.addDays(startDate, 90);
    var dates = [];
    if (mode === 'daily') {
      for (var d = startDate; d <= end && dates.length < 30; d = Store.addDays(d, 1)) dates.push(d);
    } else if (mode === 'weekly') {
      var wds = (opts.weekdays || []).slice().sort(function (a, b) { return a - b; });
      var cur = startDate;
      var guard = 0;
      while (dates.length < 30 && guard < 120) {
        if (wds.indexOf(Store.parseDate(cur).getDay()) >= 0) dates.push(cur);
        cur = Store.addDays(cur, 1);
        guard++;
      }
    } else if (mode === 'custom') {
      var n = Math.max(2, +opts.everyN || 2);
      var c = startDate;
      while (c <= end && dates.length < 30) {
        dates.push(c);
        c = Store.addDays(c, n);
      }
    }
    return dates;
  }

  function openTaskModal(task) {
    state.editingTaskId = task ? task.id : null;
    state.editingTaskGoalId = task ? (task.goalId || '') : '';
    var t = task || { date: state.planView === 'day' ? state.planDate : Store.todayStr(), energy: 'mid', estimateMin: 30 };
    var goalOpts = '<option value="">选择目标…</option>' + Store.activeGoals().map(function (g) {
      return '<option value="' + g.id + '"' + (t.goalId === g.id ? ' selected' : '') + '>' + esc(g.title) + '</option>';
    }).join('');
    var enOpts = Store.ENERGIES.map(function (e) {
      return '<option value="' + e.id + '"' + (t.energy === e.id ? ' selected' : '') + '>' + e.name + '</option>';
    }).join('');
    var statusOpts = [['todo', '待完成'], ['done', '已完成'], ['partial', '部分完成'], ['missed', '未完成']].map(function (sp) {
      return '<option value="' + sp[0] + '"' + ((t.status || 'todo') === sp[0] ? ' selected' : '') + '>' + sp[1] + '</option>';
    }).join('');
    var repeatOpts = [['once', '单次'], ['daily', '每天'], ['weekly', '每周几'], ['custom', '自定义间隔']].map(function (rp) {
      return '<option value="' + rp[0] + '"' + (rp[0] === 'once' ? ' selected' : '') + '>' + rp[1] + '</option>';
    }).join('');
    var wdChips = [1, 2, 3, 4, 5, 6, 0].map(function (w) {
      return '<button class="chip" data-action="chip-multi" data-multi="tfwd' + w + '">周' + '日一二三四五六'.charAt(w) + '</button>';
    }).join('');
    openModal('<h2>' + (task ? '编辑任务' : '手动新增任务') + '</h2>' +
      '<div class="form-item"><label>所属目标 *</label><select id="tf-goal">' + goalOpts + '</select></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>' + (task ? '日期' : '开始日期') + '</label><input type="date" id="tf-date" value="' + esc(t.date) + '"></div>' +
      (task ? '<div class="form-item"><label>状态</label><select id="tf-status">' + statusOpts + '</select></div>'
            : '<div class="form-item"><label>重复</label><select id="tf-repeat" data-tf="repeat">' + repeatOpts + '</select></div>') +
      '</div>' +
      (task ? '' :
      '<div class="form-item hidden" id="tf-weekly-box"><label>选择星期（可多选）</label><div class="radio-row">' + wdChips + '</div></div>' +
      '<div class="form-item hidden" id="tf-custom-box"><label>每隔几天重复一次</label><input type="number" id="tf-everyn" value="2" min="2" max="14"></div>' +
      '<p class="form-hint" id="tf-repeat-hint">单次任务：仅生成所选日期当天的一条</p>') +
      '<div class="form-item"><label>任务标题 *</label><input id="tf-title" value="' + esc(t.title || '') + '" placeholder="例：完成建模第一章习题"></div>' +
      '<div class="form-item"><label>任务描述</label><textarea id="tf-desc" placeholder="怎么做/产出什么（选填）">' + esc(t.desc || '') + '</textarea></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>精力</label><select id="tf-energy">' + enOpts + '</select></div>' +
      '<div class="form-item"><label>预计时长（分钟）</label><input type="number" id="tf-min" value="' + (t.estimateMin || 30) + '" min="5" step="5"></div>' +
      '</div>' +
      '<div class="btn-row">' + (task ? '<button class="btn danger" data-action="del-task" data-id="' + task.id + '">删除</button>' : '') +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-task">' + (task ? '保存' : '添加') + '</button></div>');
  }

  /** 重复模式切换：显示对应条件字段并更新生成提示 */
  function syncRepeatUI() {
    var mode = $('#tf-repeat') ? $('#tf-repeat').value : 'once';
    var weeklyBox = $('#tf-weekly-box'), customBox = $('#tf-custom-box'), hint = $('#tf-repeat-hint');
    if (!hint) return;
    if (weeklyBox) weeklyBox.classList.toggle('hidden', mode !== 'weekly');
    if (customBox) customBox.classList.toggle('hidden', mode !== 'custom');
    if (mode === 'once') { hint.textContent = '单次任务：仅生成所选日期当天的一条'; return; }
    var goalId = $('#tf-goal') ? $('#tf-goal').value : '';
    var startDate = $('#tf-date') ? $('#tf-date').value : Store.todayStr();
    var opts = {
      weekdays: $$('#modal-box [data-multi]').filter(function (el) {
        return el.dataset.multi.indexOf('tfwd') === 0 && el.classList.contains('active');
      }).map(function (el) { return +el.dataset.multi.slice(4); }),
      everyN: $('#tf-everyn') ? +$('#tf-everyn').value : 2
    };
    if (mode === 'weekly' && !opts.weekdays.length) { hint.textContent = '请先选择星期'; return; }
    var dates = repeatDates(goalId || 'none', startDate, mode, opts);
    var goal = Store.goalById(goalId);
    hint.textContent = '将一次性生成 ' + dates.length + ' 条任务（' +
      (goal && goal.deadline ? '至目标截止 ' + goal.deadline : '最长未来 90 天') + '，上限 30 条），每条可单独编辑删除';
  }

  /* ---------- 任务表单 ---------- */

  function saveTaskFromModal() {
    var goalId = $('#tf-goal').value;
    var title = $('#tf-title').value.trim();
    var date = $('#tf-date').value;
    if (!goalId) { toast('请选择所属目标', true); return; }
    if (!title) { toast('请填写任务标题', true); return; }
    if (!date) { toast('请选择开始日期', true); return; }
    var base = {
      goalId: goalId, date: date, title: title,
      desc: $('#tf-desc').value.trim(),
      energy: $('#tf-energy').value,
      estimateMin: Store.clamp(+$('#tf-min').value || 30, 5, 600)
    };
    if (state.editingTaskId) {
      var patch = Object.assign({}, base, { status: $('#tf-status') ? $('#tf-status').value : 'todo' });
      Store.updateTask(state.editingTaskId, patch);
      toast('任务已更新');
      closeModal();
      render();
      return;
    }
    // 新增：按重复规则批量生成
    var repeat = $('#tf-repeat') ? $('#tf-repeat').value : 'once';
    if (repeat === 'once') {
      Store.addTask(Store.newTask(Object.assign({}, base, { source: 'manual', order: 60 })));
      toast('任务已添加');
      closeModal();
      render();
      return;
    }
    var opts = {
      weekdays: $$('#modal-box [data-multi]').filter(function (el) {
        return el.dataset.multi.indexOf('tfwd') === 0 && el.classList.contains('active');
      }).map(function (el) { return +el.dataset.multi.slice(4); }),
      everyN: +($('#tf-everyn') ? $('#tf-everyn').value : 2) || 2
    };
    if (repeat === 'weekly' && !opts.weekdays.length) { toast('请选择重复的星期', true); return; }
    var dates = repeatDates(goalId, date, repeat, opts);
    if (!dates.length) { toast('未能生成任务：请检查开始日期与重复规则', true); return; }
    var batchId = Store.uid('batch');
    Store.addTasks(dates.map(function (d) {
      return Store.newTask(Object.assign({}, base, { date: d, source: 'manual', order: 60, batchId: batchId }));
    }));
    toast('已按重复规则生成 ' + dates.length + ' 条任务');
    closeModal();
    render();
  }

  function moveTask(id, dir) {
    var t = Store.taskById(id);
    if (!t) return;
    var siblings = Store.tasksWhere(function (x) {
      return x.date === t.date && x.goalId === t.goalId && x.status !== 'skipped';
    }).sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
    var idx = -1;
    for (var i = 0; i < siblings.length; i++) if (siblings[i].id === id) { idx = i; break; }
    var other = dir === 'up' ? siblings[idx - 1] : siblings[idx + 1];
    if (!other) { toast('已经到头啦'); return; }
    Store.updateTask(t.id, { order: other.order || 50 });
    Store.updateTask(other.id, { order: t.order || 50 });
    render();
  }

  /* ---------- AI 优化范围选择 ---------- */

  function openScopeModal() {
    var goals = Store.activeGoals();
    if (!goals.length) { toast('还没有活跃目标', true); return; }
    var btns = goals.map(function (g) {
      return '<button class="btn ghost block" style="margin-bottom:8px" data-action="pick-scope" data-scope="goal" data-goal-id="' + g.id + '">' +
        (g.isCore ? '★ ' : '') + esc(g.title) + '</button>';
    }).join('');
    openModal('<h2>✨ 让 AI 优化未来计划</h2>' +
      '<p class="card-sub">AI 会通读目标、任务负荷与近几天完成情况，给出调整建议；所有建议需你预览确认后才生效</p>' +
      '<button class="btn primary block" style="margin-bottom:12px" data-action="pick-scope" data-scope="global" data-goal-id="">🌐 全局协调（所有目标一起调整）</button>' +
      '<p class="form-hint" style="margin-bottom:8px">或只优化某个目标：</p>' + btns);
  }

  /* ==========================================================
   * 看板页
   * ========================================================== */

  function renderStats() {
    var el = $('#stats-body');
    if (!Store.getGoals().length) {
      el.innerHTML = '<div class="card">' + emptyHtml('📊', '创建目标并开始打卡后，这里会展示完成率曲线、精力分析与目标对比') + '</div>';
      return;
    }
    var sum = Agg.globalSummary();
    var html = '';

    html += '<div class="stat-grid">' +
      '<div class="cell"><b>' + sum.activeCount + '</b><span>活跃目标</span></div>' +
      '<div class="cell"><b>' + sum.allRate + '%<span class="info-i" data-action="info-cumrate">ⓘ</span></b><span>累计完成率</span></div>' +
      '<div class="cell"><b>' + sum.streak + '<span class="info-i" data-action="info-streak">ⓘ</span></b><span>连续达标(天)</span></div></div>';

    // 每日完成率曲线
    html += '<div class="card"><h3>每日完成率</h3>' +
      '<div class="range-row">' + [7, 14, 30].map(function (n) {
        return '<button class="chip ' + (state.statsRange === n ? 'active' : '') + '" data-action="stats-range" data-n="' + n + '">' + n + '天</button>';
      }).join('') + '</div>' +
      '<div class="chart-box"><canvas id="chart-daily" style="width:100%;height:100%"></canvas></div></div>';

    // 每周完成率
    html += '<div class="card"><h3>每周完成率（近 8 周）</h3>' +
      '<div class="chart-box"><canvas id="chart-weekly" style="width:100%;height:100%"></canvas></div></div>';

    // 精力维度：行渲染（无数据行显示 —）+ 依据数据分布生成描述文案
    var es = Agg.energyStats(30);
    var withData = es.filter(function (e) { return e.total > 0; });
    var energyHint;
    if (!withData.length) {
      energyHint = '近 30 天还没有任务记录';
    } else if (withData.length === 1) {
      energyHint = '当前仅包含' + withData[0].name + '任务，完成率 ' + withData[0].rate + '%';
    } else {
      var rates = withData.map(function (e) { return e.rate; });
      var spread = Math.max.apply(null, rates) - Math.min.apply(null, rates);
      var weakest = withData.slice().sort(function (a, b) { return a.rate - b.rate; })[0];
      energyHint = spread <= 15
        ? '各精力段完成情况均衡，继续保持'
        : '💡 ' + weakest.name + '任务完成率仅 ' + weakest.rate + '%（' + weakest.total + ' 个），可让 AI 调整安排';
    }
    html += '<div class="card"><h3>精力维度 · 近 30 天完成率</h3>' + es.map(function (e) {
      if (!e.total) {
        return '<div class="bar-row dim" style="margin-bottom:7px"><span style="min-width:48px;color:var(--faint)">' + e.name + '</span>' +
          '<div class="bar empty"><i style="width:0"></i></div>' +
          '<span class="val">—</span></div>';
      }
      return '<div class="bar-row" style="margin-bottom:7px"><span style="min-width:48px;color:' + e.color + '">' + e.name + '</span>' +
        '<div class="bar"><i style="width:' + e.rate + '%;background:' + e.color + '"></i></div>' +
        '<span class="val">' + e.rate + '%</span></div>';
    }).join('') +
      '<p class="form-hint">' + energyHint + '</p>' +
      '<button class="btn ghost sm" data-action="ai-rebalance" data-scope="global" data-trigger="manual" style="margin-top:4px">✨ 让 AI 优化任务安排</button></div>';

    // 分目标进度：时间进度（灰条）+ 任务完成率（类型色条）+ 延期情况
    html += '<div class="card"><h3>分目标进度</h3>';
    var stats = Store.activeGoals().map(Agg.goalStats);
    if (!stats.length) html += '<p class="card-sub">暂无活跃目标</p>';
    stats.forEach(function (s) {
      var g = s.goal, ty = Store.typeOf(g.type);
      var ratePct = Math.round(s.rate * 100);
      html += '<div class="goal-mini">' +
        '<div class="info">' +
        '<div class="name"><span class="dot" style="background:' + ty.color + '"></span>' + (g.isCore ? '★ ' : '') + esc(g.title) + '</div>' +
        '<div class="bar-row" style="margin-bottom:3px"><span style="min-width:52px;color:var(--muted)">时间进度</span>' +
        '<div class="bar"><i style="width:' + s.timePct + '%;background:#c7d0e0"></i></div>' +
        '<span class="val">' + s.timePct + '%</span></div>' +
        '<div class="bar-row"><span style="min-width:52px;color:var(--muted)">任务完成率</span>' +
        '<div class="bar"><i style="width:' + ratePct + '%;background:' + ty.color + '"></i></div>' +
        '<span class="val">' + ratePct + '%</span></div>' +
        '</div>' +
        '<div style="text-align:right;font-size:11px;color:var(--muted);min-width:76px">' +
        (s.overdue ? '<span style="color:var(--danger)">' + s.overdue + ' 个任务已延期</span>' : '<span>无延期</span>') +
        (s.eta ? '<br>' + s.eta.slice(5) + ' 预计完成' : '') +
        '</div></div>';
      if (s.lastNote) html += '<p class="form-hint" style="margin:-2px 0 6px 14px">📝 ' + esc(s.lastNote) + '</p>';
    });
    html += '</div>';

    // 目标对比
    var comp = Agg.comparison();
    if (comp.length >= 2) {
      var mostDelay = comp.slice().sort(function (a, b) { return b.overdueIdx - a.overdueIdx; })[0];
      html += '<div class="card"><h3>目标对比</h3>' + comp.map(function (c) {
        var ty = Store.typeOf(c.goal.type);
        return '<div class="bar-row" style="margin-bottom:7px"><span style="min-width:64px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.goal.title) + '</span>' +
          '<div class="bar"><i style="width:' + Math.round(c.rate * 100) + '%;background:' + ty.color + '"></i></div>' +
          '<span class="val">' + Math.round(c.rate * 100) + '%</span></div>';
      }).join('') +
        '<p class="form-hint">' + (mostDelay.overdueIdx > 0
          ? '最常拖延：<b style="color:var(--danger)">' + esc(mostDelay.goal.title) + '</b>（过期未完成占比 ' + Math.round(mostDelay.overdueIdx * 100) + '%）' +
            (mostDelay.overdueIdx > 0.3 ? '，建议让 AI 延后或拆分它的任务' : '')
          : '各目标均无延期，节奏保持得不错 🎉') + '</p></div>';
    }

    el.innerHTML = html;

    // 画图（点击数据点 → 当日详情卡片）
    var daily = Agg.dailyRates(state.statsRange);
    Chart.drawLineChart($('#chart-daily'), {
      labels: daily.map(function (d) { return d.label; }),
      values: daily.map(function (d) { return d.rate; }),
      color: '#4f6ef7', unit: '%', emptyText: '暂无打卡数据',
      tipFn: function (i) {
        var d = daily[i];
        return d.label + ' · 完成 ' + d.done + '/' + d.total + ' 个任务 · 已排 ' + d.plannedMin + ' 分钟（' + d.rate + '%）';
      },
      onPointClick: function (i) {
        if (daily[i]) openDayDetail(daily[i].date);
      }
    });
    Chart.bindTooltip($('#chart-daily'));
    var weekly = Agg.weeklyRates(8);
    Chart.drawLineChart($('#chart-weekly'), {
      labels: weekly.map(function (d) { return d.label; }),
      values: weekly.map(function (d) { return d.rate; }),
      color: '#10b981', unit: '%', emptyText: '暂无打卡数据'
    });
    Chart.bindTooltip($('#chart-weekly'));
  }

  /** 图表数据点点击：某日任务详情卡片 */
  function openDayDetail(date) {
    var st = Agg.dayStats(date);
    if (!st.count) { toast('这一天没有任务记录'); return; }
    var rows = [
      ['✅ 已完成', st.done, st.doneMin],
      ['⚠️ 部分完成', st.partial, st.partialMin],
      ['❌ 未完成', st.missed, st.missedMin],
      ['⬜ 待完成', st.todo, st.todoMin]
    ].filter(function (r) { return r[1] > 0; }).map(function (r) {
      return '<div class="log-item"><div class="log-head"><span>' + r[0] + '</span>' +
        '<span class="scope">' + r[1] + ' 个 · ' + r[2] + ' 分钟</span></div></div>';
    }).join('');
    openModal('<h2>📅 ' + date + ' 周' + Store.weekdayCN(date) + '</h2>' +
      '<div class="sum-bar" style="padding:4px 0">' +
      '<div><b>' + Math.round(st.rate * 100) + '%</b><span>完成率</span></div>' +
      '<div><b>' + (st.count - st.skipped) + '</b><span>任务数</span></div>' +
      '<div><b>' + st.plannedMin + '</b><span>预计分钟</span></div></div>' +
      rows +
      '<button class="btn ghost block" data-action="goto-plan-day" data-date="' + date + '" style="margin-top:10px">去计划页查看这一天 →</button>' +
      '<button class="btn primary block" data-action="close-modal" style="margin-top:8px">关闭</button>');
  }

  /* ==========================================================
   * 设置页
   * ========================================================== */

  function renderSettings() {
    var s = Store.loadSettings();
    var usage = Store.sumUsage();
    var el = $('#settings-body');
    var mockOpts = [['auto', '自动（无 Key 时用 Mock）'], ['on', '始终 Mock 演示'], ['off', '关闭（始终真实 API）']]
      .map(function (m) { return '<option value="' + m[0] + '"' + (s.mock === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('');

    el.innerHTML =
      // 1. 多目标管理
      '<div class="card"><h3>🎯 多目标管理</h3>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>全局预算 · 工作日（分钟）</label><input type="number" data-setting="dailyBudget.weekday" value="' + s.dailyBudget.weekday + '" min="0" step="15"></div>' +
      '<div class="form-item"><label>全局预算 · 周末（分钟）</label><input type="number" data-setting="dailyBudget.weekend" value="' + s.dailyBudget.weekend + '" min="0" step="15"></div>' +
      '</div>' +
      '<div class="form-item"><label>活跃目标数提醒阈值</label><input type="number" data-setting="goalLimit" value="' + s.goalLimit + '" min="1" max="10">' +
      '<p class="form-hint">活跃目标超过 ' + s.goalLimit + ' 个时，首页和目标页会提醒你注意负荷（仅提醒，不强制）</p></div>' +
      '</div>' +

      // 2. AI 调整（精简说明）
      '<div class="card"><h3>🤖 AI 调整</h3>' +
      '<p class="form-hint" style="margin:0">🛡️ AI 自动全局协调多目标，任何调整都先给你看预览，确认后才生效，也可以拒绝或撤销。🔒 固定任务和已完成的任务 AI 不会碰。</p></div>' +

      // 3. API 配置（高频调试区）
      '<div class="card"><h3>🔑 API 配置（OpenAI 兼容）</h3>' +
      '<div class="form-item"><label>演示模式</label><select data-setting="mock" style="width:100%">' + mockOpts + '</select></div>' +
      '<div class="form-item"><label>API 地址（Base URL）</label><input data-setting="api.base" value="' + esc(s.api.base) + '" placeholder="https://api.deepseek.com"></div>' +
      '<div class="form-item"><label>API Key</label><input type="password" data-setting="api.key" value="' + esc(s.api.key) + '" placeholder="sk-...">' +
      '<p class="form-hint" style="color:var(--danger);font-weight:600">⚠️ API Key 只保存在本机浏览器中，请勿分享应用截图或备份文件给他人；若要公开发布，建议改由自己的服务端持有密钥</p></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>模型</label><input data-setting="api.model" value="' + esc(s.api.model) + '" placeholder="deepseek-chat"></div>' +
      '<div class="form-item"><label>跨域代理前缀（可选）</label><input data-setting="api.proxyPrefix" value="' + esc(s.api.proxyPrefix) + '" placeholder="https://proxy.example.com"></div>' +
      '</div>' +
      '<button class="btn ghost sm" data-action="test-api">测试连接</button>' +
      '<p class="form-hint">兼容 DeepSeek / 智谱 GLM / 通义 / Kimi 等 OpenAI 兼容接口</p></div>' +

      // 4. AI 用量（与 API 配套）
      '<div class="card"><h3>📈 AI 用量（本机累计）</h3>' +
      '<div class="sum-bar" style="padding:4px 0">' +
      '<div><b>' + usage.count + '</b><span>调用次数</span></div>' +
      '<div><b>' + usage.total.toLocaleString() + '</b><span>Tokens</span></div>' +
      '<div><b>¥' + usage.cost.toFixed(2) + '</b><span>估算成本</span></div></div>' +
      '<button class="btn ghost sm" data-action="clear-usage">清零统计</button></div>' +

      // 5. 数据（安全防护收尾）
      '<div class="card"><h3>💾 数据（仅存本机）</h3>' +
      '<div class="btn-row" style="margin-bottom:8px">' +
      '<button class="btn ghost" data-action="export-data">导出备份</button>' +
      '<button class="btn ghost" data-action="import-data">导入备份</button></div>' +
      '<div class="btn-row">' +
      (Store.getGoals().length ? '' : '<button class="btn ok" data-action="load-demo">载入演示数据</button>') +
      (Store.hasDemoData() ? '<button class="btn ghost" data-action="clear-demo">清除演示数据</button>' : '') +
      '<button class="btn danger" data-action="reset-all">清空全部数据</button></div>' +
      '<p class="form-hint">建议定期「导出备份」保存 JSON 文件；清空浏览器站点数据会丢失所有记录，导入时自动校验备份格式</p></div>';
  }

  function saveSettingFromInput(input) {
    var path = input.dataset.setting.split('.');
    var s = Store.loadSettings();
    var val = input.type === 'checkbox' ? input.checked
      : (input.type === 'number' ? (+input.value || 0) : input.value);
    var obj = s;
    for (var i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = val;
    Store.saveSettings(s);
  }

  /* ---------- 演示数据 ---------- */

  function seedDemo() {
    if (Store.getGoals().length) { toast('已有目标，为避免混淆不再载入演示数据', true); return; }
    var today = Store.todayStr();
    var g1 = Store.addGoal(Store.newGoal({
      title: '两个月准备数学建模竞赛', description: '两个月准备数学建模竞赛', type: 'study',
      deadline: Store.addDays(today, 55), weekdayMinutes: 90, weekendMinutes: 150,
      base: '会 Python 基础，没系统学过建模', preferences: '喜欢视频课+动手练习，晚上效率高',
      priority: 'high', isCore: true, demo: true,
      milestones: [
        { id: Store.uid('ms'), title: '基础巩固', detail: '过一遍建模常用模型与 Python 工具链', targetDate: Store.addDays(today, 13), done: false },
        { id: Store.uid('ms'), title: '专题强化', detail: '优化/评价/预测三类模型逐个突破', targetDate: Store.addDays(today, 32), done: false },
        { id: Store.uid('ms'), title: '真题模拟', detail: '完整做 2 套真题并复盘论文', targetDate: Store.addDays(today, 55), done: false }
      ],
      outlineConfirmed: true
    }));
    var g2 = Store.addGoal(Store.newGoal({
      title: '三个月减脂 5 公斤', description: '三个月减脂 5 公斤', type: 'fitness',
      deadline: Store.addDays(today, 85), weekdayMinutes: 40, weekendMinutes: 60,
      base: '有一定运动习惯，最近停了', preferences: '喜欢跑步+力量，早上有空',
      priority: 'mid', isCore: false, demo: true,
      milestones: [
        { id: Store.uid('ms'), title: '体能适应', detail: '恢复运动频率，每周 3 次', targetDate: Store.addDays(today, 20), done: false },
        { id: Store.uid('ms'), title: '稳步减脂', detail: '控制饮食 + 每周 4 次训练', targetDate: Store.addDays(today, 60), done: false }
      ],
      repeatRules: [{ id: Store.uid('rule'), freq: 'daily', minutes: 30, energy: 'mid', titleTpl: '有氧运动 30 分钟', descTpl: '慢跑/跳绳/椭圆机任选', startDate: Store.addDays(today, -5) }]
    }));
    var g3 = Store.addGoal(Store.newGoal({
      title: '每天练 30 分钟英语口语', description: '每天练 30 分钟英语口语，三个月能流利对话', type: 'skill',
      deadline: Store.addDays(today, 85), weekdayMinutes: 30, weekendMinutes: 30,
      base: '能读懂，开口困难', preferences: '通勤时间可用',
      priority: 'mid', isCore: false, demo: true,
      milestones: [
        { id: Store.uid('ms'), title: '开口习惯', detail: '每天跟读，建立输出习惯', targetDate: Store.addDays(today, 25), done: false }
      ],
      repeatRules: [{ id: Store.uid('rule'), freq: 'daily', minutes: 30, energy: 'low', titleTpl: '口语跟读 30 分钟', descTpl: '跟读一段材料并录音回听', startDate: Store.addDays(today, -5) }]
    }));

    // 历史 6 天任务（含完成情况），喂出看板曲线
    var batch = Store.uid('batch');
    var hist = [];
    for (var d = 6; d >= 1; d--) {
      var date = Store.addDays(today, -d);
      hist.push(Store.newTask({
        goalId: g1.id, date: date, title: '建模基础：学习一个常用模型', desc: '看视频课 + 整理笔记',
        energy: 'high', estimateMin: 60, source: 'ai', batchId: batch, demo: true,
        status: d === 2 ? 'partial' : (d === 4 ? 'missed' : 'done'),
        missReason: d === 4 ? 'time' : ''
      }));
      hist.push(Store.newTask({
        goalId: g2.id, date: date, title: '有氧运动 30 分钟', desc: '慢跑/跳绳任选',
        energy: 'mid', estimateMin: 30, source: 'rule', demo: true,
        status: d === 3 ? 'missed' : 'done', missReason: d === 3 ? 'mood' : ''
      }));
      hist.push(Store.newTask({
        goalId: g3.id, date: date, title: '口语跟读 30 分钟', desc: '跟读并录音回听',
        energy: 'low', estimateMin: 30, source: 'rule', demo: true,
        status: d === 5 ? 'partial' : 'done'
      }));
    }
    // 今天与明天的任务
    hist.push(Store.newTask({
      goalId: g1.id, date: today, title: '线性规划模型练习', desc: '完成讲义例题并用 Python 求解',
      energy: 'high', estimateMin: 70, source: 'ai', batchId: batch, demo: true
    }));
    hist.push(Store.newTask({
      goalId: g1.id, date: Store.addDays(today, 1), title: '阅读优秀论文一篇', desc: '拆解论文结构与建模思路',
      energy: 'mid', estimateMin: 50, source: 'ai', batchId: batch, demo: true
    }));
    Store.addTasks(hist);

    Store.saveReview({
      date: Store.addDays(today, -1),
      blocked: '建模的优化模型推导卡了一会儿',
      cause: 'difficulty', tomorrowLoad: 'same',
      smoothGoalIds: [g2.id, g3.id],
      perGoalNotes: [
        { goalId: g1.id, note: '推导慢，需要补微积分', smooth: false },
        { goalId: g2.id, note: '状态不错', smooth: true }
      ]
    });
    toast('演示数据已载入（3 个目标 + 6 天历史）');
    Rules.ensureRange(today, 7);
    render();
  }

  /* ==========================================================
   * 事件分发
   * ========================================================== */

  var actions = {
    'tab': function (el) { switchPage(el.dataset.page); },
    'close-modal': closeModal,
    'confirm-ok': function () {
      closeModal();
      if (confirmCb) { var cb = confirmCb; confirmCb = null; cb(); }
    },

    /* 今日 */
    'set-view': function (el) {
      var s = Store.loadSettings();
      s.todayView = el.dataset.view;
      Store.saveSettings(s);
      render();
    },
    'dismiss-mock': function () {
      var s = Store.loadSettings();
      s.mockNoticeDismissed = true;
      Store.saveSettings(s);
      render();
    },
    'task-done': function (el) { taskQuickDone(el.dataset.id); },
    'open-task-detail': function (el) { openTaskDetailModal(el.dataset.id); },
    'detail-pick': function (el) {
      var d = state.taskDraft;
      d.status = el.dataset.status;
      if (d.status !== 'missed' && d.status !== 'partial') {
        d.missReason = ''; d.missNote = ''; d.reasonMode = '';
      }
      renderTaskDetailModal();
    },
    'detail-reason': function (el) {
      var d = state.taskDraft;
      d.reasonMode = 'preset';
      d.missReason = el.dataset.reason;
      renderTaskDetailModal();
    },
    'detail-reason-custom': function () {
      var d = state.taskDraft;
      d.reasonMode = 'custom';
      d.missReason = 'custom';
      renderTaskDetailModal();
    },
    'detail-save': function () {
      var d = state.taskDraft;
      if (!d) return;
      var patch = { status: d.status };
      if (d.status === 'partial' || d.status === 'missed') {
        if (d.reasonMode === 'custom') {
          var note = ($('#detail-reason-input') ? $('#detail-reason-input').value.trim() : '');
          if (!note) { toast('请填写自定义原因，或改选预设选项', true); return; }
          patch.missReason = 'custom';
          patch.missNote = note.slice(0, 60);
        } else {
          patch.missReason = d.missReason || '';
          patch.missNote = '';
        }
      } else {
        patch.missReason = '';
        patch.missNote = '';
      }
      Store.updateTask(d.id, patch);
      state.taskDraft = null;
      closeModal();
      toast('已保存，今日统计已更新');
      render();
    },
    'open-task-edit': function (el) {
      closeModal();
      openTaskModal(Store.taskById(el.dataset.id));
    },
    'rv-pick': function (el) {
      var box = $('#rv-blocked');
      if (!box) return;
      box.value = box.value ? box.value + '；' + el.dataset.title : el.dataset.title;
    },
    'rv-smooth': function (el) { el.classList.toggle('active'); },
    'rv-cause-custom': function (el) {
      var group = el.closest('[data-pick-group="cause"]');
      if (group) { group.dataset.val = 'custom'; }
      $$('#modal-box [data-action="chip-pick"]').forEach(function (b) {
        if (b.dataset.group === 'cause') b.classList.remove('active');
      });
      el.classList.add('active');
      var box = $('#rv-cause-custom');
      if (!box) {
        group.insertAdjacentHTML('beforeend', '<input id="rv-cause-custom" placeholder="用自己的话描述原因（选填）" style="margin-top:7px">');
      }
      var input = $('#rv-cause-custom');
      if (input) input.focus();
    },
    'open-review': openReviewModal,
    'save-review': saveReviewFromModal,
    'ai-rebalance': function (el) { runAdjust(el.dataset.scope || 'global', el.dataset.goalId || '', el.dataset.trigger || 'manual'); },
    'load-demo': seedDemo,

    /* chip 选择 */
    'chip-pick': function (el) {
      var group = el.closest('[data-pick-group="' + el.dataset.group + '"]');
      if (group) { group.dataset.val = el.dataset.val; }
      $$('#modal-box [data-action="chip-pick"]').forEach(function (b) {
        if (b.dataset.group === el.dataset.group) b.classList.remove('active');
      });
      el.classList.add('active');
      if (el.dataset.group === 'rfreq') {
        var box = $('#rf-weekdays-box');
        if (box) box.style.display = el.dataset.val === 'weekly' ? '' : 'none';
      }
    },
    'chip-multi': function (el) { el.classList.toggle('active'); },
    'gf-example': function (el) { fillGoalExample(el.dataset.target); },

    /* 目标 */
    'goal-filter': function (el) { state.goalFilter = el.dataset.id; renderGoals(); },
    'new-goal': function () { openGoalModal(null); },
    'goal-step-next': function () {
      var d = stashGoalDraft();
      if (!d.title) { toast('请先填写目标描述', true); return; }
      if (!d.type) { toast('请选择目标类型', true); return; }
      if (!d.deadline) { toast('请先选择截止时间', true); return; }
      renderGoalForm(2, state.editingGoalId ? Store.goalById(state.editingGoalId) : null);
    },
    'goal-step-back': function () {
      stashGoalDraft();
      renderGoalForm(1, null);
    },
    'save-goal': saveGoalFromModal,
    'open-detail': function (el) { openDetail(el.dataset.id); },
    'close-detail': closeDetail,
    'edit-goal': function () {
      var g = Store.goalById(state.detailId);
      if (g) openGoalModal(g);
    },
    'pause-goal': function () {
      Store.updateGoal(state.detailId, { status: 'paused' });
      toast('目标已暂停，暂停期间不参与预算与今日聚合');
      renderDetail();
    },
    'resume-goal': function () {
      Store.updateGoal(state.detailId, { status: 'active' });
      toast('目标已恢复');
      renderDetail();
    },
    'archive-goal': function () {
      var g = Store.goalById(state.detailId);
      if (!g) return;
      var to = g.status === 'archived' ? 'active' : 'archived';
      Store.updateGoal(g.id, { status: to });
      toast(to === 'archived' ? '已归档（可在已归档列表找回）' : '已取消归档');
      renderDetail();
    },
    'delete-goal': function () {
      var g = Store.goalById(state.detailId);
      if (!g) return;
      confirmBox('删除目标', '将删除「' + g.title + '」及其全部任务，不可恢复。确定删除？', '删除', function () {
        Store.removeGoal(g.id);
        closeDetail();
        toast('目标已删除');
      });
    },
    'info-rate': function () {
      toast('完成率 = 已到期任务的已完成时长 ÷ 已到期任务总时长（部分完成按一半计）');
    },
    'info-overall': function () {
      toast('整体进度 = 已完成任务时长 ÷ 目标已生成任务总时长；无任务时按已完成阶段数 ÷ 总阶段数');
    },
    'info-cumrate': function () {
      toast('累计完成率 = 已完成任务预估时长 ÷ 所有任务总预估时长（部分完成按一半计，已跳过不计）');
    },
    'info-streak': function () {
      toast('当日任务完成率 ≥' + (Store.loadSettings().streakThreshold || 80) + '% 即视为达标并累加连续天数；没有任务的日期会中断连续记录');
    },
    'goto-plan-day': function (el) {
      closeModal();
      state.planDate = el.dataset.date;
      state.planView = 'day';
      switchPage('plan');
    },
    'toggle-milestone': function (el) {
      var g = Store.goalById(state.detailId);
      if (!g) return;
      var idx = +el.dataset.index;
      var ms = (g.milestones || []).slice();
      if (!ms[idx]) return;
      ms[idx].done = !ms[idx].done;
      // 全部里程碑完成 → 提示可标记目标完成
      Store.updateGoal(g.id, { milestones: ms });
      if (ms.every(function (m) { return m.done; })) toast('🎉 全部阶段完成！可在编辑中把目标标记为已完成');
      renderDetail();
    },
    'gen-outline': function (el) { genOutlineFor(el.dataset.id); },
    'apply-outline': applyOutline,
    'expand-week': function (el) { expandWeekFor(el.dataset.id); },
    'apply-plan': applyPlan,
    'add-rule': function (el) { openRuleModal(el.dataset.id); },
    'save-rule': function (el) { saveRuleFromModal(el.dataset.id); },
    'del-rule': function (el) {
      var g = Store.goalById(el.dataset.goal);
      if (!g) return;
      var rules = (g.repeatRules || []).slice();
      rules.splice(+el.dataset.index, 1);
      Store.updateGoal(g.id, { repeatRules: rules });
      toast('固定任务已删除（已生成的任务保留）');
      renderDetail();
    },
    'adjust-goal': function (el) { runAdjust('goal', el.dataset.id, 'manual'); },
    /** AI 规划/调整整合入口：无未来任务 → 生成；已有未来任务 → 优化重排 */
    'ai-plan-or-adjust': function (el) {
      var gid = el.dataset.id;
      var g = Store.goalById(gid);
      if (!g) return;
      var future = Store.tasksWhere(function (t) {
        return t.goalId === gid && t.date >= Store.todayStr() && t.status === 'todo';
      }).length;
      if (future) runAdjust('goal', gid, 'manual');
      else expandWeekFor(gid);
    },

    /* 计划 */
    'plan-prev': function () { state.planDate = Store.addDays(state.planDate, state.planView === 'week' ? -7 : -1); renderPlan(); },
    'plan-next': function () { state.planDate = Store.addDays(state.planDate, state.planView === 'week' ? 7 : 1); renderPlan(); },
    'plan-today': function () { state.planDate = Store.todayStr(); renderPlan(); },
    'plan-view': function (el) { state.planView = el.dataset.view; renderPlan(); },
    'set-range': function (el) { state.rangeDays = +el.dataset.n; renderPlan(); },
    'plan-pick-weekday': function (el) {
      if (state.planView === 'week') {
        // 周视图：只做高亮 + 滚动到该天区块（不重渲染，保持滚动位置）
        $$('#plan-body .week-head button').forEach(function (b) {
          b.classList.toggle('active', b.dataset.date === el.dataset.date);
        });
        var sec = document.getElementById('day-' + el.dataset.date);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        state.planDate = el.dataset.date;
        return;
      }
      state.planDate = el.dataset.date;
      renderPlan();
    },
    'add-task': function () { openTaskModal(null); },
    'edit-task': function (el) { openTaskModal(Store.taskById(el.dataset.id)); },
    'menu-edit': function (el) { closeModal(); openTaskModal(Store.taskById(el.dataset.id)); },
    'task-menu': function (el) { openTaskMenuModal(el.dataset.id); },
    'menu-goto-goal': function (el) {
      closeModal();
      openDetail(el.dataset.goal);
    },
    'menu-lock': function (el) {
      var t = Store.taskById(el.dataset.id);
      if (!t) return;
      Store.updateTask(t.id, { locked: !t.locked });
      closeModal();
      toast(t.locked ? '已取消锁定，AI 可以调整这个任务' : '已锁定 🔒，AI 调整时会自动跳过它');
      render();
    },
    'save-task': saveTaskFromModal,
    'del-task': function (el) {
      var t = Store.taskById(el.dataset.id);
      confirmBox('删除任务', '确定删除「' + (t ? t.title : '') + '」？', '删除', function () {
        Store.removeTask(el.dataset.id);
        closeModal();
        toast('任务已删除');
        render();
      });
    },
    'move-task': function (el) { moveTask(el.dataset.id, el.dataset.dir); },
    'open-ai-optimize': openScopeModal,
    'pick-scope': function (el) { runAdjust(el.dataset.scope, el.dataset.goalId, 'manual'); },
    'close-ap': closeAdjustPreview,
    'ap-accept-all': function () { apAccept(false); },
    'ap-accept-checked': function () { apAccept(true); },
    'ap-reject-all': apRejectAll,
    'undo-log': function (el) {
      closeModal();
      if (Adjust.undo(el.dataset.id)) { toast('已撤销，任务恢复到调整前'); render(); }
      else toast('无法撤销（可能已撤销过）', true);
    },
    'log-detail': function (el) { openLogDetailModal(el.dataset.id); },

    /* 看板 */
    'stats-range': function (el) { state.statsRange = +el.dataset.n; renderStats(); },

    /* 设置 */
    'test-api': function () {
      toast('正在测试连接…');
      AI.testCall().then(function (r) {
        toast('✅ 连接成功 ' + r.model + ' · ' + r.ms + 'ms');
      }).catch(function (e) { toast('❌ ' + AI.humanizeError(e), true); });
    },
    'clear-usage': function () {
      Store.clearUsage();
      toast('用量统计已清零');
      renderSettings();
    },
    'export-data': function () {
      var data = JSON.stringify(Store.exportAll(), null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'goalflow-backup-' + Store.todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    'import-data': function () { $('#import-file').click(); },
    'clear-demo': function () {
      Store.removeDemoData();
      toast('演示数据已清除');
      render();
    },
    'reset-all': function () {
      confirmBox('清空全部数据', '将删除所有目标、任务、复盘与设置，且无法恢复。真的要清空吗？', '全部清空', function () {
        confirmBox('再次确认', '这是最后一次确认：所有数据将被清空。', '确认清空', function () {
          Store.resetAll();
          state.detailId = null;
          closeDetail();
          toast('已清空');
          render();
        });
      });
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
  });

  /* select / input 变更：设置项 + 计划筛选 */
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.setting) { saveSettingFromInput(t); return; }
    if (t.dataset && t.dataset.filter) {
      state.planFilter[t.dataset.filter] = t.value;
      renderPlan();
      return;
    }
    if (t.id === 'tf-repeat' || t.id === 'tf-goal' || t.id === 'tf-date' || t.id === 'tf-everyn') {
      syncRepeatUI();
    }
  });

  /* 目标表单内：分钟输入实时计算预算提示 */
  document.addEventListener('input', function (e) {
    if (e.target.classList && e.target.classList.contains('js-goal-min')) goalBudgetHint();
  });

  /* 导入文件 */
  $('#import-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        Store.importAll(obj);
        toast('备份已导入：' + Store.getGoals().length + ' 个目标');
        state.detailId = null;
        closeDetail();
        render();
      } catch (err) {
        toast('导入失败：' + (err.message || '文件格式不正确'), true);
      }
    };
    reader.readAsText(file);
  });

  /* 点击遮罩关闭弹窗 */
  $('#modal-mask').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
  });

  /* ---------------- 启动 ---------------- */

  function init() {
    Rules.ensureRange(Store.todayStr(), 7);
    switchPage('today');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* file:// 或不支持时静默 */ });
    }
  }

  init();
})(window);
