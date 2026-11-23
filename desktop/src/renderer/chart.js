(function (global) {
  'use strict';

  function cssColor(name, fallback) {
    const value = global.getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
  }

  function niceMax(value) {
    if (!Number.isFinite(value) || value <= 0) return 4;
    const target = value * 1.08;
    const exponent = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
    const scaled = target / exponent;
    const steps = [1, 2, 3, 4, 5, 6, 8, 10];
    const chosen = steps.find((step) => step >= scaled) || 10;
    return Math.max(1, chosen * exponent);
  }

  /** 刻度行数取 max 的整数因子，保证纵轴标签都是整数。 */
  function rowsFor(max) {
    for (const rows of [4, 3, 2]) {
      if (max % rows === 0) return rows;
    }
    return 1;
  }

  function shortDate(iso) {
    const parts = String(iso).split('-');
    return parts.length === 3 ? `${parts[1]}-${parts[2]}` : iso;
  }

  function fullDate(iso) {
    const parts = String(iso).split('-');
    return parts.length === 3 ? `${parts[0]} 年 ${Number(parts[1])} 月 ${Number(parts[2])} 日` : iso;
  }

  class TrendChart {
    constructor(canvas, tipElement) {
      this.canvas = canvas;
      this.tip = tipElement;
      this.ctx = canvas.getContext('2d');
      this.points = [];
      this.hoverIndex = -1;
      this.width = 0;
      this.height = 0;
      this.padding = { top: 14, right: 12, bottom: 24, left: 34 };

      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this._onResize = this._onResize.bind(this);

      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mouseleave', this._onLeave);

      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(this._onResize);
        this.observer.observe(canvas.parentElement || canvas);
      } else {
        global.addEventListener('resize', this._onResize);
      }
      this._onResize();
    }

    setData(points) {
      this.points = Array.isArray(points) ? points : [];
      this.hoverIndex = -1;
      if (this.tip) this.tip.hidden = true;
      this.draw();
    }

    refreshTheme() {
      this._onResize();
    }

    _colors() {
      return {
        axis: cssColor('--chart-grid', 'rgba(255, 255, 255, 0.06)'),
        label: cssColor('--chart-label', '#64707f'),
        line: cssColor('--chart-line', '#34d399'),
        areaTop: cssColor('--chart-area-top', 'rgba(52, 211, 153, 0.32)'),
        areaMid: cssColor('--chart-area-mid', 'rgba(52, 211, 153, 0.10)'),
        areaEnd: cssColor('--chart-area-end', 'rgba(52, 211, 153, 0)'),
        point: cssColor('--bg', '#080b12'),
      };
    }

    _onResize() {
      const parent = this.canvas.parentElement || this.canvas;
      const rect = parent.getBoundingClientRect();
      const width = Math.max(240, Math.round(rect.width));
      const height = Math.max(130, Math.round(rect.height));
      const dpr = global.devicePixelRatio || 1;
      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    _plotBox() {
      const { top, right, bottom, left } = this.padding;
      return {
        left,
        top,
        right: this.width - right,
        bottom: this.height - bottom,
        width: Math.max(1, this.width - left - right),
        height: Math.max(1, this.height - top - bottom),
      };
    }

    _positions() {
      const box = this._plotBox();
      const count = this.points.length;
      const max = niceMax(Math.max(0, ...this.points.map((point) => Number(point.count) || 0)));
      const stepX = count > 1 ? box.width / (count - 1) : 0;
      const coords = this.points.map((point, index) => {
        const value = Number(point.count) || 0;
        return {
          x: box.left + stepX * index,
          y: box.bottom - (value / max) * box.height,
          value,
          date: point.date,
        };
      });
      return { box, max, stepX, coords };
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx || !this.width || !this.height) return;
      ctx.clearRect(0, 0, this.width, this.height);
      if (!this.points.length) {
        this._drawEmpty();
        return;
      }

      const { box, max, coords } = this._positions();
      const colors = this._colors();

      // 网格与刻度
      ctx.font = '12px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      const rows = rowsFor(max);
      for (let row = 0; row <= rows; row += 1) {
        const ratio = row / rows;
        const y = box.bottom - box.height * ratio;
        ctx.strokeStyle = colors.axis;
        ctx.setLineDash(row === 0 ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(box.left, y);
        ctx.lineTo(box.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = colors.label;
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.round(max * ratio)), box.left - 8, y);
      }

      // 日期标签
      const count = coords.length;
      const stride = count <= 8 ? 1 : Math.ceil(count / 6);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = colors.label;
      coords.forEach((point, index) => {
        const isLast = index === count - 1;
        if (index % stride !== 0 && !isLast) return;
        if (isLast && index % stride !== 0 && index - (Math.floor(index / stride) * stride) < stride * 0.5) {
          // 末尾标签紧贴前一个刻度时不再重复绘制
          const previous = index - (index % stride);
          if (previous >= 0 && count - 1 - previous < stride * 0.6) return;
        }
        const x = Math.min(box.right - 4, Math.max(box.left + 4, point.x));
        ctx.fillText(shortDate(point.date), x, box.bottom + 8);
      });

      // 面积 + 曲线
      const gradient = ctx.createLinearGradient(0, box.top, 0, box.bottom);
      gradient.addColorStop(0, colors.areaTop);
      gradient.addColorStop(0.55, colors.areaMid);
      gradient.addColorStop(1, colors.areaEnd);

      ctx.beginPath();
      this._traceCurve(ctx, coords);
      ctx.lineTo(coords[coords.length - 1].x, box.bottom);
      ctx.lineTo(coords[0].x, box.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      this._traceCurve(ctx, coords);
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.line;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = colors.line;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 数据点（7 天视图全部显示，30 天视图只显示峰值与悬浮点）
      const showDots = coords.length <= 10;
      coords.forEach((point, index) => {
        if (!showDots && index !== this.hoverIndex) return;
        ctx.beginPath();
        ctx.arc(point.x, point.y, index === this.hoverIndex ? 4.5 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = index === this.hoverIndex ? colors.line : colors.point;
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1.6;
        ctx.fill();
        ctx.stroke();
      });

      if (this.hoverIndex >= 0 && this.hoverIndex < coords.length) {
        const point = coords[this.hoverIndex];
        ctx.strokeStyle = colors.line;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(point.x, box.top);
        ctx.lineTo(point.x, box.bottom);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }

    _traceCurve(ctx, coords) {
      ctx.moveTo(coords[0].x, coords[0].y);
      for (let index = 0; index < coords.length - 1; index += 1) {
        const current = coords[index];
        const next = coords[index + 1];
        const midX = (current.x + next.x) / 2;
        ctx.bezierCurveTo(midX, current.y, midX, next.y, next.x, next.y);
      }
    }

    _drawEmpty() {
      const ctx = this.ctx;
      ctx.fillStyle = this._colors().label;
      ctx.font = '13px "Microsoft YaHei UI", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无调用记录', this.width / 2, this.height / 2);
    }

    _onMove(event) {
      if (!this.points.length) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const { box, stepX, coords } = this._positions();
      if (stepX <= 0) return;
      const index = Math.max(0, Math.min(coords.length - 1, Math.round((x - box.left) / stepX)));
      if (index !== this.hoverIndex) {
        this.hoverIndex = index;
        this.draw();
      }
      this._showTip(coords[index]);
    }

    _showTip(point) {
      if (!this.tip) return;
      this.tip.innerHTML = `${fullDate(point.date)}<br /><b>${point.value}</b> 次调用`;
      this.tip.hidden = false;
      const tipWidth = this.tip.offsetWidth || 120;
      const left = Math.min(this.width - tipWidth / 2 - 6, Math.max(tipWidth / 2 + 6, point.x));
      const top = Math.max(this.tip.offsetHeight + 6, point.y - 10);
      this.tip.style.left = `${left}px`;
      this.tip.style.top = `${top}px`;
    }

    _onLeave() {
      if (this.hoverIndex === -1) return;
      this.hoverIndex = -1;
      if (this.tip) this.tip.hidden = true;
      this.draw();
    }
  }

  global.TrendChart = TrendChart;
})(window);
