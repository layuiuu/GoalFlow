/* ==========================================================
 * adjust.js —— AI 调整的预览 / 应用 / 拒绝 / 撤销
 * 原则：AI 只建议；应用必须经用户预览确认；全部写入 AdjustmentLog；
 *       应用后可一键撤销（撤销数据随日志本地保存）
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;

  function snapshotOf(t) { return JSON.parse(JSON.stringify(t)); }
  function dateNorm(v) {
    var s = String(v || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }
  /**
   * 核心规则：AI 只能调整「未来（含今天）且未完成」的任务；
   * 🔒 固定任务（rule 生成或用户手动锁定）一律跳过
   */
  function isAdjustable(t) {
    return !!t && t.date >= Store.todayStr() && t.status === 'todo' &&
      t.source !== 'rule' && !t.locked;
  }

  var OP_NAMES = {
    postpone: '延后', split: '拆分', drop: '删减', add: '新增', reorder: '排序'
  };

  /**
   * 校验并规范化 AI 返回的 changes
   * 返回 {changes:[可用变更], invalid:[被丢弃的原因]}
   */
  function normalize(rawChanges, scope, goalId) {
    var changes = [], invalid = [];
    (rawChanges || []).forEach(function (c) {
      var bad = function (why) { invalid.push(OP_NAMES[c && c.op] || '未知' + '：' + why); };
      if (!c || !c.op) return;
      var reason = String(c.reason || '').slice(0, 40);

      if (c.op === 'postpone') {
        var t = Store.taskById(c.taskId);
        if (!t) return bad('任务不存在');
        if (!isAdjustable(t)) return bad('只能调整未来的待完成任务（🔒固定与已完成任务不可调）');
        var to = dateNorm(c.to);
        if (!to) return bad('缺少目标日期');
        changes.push({ op: 'postpone', taskId: t.id, title: t.title, goalId: t.goalId, date: t.date, to: to, reason: reason, before: snapshotOf(t) });

      } else if (c.op === 'split') {
        var t2 = Store.taskById(c.taskId);
        if (!t2) return bad('任务不存在');
        if (!isAdjustable(t2)) return bad('只能调整未来的待完成任务（🔒固定与已完成任务不可调）');
        if ((+t2.estimateMin || 0) < 40) return bad('任务不足 40 分钟，无需拆分');
        changes.push({ op: 'split', taskId: t2.id, title: t2.title, goalId: t2.goalId, date: t2.date, estimateMin: t2.estimateMin, reason: reason, before: snapshotOf(t2) });

      } else if (c.op === 'drop') {
        var t3 = Store.taskById(c.taskId);
        if (!t3) return bad('任务不存在');
        if (!isAdjustable(t3)) return bad('只能调整未来的待完成任务（🔒固定与已完成任务不可调）');
        var g3 = Store.goalById(t3.goalId);
        if (g3 && g3.isCore && t3.date <= Store.addDays(Store.todayStr(), 2)) return bad('核心目标近两天的任务不建议删');
        changes.push({ op: 'drop', taskId: t3.id, title: t3.title, goalId: t3.goalId, date: t3.date, reason: reason, before: snapshotOf(t3) });

      } else if (c.op === 'add') {
        var tk = c.task || {};
        var gid = scope === 'goal' ? goalId : tk.goalId;
        var g = Store.goalById(gid);
        if (!g) return bad('新增任务缺少有效目标');
        var date = dateNorm(tk.date);
        if (!date) return bad('新增任务缺少日期');
        changes.push({
          op: 'add', goalId: gid, goalTitle: g.title, reason: reason,
          kind: (tk.kind === 'advance' || tk.kind === 'buffer') ? tk.kind : '',
          task: {
            goalId: gid, date: date,
            title: String(tk.title || 'AI 建议任务').slice(0, 40),
            desc: String(tk.desc || '').slice(0, 100),
            energy: (tk.energy === 'high' || tk.energy === 'low') ? tk.energy : 'mid',
            estimateMin: Store.clamp(Math.round(+tk.estimateMin || 30), 10, 300)
          }
        });

      } else if (c.op === 'reorder') {
        var t4 = Store.taskById(c.taskId);
        if (!t4) return bad('任务不存在');
        if (!isAdjustable(t4)) return bad('只能调整未来的待完成任务（🔒固定与已完成任务不可调）');
        if (c.dir !== 'up' && c.dir !== 'down') return bad('方向无效');
        changes.push({ op: 'reorder', taskId: t4.id, title: t4.title, goalId: t4.goalId, date: t4.date, dir: c.dir, reason: reason, before: snapshotOf(t4) });
      }
    });
    return { changes: changes, invalid: invalid };
  }

  /** 单条变更的展示文案：类型 + 调整前 → 调整后 */
  function humanChange(ch) {
    var goal = Store.goalById(ch.goalId);
    var gname = goal ? goal.title : '未知目标';
    if (ch.op === 'postpone') {
      return { icon: '📅', text: '延后「' + ch.title + '」', detail: '调整前：' + ch.date + ' → 调整后：' + ch.to + '｜' + gname };
    }
    if (ch.op === 'split') {
      return { icon: '✂️', text: '拆分「' + ch.title + '」', detail: '调整前：' + ch.date + ' ' + ch.estimateMin + ' 分钟 → 调整后：拆为两天各约 ' + Math.round(ch.estimateMin / 2) + ' 分钟｜' + gname };
    }
    if (ch.op === 'drop') {
      return { icon: '🗑️', text: '删减「' + ch.title + '」', detail: '调整前：' + ch.date + ' 待完成 → 调整后：移除该任务｜' + gname };
    }
    if (ch.op === 'add') {
      var kindTxt = ch.kind === 'advance' ? '增加进阶任务' : ch.kind === 'buffer' ? '增加缓冲任务' : '新增任务';
      var kindIcon = ch.kind === 'advance' ? '🚀' : ch.kind === 'buffer' ? '🛟' : '➕';
      return { icon: kindIcon, text: kindTxt + '「' + ch.task.title + '」', detail: '调整前：无 → 调整后：' + ch.task.date + ' · ' + ch.task.estimateMin + ' 分钟｜' + ch.goalTitle };
    }
    if (ch.op === 'reorder') {
      return { icon: '🔀', text: (ch.dir === 'up' ? '前移' : '后移') + '「' + ch.title + '」', detail: '调整前：' + ch.date + ' → 调整后：当日' + (ch.dir === 'up' ? '更靠前' : '更靠后') + '｜' + gname };
    }
    return { icon: '•', text: String(ch.op), detail: '' };
  }

  /**
   * 应用预览中的变更（全部或勾选部分）
   * preview: {scope, goalId, trigger, summary, changes}
   * 返回日志对象
   */
  function apply(preview, selectedIdx) {
    var undoData = [];
    var applied = [];
    preview.changes.forEach(function (ch, idx) {
      if (selectedIdx && selectedIdx.indexOf(idx) < 0) return;
      applied.push(ch);

      if (ch.op === 'postpone') {
        Store.updateTask(ch.taskId, { date: ch.to, order: 60 });
        undoData.push({ op: 'postpone', taskId: ch.taskId, before: ch.before });

      } else if (ch.op === 'split') {
        var t = Store.taskById(ch.taskId);
        if (!t) return;
        var half = Math.max(10, Math.round((+t.estimateMin || 0) / 2));
        var t2 = Store.newTask({
          goalId: t.goalId, date: Store.addDays(t.date, 1),
          title: t.title + '（续）', desc: t.desc, energy: t.energy,
          estimateMin: Math.max(10, (+t.estimateMin || 0) - half),
          order: t.order, source: 'ai', demo: !!t.demo
        });
        Store.updateTask(t.id, { estimateMin: half, desc: (t.desc ? t.desc + '；' : '') + '已拆分为两部分' });
        Store.addTask(t2);
        undoData.push({ op: 'split', taskId: t.id, before: ch.before, addedId: t2.id });

      } else if (ch.op === 'drop') {
        if (!Store.taskById(ch.taskId)) return;
        Store.removeTask(ch.taskId);
        undoData.push({ op: 'drop', before: ch.before });

      } else if (ch.op === 'add') {
        var added = Store.addTask(Store.newTask(Object.assign({}, ch.task, { source: 'ai' })));
        undoData.push({ op: 'add', addedId: added.id });

      } else if (ch.op === 'reorder') {
        var cur = Store.taskById(ch.taskId);
        if (!cur) return;
        var siblings = Store.tasksWhere(function (x) {
          return x.date === cur.date && x.goalId === cur.goalId && x.status !== 'skipped';
        }).sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
        var idx2 = -1;
        for (var i = 0; i < siblings.length; i++) if (siblings[i].id === cur.id) { idx2 = i; break; }
        var other = ch.dir === 'up' ? siblings[idx2 - 1] : siblings[idx2 + 1];
        if (other) {
          Store.updateTask(cur.id, { order: other.order || 50 });
          Store.updateTask(other.id, { order: cur.order || 50 });
          undoData.push({ op: 'reorder', taskId: cur.id, otherId: other.id, a: cur.order || 50, b: other.order || 50 });
        }
      }
    });

    return Store.addLog({
      id: Store.uid('adj'), ts: Date.now(),
      scope: preview.scope, goalId: preview.goalId || '', trigger: preview.trigger || 'manual',
      summary: preview.summary || '',
      changes: applied, status: 'applied', undone: false, undoData: undoData
    });
  }

  /** 拒绝建议（留痕） */
  function reject(preview) {
    return Store.addLog({
      id: Store.uid('adj'), ts: Date.now(),
      scope: preview.scope, goalId: preview.goalId || '', trigger: preview.trigger || 'manual',
      summary: preview.summary || '',
      changes: preview.changes, status: 'rejected', undone: false, undoData: []
    });
  }

  /** 撤销一条已应用的日志 */
  function undo(logId) {
    var log = Store.logById(logId);
    if (!log || log.status !== 'applied' || log.undone) return false;
    (log.undoData || []).slice().reverse().forEach(function (u) {
      if (u.op === 'add') {
        Store.removeTask(u.addedId);
      } else if (u.op === 'drop') {
        if (!Store.taskById(u.before.id)) Store.addTask(u.before);
      } else if (u.op === 'split') {
        Store.removeTask(u.addedId);
        Store.updateTask(u.taskId, u.before);
      } else if (u.op === 'postpone') {
        // 若原日期的规则任务已被本地补齐，恢复会产生重复：改为移除这条延后的任务
        var b = u.before;
        var dup = b.ruleId ? Store.tasksWhere(function (x) {
          return x.id !== u.taskId && x.goalId === b.goalId && x.ruleId === b.ruleId && x.date === b.date;
        }) : [];
        if (dup.length) Store.removeTask(u.taskId);
        else Store.updateTask(u.taskId, { date: b.date, order: b.order });
      } else if (u.op === 'reorder') {
        Store.updateTask(u.taskId, { order: u.a });
        Store.updateTask(u.otherId, { order: u.b });
      }
    });
    Store.updateLog(logId, { undone: true });
    return true;
  }

  global.Adjust = {
    OP_NAMES: OP_NAMES,
    normalize: normalize,
    humanChange: humanChange,
    apply: apply,
    reject: reject,
    undo: undo
  };
})(window);
