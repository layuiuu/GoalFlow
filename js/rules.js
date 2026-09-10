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
    var done = 0, total = 0;
    var today = Store.todayStr();
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'skipped') continue;
      if (t.date > today) continue; // 未来任务不计入完成率，避免稀释
      total++;
      if (t.status === 'done') done += 1;
      else if (t.status === 'partial') done += 0.5;
    }
    var taskRate = total ? done / total : 0;

    var ms = goal.milestones || [];
    var msDone = 0;
    for (var m = 0; m < ms.length; m++) if (ms[m].done) msDone++;
    var msRate = ms.length ? msDone / ms.length : 0;

    var overall = ms.length ? taskRate * 0.5 + msRate * 0.5 : taskRate;
    return {
      taskRate: taskRate,
      taskTotal: total,
      milestoneRate: msRate,
      milestoneDone: msDone,
      milestoneTotal: ms.length,
      overall: overall
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
    currentMilestone: currentMilestone
  };
})(window);
