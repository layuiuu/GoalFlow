/* ==========================================================
 * importer.js —— 外部计划导入：文本解析与结构归一化
 * 场景：用户把 ChatGPT / Claude 生成的 Markdown 计划粘贴进来，
 *       解析为「阶段大纲(milestones) + 未来 7 天任务(tasks)」。
 * 说明：
 *   - 本模块只做「文本 → 结构」，不调用 AI；AI 路径由 ai.js 调用
 *     Importer.normalize() 复用同一套校验与钳制规则。
 *   - 规则解析器同时充当「无 Key 兜底」与「Mock 数据源」，一份代码两用。
 *   - 相对日期基准：Day 1 / D1 / 第 1 天 = 今天。
 *   - 只导入未来 7 天内的任务；更远的内容归入阶段大纲（省 Token 且贴合
 *     现有滚动窗口模型）。所有输出字段经钳制，非法项进 warnings。
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;

  var MAX_TEXT = 20000;    // textarea 允许的最大字符数
  var AI_TEXT_LIMIT = 8000; // 送入 AI 的文本上限（控制 token）
  var MAX_TASKS = 100;     // 单次导入任务上限
  var MAX_MILESTONES = 8;
  var WINDOW_DAYS = 7;     // 任务导入窗口：今天 + 6 天

  /* ---------------- 基础工具 ---------------- */

  function today() { return Store.todayStr(); }
  function pad2(n) { return Store.pad2(n); }

  function isDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function validDateIn(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return '';
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    return dt.getFullYear() + '-' + pad2(m) + '-' + pad2(d);
  }
  function validType(id) {
    for (var i = 0; i < Store.GOAL_TYPES.length; i++) if (Store.GOAL_TYPES[i].id === id) return id;
    return '';
  }
  function validEnergy(id) { return (id === 'high' || id === 'mid' || id === 'low') ? id : ''; }
  function windowEnd() { return Store.addDays(today(), WINDOW_DAYS - 1); }

  /* ---------------- 日期语义解析 ---------------- */

  var WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

  /** 无年份的月/日：若已过则顺延到明年（最近的未来日期） */
  function monthDay(m, d, base) {
    var y = Store.parseDate(base).getFullYear();
    var s = validDateIn(y, m, d);
    if (s && s < base) s = validDateIn(y + 1, m, d);
    return s;
  }

  /** 下一个指定星期几（今天匹配则取今天） */
  function nextWeekday(target, base) {
    var cur = Store.parseDate(base).getDay();
    return Store.addDays(base, (target - cur + 7) % 7);
  }

  /**
   * 在文本中识别一个日期表达式，返回 { date, start, end }（找不到则 date=''）
   * 支持：2026-09-15 / 2026/9/15 / 9月15日 / 9.15 / 15号 /
   *       Day 1 / D1 / 第1天 / 明天 / 后天 / 大后天 / 周一~周日
   */
  function findDate(text, base) {
    var m;
    // 绝对日期（带年）
    m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {
      var abs = validDateIn(+m[1], +m[2], +m[3]);
      if (abs) return { date: abs, token: m[0] };
    }
    // 月日（中文）
    m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
    if (m) {
      var cn = monthDay(+m[1], +m[2], base);
      if (cn) return { date: cn, token: m[0] };
    }
    // 月/日、月.日（无年）
    m = text.match(/(\d{1,2})[/.](\d{1,2})(?!\d)/);
    if (m && +m[1] <= 12 && +m[2] <= 31) {
      var md = monthDay(+m[1], +m[2], base);
      if (md) return { date: md, token: m[0] };
    }
    // 15号 / 15日
    m = text.match(/(\d{1,2})\s*[日号](?!\d)/);
    if (m && +m[1] >= 1 && +m[1] <= 31) {
      var curM = Store.parseDate(base).getMonth() + 1;
      var dom = monthDay(curM, +m[1], base);
      if (dom) return { date: dom, token: m[0] };
    }
    // Day N / D N / 第 N 天（Day 1 = 今天）
    m = text.match(/(?:day|d)\s*(\d{1,3})/i) || text.match(/第\s*(\d{1,3})\s*天/);
    if (m) {
      var n = +m[1];
      if (n >= 1) return { date: Store.addDays(base, n - 1), token: m[0] };
    }
    // 中文相对日
    var rel = [['大后天', 3], ['后天', 2], ['明天', 1], ['明日', 1], ['今天', 0], ['今日', 0]];
    for (var i = 0; i < rel.length; i++) {
      if (text.indexOf(rel[i][0]) >= 0) return { date: Store.addDays(base, rel[i][1]), token: rel[i][0] };
    }
    // 星期
    m = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (m) return { date: nextWeekday(WEEKDAY_MAP[m[1]], base), token: m[0] };
    return { date: '', token: '' };
  }

  /** 识别时长（分钟），支持 45分钟 / 1小时 / 1.5h */
  function findMinutes(text) {
    var m = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|个小时|h|hr|hour)/i);
    if (m) return { min: Math.round(+m[1] * 60), token: m[0] };
    m = text.match(/(\d+)\s*(?:分钟|分|min)/i);
    if (m) return { min: +m[1], token: m[0] };
    return { min: 0, token: '' };
  }

  /** 识别精力关键词 */
  function findEnergy(text) {
    if (/高精力|高强度|高难度|重要|重点|优先/.test(text)) return 'high';
    if (/低精力|轻松|碎片|简单|轻量/.test(text)) return 'low';
    return '';
  }

  /** 清理标题：去掉已消费的日期/时长 token、空括号与装饰符号 */
  function cleanTitle(text, tokens) {
    var s = String(text || '');
    (tokens || []).forEach(function (tk) {
      if (!tk) return;
      s = s.split(tk).join(' ');
    });
    return s
      .replace(/^[\s\-*•·>]+/, '')
      .replace(/^\[[ xX✓]\]\s*/, '')
      .replace(/[*_`#]/g, '')
      // 括号内的时长/日期/精力标注整体移除（外部计划常写「完成练习（45分钟）」）
      .replace(/[（(][^（()）]{0,24}[)）]/g, function (m) {
        return (findMinutes(m).min || findDate(m, Store.todayStr()).date || findEnergy(m)) ? ' ' : m;
      })
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/[\s·\-—:：,，、|（(【\[]+$/, '')
      .replace(/^[\s·\-—:：,，、|)）】\]]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 目标类型关键词推断（规则解析兜底用；AI 解析由模型决定） */
  var TYPE_HINTS = [
    ['fitness', /健身|减脂|增肌|跑步|运动|锻炼|体重|有氧|力量训练|瑜伽|游泳|俯卧撑|深蹲/],
    ['reading', /阅读|读书|读完|书单|书籍|看完全书/],
    ['skill', /口语|英语|编程|写作|绘画|吉他|钢琴|技能|跟读|作品|发音|听力/],
    ['study', /考试|竞赛|考研|学习|数学|建模|课程|复习|习题|论文|知识点|刷题|备考/]
  ];
  function guessType(text) {
    var s = String(text || '');
    for (var i = 0; i < TYPE_HINTS.length; i++) {
      if (TYPE_HINTS[i][1].test(s)) return TYPE_HINTS[i][0];
    }
    return '';
  }

  /* ---------------- 行分类 ---------------- */

  var RE_HEADING = /^(#{1,6})\s*(.+)$/;
  var RE_PHASE = /^(?:第\s*[一二三四五六七八九十\d]+\s*(?:周|阶段|月|部分)|阶段\s*[一二三四五六七八九十\d]+|phase\s*\d+|week\s*\d+)\s*[:：]?\s*(.*)$/i;
  var RE_LIST = /^(?:[-*+•]|\d+[.、)])\s+(.+)$/;
  var RE_META = /^(目标名称|目标|标题|计划名称|计划|title|plan)\s*[:：]\s*(.+)$/i;
  var RE_DEADLINE = /^(截止日期|截止时间|截止|deadline|due)\s*[:：]\s*(.+)$/i;
  var RE_TABLE = /^\|(.+)\|$/;

  /**
   * 规则解析：文本 → 归一化后的 ImportResult
   * @param {string} text 计划原文
   * @param {object} opts { title, type, deadline } 用户在弹窗里的覆盖值
   */
  function ruleParse(text, opts) {
    opts = opts || {};
    var base = today();
    var raw = {
      title: '', type: '', deadline: '',
      milestones: [], tasks: [], warnings: [], source: 'rule', mock: false
    };

    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    if (String(text || '').length > MAX_TEXT) {
      raw.warnings.push({ reason: '文本超过 ' + MAX_TEXT + ' 字符，仅解析前 ' + MAX_TEXT + ' 字符', text: '' });
      lines = String(text).slice(0, MAX_TEXT).split('\n');
    }

    var cursor = base;          // 无日期任务的落点游标
    var cursorCount = 0;        // 游标上当已排任务数
    var lastTask = null;        // 用于承接描述续行
    var lastMs = null;
    var seenTitle = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      var t = line.trim();
      if (!t) continue;

      // 截止日期元信息
      var md = t.match(RE_DEADLINE);
      if (md) {
        var dd = findDate(md[2], base).date;
        if (dd) { raw.deadline = dd; continue; }
      }
      // 标题元信息
      var mt = t.match(RE_META);
      if (mt) {
        var titleTxt = cleanTitle(mt[2], []);
        if (titleTxt && !raw.title) raw.title = titleTxt;
        continue;
      }

      // 阶段标题（Markdown 标题 / “第一周”等）
      // 注意：# 一级标题通常是整份计划的目标名称，## 及以下才是阶段
      var mh = t.match(RE_HEADING);
      var mPhase = mh ? null : t.match(RE_PHASE);
      if (mh || mPhase) {
        var body = mh ? mh[2] : (mPhase[1] || mPhase[0]);
        var level = mh ? mh[1].length : 99;
        if (level === 1 && !raw.title && !raw.milestones.length && !raw.tasks.length) {
          var docTitle = cleanTitle(body, [findDate(body, base).token]);
          if (docTitle) { raw.title = docTitle.slice(0, 60); seenTitle = true; continue; }
        }
        var headDate = findDate(body, base);
        var headTitle = cleanTitle(body, [headDate.token]) || ('阶段 ' + (raw.milestones.length + 1));
        lastMs = {
          title: headTitle.slice(0, 30),
          detail: '',
          startDate: headDate.date || '',
          targetDate: '',
          _explicitStart: !!headDate.date
        };
        raw.milestones.push(lastMs);
        lastTask = null;
        if (headDate.date && headDate.date >= base) { cursor = headDate.date; cursorCount = 0; }
        continue;
      }

      // 表格行：取含日期的一列 + 最后一个非空列作为标题；无日期的表格行视为表头/备注，跳过
      var mTable = t.match(RE_TABLE);
      if (mTable) {
        var cells = mTable[1].split('|').map(function (c) { return c.trim(); })
          .filter(function (c) { return c && !/^[-:\s]+$/.test(c); });
        if (cells.length >= 2) {
          var cellDate = '', cellTitle = '';
          cells.forEach(function (c) {
            var fd = findDate(c, base);
            if (fd.date && !cellDate) cellDate = fd.date;
          });
          for (var ci = cells.length - 1; ci >= 0; ci--) {
            if (!findDate(cells[ci], base).date && !/^\d+$/.test(cells[ci])) { cellTitle = cells[ci]; break; }
          }
          if (cellDate && cellTitle) {
            var rowTask = makeTask(cells.join(' '), cellDate, base, cursor, cursorCount);
            if (rowTask) {
              raw.tasks.push(rowTask.task);
              cursor = rowTask.cursor; cursorCount = rowTask.cursorCount;
              lastTask = raw.tasks[raw.tasks.length - 1];
            }
            continue;
          }
        }
        raw.warnings.push({ reason: '表格行没有可用日期，已跳过', text: t.slice(0, 60) });
        continue;
      }

      // 列表项 → 任务
      var ml = t.match(RE_LIST);
      if (ml) {
        var made = makeTask(ml[1], '', base, cursor, cursorCount);
        if (made) {
          raw.tasks.push(made.task);
          cursor = made.cursor; cursorCount = made.cursorCount;
          lastTask = made.task;
        } else {
          raw.warnings.push({ reason: '任务行内容为空', text: t.slice(0, 60) });
        }
        continue;
      }

      // 纯文本行：首个无标记且不含日期的短行 → 目标标题；
      // 含日期的行 → 任务；其余作为上一条的描述续行
      var plainDate = findDate(t, base);
      if (!seenTitle && !raw.milestones.length && !raw.tasks.length && t.length <= 60 && !plainDate.date) {
        var plain = cleanTitle(t, []);
        if (plain) { raw.title = plain; seenTitle = true; continue; }
      }
      if (plainDate.date) {
        var madePlain = makeTask(t, '', base, cursor, cursorCount);
        if (madePlain) {
          raw.tasks.push(madePlain.task);
          cursor = madePlain.cursor; cursorCount = madePlain.cursorCount;
          lastTask = madePlain.task;
          continue;
        }
      }
      if (lastTask) {
        lastTask.desc = ((lastTask.desc ? lastTask.desc + ' ' : '') + cleanTitle(t, [])).slice(0, 100);
        continue;
      }
      if (lastMs) {
        lastMs.detail = ((lastMs.detail ? lastMs.detail + ' ' : '') + cleanTitle(t, [])).slice(0, 120);
        continue;
      }
      raw.warnings.push({ reason: '无法识别的行', text: t.slice(0, 60) });
    }

    if (!raw.type) {
      var hay = [raw.title].concat(
        raw.milestones.map(function (m) { return m.title; }),
        raw.tasks.map(function (t) { return t.title; })
      ).join(' ');
      raw.type = guessType(hay);
    }
    return normalize(raw, opts);
  }

  /**
   * 由一行文本构造任务（内部工具）
   * 无日期时使用游标，每 2 条任务把游标推进一天，避免全部堆在今天
   */
  function makeTask(text, explicitDate, base, cursor, cursorCount) {
    var fd = explicitDate ? { date: explicitDate, token: '' } : findDate(text, base);
    var fm = findMinutes(text);
    var fe = findEnergy(text);
    var title = cleanTitle(text, [fd.token, fm.token]);
    if (!title) return null;
    var date = fd.date || cursor;
    var nextCursor = cursor, nextCount = cursorCount;
    if (fd.date) {
      nextCursor = fd.date;
      nextCount = 1;
    } else {
      nextCount = cursorCount + 1;
      if (nextCount > 2) { nextCursor = Store.addDays(cursor, 1); nextCount = 1; }
    }
    return {
      task: {
        date: date,
        title: title.slice(0, 40),
        desc: '',
        energy: fe || 'mid',
        estimateMin: fm.min || 30
      },
      cursor: nextCursor,
      cursorCount: nextCount
    };
  }

  /* ---------------- 归一化（AI 与规则共用） ---------------- */

  /** 阶段缺日期 / 日期不合理时，按数量在 [今天, 截止日] 内均分 */
  function assignMilestoneDates(list, from, deadline) {
    if (!list.length) return;
    var span = Math.max(list.length, Store.daysBetween(from, deadline) || 0);
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!isDateStr(m.targetDate) || m.targetDate < from) {
        m.targetDate = Store.addDays(from, Math.max(1, Math.round(span * (i + 1) / list.length)));
      }
      if (m.targetDate > deadline) m.targetDate = deadline;
    }
    // 至少保证单调不减
    for (var j = 1; j < list.length; j++) {
      if (list[j].targetDate < list[j - 1].targetDate) list[j].targetDate = list[j - 1].targetDate;
    }
    for (var k = 0; k < list.length; k++) {
      if (!isDateStr(list[k].startDate) || list[k].startDate > list[k].targetDate) {
        list[k].startDate = k === 0 ? from : Store.addDays(list[k - 1].targetDate, 1);
      }
      if (list[k].startDate < from) list[k].startDate = from;
    }
  }

  /**
   * 校验并规范化 ImportResult（AI 与规则解析共用）
   * opts: { title, type, deadline } 覆盖解析结果（用户在弹窗中的选择优先）
   */
  function normalize(raw, opts) {
    opts = opts || {};
    raw = raw || {};
    var base = today();
    var warnings = (raw.warnings || []).slice();

    // 目标基础信息
    var deadline = isDateStr(opts.deadline) ? opts.deadline
      : (isDateStr(raw.deadline) ? raw.deadline : Store.addDays(base, 60));
    if (deadline < base) {
      warnings.push({ reason: '截止日期早于今天，已自动调整为 ' + Store.addDays(base, 60), text: deadline });
      deadline = Store.addDays(base, 60);
    }
    var title = String(opts.title || raw.title || '').trim().slice(0, 60) || '导入计划';
    var type = validType(opts.type) || validType(raw.type) || 'other';

    // 阶段
    var milestones = [];
    (Array.isArray(raw.milestones) ? raw.milestones : []).forEach(function (m) {
      if (!m || !String(m.title || '').trim()) return;
      if (milestones.length >= MAX_MILESTONES) return;
      var sd = isDateStr(m.startDate) ? m.startDate : '';
      var td = isDateStr(m.targetDate) ? m.targetDate : '';
      milestones.push({
        title: String(m.title).trim().slice(0, 30),
        detail: String(m.detail || '').trim().slice(0, 120),
        startDate: sd,
        targetDate: td
      });
    });
    if (milestones.length > MAX_MILESTONES) milestones = milestones.slice(0, MAX_MILESTONES);
    assignMilestoneDates(milestones, base, deadline);

    // 任务（只保留未来 7 天窗口内）
    var end = windowEnd();
    var seen = {};
    var tasks = [];
    var outOfRange = 0, dup = 0, invalid = 0;
    (Array.isArray(raw.tasks) ? raw.tasks : []).forEach(function (t) {
      if (!t) return;
      var name = String(t.title || '').trim();
      if (!name) { invalid++; return; }
      var d = isDateStr(t.date) ? t.date : '';
      if (!d || d < base || d > end) { outOfRange++; return; }
      var key = d + '|' + name;
      if (seen[key]) { dup++; return; }
      seen[key] = true;
      tasks.push({
        date: d,
        title: name.slice(0, 40),
        desc: String(t.desc || '').trim().slice(0, 100),
        energy: validEnergy(t.energy) || 'mid',
        estimateMin: Store.clamp(Math.round(+t.estimateMin || 30), 10, 300)
      });
    });
    if (outOfRange) warnings.push({ reason: '有 ' + outOfRange + ' 条任务不在未来 7 天内，未导入为任务（已归入阶段大纲，后续可用 AI 展开）', text: '' });
    if (dup) warnings.push({ reason: '已自动忽略 ' + dup + ' 条重复任务', text: '' });
    if (invalid) warnings.push({ reason: '已忽略 ' + invalid + ' 条缺少标题的任务', text: '' });
    if (tasks.length > MAX_TASKS) {
      warnings.push({ reason: '任务超过 ' + MAX_TASKS + ' 条，已截断（防止一次导入过多）', text: '' });
      tasks = tasks.slice(0, MAX_TASKS);
    }
    tasks.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    var plannedMin = 0;
    tasks.forEach(function (t) { plannedMin += t.estimateMin; });

    return {
      goal: { title: title, type: type, deadline: deadline, description: '' },
      milestones: milestones,
      tasks: tasks,
      warnings: warnings,
      stats: { taskCount: tasks.length, milestoneCount: milestones.length, plannedMin: plannedMin },
      source: raw.source === 'ai' ? 'ai' : 'rule',
      mock: !!raw.mock
    };
  }

  /* ---------------- 供 UI 使用的小工具 ---------------- */

  /** 未来 7 天的下拉选项（导入预览的行内日期选择） */
  function windowDates() {
    var out = [];
    var base = today();
    var names = ['今天', '明天', '后天'];
    for (var i = 0; i < WINDOW_DAYS; i++) {
      var d = Store.addDays(base, i);
      var md = (Store.parseDate(d).getMonth() + 1) + '-' + Store.parseDate(d).getDate();
      var label = i < 3 ? names[i] + ' ' + md : md + ' 周' + Store.weekdayCN(d);
      out.push({ date: d, label: label });
    }
    return out;
  }

  /** 预计每日负荷（分钟），用于预览页的预算提示 */
  function dailyLoad(tasks) {
    var map = {};
    (tasks || []).forEach(function (t) {
      if (!t || !t.date || t.status === 'skipped') return;
      map[t.date] = (map[t.date] || 0) + (+t.estimateMin || 0);
    });
    return map;
  }

  global.Importer = {
    MAX_TEXT: MAX_TEXT,
    AI_TEXT_LIMIT: AI_TEXT_LIMIT,
    MAX_TASKS: MAX_TASKS,
    ruleParse: ruleParse,
    normalize: normalize,
    windowDates: windowDates,
    dailyLoad: dailyLoad
  };
})(window);
