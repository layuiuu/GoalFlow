/* ==========================================================
 * store.js —— 本地数据层（localStorage）
 * GoalFlow 多目标管理：设置 / 目标 / 任务 / 复盘 / 调整日志 / AI 用量
 * 约定：所有 key 带版本号；读写均容错；数据只存本机，无账号体系
 * ========================================================== */
(function (global) {
  'use strict';

  var K_SETTINGS = 'goalflow.settings.v1';
  var K_GOALS    = 'goalflow.goals.v1';
  var K_TASKS    = 'goalflow.tasks.v1';
  var K_REVIEWS  = 'goalflow.reviews.v1';
  var K_LOGS     = 'goalflow.adjustlogs.v1';
  var K_USAGE    = 'goalflow.aiusage.v1';

  /* ---------------- 字典常量 ---------------- */

  var GOAL_TYPES = [
    { id: 'study',   name: '学习', color: '#3b82f6' },
    { id: 'fitness', name: '健身', color: '#f97316' },
    { id: 'skill',   name: '技能', color: '#8b5cf6' },
    { id: 'reading', name: '阅读', color: '#10b981' },
    { id: 'other',   name: '其他', color: '#64748b' }
  ];

  var PRIORITIES = [
    { id: 'high', name: '高', weight: 3, color: '#ef4444' },
    { id: 'mid',  name: '中', weight: 2, color: '#f59e0b' },
    { id: 'low',  name: '低', weight: 1, color: '#94a3b8' }
  ];

  var ENERGIES = [
    { id: 'high', name: '高精力', weight: 3, color: '#ef4444' },
    { id: 'mid',  name: '中精力', weight: 2, color: '#f59e0b' },
    { id: 'low',  name: '低精力', weight: 1, color: '#22c55e' }
  ];

  var TASK_STATUS = {
    todo:    { name: '待完成', icon: '⬜' },
    done:    { name: '已完成', icon: '✅' },
    partial: { name: '部分完成', icon: '⚠️' },
    missed:  { name: '未完成', icon: '❌' },
    skipped: { name: '已跳过', icon: '⏭️' }
  };

  var MISS_REASONS = [
    { id: 'hard', name: '难度超预期' },
    { id: 'time', name: '时间不够' },
    { id: 'mood', name: '状态不佳' }
  ];

  var GOAL_STATUS = {
    active:   { name: '进行中' },
    paused:   { name: '已暂停' },
    done:     { name: '已完成' },
    archived: { name: '已归档' }
  };

  /* ---------------- 工具 ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return fmtDate(new Date()); }
  function parseDate(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
  function isWeekend(s) { var w = parseDate(s).getDay(); return w === 0 || w === 6; }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function weekdayCN(s) { return '日一二三四五六'.charAt(parseDate(s).getDay()); }
  function uid(p) { return (p || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function clamp(n, min, max) { n = +n || 0; return Math.max(min, Math.min(max, n)); }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.warn('[store] 写入失败', e); }
  }

  function typeOf(id) {
    for (var i = 0; i < GOAL_TYPES.length; i++) if (GOAL_TYPES[i].id === id) return GOAL_TYPES[i];
    return GOAL_TYPES[4];
  }
  function prioOf(id) {
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].id === id) return PRIORITIES[i];
    return PRIORITIES[1];
  }
  function energyOf(id) {
    for (var i = 0; i < ENERGIES.length; i++) if (ENERGIES[i].id === id) return ENERGIES[i];
    return ENERGIES[1];
  }

  /* ---------------- 设置 ---------------- */

  function defaultPriceTable() {
    // 元 / 百万 Token（估算口径，可在导出文件中修改）
    return [
      { model: 'deepseek-chat', hit: 0.5, miss: 2, out: 8 },
      { model: 'deepseek-reasoner', hit: 1, miss: 4, out: 16 }
    ];
  }

  function defaults() {
    return {
      dailyBudget: { weekday: 180, weekend: 300 },  // 全局每日可用总时长（分钟）
      defaultPriority: 'mid',
      planMode: 'per-goal',        // per-goal | global（global 为 v2 预留）
      allowCrossGoal: true,        // 允许 AI 提出跨目标调整建议
      autoRebalance: false,        // 生成计划时自动应用目标间协调（变更仍留痕可撤销）
      todayView: 'smart',          // smart | byGoal | byTime
      goalLimit: 5,                // 活跃目标数软上限
      streakThreshold: 80,         // 当日完成率 ≥x% 记为达标天（连续达标判定）
      api: { base: 'https://api.deepseek.com', key: '', model: 'deepseek-chat', proxyPrefix: '' },
      mock: 'auto',                // auto=无 Key 时用 Mock | on=始终 Mock | off=始终真实
      priceTable: defaultPriceTable()
    };
  }

  function loadSettings() {
    var d = defaults();
    var s = Object.assign(d, readJSON(K_SETTINGS, {}));
    s.dailyBudget = Object.assign({ weekday: 180, weekend: 300 }, s.dailyBudget);
    s.api = Object.assign(defaults().api, s.api);
    if (!Array.isArray(s.priceTable) || !s.priceTable.length) s.priceTable = defaultPriceTable();
    return s;
  }
  function saveSettings(s) { writeJSON(K_SETTINGS, s); }

  /* ---------------- 目标 Goal ---------------- */

  function getGoals() { return readJSON(K_GOALS, []); }
  function saveGoals(list) { writeJSON(K_GOALS, list); }
  function goalById(id) {
    var list = getGoals();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function addGoal(g) {
    var list = getGoals();
    list.unshift(g);
    saveGoals(list);
    return g;
  }
  function updateGoal(id, patch) {
    var list = getGoals();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        Object.assign(list[i], patch);
        saveGoals(list);
        return list[i];
      }
    }
    return null;
  }
  function removeGoal(id) {
    saveGoals(getGoals().filter(function (g) { return g.id !== id; }));
    // 同步删除其任务
    saveTasks(getTasks().filter(function (t) { return t.goalId !== id; }));
  }
  function activeGoals() {
    return getGoals().filter(function (g) { return g.status === 'active'; });
  }

  function newGoal(fields) {
    var s = loadSettings();
    return Object.assign({
      id: uid('goal'),
      title: '',
      description: '',
      type: 'study',
      deadline: addDays(todayStr(), 60),
      weekdayMinutes: 60,
      weekendMinutes: 90,
      base: '',
      preferences: '',
      priority: s.defaultPriority || 'mid',
      isCore: false,
      status: 'active',
      milestones: [],
      repeatRules: [],
      outlineConfirmed: false,
      demo: false,
      createdAt: Date.now(),
      completedAt: 0
    }, fields);
  }

  /* ---------------- 任务 Task ---------------- */

  function getTasks() { return readJSON(K_TASKS, []); }
  function saveTasks(list) { writeJSON(K_TASKS, list); }
  function taskById(id) {
    var list = getTasks();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function addTask(t) {
    var list = getTasks();
    list.push(t);
    saveTasks(list);
    return t;
  }
  function addTasks(arr) {
    var list = getTasks();
    for (var i = 0; i < arr.length; i++) list.push(arr[i]);
    saveTasks(list);
    return arr;
  }
  function updateTask(id, patch) {
    var list = getTasks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        Object.assign(list[i], patch);
        saveTasks(list);
        return list[i];
      }
    }
    return null;
  }
  function removeTask(id) { saveTasks(getTasks().filter(function (t) { return t.id !== id; })); }
  function tasksWhere(fn) { return getTasks().filter(fn); }
  function tasksByDate(date) { return tasksWhere(function (t) { return t.date === date; }); }
  function findRuleTask(goalId, ruleId, date) {
    var list = getTasks();
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.goalId === goalId && t.ruleId === ruleId && t.date === date) return t;
    }
    return null;
  }

  function newTask(fields) {
    return Object.assign({
      id: uid('task'),
      goalId: '',
      date: todayStr(),
      title: '',
      desc: '',
      energy: 'mid',
      estimateMin: 30,
      actualMin: 0,
      status: 'todo',
      missReason: '',
      missNote: '',       // 自定义原因文本（missReason === 'custom' 时使用）
      locked: false,      // 🔒 用户锁定：AI 不可调整
      order: 50,
      source: 'manual',   // ai | rule | manual
      ruleId: '',
      batchId: '',
      demo: false,
      createdAt: Date.now()
    }, fields);
  }

  /* ---------------- 复盘 DailyReview ---------------- */

  function getReviews() { return readJSON(K_REVIEWS, []); }
  function reviewByDate(date) {
    var list = getReviews();
    for (var i = 0; i < list.length; i++) if (list[i].date === date) return list[i];
    return null;
  }
  function saveReview(r) {
    var list = getReviews();
    r.createdAt = Date.now();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].date === r.date) { list[i] = r; found = true; break; }
    }
    if (!found) list.push(r);
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    writeJSON(K_REVIEWS, list);
    return r;
  }

  /* ---------------- AI 调整日志 AdjustmentLog ---------------- */

  function getLogs() { return readJSON(K_LOGS, []); }
  function addLog(l) {
    var list = getLogs();
    list.unshift(l);
    if (list.length > 300) list = list.slice(0, 300);
    writeJSON(K_LOGS, list);
    return l;
  }
  function logById(id) {
    var list = getLogs();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function updateLog(id, patch) {
    var list = getLogs();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { Object.assign(list[i], patch); writeJSON(K_LOGS, list); return list[i]; }
    }
    return null;
  }

  /* ---------------- AI 用量 ---------------- */

  function getUsage() { return readJSON(K_USAGE, []); }
  function addUsage(u) {
    var list = getUsage();
    list.push(Object.assign({ ts: Date.now(), scene: '', prompt: 0, completion: 0, total: 0, cacheHit: 0, cost: 0, mock: false }, u));
    if (list.length > 2000) list = list.slice(list.length - 2000);
    writeJSON(K_USAGE, list);
  }
  function clearUsage() { writeJSON(K_USAGE, []); }

  /** 累计用量 + 按价格表估算成本（元） */
  function sumUsage() {
    var table = loadSettings().priceTable;
    var list = getUsage();
    var r = { count: 0, prompt: 0, completion: 0, total: 0, cost: 0 };
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.mock) continue;
      r.count++;
      r.prompt += u.prompt || 0;
      r.completion += u.completion || 0;
      r.total += u.total || 0;
      var p = table[0];
      for (var j = 0; j < table.length; j++) if (table[j].model === u.model) { p = table[j]; break; }
      var hit = Math.min(u.cacheHit || 0, u.prompt || 0);
      var miss = Math.max(0, (u.prompt || 0) - hit);
      r.cost += hit / 1e6 * (p.hit || 0) + miss / 1e6 * (p.miss || 0) + (u.completion || 0) / 1e6 * (p.out || 0);
    }
    return r;
  }

  /* ---------------- 导出 / 导入 / 清理 ---------------- */

  function exportAll() {
    return {
      app: 'goalflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: loadSettings(),
      goals: getGoals(),
      tasks: getTasks(),
      reviews: getReviews(),
      adjustlogs: getLogs(),
      aiusage: getUsage()
    };
  }

  function importAll(obj) {
    if (!obj || obj.app !== 'goalflow') {
      throw new Error('文件格式不正确：不是 GoalFlow 备份');
    }
    if (obj.version !== 1) {
      throw new Error('备份版本不兼容（version=' + (obj.version || '缺失') + '），请使用 GoalFlow v1 导出的备份文件');
    }
    if (!Array.isArray(obj.goals) || !Array.isArray(obj.tasks)) {
      throw new Error('备份缺少目标或任务数据，文件可能已损坏');
    }
    // 数据容错：丢弃缺关键字段的条目，避免导入后渲染崩溃
    var goals = obj.goals.filter(function (g) { return g && g.id && g.title; });
    var tasks = obj.tasks.filter(function (t) { return t && t.id && t.goalId; });
    if (obj.settings) saveSettings(Object.assign(defaults(), obj.settings));
    saveGoals(goals);
    saveTasks(tasks);
    writeJSON(K_REVIEWS, Array.isArray(obj.reviews) ? obj.reviews.filter(function (r) { return r && r.date; }) : []);
    writeJSON(K_LOGS, Array.isArray(obj.adjustlogs) ? obj.adjustlogs : []);
    writeJSON(K_USAGE, Array.isArray(obj.aiusage) ? obj.aiusage : []);
  }

  function resetAll() {
    [K_SETTINGS, K_GOALS, K_TASKS, K_REVIEWS, K_LOGS, K_USAGE].forEach(function (k) {
      localStorage.removeItem(k);
    });
  }

  /** 清除演示数据（带 demo 标记的实体） */
  function removeDemoData() {
    saveGoals(getGoals().filter(function (g) { return !g.demo; }));
    saveTasks(getTasks().filter(function (t) { return !t.demo; }));
  }
  function hasDemoData() {
    return getGoals().some(function (g) { return g.demo; }) || getTasks().some(function (t) { return t.demo; });
  }

  /* ---------------- 导出 API ---------------- */

  global.Store = {
    // 常量与字典
    GOAL_TYPES: GOAL_TYPES, PRIORITIES: PRIORITIES, ENERGIES: ENERGIES,
    TASK_STATUS: TASK_STATUS, MISS_REASONS: MISS_REASONS, GOAL_STATUS: GOAL_STATUS,
    typeOf: typeOf, prioOf: prioOf, energyOf: energyOf,
    // 日期工具
    fmtDate: fmtDate, todayStr: todayStr, parseDate: parseDate, addDays: addDays,
    isWeekend: isWeekend, daysBetween: daysBetween, weekdayCN: weekdayCN, pad2: pad2,
    uid: uid, clamp: clamp,
    // 设置
    loadSettings: loadSettings, saveSettings: saveSettings,
    // 目标
    getGoals: getGoals, goalById: goalById, addGoal: addGoal, updateGoal: updateGoal,
    removeGoal: removeGoal, activeGoals: activeGoals, newGoal: newGoal,
    // 任务
    getTasks: getTasks, taskById: taskById, addTask: addTask, addTasks: addTasks,
    updateTask: updateTask, removeTask: removeTask, tasksWhere: tasksWhere,
    tasksByDate: tasksByDate, findRuleTask: findRuleTask, newTask: newTask,
    // 复盘
    getReviews: getReviews, reviewByDate: reviewByDate, saveReview: saveReview,
    // 调整日志
    getLogs: getLogs, addLog: addLog, logById: logById, updateLog: updateLog,
    // AI 用量
    getUsage: getUsage, addUsage: addUsage, clearUsage: clearUsage, sumUsage: sumUsage,
    // 备份
    exportAll: exportAll, importAll: importAll, resetAll: resetAll,
    removeDemoData: removeDemoData, hasDemoData: hasDemoData
  };
})(window);
