/* ==========================================================
 * chart.js —— 原生 Canvas 折线图（零依赖，沿用 project1 版本）
 * drawLineChart(canvas, { labels, values, color, unit, emptyText })
 * 支持 DPR 高清、空数据占位、触摸/悬停提示
 * ========================================================== */
(function (global) {
  'use strict';

  // 绘制参数挂在各 canvas 元素上（canvas.__chartState），多图表互不干扰

  function niceMax(v) {
    if (v <= 0) return 100;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  function fmtNum(v) {
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v * 10) / 10);
  }

  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(rect.width, 50);
    var h = Math.max(rect.height, 50);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /** 清空画布（含容器中遗留 tooltip） */
  function clear(canvas) {
    var box = canvas.parentElement;
    var tip = box && box.querySelector('.chart-tip');
    if (tip) tip.style.display = 'none';
    var s = setupCanvas(canvas);
    s.ctx.clearRect(0, 0, s.w, s.h);
  }

  /**
   * 绘制折线图
   * opts: { labels: string[], values: number[], color: '#4f6ef7', unit: '%', emptyText: '...' }
   */
  function drawLineChart(canvas, opts) {
    var s = setupCanvas(canvas);
    var ctx = s.ctx, W = s.w, H = s.h;
    var labels = opts.labels || [];
    var values = opts.values || [];
    var color = opts.color || '#4f6ef7';
    var unit = opts.unit || '';
    var n = values.length;

    var pad = { top: 16, right: 14, bottom: 24, left: 38 };
    var iw = W - pad.left - pad.right;
    var ih = H - pad.top - pad.bottom;

    var maxV = niceMax(Math.max.apply(null, values.concat([0])));
    var hasData = n > 0 && values.some(function (v) { return v > 0; });

    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';

    // 网格 + Y 轴刻度
    ctx.strokeStyle = '#edf0f6';
    ctx.fillStyle = '#9ca3af';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = pad.top + ih - (ih * g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(W - pad.right, gy);
      ctx.stroke();
      var val = maxV * g / 4;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(val), pad.left - 6, gy);
    }

    if (!hasData) {
      ctx.fillStyle = '#b7c0cf';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(opts.emptyText || '暂无数据', W / 2, H / 2);
      canvas.__chartState = null;
      return;
    }

    var stepX = n > 1 ? iw / (n - 1) : 0;
    function xAt(i) { return n > 1 ? pad.left + i * stepX : pad.left + iw / 2; }
    function yAt(v) { return pad.top + ih - (v / maxV) * ih; }

    // 渐变填充
    var grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ih);
    grad.addColorStop(0, hexA(color, 0.28));
    grad.addColorStop(1, hexA(color, 0.02));

    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(values[0]));
    for (var i = 1; i < n; i++) {
      var xc = (xAt(i - 1) + xAt(i)) / 2;
      var y1 = yAt(values[i - 1]), y2 = yAt(values[i]);
      ctx.bezierCurveTo(xc, y1, xc, y2, xAt(i), y2);
    }
    // 填充区
    var fillPath = new Path2D();
    fillPath.moveTo(xAt(0), pad.top + ih);
    for (var f = 0; f < n; f++) fillPath.lineTo(xAt(f), yAt(values[f]));
    fillPath.lineTo(xAt(n - 1), pad.top + ih);
    fillPath.closePath();
    ctx.fillStyle = grad;
    ctx.fill(fillPath);

    // 折线
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(values[0]));
    for (var j = 1; j < n; j++) {
      var mx = (xAt(j - 1) + xAt(j)) / 2;
      var my1 = yAt(values[j - 1]), my2 = yAt(values[j]);
      ctx.bezierCurveTo(mx, my1, mx, my2, xAt(j), my2);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 数据点
    for (var p = 0; p < n; p++) {
      ctx.beginPath();
      ctx.arc(xAt(p), yAt(values[p]), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    // X 轴标签：按间隔取样，末尾标签若与前一个太近则替换前一个，避免重叠
    var every = Math.max(1, Math.ceil(n / 7));
    var idxs = [];
    for (var t2 = 0; t2 < n; t2++) if (t2 % every === 0) idxs.push(t2);
    if (idxs.indexOf(n - 1) < 0) {
      if (idxs.length && (n - 1) - idxs[idxs.length - 1] < every) idxs.pop();
      idxs.push(n - 1);
    }
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    idxs.forEach(function (t) { ctx.fillText(labels[t], xAt(t), pad.top + ih + 8); });

    canvas.__chartState = { canvas: canvas, opts: opts, pad: pad, n: n, stepX: stepX, maxV: maxV, iw: iw, ih: ih };
  }

  /** 交互提示：pointermove / touch 时高亮最近点；轻点（位移<8px）触发 opts.onPointClick(i) */
  function bindTooltip(canvas) {
    var box = canvas.parentElement;
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    box.appendChild(tip);
    var downPos = null;

    function idxAt(ev, st) {
      var rect = canvas.getBoundingClientRect();
      var cx = (ev.clientX - rect.left);
      var i = st.n > 1
        ? Math.round((cx - st.pad.left) / st.stepX)
        : 0;
      return Math.max(0, Math.min(st.n - 1, i));
    }

    function onMove(ev) {
      var st = canvas.__chartState;
      if (!st) return;
      var i = idxAt(ev, st);
      var v = st.opts.values[i];
      var x = st.pad.left + (st.n > 1 ? i * st.stepX : st.iw / 2);
      var y = st.pad.top + st.ih - (v / st.maxV) * st.ih;
      tip.style.display = 'block';
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
      tip.textContent = st.opts.tipFn
        ? st.opts.tipFn(i)
        : (st.opts.labels[i] + ' · ' + v + (st.opts.unit || ''));
    }
    function onDown(ev) {
      downPos = { x: ev.clientX, y: ev.clientY };
      onMove(ev);
    }
    function onUp(ev) {
      tip.style.display = 'none';
      var st = canvas.__chartState;
      if (downPos && st) {
        var dx = Math.abs(ev.clientX - downPos.x);
        var dy = Math.abs(ev.clientY - downPos.y);
        if (dx < 8 && dy < 8 && typeof st.opts.onPointClick === 'function') {
          st.opts.onPointClick(idxAt(ev, st));
        }
      }
      downPos = null;
    }
    function onLeave() { tip.style.display = 'none'; }

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onUp);
  }

  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  global.Chart = {
    drawLineChart: drawLineChart,
    bindTooltip: bindTooltip,
    clear: clear
  };
})(window);
