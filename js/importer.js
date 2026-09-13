/* ==========================================================
 * importer.js —— 外部计划导入：文本解析与结构归一化
 * 场景：用户把 ChatGPT / Claude 生成的 Markdown/文本计划粘贴进来，
 *       解析为「阶段大纲(milestones) + 每日任务(tasks)」。
 *
 * 设计要点（v2.2.0 起）：
 *   - 导入范围 = 整份计划：从今天到 min(截止日, 今天+180 天)，
 *     不再只保留未来 7 天（AI 生成的滚动周计划仍走 ai.js 的 7 天窗口）。
 *   - 早于今天的任务不导入，但会逐条列在 dropped 里交给 UI 展示。
 *   - 日期解析尽量宽松（flexDate）：2026-09-15 / 2026/9/15 / 9月15日 /
 *     15号 / Day 3 / 第3天 / 第一天 / 明天 / 周三 / 下周一 / Mon / Week 2。
 *   - 结构识别覆盖 Markdown 标题、加粗小节、「一、」「（一）」、Week N:、
 *     无序/有序列表（含无空格「1、」）、复选框、引用、表格；
 *     代码围栏内内容不解析；缩进子项作为父项描述。
 *   - 本模块只做「文本 → 结构」，不调用 AI；AI 路径复用 normalize()。
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;

  var MAX_TEXT = 20000;        // textarea 允许的最大字符数
  var AI_TEXT_LIMIT = 20000;   // 送入 AI 的文本上限
  var MAX_TASKS = 300;         // 单次导入任务上限
  var MAX_MILESTONES = 24;     // 阶段上限（周计划常见 12-20 个阶段）
  var HORIZON_MAX_DAYS = 180;  // 导入跨度上限
  var UNDATED_PER_DAY = 3;     // 无日期任务每天最多排几条

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

  /** 导入跨度终点：截止日与「今天+180」取小者 */
  function horizonEnd(deadline) {
    var cap = Store.addDays(today(), HORIZON_MAX_DAYS);
    var d = isDateStr(deadline) ? deadline : '';
    if (!d || d > cap) return cap;
    return d < today() ? today() : d;
  }

  /**
   * 宽松日期解析：把各种写法归一为 YYYY-MM-DD（解析不出返回 ''）
   * 供 AI 与规则两条路径共用，避免 AI 返回 2026/9/15 这类格式被静默丢弃
   */
  function flexDate(v, base) {
    base = base || today();
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (isDateStr(s)) return s;
    // ISO 带时间：2026-09-15T08:00:00
    var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]/);
    if (iso) return validDateIn(+iso[1], +iso[2], +iso[3]) || '';
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return validDateIn(+m[1], +m[2], +m[3]) || '';
    m = s.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
    if (m) return explicitMonthDay(+m[1], +m[2], base);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
    if (m) return explicitMonthDay(+m[1], +m[2], base);
    return '';
  }

  /* ---------------- 日期语义 ---------------- */

  var WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  var EN_WEEKDAY = { mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6, sun: 0 };
  var CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  /** 中文数字（一~三十九）→ 数字；不是中文数字时返回 NaN */
  function cnNumber(s) {
    s = String(s || '');
    if (/^\d+$/.test(s)) return +s;
    if (!$cnNumberRe.test(s)) return NaN;
    var m = s.match(/^(.?)十(.?)$/);
    if (m) {
      var tens = m[1] ? (CN_NUM[m[1]] || 0) : 1;
      var ones = m[2] ? (CN_NUM[m[2]] || 0) : 0;
      if (tens === 0 || (m[1] && CN_NUM[m[1]] === undefined) || (m[2] && CN_NUM[m[2]] === undefined)) return NaN;
      return tens * 10 + ones;
    }
    if (s.length === 1) return CN_NUM[s] === undefined ? NaN : CN_NUM[s];
    return NaN;
  }
  var $cnNumberRe = /^[零一二两三四五六七八九十]+$/;

  /** 明确写了月份的日期（9月15日）：不跨月顺延，过去就是过去 */
  function explicitMonthDay(m, d, base) {
    var y = Store.parseDate(base).getFullYear();
    return validDateIn(y, m, d);
  }

  /** 只写日号（15号）：本月未到则取下月 */
  function dayOfMonth(d, base) {
    var b = Store.parseDate(base);
    var s = validDateIn(b.getFullYear(), b.getMonth() + 1, d);
    if (s && s >= base) return s;
    var nm = b.getMonth() + 2, ny = b.getFullYear();
    if (nm > 12) { nm = 1; ny++; }
    return validDateIn(ny, nm, d) || s || '';
  }

  function nextWeekday(target, base) {
    var cur = Store.parseDate(base).getDay();
    return Store.addDays(base, (target - cur + 7) % 7);
  }

  // 这些单位跟在数字后说明它是个量值，不是日期（1.5小时、5.5公里）
  var UNIT_AFTER = /^(?:\s*(?:倍|公里|千米|km|kg|克|斤|小时|分钟|分|秒|%|％|元|块|次|个|岁|米|页|题|篇|组|遍|级|层|件|km\/h))/i;
  var DATE_CTX_BEFORE = /(?:截止|开始|起|到|至|从|之前|前|完成于|deadline|due|before|by)\s*$/i;

  /** 扫描「月/日」「月.日」形式，排除小数、比例与量值 */
  function findMonthDay(s, base) {
    var re = /(?:^|[^\dA-Za-z./-])(\d{1,2})([/.])(\d{1,2})(?![\dA-Za-z./-])/g;
    var m;
    while ((m = re.exec(s))) {
      var mm = +m[1], dd = +m[3];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
      var end = m.index + m[0].length;
      var after = s.slice(end);
      if (UNIT_AFTER.test(after)) continue;                       // 1.5小时 / 5.5公里
      if (/^\s*[:：]\s*\d/.test(after)) continue;                  // 比例 2:3
      var before = s.slice(0, m.index + 1);
      if (DATE_CTX_BEFORE.test(before)) { /* 明确语境，直接采用 */ }
      else if (!(dd > 12 || /^\s*[日号]/.test(after))) continue;   // 2/3、1.5 这类歧义不认
      var d = explicitMonthDay(mm, dd, base);
      if (d) return { date: d, token: m[1] + m[2] + m[3] };
    }
    return null;
  }

  /**
   * 在文本中识别日期，返回 { date, token }（找不到 date=''）
   */
  function findDate(text, base) {
    base = base || today();
    var s = String(text || '');
    var m;

    // 1) 带年：2026-09-15 / 2026/9/15 / 2026.9.15
    m = s.match(/(?:^|[^\d])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/);
    if (m) {
      var abs = validDateIn(+m[1], +m[3], +m[4]);
      if (abs) return { date: abs, token: m[1] + m[2] + m[3] + m[2] + m[4] };
    }
    // 2) 中文月日：9月15日
    m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
    if (m) {
      var cn = explicitMonthDay(+m[1], +m[2], base);
      if (cn) return { date: cn, token: m[0] };
    }
    // 3) 月/日、月.日（排除量值与比例）
    var md = findMonthDay(s, base);
    if (md) return md;

    // 4) 只写日号：15号 / 15日
    m = s.match(/(?:^|[^\d])(\d{1,2})\s*[日号](?!\d)/);
    if (m) {
      var dom = dayOfMonth(+m[1], base);
      if (dom) return { date: dom, token: m[0] };
    }
    // 5) Day N / D N（需词边界，避免 add 3 / read 2 被误判）
    m = s.match(/(?:^|[^A-Za-z])day\s*(\d{1,3})(?![\dA-Za-z])/i);
    if (m) return { date: Store.addDays(base, +m[1] - 1), token: m[0] };
    m = s.match(/(?:^|[^A-Za-z])D\s*(\d{1,3})(?![\dA-Za-z])/);
    if (m) return { date: Store.addDays(base, +m[1] - 1), token: m[0] };
    // 6) 第 N 天 / 第N天 / 第一天
    m = s.match(/第\s*([0-9]{1,3}|[零一二两三四五六七八九十]+)\s*天/);
    if (m) {
      var n = cnNumber(m[1]);
      if (!isNaN(n) && n >= 1) return { date: Store.addDays(base, n - 1), token: m[0] };
    }
    // 7) N 天后 / N 周后
    m = s.match(/(\d{1,3})\s*天\s*(?:后|之后)/);
    if (m) return { date: Store.addDays(base, +m[1]), token: m[0] };
    m = s.match(/(\d{1,2})\s*(?:周|星期|礼拜)\s*(?:后|之后)/);
    if (m) return { date: Store.addDays(base, +m[1] * 7), token: m[0] };
    // 8) 中文相对日
    var rel = [['大后天', 3], ['后天', 2], ['明天', 1], ['明日', 1], ['今天', 0], ['今日', 0]];
    for (var i = 0; i < rel.length; i++) {
      if (s.indexOf(rel[i][0]) >= 0) return { date: Store.addDays(base, rel[i][1]), token: rel[i][0] };
    }
    // 9) 中文星期（带 上/本/这/下 限定词）
    m = s.match(/(上|本|这|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (m) {
      var wk = nextWeekday(WEEKDAY_MAP[m[2]], base);
      if (m[1] === '下') wk = Store.addDays(wk, 7);
      else if (m[1] === '上') wk = Store.addDays(wk, -7);
      return { date: wk, token: m[0] };
    }
    // 10) 英文星期 Mon / Monday
    m = s.match(/(?:^|[^A-Za-z])(mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)(?:day)?(?![\dA-Za-z])/i);
    if (m) {
      var key = m[1].toLowerCase();
      if (EN_WEEKDAY[key] !== undefined) return { date: nextWeekday(EN_WEEKDAY[key], base), token: m[0] };
    }
    // 11) Week N / 第N周 → 该周第一天（Day 1 = 今天所在这一周）
    m = s.match(/(?:^|[^A-Za-z])(?:week|wk)\s*(\d{1,2})(?!\d)/i) || s.match(/第\s*([0-9]{1,2}|[一二三四五六七八九十]+)\s*(?:周|星期)/);
    if (m) {
      var w2 = cnNumber(m[1]);
      if (!isNaN(w2) && w2 >= 1) return { date: Store.addDays(base, (w2 - 1) * 7), token: m[0] };
    }
    return { date: '', token: '' };
  }

  // 区间里出现的日期是确定的，不受"日 ≤ 12 可能是小数/比例"的限制
  var RANGE_CTX_BEFORE = /(?:截止|deadline|due|第\s*[0-9一二两三四五六七八九十]{1,3}\s*周|本周|下周|周|星期|礼拜)\s*[（(【\[]?\s*$/i;

  /**
   * 识别「A–B」形式的日期区间，如 9.28–10.4 / 10.5–10.11 / 9月28日-10月4日
   * 返回 { start, end, tokens:[整段文本] } 或 null
   * 误判防护：必须位于括号内、或两侧日号都 > 12、或紧跟在「第N周/截止/周X」等语境之后
   */
  function findDateRangePair(s, base, assumeBracket) {
    var re = /(\d{1,2})([.月/])(\d{1,2})\s*[日号]?\s*(?:[–—~～]|至|到|-)\s*(\d{1,2})([.月/])(\d{1,2})\s*[日号]?/g;
    var m;
    while ((m = re.exec(s))) {
      var m1 = +m[1], d1 = +m[3], m2 = +m[4], d2 = +m[6];
      if (m1 < 1 || m1 > 12 || d1 < 1 || d1 > 31) continue;
      if (m2 < 1 || m2 > 12 || d2 < 1 || d2 > 31) continue;
      var before = s.slice(0, m.index);
      var inBracket = !!assumeBracket || /[（(【\[]\s*$/.test(before);
      if (!inBracket && !(d1 > 12 && d2 > 12) && !RANGE_CTX_BEFORE.test(before)) continue;
      var after = s.slice(m.index + m[0].length);
      if (UNIT_AFTER.test(after) || /^\s*[:：]\s*\d/.test(after)) continue;  // 1.5–2.5 公里 / 比例
      var a = explicitMonthDay(m1, d1, base);
      var b = explicitMonthDay(m2, d2, base);
      if (!a || !b || b < a) continue;
      return { start: a, end: b, tokens: [m[0]] };
    }
    return null;
  }

  /** 识别日期区间（9月15日-9月20日）→ { start, end, tokens } */
  function findDateRange(text, base) {
    var pair = findDateRangePair(text, base);
    if (pair) return pair;
    var first = findDate(text, base);
    if (!first.date) return { start: '', end: '', tokens: [] };
    var rest = text.split(first.token).join(' ');
    var second = findDate(rest, base);
    if (second.date && second.date >= first.date) {
      return { start: first.date, end: second.date, tokens: [first.token, second.token] };
    }
    return { start: first.date, end: '', tokens: [first.token] };
  }

  // 时长后面紧跟这些名词时，说明它是「内容规格」而非本任务的时间预算（如「5 分钟演讲」「10 分钟视频」）
  var DUR_DESC_NOUN = /^\s*(?:演讲|视频|音频|文章|短文|材料|朗读|对话|段落|内容|时长|录音|练习曲|篇幅)/;

  /** 时长：45分钟 / 1小时 / 1.5h / 约45分钟；多处出现时取最大（更能代表该项占用的时间块） */
  function findMinutes(text) {
    var best = { min: 0, token: '' };
    var m;
    var reH = /(\d+(?:\.\d+)?)\s*(?:个?\s*小时|hours?|hrs?)/gi;
    var reM = /(\d+)\s*(?:分钟|分|mins?|min\b|h\b)/gi;
    var take = function (mins, token, endIdx) {
      if (!mins) return;
      if (DUR_DESC_NOUN.test(String(text).slice(endIdx))) return;
      if (mins > best.min) best = { min: mins, token: token };
    };
    while ((m = reH.exec(text))) take(Math.round(+m[1] * 60), m[0], m.index + m[0].length);
    while ((m = reM.exec(text))) take(+m[1], m[0], m.index + m[0].length);
    return best;
  }

  /** 括号内的时长优先：任务真实时长通常写在行尾括号里（如（130分钟·高精力）） */
  function findBracketMinutes(text) {
    var re = /[（(][^（()）]{0,40}[)）]/g;
    var m;
    while ((m = re.exec(text))) {
      var v = findMinutes(m[0]);
      if (v.min) return v;
    }
    return null;
  }

  var ENERGY_HIGH = /高精力|高强度|高难度|最重要|优先完成/;
  var ENERGY_LOW = /低精力|低强度|轻松|碎片|简单|轻量/;
  var ENERGY_MID = /中精力|中强度|中难度/;

  /** 精力关键词 → 'high' | 'mid' | 'low' | '' */
  function findEnergy(text) {
    if (ENERGY_HIGH.test(text)) return 'high';
    if (ENERGY_LOW.test(text)) return 'low';
    if (ENERGY_MID.test(text)) return 'mid';
    return '';
  }

  // 「纯标注括号」里允许出现的词：精力 + 时长单位 + 星期 + 约数词
  var META_IN_BRACKET = new RegExp(
    '(?:' +
    '高精力|中精力|低精力|高强度|中强度|低强度|高难度|中难度|轻松|碎片|简单|轻量|最重要|优先完成' +
    '|(?:个?\\s*小时)|hours?|hrs?|分钟|分|mins?|min|h' +
    '|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|(?:mon|tues|tue|wed|thu|thur|thurs|fri|sat|sun)(?:day)?' +
    '|约|大约|左右|每次|每天|每日|时长|建议|分钟左右' +
    ')', 'gi');

  /** 标题净化：移除已消费的日期/时长 token、编号、装饰与「纯标注括号」 */
  function cleanTitle(text, tokens) {
    var s = String(text || '');
    var kept = [];
    // 括号内若全部是时长/日期/精力/星期标注则整体删除，否则原样保留
    // 保留的括号先占位，避免随后的 token 剥离把括号里有意义的内容挖空
    s = s.replace(/[（(][^（()）]{0,30}[)）]/g, function (m) {
      var inner = m.slice(1, -1);
      if (!inner.trim()) return ' ';
      var isMeta = !!findMinutes(inner).min || !!findDate(inner, today()).date ||
        !!findDateRangePair(inner, today(), true) || !!findEnergy(inner);
      var remainder = inner.replace(META_IN_BRACKET, '');
      var hasExtra = /[，,。；;、:：a-zA-Z\u4e00-\u9fa5]/.test(remainder);
      if (isMeta && !hasExtra) return ' ';
      kept.push(m);
      return '\u0001' + (kept.length - 1) + '\u0001';
    });
    (tokens || []).forEach(function (tk) {
      if (!tk) return;
      s = s.split(tk).join(' ');
    });
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return kept[+i]; });
    return s
      .replace(/^[\s\-*•·>]+/, '')
      .replace(/^\[[ xX✓]\]\s*/, '')
      .replace(/^(?:约|大约|左右)\s*/, '')
      .replace(/\s*(?:约|左右)\s*$/, '')
      .replace(/[*_`]/g, '')
      .replace(/[\s·\-—:：,，、|（(【\[]+$/, '')
      .replace(/^[\s·\-—:：,，、|)）】\]]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------------- 行分类规则 ---------------- */

  var RE_FENCE = /^\s*```/;
  var RE_SEP = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var RE_HEADING = /^(#{1,6})\s*(.+)$/;
  var RE_BOLD_LINE = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/;
  var RE_CN_SECTION = /^([一二三四五六七八九十]+)\s*[、.．]\s*(.*)$/;
  var RE_CN_PAREN = /^[（(]\s*([一二三四五六七八九十]+)\s*[)）]\s*(.*)$/;
  var RE_WEEK_PHASE = /^(?:第\s*([一二三四五六七八九十\d]+)\s*(?:周|阶段|部分|月)|(?:week|wk|phase)\s*(\d+))\s*[：:、.．]?\s*(.*)$/i;
  var RE_LIST = /^(?:[-*+•]|\d{1,3}\s*[.、)])\s*(?!\d)(.*)$/;
  var RE_QUOTE = /^>\s?(.*)$/;
  var RE_TABLE = /^\|(.+)\|$/;
  var RE_META = /^(目标名称|目标|标题|计划名称|计划|title|plan)\s*[:：]\s*(.+)$/i;
  var RE_DEADLINE = /^(截止日期|截止时间|截止|deadline|due)\s*[:：]\s*(.+)$/i;
  var RE_NOISE = /^(以下是|下面是|下面是我|注[：:]|备注[：:]|说明[：:]|提示[：:]|前言|注意[：:]|要求[：:]|原则[：:])/;
  // 阶段说明行（如「本周目标：…」）：应作为阶段说明，不要因为句中出现「第2周」而被当成任务
  var RE_PHASE_NOTE = /^(?:本周目标|本月目标|阶段目标|本周重点|阶段重点|本周任务|本周安排|阶段安排)\s*[:：]\s*(.*)$/;

  /* ------- 无换行兜底：把结构边界补成换行（从聊天窗口复制常丢换行） ------- */
  // 只在两种强特征处切：①「第N周」后带分隔符；②「M月D日（周X）」
  // 注意：日期前必须用 [^\d] 卡边界，否则「11月1日」会被从第二位数字处切开，误judge成 1月1日
  var SPLIT_MARK = '\u0002';
  var RE_DATE_SIG = /\d{1,2}\s*月\s*\d{1,2}\s*[日号]\s*[（(]\s*周/g;

  function markBoundaries(s) {
    return s
      .replace(/(^|[\s\S])(?=第\s*[0-9一二两三四五六七八九十]{1,3}\s*周\s*[·.、:：])/g, '$1' + SPLIT_MARK)
      .replace(/(^|[^\d])(?=\d{1,2}\s*月\s*\d{1,2}\s*[日号]\s*[（(]\s*周)/g, '$1' + SPLIT_MARK);
  }

  function splitStructure(lines) {
    var out = [];
    var did = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var marks = (line.match(RE_DATE_SIG) || []).length;
      if (line.length > 120 || marks >= 2) {
        var parts = markBoundaries(line).split(SPLIT_MARK)
          .map(function (x) { return x.trim(); })
          .filter(function (x) { return !!x; });
        if (parts.length > 1) { out = out.concat(parts); did = true; continue; }
      }
      out.push(line);
    }
    return { lines: out, did: did };
  }

  /* ---------------- 规则解析 ---------------- */

  /**
   * 规则解析：文本 → 归一化后的 ImportResult
   * @param {string} text 计划原文
   * @param {object} opts { title, type, deadline } 用户覆盖值
   */
  function ruleParse(text, opts) {
    opts = opts || {};
    var base = today();
    var raw = {
      title: '', type: '', deadline: '',
      milestones: [], tasks: [], warnings: [], source: 'rule', mock: false
    };

    var full = String(text || '');
    if (full.length > MAX_TEXT) {
      raw.warnings.push({ reason: '文本超过 ' + MAX_TEXT + ' 字符，仅解析前 ' + MAX_TEXT + ' 字符，建议分段导入', text: '' });
    }
    var lines = full.slice(0, MAX_TEXT).replace(/\r\n?/g, '\n').split('\n');
    var split = splitStructure(lines);
    lines = split.lines;
    if (split.did) {
      raw.warnings.push({
        reason: '检测到内容缺少换行，已按「第N周」与日期边界自动切分为 ' + lines.length + ' 行；若结果有偏差，建议改用文件导入或手动换行',
        text: ''
      });
    }

    var cursor = base;
    var cursorCount = 0;
    var lastTask = null;
    var lastMs = null;
    var seenTitle = false;
    var inFence = false;
    var lost = 0;

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var t = rawLine.trim();

      // 代码围栏内不做解析
      if (RE_FENCE.test(rawLine)) { inFence = !inFence; continue; }
      if (inFence) continue;
      if (!t || RE_SEP.test(t)) continue;

      // 缩进子项：并入上一条的描述，不单独成为任务
      var indent = rawLine.length - rawLine.replace(/^\s+/, '').length;

      // 元信息
      var mDead = t.match(RE_DEADLINE);
      if (mDead) {
        var dd = findDate(mDead[2], base).date;
        if (dd) { raw.deadline = dd; continue; }
      }
      var mMeta = t.match(RE_META);
      if (mMeta) {
        var mt = cleanTitle(mMeta[2], []);
        if (mt && !raw.title) { raw.title = mt.slice(0, 60); seenTitle = true; }
        continue;
      }
      if (RE_NOISE.test(t)) { continue; }

      // 阶段说明行 → 归入当前阶段的 detail（避免句中的「第2周」被当成日期）
      var mNote = t.match(RE_PHASE_NOTE);
      if (mNote) {
        var noteText = cleanTitle(mNote[1], []);
        if (lastMs && !lastMs.detail) { lastMs.detail = noteText.slice(0, 120); continue; }
        if (lastTask) {
          lastTask.desc = ((lastTask.desc ? lastTask.desc + '；' : '') + noteText).slice(0, 100);
          continue;
        }
        if (!raw.title && !seenTitle && noteText) { raw.title = noteText.slice(0, 60); seenTitle = true; continue; }
        continue;
      }

      // 引用：剥掉前缀后按同样规则处理
      var mq = t.match(RE_QUOTE);
      if (mq) {
        t = mq[1].trim();
        if (!t) continue;
        indent = 0;
      }

      // 阶段形态（标题 / 整行加粗 / 一、 / （一） / 第N周： / Week N:）
      var phase = detectPhase(t);
      if (phase) {
        if (phase.level === 1 && !raw.title && !seenTitle) {
          raw.title = phase.body.slice(0, 60);
          seenTitle = true;
          continue;
        }
        // 「本周目标：…」若和阶段标题写在同一行（例如无换行的粘贴），拆出来作为阶段说明
        var bodyParts = String(phase.body || '').split(/本周目标\s*[:：]/);
        var mainBody = bodyParts[0];
        var goalNote = bodyParts.length > 1 ? bodyParts.slice(1).join(' ').trim().slice(0, 120) : '';
        var headRange = findDateRange(mainBody || phase.label, base);
        var headTitle = cleanTitle(mainBody, headRange.tokens);
        if (!headTitle) headTitle = phase.label;
        if (!headTitle) headTitle = '阶段 ' + (raw.milestones.length + 1);
        lastMs = {
          title: (phase.labelPrefix && headTitle.indexOf(phase.labelPrefix) < 0
            ? phase.labelPrefix + ' · ' + headTitle
            : headTitle).slice(0, 30),
          detail: goalNote,
          startDate: headRange.start || '',
          targetDate: headRange.end || ''
        };
        raw.milestones.push(lastMs);
        lastTask = null;
        if (headRange.start && headRange.start >= base) {
          cursor = clampCursor(headRange.start, base);
          cursorCount = 0;
        }
        continue;
      }

      // 表格行
      var mTable = t.match(RE_TABLE);
      if (mTable) {
        var cells = mTable[1].split('|').map(function (c) { return c.trim(); })
          .filter(function (c) { return c && !/^[-:\s]+$/.test(c); });
        var cellDate = '', cellTitle = '';
        cells.forEach(function (c) {
          var fd = findDate(c, base);
          if (fd.date && !cellDate) cellDate = fd.date;
        });
        for (var ci = cells.length - 1; ci >= 0; ci--) {
          if (!findDate(cells[ci], base).date && !/^\d+$/.test(cells[ci]) && cells[ci].length > 1) { cellTitle = cells[ci]; break; }
        }
        if (cellDate && cellTitle) {
          var row = makeTask(cellTitle, cellDate, base, cursor, cursorCount);
          if (row) {
            raw.tasks.push(row.task);
            cursor = row.cursor; cursorCount = row.cursorCount;
            lastTask = row.task;
          }
        } else {
          raw.warnings.push({ reason: '第 ' + (i + 1) + ' 行：表格行没有可用日期，已跳过', text: t.slice(0, 60) });
        }
        continue;
      }

      // 列表项 → 任务
      var ml = t.match(RE_LIST);
      if (ml) {
        var body = ml[1];
        if (indent >= 2 && (lastTask || lastMs)) {
          var sub = cleanTitle(body, [findDate(body, base).token, findMinutes(body).token]);
          if (sub) {
            if (lastTask) lastTask.desc = ((lastTask.desc ? lastTask.desc + '；' : '') + sub).slice(0, 100);
            else lastMs.detail = ((lastMs.detail ? lastMs.detail + '；' : '') + sub).slice(0, 120);
          }
          continue;
        }
        var made = makeTask(body, '', base, cursor, cursorCount);
        if (made) {
          raw.tasks.push(made.task);
          cursor = made.cursor; cursorCount = made.cursorCount;
          lastTask = made.task;
        } else {
          raw.warnings.push({ reason: '第 ' + (i + 1) + ' 行：列表项内容为空', text: t.slice(0, 60) });
        }
        continue;
      }

      // 纯文本行：含日期 → 任务；首个短行 → 目标标题；否则作为上一条描述
      var plainFd = findDate(t, base);
      if (plainFd.date) {
        var madeP = makeTask(t, '', base, cursor, cursorCount);
        if (madeP) {
          raw.tasks.push(madeP.task);
          cursor = madeP.cursor; cursorCount = madeP.cursorCount;
          lastTask = madeP.task;
          continue;
        }
      }
      if (!seenTitle && !raw.milestones.length && !raw.tasks.length && t.length <= 60) {
        var plain = cleanTitle(t, []);
        if (plain) { raw.title = plain.slice(0, 60); seenTitle = true; continue; }
      }
      if (lastTask) {
        lastTask.desc = ((lastTask.desc ? lastTask.desc + ' ' : '') + cleanTitle(t, [])).slice(0, 100);
        continue;
      }
      if (lastMs) {
        lastMs.detail = ((lastMs.detail ? lastMs.detail + ' ' : '') + cleanTitle(t, [])).slice(0, 120);
        continue;
      }
      lost++;
      if (lost <= 12) raw.warnings.push({ reason: '第 ' + (i + 1) + ' 行：无法识别', text: t.slice(0, 60) });
    }

    if (!raw.type) {
      var hay = [raw.title].concat(
        raw.milestones.map(function (m) { return m.title; }),
        raw.tasks.map(function (x) { return x.title; })
      ).join(' ');
      raw.type = guessType(hay);
    }
    if (lost > 12) raw.warnings.push({ reason: '另有 ' + (lost - 12) + ' 行无法识别（已省略明细）', text: '' });
    raw._lineCount = lines.length;
    raw._truncated = full.length > MAX_TEXT;
    return normalize(raw, opts);
  }

  /** 光标上限保护：避免远期阶段日期把后续无日期任务推出跨度 */
  function clampCursor(date, base) {
    var cap = Store.addDays(base, HORIZON_MAX_DAYS);
    if (date > cap) return cap;
    return date;
  }

  /** 阶段行识别：返回 { level, label, labelPrefix, body } 或 null */
  function detectPhase(t) {
    var m = t.match(RE_HEADING);
    if (m) {
      var body = cleanTitle(m[2], []);
      return { level: m[1].length, label: body, labelPrefix: '', body: m[2] };
    }
    m = t.match(RE_WEEK_PHASE);
    if (m) {
      var label = m[1] ? ('第 ' + m[1] + ' 周') : (m[2] ? ('Week ' + m[2]) : '');
      return { level: 2, label: label, labelPrefix: label, body: m[3] || '', _force: true };
    }
    m = t.match(RE_CN_SECTION);
    if (m) return { level: 2, label: m[1] + '、', labelPrefix: '', body: m[2] };
    m = t.match(RE_CN_PAREN);
    if (m) return { level: 2, label: '（' + m[1] + '）', labelPrefix: '', body: m[2] };
    m = t.match(RE_BOLD_LINE);
    if (m) {
      if (!m[1] || m[1].length > 30) return null;
      return { level: 2, label: cleanTitle(m[1], []), labelPrefix: '', body: (m[1] + ' ' + (m[2] || '')).trim() };
    }
    return null;
  }

  /**
   * 由一行文本构造任务
   * 无日期时使用游标，每 UNDATED_PER_DAY 条推进一天，并受跨度上限保护
   */
  function makeTask(text, explicitDate, base, cursor, cursorCount) {
    var range = findDateRange(text, base);
    var bracketMin = findBracketMinutes(text);
    var fm = bracketMin || findMinutes(text);
    var fe = findEnergy(text);
    // 括号里已给出时长时，只删括号、不再剥离正文里的时长（避免「严格计时130分钟」被挖空）
    var title = cleanTitle(text, range.tokens.concat(bracketMin ? [] : [fm.token]));
    if (!title) return null;
    // 能量词从标题里去掉（只作为属性）
    title = title.replace(/\s*(?:高精力|低精力|高强度|低强度|轻松|碎片|简单|轻量)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    var date = explicitDate || range.start || cursor;
    var nextCursor = cursor, nextCount = cursorCount;
    if (explicitDate || range.start) {
      nextCursor = clampCursor(date, base);
      nextCount = 1;
    } else {
      nextCount = cursorCount + 1;
      if (nextCount > UNDATED_PER_DAY) {
        nextCursor = clampCursor(Store.addDays(cursor, 1), base);
        nextCount = 1;
      }
    }
    return {
      task: {
        date: date,
        endDate: (!explicitDate && range.end) ? range.end : '',
        title: title.slice(0, 60),
        desc: '',
        energy: fe || 'mid',
        estimateMin: fm.min || 30
      },
      cursor: nextCursor,
      cursorCount: nextCount
    };
  }

  /* ---------------- 归一化（AI 与规则共用） ---------------- */

  /** 阶段缺日期时，按任务/阶段数量在 [今天, 截止日] 内均分 */
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

  /** 兜底阶段：解析不到阶段但任务跨多天时，按周自动生成 */
  function autoMilestones(tasks, from, deadline) {
    if (tasks.length < 3) return [];
    var dates = tasks.map(function (t) { return t.date; }).sort();
    var first = dates[0], last = dates[dates.length - 1];
    if (Store.daysBetween(first, last) < 2) return [];
    var out = [];
    var cur = first;
    var n = 0;
    while (cur <= last && out.length < 6) {
      n++;
      var end = Store.addDays(cur, 6);
      if (end > last) end = last;
      if (end > deadline) end = deadline;
      out.push({ title: '第 ' + n + ' 周（自动生成）', detail: '', startDate: cur, targetDate: end });
      if (end >= last) break;
      cur = Store.addDays(end, 1);
    }
    return out;
  }

  /**
   * 校验并规范化 ImportResult
   * opts: { title, type, deadline } 覆盖解析结果（用户在弹窗中的选择优先）
   */
  function normalize(raw, opts) {
    opts = opts || {};
    raw = raw || {};
    var base = today();
    var warnings = (raw.warnings || []).slice();
    var dropped = [];

    // 任务先规范化（不依赖 deadline）
    var tasks = [];
    var pending = [];      // 没有可用日期的任务，稍后顺序补日期
    var seen = {};
    var dup = 0, invalid = 0, pastCount = 0;
    (Array.isArray(raw.tasks) ? raw.tasks : []).forEach(function (t) {
      if (!t) return;
      var name = String(t.title || '').trim().replace(/\s+/g, ' ');
      if (!name) { invalid++; return; }
      var d = flexDate(t.date, base) || (isDateStr(t.date) ? t.date : '');
      var item = {
        title: name.slice(0, 60),
        desc: String(t.desc || '').trim().slice(0, 100),
        energy: validEnergy(t.energy) || 'mid',
        estimateMin: Store.clamp(Math.round(+t.estimateMin || 30), 10, 300),
        endDate: ''
      };
      if (!d) { pending.push(item); return; }
      if (d < base) {
        pastCount++;
        if (dropped.length < 40) dropped.push({ date: d, title: item.title, reason: '早于今天' });
        return;
      }
      item.date = d;
      var key = d + '|' + item.title;
      if (seen[key]) { dup++; return; }
      seen[key] = true;
      tasks.push(item);
    });

    // 无日期任务：从今天起顺序补（每 UNDATED_PER_DAY 条推进一天）
    if (pending.length) {
      var cur = base, cnt = 0;
      pending.forEach(function (item) {
        cnt++;
        if (cnt > UNDATED_PER_DAY) { cur = Store.addDays(cur, 1); cnt = 1; }
        item.date = cur;
        var k2 = item.date + '|' + item.title;
        if (seen[k2]) { dup++; return; }
        seen[k2] = true;
        tasks.push(item);
      });
      warnings.push({ reason: '有 ' + pending.length + ' 条任务原文没有日期，已按顺序从今天起排列，可在预览里调整', text: '' });
    }

    tasks.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    // 截止日期：用户选择 > 原文 > 任务最后一天+7 > 今天+60
    var deadline = flexDate(opts.deadline, base) || flexDate(raw.deadline, base) || '';
    if (!deadline) {
      deadline = tasks.length ? Store.addDays(tasks[tasks.length - 1].date, 7) : Store.addDays(base, 60);
    }
    if (deadline < base) {
      warnings.push({ reason: '原文截止日期 ' + deadline + ' 早于今天，已自动调整为 ' + Store.addDays(base, 60), text: '' });
      deadline = Store.addDays(base, 60);
    }

    // 超出导入跨度的任务：钳到跨度终点（不丢弃）
    var horizon = horizonEnd(deadline);
    var clamped = 0;
    tasks.forEach(function (t) {
      if (t.date > horizon) { t.date = horizon; clamped++; }
    });
    if (clamped) warnings.push({ reason: '有 ' + clamped + ' 条任务超出导入跨度（最多 ' + HORIZON_MAX_DAYS + ' 天），已排到跨度最后一天', text: '' });

    // 任务上限：保留最早的
    if (tasks.length > MAX_TASKS) {
      var over = tasks.length - MAX_TASKS;
      tasks = tasks.slice(0, MAX_TASKS);
      warnings.push({ reason: '任务超过 ' + MAX_TASKS + ' 条，已保留最早的 ' + MAX_TASKS + ' 条，其余 ' + over + ' 条未导入', text: '' });
    }

    var title = String(opts.title || raw.title || '').trim().slice(0, 60) || '导入计划';
    var type = validType(opts.type) || validType(raw.type) || 'other';

    // 阶段
    var milestones = [];
    (Array.isArray(raw.milestones) ? raw.milestones : []).forEach(function (m) {
      if (!m || !String(m.title || '').trim()) return;
      if (milestones.length >= MAX_MILESTONES) return;
      var sd = flexDate(m.startDate, base) || (isDateStr(m.startDate) ? m.startDate : '');
      var td = flexDate(m.targetDate, base) || (isDateStr(m.targetDate) ? m.targetDate : '');
      milestones.push({
        title: String(m.title).trim().replace(/\s+/g, ' ').slice(0, 40),
        detail: String(m.detail || '').trim().slice(0, 120),
        startDate: sd,
        targetDate: td
      });
    });
    if ((raw.milestones || []).length > MAX_MILESTONES) {
      var droppedMs = (raw.milestones || []).slice(MAX_MILESTONES).map(function (m) {
        return String((m && m.title) || '').trim();
      }).filter(Boolean);
      warnings.push({
        reason: '阶段超过 ' + MAX_MILESTONES + ' 个，已保留前 ' + MAX_MILESTONES + ' 个；未导入：' +
          droppedMs.slice(0, 8).join('、') + (droppedMs.length > 8 ? ' 等' : ''),
        text: ''
      });
    }
    var auto = false;
    if (!milestones.length) {
      milestones = autoMilestones(tasks, base, deadline);
      auto = milestones.length > 0;
      if (auto) warnings.push({ reason: '未识别到阶段标题，已按周自动生成 ' + milestones.length + ' 个阶段（可删可改）', text: '' });
    }
    assignMilestoneDates(milestones, base, deadline);

    if (pastCount) {
      warnings.push({
        reason: '有 ' + pastCount + ' 条任务早于今天，未导入' +
          (pastCount > dropped.length ? '（下方仅列出前 ' + dropped.length + ' 条）' : '（见下方明细）'),
        text: ''
      });
    }
    if (dup) warnings.push({ reason: '已自动忽略 ' + dup + ' 条重复任务（同日期同标题）', text: '' });
    if (invalid) warnings.push({ reason: '已忽略 ' + invalid + ' 条缺少标题或日期格式无效的任务', text: '' });

    var plannedMin = 0;
    tasks.forEach(function (t) { plannedMin += t.estimateMin; });

    return {
      goal: { title: title, type: type, deadline: deadline, description: '' },
      milestones: milestones,
      tasks: tasks,
      warnings: warnings,
      dropped: dropped,
      truncated: raw._truncated === true,
      stats: {
        taskCount: tasks.length,
        milestoneCount: milestones.length,
        plannedMin: plannedMin,
        lineCount: raw._lineCount || 0,
        autoMilestones: auto
      },
      source: raw.source === 'ai' ? 'ai' : 'rule',
      mock: !!raw.mock,
      aiFailed: !!raw.aiFailed,
      aiError: raw.aiError || ''
    };
  }

  /* ---------------- 供 UI 使用的小工具 ---------------- */

  /** 预计每日负荷（分钟） */
  function dailyLoad(tasks) {
    var map = {};
    (tasks || []).forEach(function (t) {
      if (!t || !t.date || t.status === 'skipped') return;
      map[t.date] = (map[t.date] || 0) + (+t.estimateMin || 0);
    });
    return map;
  }

  /** 目标类型关键词推断（规则解析兜底） */
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

  global.Importer = {
    MAX_TEXT: MAX_TEXT,
    AI_TEXT_LIMIT: AI_TEXT_LIMIT,
    MAX_TASKS: MAX_TASKS,
    HORIZON_MAX_DAYS: HORIZON_MAX_DAYS,
    ruleParse: ruleParse,
    normalize: normalize,
    flexDate: flexDate,
    horizonEnd: horizonEnd,
    dailyLoad: dailyLoad
  };
})(window);
