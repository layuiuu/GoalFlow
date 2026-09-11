/* ==========================================================
 * ai.js —— AI 层：OpenAI 兼容接入（内置 DeepSeek 预设）+ Mock 引擎
 * 三个场景（真实调用与 Mock 输出同一 JSON Schema）：
 *   outline —— 目标 → 阶段大纲（里程碑）
 *   plan    —— 目标 → 未来 7 天每日任务（滚动窗口，省 Token）
 *   adjust  —— 分目标 / 全局动态调整建议（只建议，应用需用户预览确认）
 * 每次调用记录 token 用量与估算成本到本地
 * ========================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;
  var Agg = global.Agg;
  var Rules = global.Rules;

  var SYSTEM_PROMPT = '你是严谨的中文日程规划助手。无论用户要求什么，你只能输出一个 JSON 对象：' +
    '不要使用 markdown 代码块，不要解释，不要输出 JSON 以外的任何文字。所有文本用简体中文。';

  /* ---------------- 底层请求 ---------------- */

  function baseOf(s) { return ((s.api && s.api.base) || 'https://api.deepseek.com').replace(/\/+$/, ''); }

  function withProxy(url, s) {
    var p = (s.api && s.api.proxyPrefix) || '';
    if (!p) return url;
    return p.replace(/\/+$/, '') + '/' + url.replace(/^https?:\/\//, '');
  }

  /** 统一请求：出错时抛出带友好 message 的 Error（沿用 project1 providers.js 模式） */
  function request(url, options) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null; // 60s 网络超时
    var opts = Object.assign({}, options);
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (resp) {
      if (timer) clearTimeout(timer);
      return resp.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
        if (!resp.ok) {
          var msg = (data && (data.error && data.error.message || data.message || data.msg)) || ('HTTP ' + resp.status);
          if (resp.status === 401 || resp.status === 403) msg = 'API Key 无效或无权限（' + msg + '）';
          var err = new Error(msg);
          err.status = resp.status;
          throw err;
        }
        return data;
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new Error('请求超时（60 秒）：网络不稳定或模型响应慢，请重试');
      }
      if (e instanceof TypeError) {
        throw new Error('网络请求失败：可能是网络不通或浏览器跨域(CORS)限制，可在设置中修改 API 地址或填写跨域代理前缀');
      }
      throw e;
    });
  }

  function useMock() {
    var s = Store.loadSettings();
    if (s.mock === 'on') return true;
    if (s.mock === 'off') return false;
    return !s.api.key; // auto：无 Key 时自动 Mock
  }

  /** 记录一次调用的 token 用量与估算成本 */
  function recordUsage(scene, model, usage, isMock) {
    var s = Store.loadSettings();
    var prompt = (usage && usage.prompt_tokens) || 0;
    var completion = (usage && usage.completion_tokens) || 0;
    var hit = usage && usage.prompt_cache_hit_tokens !== undefined
      ? usage.prompt_cache_hit_tokens
      : (usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    var p = s.priceTable[0];
    for (var i = 0; i < s.priceTable.length; i++) if (s.priceTable[i].model === model) { p = s.priceTable[i]; break; }
    var hitN = Math.min(hit || 0, prompt);
    var miss = Math.max(0, prompt - hitN);
    Store.addUsage({
      scene: scene, model: model,
      prompt: prompt, completion: completion, total: (usage && usage.total_tokens) || (prompt + completion),
      cacheHit: hitN, mock: !!isMock,
      cost: hitN / 1e6 * (p.hit || 0) + miss / 1e6 * (p.miss || 0) + completion / 1e6 * (p.out || 0)
    });
  }

  /** 发送一次 chat 请求并返回 {content}；自动记录用量 */
  function chat(s, scene, messages, maxTokens) {
    var model = s.api.model || 'deepseek-chat';
    var body = {
      model: model,
      messages: messages,
      temperature: 0.6,
      max_tokens: maxTokens || 2000,
      stream: false
    };
    if (scene !== 'test') body.response_format = { type: 'json_object' };
    return request(withProxy(baseOf(s) + '/chat/completions', s), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.api.key },
      body: JSON.stringify(body)
    }).then(function (data) {
      recordUsage(scene, model, data && data.usage, false);
      var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
      return { content: content, model: model };
    });
  }

  function extractJSON(text) {
    if (!text) throw new Error('EMPTY_CONTENT');
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('NO_JSON');
    return JSON.parse(m[0]);
  }

  /** 将底层错误转换为用户可读的提示 */
  function humanizeError(e) {
    var m = (e && e.message) || '';
    if (m === 'EMPTY_CONTENT' || m === 'NO_JSON' || m.indexOf('Unexpected token') >= 0 || m.indexOf('JSON') >= 0) {
      return 'AI 正在休息，这次没有给出有效回复。请稍后再试；若反复出现，建议在设置中把模型换成 deepseek-chat（推理模型容易把输出额度用完）';
    }
    return m || 'AI 调用失败，请稍后再试';
  }

  /** JSON 请求 + 解析失败自动重试一次 */
  function askJSON(s, scene, userPrompt, maxTokens) {
    var messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
    return chat(s, scene, messages, maxTokens).then(function (res) {
      try { return extractJSON(res.content); }
      catch (e) {
        var retry = messages.concat([
          { role: 'assistant', content: res.content },
          { role: 'user', content: '你的输出不是合法 JSON。请重新回答，只输出一个 JSON 对象，不要任何其他文字。' }
        ]);
        return chat(s, scene, retry, maxTokens).then(function (res2) { return extractJSON(res2.content); });
      }
    });
  }

  /* ---------------- 工具 ---------------- */

  function dateNorm(v, fallback) {
    var s = String(v || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return fallback;
  }
  function energyNorm(v) {
    return (v === 'high' || v === 'mid' || v === 'low') ? v : 'mid';
  }

  function goalBrief(goal) {
    var lines = [
      '目标：' + goal.title,
      '描述：' + (goal.description || '无'),
      '类型：' + Store.typeOf(goal.type).name,
      '截止日期：' + goal.deadline + '（今天 ' + Store.todayStr() + '，剩余 ' + Math.max(0, Store.daysBetween(Store.todayStr(), goal.deadline)) + ' 天）',
      '期望投入：工作日 ' + goal.weekdayMinutes + ' 分钟 / 周末 ' + goal.weekendMinutes + ' 分钟',
      '当前基础：' + (goal.base || '未填写'),
      '个人偏好：' + (goal.preferences || '未填写'),
      '优先级：' + Store.prioOf(goal.priority).name + (goal.isCore ? '（核心目标）' : '')
    ];
    if ((goal.milestones || []).length) {
      var ms = goal.milestones.map(function (m) {
        return '- ' + m.title + '（' + (m.startDate ? m.startDate + ' 至 ' : '') + m.targetDate + (m.done ? '，已完成' : '') + '）' + (m.detail ? '：' + m.detail : '');
      });
      lines.push('阶段大纲：\n' + ms.join('\n'));
    }
    if ((goal.repeatRules || []).length) {
      lines.push('注意：该目标已有本地固定任务（如每日打卡），无需为其重复安排同类任务。');
    }
    return lines.join('\n');
  }

  function recentText(goalId, days) {
    var out = [];
    for (var i = 1; i <= days; i++) {
      var date = Store.addDays(Store.todayStr(), -i);
      var tasks = Store.tasksByDate(date).filter(function (t) { return !goalId || t.goalId === goalId; });
      if (!tasks.length) continue;
      var done = 0, total = 0;
      tasks.forEach(function (t) {
        if (t.status === 'skipped') return;
        total++;
        if (t.status === 'done') done += 1;
        else if (t.status === 'partial') done += 0.5;
      });
      var missed = tasks.filter(function (t) { return t.status === 'missed'; })
        .map(function (t) {
          var why = t.missNote || '';
          if (!why) {
            for (var k = 0; k < Store.MISS_REASONS.length; k++) {
              if (Store.MISS_REASONS[k].id === t.missReason) { why = Store.MISS_REASONS[k].name; break; }
            }
          }
          return t.title + (why ? '（原因：' + why + '）' : '');
        }).slice(0, 3);
      out.push(date + ' 完成率 ' + (total ? Math.round(done / total * 100) : 0) + '%' +
        (missed.length ? '（未完成：' + missed.join('、') + '）' : ''));
    }
    return out.length ? out.join('；') : '近几天无任务记录';
  }

  function reviewText(goalId) {
    var r = Store.reviewByDate(Store.addDays(Store.todayStr(), -1)) || Store.reviewByDate(Store.todayStr());
    if (!r) return '暂无复盘';
    var parts = [];
    if (r.blocked) parts.push('卡点：' + r.blocked);
    if (r.cause && r.cause !== 'none') parts.push('原因：' + r.cause);
    if (r.tomorrowLoad) parts.push('明日负荷期望：' + (r.tomorrowLoad === 'more' ? '多一点' : r.tomorrowLoad === 'less' ? '少一点' : '保持'));
    (r.perGoalNotes || []).forEach(function (n) {
      if (!goalId || n.goalId === goalId) parts.push('目标备注：' + (n.note || (n.smooth ? '顺利' : '不顺利')));
    });
    return parts.length ? parts.join('；') : '复盘内容为空';
  }

  /* ---------------- 场景一：阶段大纲 outline ---------------- */

  function mockOutline(goal) {
    var tpl = {
      study: ['基础巩固', '专题强化', '实战训练', '冲刺复盘'],
      fitness: ['体能适应', '强度提升', '巩固保持', '冲刺达标'],
      skill: ['入门熟悉', '刻意练习', '综合运用', '输出作品'],
      reading: ['通读理解', '精读笔记', '主题延伸', '总结输出'],
      other: ['摸底准备', '推进执行', '查漏补缺', '收尾验收']
    }[goal.type] || ['摸底准备', '推进执行', '查漏补缺', '收尾验收'];
    var details = {
      study: ['梳理核心概念与方法，建立知识框架', '针对薄弱专题集中训练并整理错题', '完整实战演练，限时完成成套任务', '查漏补缺，复盘沉淀方法与模板'],
      fitness: ['完成体能基线自测，建立运动习惯', '逐步加量，掌握标准动作模式', '提升强度并稳定输出，关注恢复', '对照基线复测，固化训练计划'],
      skill: ['建立练习习惯，熟悉基础材料', '刻意练习薄弱环节并录音复盘', '综合运用，完成完整输出', '输出作品并总结方法'],
      reading: ['通读全书，标记重点章节', '精读重点并整理笔记', '延伸主题阅读与对照', '输出总结与行动清单'],
      other: ['摸底并明确阶段目标', '持续推进核心任务', '查漏补缺，调整方法', '收尾验收并沉淀经验']
    };
    var today = Store.todayStr();
    var span = Math.max(7, Store.daysBetween(today, goal.deadline));
    var n = tpl.length;
    var milestones = tpl.map(function (title, i) {
      var seg = Math.round(span * (i + 1) / n);
      var segStart = i === 0 ? today : Store.addDays(today, Math.round(span * i / n) + 1);
      var dl = details[goal.type] || details.other;
      return {
        id: Store.uid('ms'),
        title: title,
        detail: Array.isArray(dl) ? dl[i % dl.length] : dl,
        startDate: segStart,
        targetDate: Store.addDays(today, Math.min(seg, span)),
        done: false
      };
    });
    return Promise.resolve({
      milestones: milestones,
      advice: '按阶段推进，每周末对照大纲检查一次进度（Mock 演示数据）',
      mock: true
    });
  }

  function genOutline(goal) {
    if (useMock()) return mockOutline(goal);
    var s = Store.loadSettings();
    var prompt = [
      '请为下面的目标制定 3-6 个阶段（里程碑）大纲。',
      goalBrief(goal),
      '',
      '只输出 JSON，格式：',
      '{"milestones":[{"title":"阶段名(4-12字)","detail":"这个阶段的关键节点目标：要达成什么、产出是什么(40字内)","startDate":"YYYY-MM-DD","targetDate":"YYYY-MM-DD"}],"advice":"一句话总体建议"}',
      '要求：startDate 与 targetDate 从今天起递增、各阶段时间首尾衔接不重叠、第一个 startDate 为今天、最后一个 targetDate 不超过截止日期；阶段划分要贴合目标类型与剩余天数。'
    ].join('\n');
    return askJSON(s, 'outline', prompt, 1600).then(function (data) {
      var list = Array.isArray(data.milestones) ? data.milestones : [];
      if (!list.length) throw new Error('AI 未返回有效的阶段大纲');
      var today = Store.todayStr();
      var milestones = list.slice(0, 8).map(function (m, i) {
        var d = dateNorm(m.targetDate, Store.addDays(today, (i + 1) * 7));
        if (d > goal.deadline) d = goal.deadline;
        if (d < today) d = Store.addDays(today, (i + 1) * 3);
        var sd = dateNorm(m.startDate, '');
        return {
          id: Store.uid('ms'),
          title: String(m.title || ('阶段' + (i + 1))).slice(0, 30),
          detail: String(m.detail || ''),
          startDate: sd,
          targetDate: d,
          done: false
        };
      });
      milestones.sort(function (a, b) { return a.targetDate < b.targetDate ? -1 : 1; });
      // 起止时间补全：缺失的按上一阶段结束次日推导
      for (var i = 0; i < milestones.length; i++) {
        if (!milestones[i].startDate) {
          milestones[i].startDate = i === 0 ? today : Store.addDays(milestones[i - 1].targetDate, 1);
        }
        if (milestones[i].startDate > milestones[i].targetDate) milestones[i].startDate = milestones[i].targetDate;
      }
      return { milestones: milestones, advice: String(data.advice || ''), mock: false };
    });
  }

  /* ---------------- 场景二：滚动周计划 plan ---------------- */

  function mockWeekPlan(goal, days) {
    var ms = Rules.currentMilestone(goal) || { title: goal.title };
    var dates = [];
    for (var i = 0; i < days; i++) dates.push(Store.addDays(Store.todayStr(), i));
    var occupied = Agg.occupiedByDate(dates, goal.id);
    var tasks = [];
    var counter = {};
    dates.forEach(function (date) {
      var budget = Store.isWeekend(date) ? goal.weekendMinutes : goal.weekdayMinutes;
      var globalLeft = Math.max(0, Agg.budgetFor(date) - occupied[date]);
      budget = Math.min(budget, globalLeft);
      if (budget < 20) return;
      counter[date] = (counter[date] || 0) + 1;
      var n = Store.isWeekend(date) && budget >= 60 ? 2 : 1;
      for (var k = 0; k < n; k++) {
        var minutes = Math.min(k === 0 ? Math.round(budget * 0.5 / 5) * 5 : Math.round(budget * 0.35 / 5) * 5, budget);
        if (minutes < 15) break;
        tasks.push({
          date: date,
          title: ms.title + '·' + (k === 0 ? '集中推进' : '练习巩固') + '（' + counter[date] + '）',
          desc: '围绕「' + ms.title + '」' + (k === 0 ? '完成一段专注推进并记录产出' : '做巩固练习，查漏补缺') + '（Mock 演示数据）',
          energy: k === 0 ? (Store.isWeekend(date) ? 'high' : 'mid') : 'low',
          estimateMin: minutes
        });
      }
    });
    return Promise.resolve({ tasks: tasks, mock: true });
  }

  function genWeekPlan(goal, opts) {
    opts = opts || {};
    var days = opts.days || 7;
    if (useMock()) return mockWeekPlan(goal, days);
    var s = Store.loadSettings();
    var dates = [];
    for (var i = 0; i < days; i++) dates.push(Store.addDays(Store.todayStr(), i));
    var occupied = Agg.occupiedByDate(dates, goal.id);
    var occText = dates.map(function (d) {
      return d + (Store.isWeekend(d) ? '(周末)' : '') + ' 其他目标已占 ' + occupied[d] + ' 分钟';
    }).join('；');
    var prompt = [
      '请为目标生成从 ' + dates[0] + ' 到 ' + dates[dates.length - 1] + ' 共 ' + days + ' 天的每日任务。',
      goalBrief(goal),
      '全局预算：工作日 ' + s.dailyBudget.weekday + ' 分钟 / 周末 ' + s.dailyBudget.weekend + ' 分钟。',
      '其他目标占用情况：' + occText + '。该目标的任务不得再占用这些已占部分。',
      '近期该目标完成情况：' + recentText(goal.id, 3),
      '最近复盘：' + reviewText(goal.id),
      '',
      '只输出 JSON，格式：',
      '{"tasks":[{"date":"YYYY-MM-DD","title":"任务标题(具体可执行,15字内)","desc":"怎么做/产出什么(30字内)","energy":"high|mid|low","estimateMin":30}]}',
      '要求：',
      '1. 每天安排 1-3 个任务，单日总时长不超过该目标当日剩余预算；无空余时间的天可以不安排。',
      '2. 高精力任务优先放在周末或工作日靠前位置；任务要具体到可直接执行。',
      '3. date 必须在 ' + dates[0] + ' 至 ' + dates[dates.length - 1] + ' 之间；estimateMin 为 15-240 的整数。'
    ].join('\n');
    return askJSON(s, 'plan', prompt, 4000).then(function (data) {
      var list = Array.isArray(data.tasks) ? data.tasks : [];
      if (!list.length) throw new Error('AI 未返回有效任务');
      var tasks = list.map(function (t) {
        return {
          date: dateNorm(t.date, dates[0]),
          title: String(t.title || '未命名任务').slice(0, 40),
          desc: String(t.desc || '').slice(0, 100),
          energy: energyNorm(t.energy),
          estimateMin: Store.clamp(Math.round(+t.estimateMin || 30), 10, 300)
        };
      }).filter(function (t) { return dates.indexOf(t.date) >= 0; });
      if (!tasks.length) throw new Error('AI 返回的任务日期不在有效范围内');
      return { tasks: tasks, mock: false };
    });
  }

  /* ---------------- 场景三：动态调整 adjust ---------------- */

  var OPS_DESC = [
    '- 延后任务：{"op":"postpone","taskId":"任务ID","to":"YYYY-MM-DD","reason":"理由(15字内)"}',
    '- 拆分任务：{"op":"split","taskId":"任务ID","reason":"理由(15字内)"}（拆成两天各一半）',
    '- 删减任务：{"op":"drop","taskId":"任务ID","reason":"理由(15字内)"}（仅明显多余时使用）',
    '- 新增任务：{"op":"add","task":{"goalId":"目标ID","date":"YYYY-MM-DD","title":"标题","desc":"描述","energy":"high|mid|low","estimateMin":30},"reason":"理由(15字内)"}',
    '- 同日排序：{"op":"reorder","taskId":"任务ID","dir":"up|down","reason":"理由(15字内)"}'
  ];

  function futureTasksOf(goals, days) {
    var ids = {};
    goals.forEach(function (g) { ids[g.id] = g; });
    var today = Store.todayStr();
    var out = [];
    Store.getTasks().forEach(function (t) {
      if (!ids[t.goalId]) return;
      if (t.date < today || t.date >= Store.addDays(today, days)) return;
      if (t.status === 'skipped') return;
      out.push(t);
    });
    return out;
  }

  function buildAdjustPrompt(scope, opts) {
    var s = Store.loadSettings();
    var goals = scope === 'goal'
      ? [Store.goalById(opts.goalId)].filter(Boolean)
      : Store.activeGoals();
    var tasks = futureTasksOf(goals, 7);
    var today = Store.todayStr();
    var lines = [];
    lines.push(scope === 'goal'
      ? '请针对以下单个目标的未来 7 天任务提出调整建议。'
      : '请针对全部活跃目标的未来 7 天任务做全局协调，提出调整建议。');
    goals.forEach(function (g) {
      lines.push('【目标】' + g.title + '｜优先级：' + Store.prioOf(g.priority).name + (g.isCore ? '｜核心目标' : '') +
        '｜截止：' + g.deadline);
    });
    lines.push('【未来 7 天任务】');
    if (!tasks.length) lines.push('（无）');
    tasks.forEach(function (t) {
      var g = Store.goalById(t.goalId) || {};
      lines.push('- id:' + t.id + '｜' + t.date + '｜' + (g.title || '?') + '｜' + t.title +
        '｜' + t.estimateMin + '分钟｜' + Store.energyOf(t.energy).name +
        ((t.source === 'rule' || t.locked) ? '｜🔒固定' : ''));
    });
    var es = Agg.energyStats(30, scope === 'goal' ? goals[0] && goals[0].id : '');
    lines.push('【近 30 天精力完成情况】' + es.map(function (e) {
      return e.name + ' ' + e.rate + '%（' + e.total + '个）';
    }).join('；'));
    var st0 = Agg.dayStats(Store.todayStr());
    lines.push('【今日负荷】已排 ' + st0.plannedMin + ' 分钟 / 预算 ' + st0.budget + ' 分钟' + (st0.over ? '（超载 ' + st0.over + ' 分钟）' : ''));
    lines.push('【近 3 天完成情况】' + (scope === 'goal' ? recentText(goals[0] && goals[0].id, 3) : recentText('', 3)));
    lines.push('【最近复盘】' + reviewText(scope === 'goal' ? goals[0] && goals[0].id : ''));
    lines.push('');
    lines.push('允许的操作（只能用这些格式）：');
    lines = lines.concat(OPS_DESC);
    lines.push('约束：');
    lines.push('1. 改动总数不超过 6 条；每条必须带 reason。');
    lines.push('2. 标注 🔒固定 的任务是用户锁定的固定任务（如每日打卡），不要对它们提出任何操作建议。');
    if (scope === 'global') {
      lines.push('3. 目标间冲突时，优先延后低优先级、非核心目标的任务；核心目标任务尽量保留。');
      if (!s.allowCrossGoal) lines.push('4. 不允许跨目标：所有操作只能针对第一个目标。');
    } else {
      lines.push('3. 只调整该目标的任务，不要建议动其他目标。');
    }
    lines.push('4. 任务只能移到 ' + today + ' 至 ' + Store.addDays(today, 6) + ' 之间，且不能超过对应目标截止日期；不要动已完成/部分完成的任务。');
    lines.push('5. 若当前计划合理，changes 返回空数组。');
    lines.push('');
    lines.push('只输出 JSON：{"summary":"一句话总结","changes":[...]}');
    return { prompt: lines.join('\n'), goals: goals, tasks: tasks };
  }

  function mockAdjust(scope, opts) {
    var goals = scope === 'goal' ? [Store.goalById(opts.goalId)].filter(Boolean) : Store.activeGoals();
    var tasks = futureTasksOf(goals, 7);
    var today = Store.todayStr();
    var changes = [];
    var summaryParts = [];

    // 规则 1：某天超载 → 延后低优先级非核心目标的任务
    var byDate = {};
    tasks.forEach(function (t) { (byDate[t.date] = byDate[t.date] || []).push(t); });
    dates_loop:
    for (var i = 0; i < 7; i++) {
      var date = Store.addDays(today, i);
      var st = Agg.dayStats(date);
      if (st.over <= 0) continue;
      var dayTasks = (byDate[date] || []).slice().sort(function (a, b) {
        var ga = Store.goalById(a.goalId) || {}, gb = Store.goalById(b.goalId) || {};
        var core = (ga.isCore ? 1 : 0) - (gb.isCore ? 1 : 0);
        if (core) return core;
        return Store.prioOf(ga.priority).weight - Store.prioOf(gb.priority).weight;
      });
      for (var k = 0; k < dayTasks.length && st.over > 0; k++) {
        var cand = dayTasks[k];
        if (cand.source === 'rule' || cand.locked) continue; // 🔒 锁定任务跳过
        if (changes.some(function (c) { return c.taskId === cand.id; })) continue;
        // 同目标同标题的任务只建议一次，避免文案重复
        if (changes.some(function (c) {
          var t = Store.taskById(c.taskId);
          return t && t.goalId === cand.goalId && t.title === cand.title;
        })) continue;
        if (cand.estimateMin <= st.over && st.over > 15) {
          var to = Store.addDays(date, 1);
          changes.push({ op: 'postpone', taskId: cand.id, to: to, reason: '当日超载，建议延后' });
          st.over -= cand.estimateMin;
          if (changes.length >= 3) break dates_loop;
        }
      }
    }
    if (changes.length) summaryParts.push('检测到超载，建议延后 ' + changes.length + ' 个任务');

    // 规则 2：近 3 天完成率低 → 拆分最大任务
    var rateText = scope === 'goal' ? recentText(goals[0] && goals[0].id, 3) : recentText('', 3);
    var rateMatch = rateText.match(/(\d+)%/g);
    var avg = 0;
    if (rateMatch) {
      rateMatch.forEach(function (x) { avg += parseInt(x, 10); });
      avg = Math.round(avg / rateMatch.length);
    } else avg = 100;
    if (avg < 50 && changes.length < 4) {
      var big = tasks.slice().sort(function (a, b) { return b.estimateMin - a.estimateMin; })
        .find(function (t) {
          return t.source !== 'rule' && !t.locked && t.estimateMin >= 60 &&
            !changes.some(function (c) { return c.taskId === t.id; });
        });
      if (big) {
        changes.push({ op: 'split', taskId: big.id, reason: '近期完成率偏低，拆分减压' });
        summaryParts.push('完成率 ' + avg + '%，建议拆分最大任务');
      }
    }

    // 规则 3：完成率很高且希望加量 → 增加进阶任务
    var r = Store.reviewByDate(Store.addDays(today, -1)) || Store.reviewByDate(today);
    if (avg >= 90 && r && r.tomorrowLoad === 'more' && goals.length && changes.length < 5) {
      var top = goals.slice().sort(function (a, b) {
        return (b.isCore ? 1 : 0) - (a.isCore ? 1 : 0) || Store.prioOf(b.priority).weight - Store.prioOf(a.priority).weight;
      })[0];
      changes.push({
        op: 'add', kind: 'advance',
        task: {
          goalId: top.id, date: Store.addDays(today, 1),
          title: '进阶挑战：' + top.title.slice(0, 10),
          desc: '在完成基础任务后，做一次更难的进阶练习',
          energy: 'high', estimateMin: 30
        },
        reason: '近期推进顺利且希望加量'
      });
      summaryParts.push('推进顺利，为「' + top.title + '」增加进阶任务');
    }

    if (!changes.length) summaryParts.push('当前计划负荷合理，无需调整');
    return Promise.resolve({
      summary: summaryParts.join('；') + '（Mock 演示）',
      changes: changes,
      context: adjustContext(scope, opts),
      mock: true
    });
  }

  /** 组装触发上下文（预览页顶部展示：为什么 AI 给出这些建议） */
  function adjustContext(scope, opts) {
    var today = Store.todayStr();
    var st = Agg.dayStats(today);
    var parts = [];
    parts.push('今日完成率 ' + Math.round(st.rate * 100) + '%');
    if (st.over > 0) parts.push('今日超载 ' + st.over + ' 分钟');
    var r = Store.reviewByDate(Store.addDays(today, -1)) || Store.reviewByDate(today);
    if (r && r.blocked) parts.push('复盘卡点：' + r.blocked.slice(0, 30));
    var missed = Store.tasksWhere(function (t) {
      return t.date === today && t.status === 'missed' && (!opts.goalId || t.goalId === opts.goalId);
    }).map(function (t) { return t.title; }).slice(0, 2);
    if (missed.length) parts.push('未完成：' + missed.join('、'));
    return parts.join(' · ');
  }

  function genAdjust(scope, opts) {
    opts = opts || {};
    if (useMock()) return mockAdjust(scope, opts);
    var s = Store.loadSettings();
    var built = buildAdjustPrompt(scope, opts);
    return askJSON(s, 'adjust', built.prompt, 3000).then(function (data) {
      var list = Array.isArray(data.changes) ? data.changes : [];
      return {
        summary: String(data.summary || ''),
        changes: list.slice(0, 8),
        goals: built.goals,
        context: adjustContext(scope, opts),
        mock: false
      };
    });
  }

  /* ---------------- 场景四：复盘反馈 feedback ---------------- */

  function mockFeedback(p) {
    var parts = [];
    if (p.smoothTasks.length) {
      parts.push('很棒，「' + p.smoothTasks[0] + '」等 ' + p.smoothTasks.length + ' 项任务顺利推进，保持这个节奏');
    } else {
      parts.push('今天完成了打卡，坚持本身就是最难得的一步');
    }
    if (p.blocked) {
      parts.push('关于「' + p.blocked.slice(0, 14) + '」的卡点，明天会把它拆成更小的一步，并安排在精力最好的时段');
    }
    if (p.tomorrowLoad === 'less') parts.push('明天的任务量会适当减轻，先恢复状态');
    else if (p.tomorrowLoad === 'more') parts.push('明天会为你准备一点进阶挑战');
    return parts.slice(0, 3).join('。') + '。（Mock 演示）';
  }

  /** 复盘保存后的即时 AI 反馈（2-3 句，短输出） */
  function genReviewFeedback(payload) {
    if (useMock()) {
      return Promise.resolve({ reply: mockFeedback(payload), mock: true });
    }
    var s = Store.loadSettings();
    var prompt = [
      '用户刚完成今日复盘。请生成 2-3 句温暖、具体、口语化的中文反馈：先肯定成果，再针对卡点给一句明天可执行的小建议，最后呼应用户对明日期望。不要说教，不要用列表。',
      '今日完成情况：' + payload.statsText,
      '顺利推进的任务：' + (payload.smoothTasks.join('、') || '无'),
      '卡住的任务：' + (payload.blocked || '无') + (payload.causeName ? '（原因：' + payload.causeName + '）' : ''),
      '明天的任务量期望：' + payload.loadName,
      '进行中的目标：' + payload.goalsText,
      '',
      '只输出 JSON：{"reply":"2-3 句反馈"}'
    ].join('\n');
    return askJSON(s, 'feedback', prompt, 600).then(function (data) {
      return { reply: String(data.reply || '').slice(0, 300), mock: false };
    });
  }

  /* ---------------- 连通性测试（设置页） ---------------- */

  function testCall() {
    var s = Store.loadSettings();
    if (!s.api.key) return Promise.reject(new Error('尚未填写 API Key'));
    var t0 = Date.now();
    return chat(s, 'test', [{ role: 'user', content: '你好' }], 16).then(function (res) {
      return { model: res.model, ms: Date.now() - t0 };
    });
  }

  global.AI = {
    useMock: useMock,
    humanizeError: humanizeError,
    genReviewFeedback: genReviewFeedback,
    genOutline: genOutline,
    genWeekPlan: genWeekPlan,
    genAdjust: genAdjust,
    testCall: testCall
  };
})(window);
