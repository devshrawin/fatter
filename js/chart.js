// chart.js — stats computation and the Chart.js line chart. Uses a linear
// x-axis over epoch-ms (not the Chart.js "time" scale) so entries at
// irregular dates space out proportionally without pulling in a date-adapter
// dependency.

(function (global) {
  'use strict';

  // entries: sorted ascending by date, each { date, weightKg }.
  // Returns display-unit stats, or a zeroed/guarded shape when there's
  // not enough data — never NaN/Infinity reaching the UI.
  function computeStats(entries, unit) {
    const { toDisplayWeight } = FatterDB;
    if (!entries.length) {
      return { count: 0, start: null, current: null, totalChange: null, avgWeeklyChange: null };
    }
    const start = toDisplayWeight(entries[0].weightKg, unit);
    const current = toDisplayWeight(entries[entries.length - 1].weightKg, unit);
    const totalChange = current - start;

    let avgWeeklyChange = 0;
    if (entries.length > 1) {
      const firstDate = new Date(entries[0].date + 'T00:00:00');
      const lastDate = new Date(entries[entries.length - 1].date + 'T00:00:00');
      const days = Math.max(1, (lastDate - firstDate) / 86400000);
      avgWeeklyChange = totalChange / (days / 7);
    }

    return {
      count: entries.length,
      start,
      current,
      totalChange,
      avgWeeklyChange,
    };
  }

  function deltaDirection(delta, epsilon = 0.05) {
    if (delta > epsilon) return 'up';
    if (delta < -epsilon) return 'down';
    return 'flat';
  }

  let chartInstance = null;

  function readCssColor(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function renderChart(canvas, entries, unit) {
    const { toDisplayWeight } = FatterDB;

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    if (!canvas || !entries.length) return null;

    const accent = readCssColor('--accent') || '#7ce88c';
    const textSecondary = readCssColor('--text-secondary') || '#a8b39a';
    const border = readCssColor('--border') || '#2a3020';

    const points = entries.map((e) => ({
      x: new Date(e.date + 'T00:00:00').getTime(),
      y: Math.round(toDisplayWeight(e.weightKg, unit) * 10) / 10,
    }));

    // A linear scale has no natural tick range from a single x value (or a
    // single repeated date) — Chart.js falls back to an arbitrary auto-range
    // and produces nonsense date labels. Pin a small explicit window around
    // the lone point(s) instead.
    const xs = points.map((p) => p.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const DAY = 86400000;
    const xRange = minX === maxX ? { min: minX - 3 * DAY, max: maxX + 3 * DAY } : {};

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 220);
    gradient.addColorStop(0, hexToRgba(accent, 0.28));
    gradient.addColorStop(1, hexToRgba(accent, 0.02));

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          data: points,
          borderColor: accent,
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: points.length > 40 ? 0 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: accent,
          pointBorderColor: accent,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400 },
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            grid: { display: false },
            ...xRange,
            ticks: {
              color: textSecondary,
              maxRotation: 0,
              autoSkip: true,
              callback: (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            },
          },
          y: {
            grid: { color: border },
            ticks: { color: textSecondary },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => new Date(items[0].parsed.x).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
              label: (item) => `${item.parsed.y} ${unit}`,
            },
          },
        },
      },
    });
    return chartInstance;
  }

  // Normalizes ANY valid CSS color (hex, oklch(), named, ...) to rgba() at the
  // given alpha, via a canvas fillStyle round-trip — canvas 2D is spec-required
  // to accept all CSS Color 4 syntaxes and always reads fillStyle back as a
  // plain #hex/rgb()/rgba() string, regardless of how the color was authored.
  let normalizeCtx = null;
  function hexToRgba(cssColor, alpha) {
    if (!normalizeCtx) normalizeCtx = document.createElement('canvas').getContext('2d');
    normalizeCtx.fillStyle = '#000'; // reset so an invalid input below is detectable
    normalizeCtx.fillStyle = cssColor;
    const normalized = normalizeCtx.fillStyle; // '#rrggbb' or 'rgba(...)'
    let r, g, b;
    if (normalized.startsWith('#')) {
      const bigint = parseInt(normalized.slice(1), 16);
      r = (bigint >> 16) & 255; g = (bigint >> 8) & 255; b = bigint & 255;
    } else {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(normalized);
      [r, g, b] = m ? [+m[1], +m[2], +m[3]] : [124, 232, 140];
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  global.FatterChart = { computeStats, deltaDirection, renderChart };
})(window);
