/* ==========================================================
 * aggregate.js —— 聚合与统计（全部本地计算，零 AI）
 * 今日聚合 / 预算与过载检测 / 三种排序视图 / 看板全部统计
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;

  /* ---------------- 预算与单日统计 ---------------- */

  /** 某日全局预算（分钟）：工作日 / 周末两档 */
  function budgetFor(date) {
    var b = Store.loadSettings().dailyBudget;
    return Store.isWeekend(date) ? (+b.weekend || 0) : (+b.weekday || 0);
  }

  /** 某日全部任务 */
  function tasksFor(date) { return Store.tasksByDate(date); }

  /**
   * 单日统计：
   * rate = (done + partial*0.5) / 非跳过任务数
   * over = 已排时长超出预算的分钟数
   */
  function dayStats(date) {
    var tasks = tasksFor(date);
    var st = {
      date: date,
      budget: budgetFor(date),
      plannedMin: 0, count: tasks.length,
      done: 0, partial: 0, missed: 0, skipped: 0, todo: 0,
      score: 0, rate: 0, remaining: 0, over: 0
    };
    var denominator = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status !== 'skipped') st.plannedMin += (+t.estimateMin || 0);
      if (t.status === 'done') { st.done++; st.score += 1; }
      else if (t.status === 'partial') { st.partial++; st.score += 0.5; }
      else if (t.status === 'missed') st.missed++;
      else if (t.status === 'skipped') st.skipped++;
      else st.todo++;
      if (t.status !== 'skipped') denominator++;
    }
    st.rate = denominator ? st.score / denominator : 0;
    st.remaining = Math.max(0, st.budget - st.plannedMin);
    st.over = Math.max(0, st.plannedMin - st.budget);
    return st;
  }

  /** 某日期区间内每天「其他目标」已占用分钟数（排除 excludeGoalId，跳过的不算） */
  function occupiedByDate(dates, excludeGoalId) {
    var map = {};
    dates.forEach(function (d) { map[d] = 0; });
    Store.getTasks().forEach(function (t) {
      if (map[t.date] === undefined) return;
      if (excludeGoalId && t.goalId === excludeGoalId) return;
      if (t.status === 'skipped') return;
      map[t.date] += (+t.estimateMin || 0);
    });
    return map;
  }

  /* ---------------- 排序视图 ---------------- */

  /** 智能排序：核心★ > 优先级 > 精力 > 预计时长 */
  function smartSort(tasks) {
    var goalMap = {};
    Store.getGoals().forEach(function (g) { goalMap[g.id] = g; });
    return tasks.slice().sort(function (a, b) {
      var ga = goalMap[a.goalId] || {}, gb = goalMap[b.goalId] || {};
      var core = (gb.isCore ? 1 : 0) - (ga.isCore ? 1 : 0);
      if (core) return core;
      var prio = Store.prioOf(gb.priority).weight - Store.prioOf(ga.priority).weight;
      if (prio) return prio;
      var en = Store.energyOf(b.energy).weight - Store.energyOf(a.energy).weight;
      if (en) return en;
      return (+b.estimateMin || 0) - (+a.estimateMin || 0);
    });
  }

  /** 按目标分组：返回 [{goal, tasks}]，组间按核心/优先级排序 */
  function groupByGoal(tasks) {
    var map = {}, order = [];
    tasks.forEach(function (t) {
      if (!map[t.goalId]) {
        var g = Store.goalById(t.goalId) || { id: t.goalId, title: '已删除目标', type: 'other', priority: 'low', isCore: false };
        map[t.goalId] = { goal: g, tasks: [] };
        order.push(t.goalId);
      }
      map[t.goalId].tasks.push(t);
    });
    var arr = order.map(function (id) { return map[id]; });
    arr.sort(function (a, b) {
      var core = (b.goal.isCore ? 1 : 0) - (a.goal.isCore ? 1 : 0);
      if (core) return core;
      return Store.prioOf(b.goal.priority).weight - Store.prioOf(a.goal.priority).weight;
    });
    arr.forEach(function (grp) {
      grp.tasks.sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
    });
    return arr;
  }

  /** 按预计时长排序：大块任务在前（需要整块时间） */
  function byTimeSort(tasks) {
    return tasks.slice().sort(function (a, b) {
      return (+b.estimateMin || 0) - (+a.estimateMin || 0) || (a.order || 50) - (b.order || 50);
    });
  }

  /* ---------------- 看板统计 ---------------- */

  /** 最近 n 天每日完成率：[{date,label,rate,done,total}] */
  function dailyRates(n) {
    var out = [];
    var today = Store.todayStr();
    for (var i = n - 1; i >= 0; i--) {
      var date = Store.addDays(today, -i);
      var st = dayStats(date);
      out.push({
        date: date,
        label: (Store.parseDate(date).getMonth() + 1) + '/' + Store.parseDate(date).getDate(),
        rate: Math.round(st.rate * 100),
        done: st.done + st.partial,
        total: st.count - st.skipped,
        plannedMin: st.plannedMin,
        hasTasks: st.count > 0
      });
    }
    return out;
  }

  /** 最近 n 周每周完成率（周一为一周起点，未到的天不计）：[{label,rate}] */
  function weeklyRates(n) {
    var out = [];
    var mon = weekDates(Store.todayStr())[0];
    for (var i = n - 1; i >= 0; i--) {
      var start = Store.addDays(mon, -7 * i);
      var score = 0, denominator = 0;
      for (var d = 0; d < 7; d++) {
        var date = Store.addDays(start, d);
        if (Store.daysBetween(date, Store.todayStr()) < 0) break; // 未来天跳过
        var st = dayStats(date);
        score += st.score; denominator += (st.count - st.skipped);
      }
      var sd = Store.parseDate(start);
      out.push({
        label: (sd.getMonth() + 1) + '/' + sd.getDate(),
        rate: denominator ? Math.round(score / denominator * 100) : 0
      });
    }
    return out;
  }

  /** 以 anchor 所在的周一为起点的 7 天日期（周一~周日） */
  function weekDates(anchor) {
    var d = Store.parseDate(anchor);
    var offset = (d.getDay() + 6) % 7;
    var mon = Store.addDays(anchor, -offset);
    var out = [];
    for (var i = 0; i < 7; i++) out.push(Store.addDays(mon, i));
    return out;
  }

  /** 高/中/低精力任务完成情况（近 daysBack 天，可选限定目标） */
  function energyStats(daysBack, goalId) {
    var from = Store.addDays(Store.todayStr(), -(daysBack - 1));
    var res = {};
    Store.ENERGIES.forEach(function (e) {
      res[e.id] = { id: e.id, name: e.name, color: e.color, total: 0, score: 0, rate: 0 };
    });
    Store.getTasks().forEach(function (t) {
      if (goalId && t.goalId !== goalId) return;
      if (t.date < from || t.date > Store.todayStr()) return;
      if (t.status === 'skipped') return;
      var e = res[t.energy] || res.mid;
      e.total++;
      if (t.status === 'done') e.score += 1;
      else if (t.status === 'partial') e.score += 0.5;
    });
    Store.ENERGIES.forEach(function (e) {
      res[e.id].rate = res[e.id].total ? Math.round(res[e.id].score / res[e.id].total * 100) : 0;
    });
    return Store.ENERGIES.map(function (e) { return res[e.id]; });
  }

  /** 连续达标天数：当日完成率 ≥ 阈值记达标；无任务的天中断（今天未达标不回溯中断昨天链条） */
  function streak() {
    var thr = Store.loadSettings().streakThreshold || 60;
    var today = dayStats(Store.todayStr());
    var base = 0, d = Store.addDays(Store.todayStr(), -1);
    while (true) {
      var s = dayStats(d);
      if (s.count === 0 || s.rate * 100 < thr) break;
      base++;
      d = Store.addDays(d, -1);
    }
    if (today.count > 0 && today.rate * 100 >= thr) base++;
    return base;
  }

  /** 过期未完成任务（今天之前仍 todo/partial） */
  function overdueTasks(goalId) {
    var today = Store.todayStr();
    return Store.tasksWhere(function (t) {
      if (t.date >= today) return false;
      if (t.status !== 'todo' && t.status !== 'partial') return false;
      if (goalId && t.goalId !== goalId) return false;
      return true;
    });
  }

  /** 单目标统计卡数据 */
  function goalStats(goal) {
    var tasks = Store.tasksWhere(function (t) { return t.goalId === goal.id; });
    var prog = global.Rules.milestoneProgress(goal, tasks);
    var overdue = overdueTasks(goal.id);
    var past = tasks.filter(function (t) { return t.status !== 'skipped'; });
    var rate = past.length ? past.reduce(function (s, t) {
      return s + (t.status === 'done' ? 1 : t.status === 'partial' ? 0.5 : 0);
    }, 0) / past.length : 0;
    // 最近一次与该目标相关的复盘备注
    var note = '', noteDate = '';
    Store.getReviews().forEach(function (r) {
      (r.perGoalNotes || []).forEach(function (n) {
        if (n.goalId === goal.id && r.date > noteDate) { noteDate = r.date; note = n.note || ''; }
      });
    });
    // 预计完成日期：优先取最近未完成里程碑的 targetDate；
    // 无里程碑时按「剩余任务总时长 ÷ 日均投入」估算
    var eta = '';
    var openMs = (goal.milestones || []).filter(function (m) { return !m.done; })
      .sort(function (a, b) { return a.targetDate < b.targetDate ? -1 : 1; });
    if (openMs.length) {
      eta = openMs[0].targetDate;
    } else {
      var remainMin = 0;
      tasks.forEach(function (t) {
        if (t.date >= Store.todayStr() && t.status === 'todo') remainMin += (+t.estimateMin || 0);
      });
      var daily = ((+goal.weekdayMinutes || 0) * 5 + (+goal.weekendMinutes || 0) * 2) / 7;
      if (remainMin > 0 && daily > 0) eta = Store.addDays(Store.todayStr(), Math.ceil(remainMin / daily));
    }
    return {
      goal: goal,
      progress: prog,
      rate: rate,
      overdue: overdue.length,
      future: tasks.filter(function (t) { return t.date >= Store.todayStr() && t.status === 'todo'; }).length,
      eta: eta,
      lastNote: note,
      lastNoteDate: noteDate
    };
  }

  /** 目标对比：完成率 + 拖延指数（过期未完成 / 过期应完成） */
  function comparison() {
    return Store.activeGoals().map(function (g) {
      var tasks = Store.tasksWhere(function (t) { return t.goalId === g.id; });
      var today = Store.todayStr();
      var pastAll = 0, pastBad = 0;
      tasks.forEach(function (t) {
        if (t.date >= today || t.status === 'skipped') return;
        pastAll++;
        if (t.status === 'todo' || t.status === 'partial') pastBad++;
      });
      var st = goalStats(g);
      return {
        goal: g,
        rate: st.rate,
        progress: st.progress.overall,
        overdueIdx: pastAll ? pastBad / pastAll : 0,
        overdue: pastBad
      };
    }).sort(function (a, b) { return b.rate - a.rate; });
  }

  /** 全局汇总（看板首屏） */
  function globalSummary() {
    var all = Store.getTasks().filter(function (t) { return t.status !== 'skipped'; });
    var score = all.reduce(function (s, t) {
      return s + (t.status === 'done' ? 1 : t.status === 'partial' ? 0.5 : 0);
    }, 0);
    return {
      activeCount: Store.activeGoals().length,
      today: dayStats(Store.todayStr()),
      allRate: all.length ? Math.round(score / all.length * 100) : 0,
      streak: streak()
    };
  }

  global.Agg = {
    budgetFor: budgetFor,
    tasksFor: tasksFor,
    dayStats: dayStats,
    occupiedByDate: occupiedByDate,
    smartSort: smartSort,
    groupByGoal: groupByGoal,
    byTimeSort: byTimeSort,
    dailyRates: dailyRates,
    weeklyRates: weeklyRates,
    weekDates: weekDates,
    energyStats: energyStats,
    streak: streak,
    overdueTasks: overdueTasks,
    goalStats: goalStats,
    comparison: comparison,
    globalSummary: globalSummary
  };
})(window);
