/* ==========================================================
 * rules.js —— 本地规则引擎（不消耗 AI Token）
 * 1) RepeatRule 每日固定任务展开：如「每天练 30 分钟口语」
 *    由本地规则按日期生成任务，幂等（同一天同规则只生成一次）
 * 2) 里程碑进度与目标整体进度计算
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;

  /** 判断规则在某天是否生效 */
  function ruleApplies(rule, dateStr, goal) {
    if (!rule || !rule.freq) return false;
    var start = rule.startDate || (goal ? Store.fmtDate(new Date(goal.createdAt || Date.now())) : Store.todayStr());
    if (Store.daysBetween(start, dateStr) < 0) return false; // 早于开始日
    if (rule.until && Store.daysBetween(dateStr, rule.until) < 0) return false;
    if (rule.freq === 'daily') return true;
    if (rule.freq === 'everyN') {
      var n = Math.max(1, +rule.n || 2);
      return Store.daysBetween(start, dateStr) % n === 0;
    }
    if (rule.freq === 'weekly') {
      var wds = rule.weekdays || [];
      return wds.indexOf(Store.parseDate(dateStr).getDay()) >= 0;
    }
    return false;
  }

  /**
   * 展开日期区间 [startDate, startDate+days) 的固定任务
   * 幂等：已存在（同 goalId+ruleId+date）的不重复创建
   * 返回新建的任务数组
   */
  function ensureRange(startDate, days) {
    var created = [];
    var goals = Store.activeGoals();
    var end = Store.addDays(startDate, days);
    for (var g = 0; g < goals.length; g++) {
      var goal = goals[g];
      var rules = goal.repeatRules || [];
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        for (var d = 0; d < days; d++) {
          var date = Store.addDays(startDate, d);
          if (date >= end) break;
          if (!ruleApplies(rule, date, goal)) continue;
          if (Store.findRuleTask(goal.id, rule.id, date)) continue;
          created.push(Store.newTask({
            goalId: goal.id,
            date: date,
            title: rule.titleTpl || '固定任务',
            desc: rule.descTpl || '',
            energy: rule.energy || 'mid',
            estimateMin: +rule.minutes || 30,
            order: 40,               // 固定任务默认排前面
            source: 'rule',
            ruleId: rule.id,
            demo: !!goal.demo
          }));
        }
      }
    }
    if (created.length) Store.addTasks(created);
    return created;
  }

  /**
   * 目标进度：
   * - taskRate：全部历史任务的加权完成率（done=1，partial=0.5，skipped 不计分母）
   * - milestoneRate：已勾选里程碑占比
   * - overall：有大纲时两者各占 50%，否则等于 taskRate
   */
  function milestoneProgress(goal, tasks) {
    // 口径说明（详情页 ⓘ 展示）：
    // 任务完成率 = 已到期任务的已完成时长 ÷ 已到期任务总时长（部分完成按一半计）
    // 整体进度   = 已完成任务的时长 ÷ 目标已生成任务的总时长；无任务时按已完成阶段数 ÷ 总阶段数
    var today = Store.todayStr();
    var dueMin = 0, dueDoneMin = 0;      // 已到期（含今天）任务
    var allMin = 0, allDoneMin = 0;      // 全部已生成任务（含未来）
    var total = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'skipped') continue;
      var min = +t.estimateMin || 0;
      var credit = t.status === 'done' ? min : (t.status === 'partial' ? min * 0.5 : 0);
      allMin += min;
      allDoneMin += credit;
      if (t.date <= today) {
        total++;
        dueMin += min;
        dueDoneMin += credit;
      }
    }
    var taskRate = dueMin ? dueDoneMin / dueMin : 0;

    var ms = goal.milestones || [];
    var msDone = 0;
    for (var m = 0; m < ms.length; m++) if (ms[m].done) msDone++;
    var msRate = ms.length ? msDone / ms.length : 0;

    var overall = allMin ? allDoneMin / allMin : msRate;
    return {
      taskRate: taskRate,
      taskTotal: total,
      doneMin: dueDoneMin,
      dueMin: dueMin,
      allMin: allMin,
      allDoneMin: allDoneMin,
      milestoneRate: msRate,
      milestoneDone: msDone,
      milestoneTotal: ms.length,
      overall: overall
    };
  }

  /** 当前阶段信息（目标列表卡展示用）：阶段名 / 剩余任务数 / 预计结束日 / 阶段内完成进度 */
  function currentStageInfo(goal, tasks) {
    var cur = currentMilestone(goal);
    if (!cur) return null;
    var today = Store.todayStr();
    var start = cur.startDate || (goal.milestones && goal.milestones.indexOf(cur) === 0
      ? Store.fmtDate(new Date(goal.createdAt || Date.now()))
      : '');
    var stageMin = 0, stageDoneMin = 0, remaining = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'skipped') continue;
      var inStage = t.date >= start && t.date <= cur.targetDate;
      var min = +t.estimateMin || 0;
      if (inStage && t.status === 'todo') remaining++;
      if (inStage) {
        stageMin += min;
        if (t.status === 'done') stageDoneMin += min;
        else if (t.status === 'partial') stageDoneMin += min * 0.5;
      }
    }
    if (remaining === 0) {
      // 阶段区间没有未来任务时，退化为全部未来任务
      for (var j = 0; j < tasks.length; j++) {
        var t2 = tasks[j];
        if (t2.status === 'todo' && t2.date >= today) remaining++;
      }
    }
    return {
      name: cur.title,
      startDate: start,
      targetDate: cur.targetDate,
      remaining: remaining,
      stagePct: stageMin ? Math.round(stageDoneMin / stageMin * 100) : 0
    };
  }

  /** 找到当前进行中的阶段（第一个未完成且 targetDate 最近的里程碑） */
  function currentMilestone(goal) {
    var ms = (goal.milestones || []).slice().sort(function (a, b) {
      return a.targetDate < b.targetDate ? -1 : 1;
    });
    for (var i = 0; i < ms.length; i++) if (!ms[i].done) return ms[i];
    return ms.length ? ms[ms.length - 1] : null;
  }

  global.Rules = {
    ruleApplies: ruleApplies,
    ensureRange: ensureRange,
    milestoneProgress: milestoneProgress,
    currentMilestone: currentMilestone,
    currentStageInfo: currentStageInfo
  };
})(window);
