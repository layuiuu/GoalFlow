# -*- coding: utf-8 -*-
"""一次性补丁：任务菜单精简 + 任务表单重复选项"""
import io

p = 'js/app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 任务菜单重写
old = """  /** 计划页任务操作菜单（action sheet） */
  function openTaskMenuModal(id) {
    var t = Store.taskById(id);
    if (!t) return;
    var lockItem;
    if (t.source === 'rule') {
      lockItem = '<button class="as-item" style="color:var(--muted)" data-action="close-modal">🔒 规则生成的固定任务（到目标详情管理规则）</button>';
    } else if (t.locked) {
      lockItem = '<button class="as-item" data-action="menu-lock" data-id="' + t.id + '">🔓 取消锁定（允许 AI 调整）</button>';
    } else {
      lockItem = '<button class="as-item" data-action="menu-lock" data-id="' + t.id + '">🔒 锁定（设为固定，AI 不可修改）</button>';
    }
    openModal('<div class="action-sheet">' +
      '<p class="card-sub" style="margin-bottom:6px">' + (t.locked || t.source === 'rule' ? '🔒 ' : '') + esc(t.title) + ' · ' + t.date + '</p>' +
      '<button class="as-item" data-action="menu-edit" data-id="' + t.id + '">✎ 编辑任务</button>' +
      (t.source === 'rule' || t.locked ? '' :
        '<button class="as-item" data-action="menu-move" data-id="' + t.id + '" data-dir="up">↑ 同日内前移</button>' +
        '<button class="as-item" data-action="menu-move" data-id="' + t.id + '" data-dir="down">↓ 同日内后移</button>') +
      '<button class="as-item" data-action="open-task-detail" data-id="' + t.id + '">🎯 标记状态</button>' +
      lockItem +
      '<button class="as-item danger" data-action="del-task" data-id="' + t.id + '">🗑 删除任务</button>' +
      '<button class="as-item" data-action="close-modal" style="text-align:center;color:var(--muted)">取消</button>' +
      '</div>');
  }"""

new = """  /** 计划页任务操作菜单（action sheet）：专注管理（编辑/锁定/删除） */
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
  }"""
assert old in s, 'menu not found'
s = s.replace(old, new, 1)

# 2) openTaskModal 重写（状态字段 + 重复选项）
old2 = """  function openTaskModal(task) {
    state.editingTaskId = task ? task.id : null;
    var t = task || { date: state.planView === 'day' ? state.planDate : Store.todayStr(), energy: 'mid', estimateMin: 30 };
    var goalOpts = '<option value="">选择目标…</option>' + Store.activeGoals().map(function (g) {
      return '<option value="' + g.id + '"' + (t.goalId === g.id ? ' selected' : '') + '>' + esc(g.title) + '</option>';
    }).join('');
    var enOpts = Store.ENERGIES.map(function (e) {
      return '<option value="' + e.id + '"' + (t.energy === e.id ? ' selected' : '') + '>' + e.name + '</option>';
    }).join('');
    openModal('<h2>' + (task ? '编辑任务' : '手动新增任务') + '</h2>' +
      '<div class="form-item"><label>所属目标 *</label><select id="tf-goal">' + goalOpts + '</select></div>' +
      '<div class="form-item"><label>日期</label><input type="date" id="tf-date" value="' + esc(t.date) + '"></div>' +
      '<div class="form-item"><label>任务标题 *</label><input id="tf-title" value="' + esc(t.title || '') + '" placeholder="例：完成建模第一章习题"></div>' +
      '<div class="form-item"><label>任务描述</label><textarea id="tf-desc" placeholder="怎么做/产出什么（选填）">' + esc(t.desc || '') + '</textarea></div>' +
      '<div class="form-2col">' +
      '<div class="form-item"><label>精力</label><select id="tf-energy">' + enOpts + '</select></div>' +
      '<div class="form-item"><label>预计时长（分钟）</label><input type="number" id="tf-min" value="' + (t.estimateMin || 30) + '" min="5" step="5"></div>' +
      '</div>' +
      '<div class="btn-row">' + (task ? '<button class="btn danger" data-action="del-task" data-id="' + task.id + '">删除</button>' : '') +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-task">' + (task ? '保存' : '添加') + '</button></div>');
  }"""

new2 = """  /** 重复任务生成：按规则返回日期数组（上限 30 条） */
  function repeatDates(startDate, mode, opts) {
    var goal = Store.goalById(state.editingTaskGoalId);
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
    var repeatOpts = [['once', '单次'], ['daily', '每天'], ['weekly', '每周几'], ['custom', '自定义间隔']].map(function (r) {
      return '<option value="' + r[0] + '"' + (r[0] === 'once' ? ' selected' : '') + '>' + r[1] + '</option>';
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
  }"""
assert old2 in s, 'openTaskModal not found'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('patch1 ok')
