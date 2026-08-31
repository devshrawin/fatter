// chart.js: stats computation and the Chart.js line chart. Uses a linear
// x-axis over epoch-ms (not the Chart.js "time" scale) so entries at
// irregular dates space out proportionally without pulling in a date-adapter
// dependency.

(function (global) {
  'use strict';

  // entries: sorted ascending by date, each { date, weightKg }.
  // Returns display-unit stats, or a zeroed/guarded shape when there's
  // not enough data. NaN/Infinity never reaches the UI.
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

  // Consecutive calendar days (up to and including today) with at least one
  // entry. Doesn't break until a full day is missed. If today has no entry
  // yet, the streak still counts through yesterday rather than showing 0
  // the moment the clock ticks past midnight before you've logged.
  function computeStreak(entries) {
    if (!entries.length) return 0;
    const days = new Set(entries.map((e) => e.date));
    const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cursor = new Date();
    if (!days.has(toISO(cursor))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (days.has(toISO(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  // entries: ascending by date. days: number of trailing days to keep, or
  // 'all'. Used to scope the CHART to a recent window; the stat cards stay
  // all-time regardless, same convention most progress-chart apps use.
  function filterEntriesByRange(entries, days) {
    if (days === 'all') return entries;
    const cutoff = Date.now() - days * 86400000;
    return entries.filter((e) => new Date(e.date + 'T00:00:00').getTime() >= cutoff);
  }

  // goalKg: canonical kg or null. stats: the object computeStats returned
  // (must have .current and .avgWeeklyChange in the same display unit).
  // Returns null when there's no goal or no data yet; otherwise a
  // direction-neutral progress summary: "remaining" is always positive,
  // and an ETA is only included when the recent trend is actually headed
  // toward the goal (a flat or reversing trend gets no ETA, not a wrong one).
  function computeGoalProgress(stats, goalKg, unit) {
    if (goalKg == null || stats.current == null) return null;
    const goalDisplay = FatterDB.toDisplayWeight(goalKg, unit);
    const diff = goalDisplay - stats.current; // signed: >0 means current is below goal
    const remaining = Math.round(Math.abs(diff) * 10) / 10;

    // Direction (losing vs gaining toward the goal) is inferred from where
    // the goal sits relative to the starting weight. Without this, someone
    // who overshoots (e.g. keeps losing past a weight-loss goal) would see
    // "X kg to go" grow forever instead of "Reached", since diff crosses
    // zero and its magnitude starts climbing again on the other side.
    const losingTowardGoal = goalDisplay <= stats.start;
    const overshot = losingTowardGoal ? diff > 0 : diff < 0;
    if (remaining < 0.1 || overshot) return { reached: true, goalDisplay };

    const epsilon = 0.02;
    const headingTowardGoal = (diff > 0 && stats.avgWeeklyChange > epsilon) || (diff < 0 && stats.avgWeeklyChange < -epsilon);
    let etaDate = null;
    if (headingTowardGoal) {
      const weeks = Math.abs(diff) / Math.abs(stats.avgWeeklyChange);
      etaDate = new Date(Date.now() + weeks * 7 * 86400000);
    }
    return { reached: false, remaining, goalDisplay, etaDate };
  }

  // Adult WHO bands. BMI is a crude population-level measure. It doesn't
  // account for muscle mass, frame, age, or sex, so this is shown as
  // informational context, never as a target to chase.
  const BMI_BANDS = [
    { max: 18.5, label: 'Underweight' },
    { max: 25, label: 'Normal' },
    { max: 30, label: 'Overweight' },
    { max: Infinity, label: 'Obese' },
  ];

  function computeBMI(weightKg, heightCm) {
    if (!heightCm) return null;
    const heightM = heightCm / 100;
    return weightKg / (heightM * heightM);
  }

  function bmiCategory(bmi) {
    return BMI_BANDS.find((b) => bmi < b.max).label;
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

  // opts.metric: 'weight' (default) | 'bmi'. opts.heightCm required for 'bmi'.
  //
  // Updates the existing Chart instance in place (chart.update('none')) when
  // re-rendering onto the SAME canvas (e.g. the Weight/BMI and date-range
  // toggles both call this repeatedly on one long-lived canvas). destroy()+
  // new Chart() on every toggle tap tears down and rebuilds the canvas
  // context and restarts the entrance animation each time, which visibly
  // flickers on quick successive taps. A genuinely new canvas (a full
  // dashboard re-render after save/edit/delete) still gets a fresh instance.
  function renderChart(canvas, entries, unit, opts = {}) {
    const { toDisplayWeight } = FatterDB;
    const metric = opts.metric === 'bmi' ? 'bmi' : 'weight';

    if (chartInstance && chartInstance.canvas !== canvas) {
      chartInstance.destroy();
      chartInstance = null;
    }
    if (!canvas || !entries.length) {
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return null;
    }
    if (metric === 'bmi' && !opts.heightCm) {
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return null;
    }

    const accent = readCssColor('--accent') || '#ff8900';
    const textSecondary = readCssColor('--text-secondary') || '#a8a596';
    const border = readCssColor('--border') || '#2e3126';

    const raw = entries.map((e) => ({
      x: new Date(e.date + 'T00:00:00').getTime(),
      y: metric === 'bmi'
        ? Math.round(computeBMI(e.weightKg, opts.heightCm) * 10) / 10
        : Math.round(toDisplayWeight(e.weightKg, unit) * 10) / 10,
    }));

    // Break the line across long gaps instead of drawing straight through
    // them. Joining two entries months apart draws a smooth descent over a
    // period with no measurements at all, which reads as steady progress that
    // was never recorded. A null between them leaves the gap visibly empty,
    // which is the truth. Threshold is deliberately generous so ordinary
    // week-to-week logging stays connected.
    const GAP_MS = (opts.gapDays || 21) * 86400000;
    const points = [];
    raw.forEach((p, i) => {
      if (i && p.x - raw[i - 1].x > GAP_MS) points.push({ x: raw[i - 1].x + 1, y: null });
      points.push(p);
    });

    // A linear scale has no natural tick range from a single x value (or a
    // single repeated date). Chart.js falls back to an arbitrary auto-range
    // and produces nonsense date labels. Pin a small explicit window around
    // the lone point(s) instead.
    const xs = raw.map((p) => p.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const DAY = 86400000;
    const xRange = minX === maxX ? { min: minX - 3 * DAY, max: maxX + 3 * DAY } : { min: undefined, max: undefined };

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 220);
    gradient.addColorStop(0, hexToRgba(accent, 0.28));
    gradient.addColorStop(1, hexToRgba(accent, 0.02));

    const tooltipLabel = (item) => metric === 'bmi' ? `BMI ${item.parsed.y} · ${bmiCategory(item.parsed.y)}` : `${item.parsed.y} ${unit}`;

    // Points stay visible however long the history gets. Hiding them past an
    // arbitrary count removes the only cue that these are discrete weigh-ins
    // rather than a continuous measurement, so shrink them instead.
    const dotSize = raw.length > 120 ? 1.5 : raw.length > 40 ? 2 : 3;

    // A goal line is worth far more on the chart than in a stat card: it turns
    // the trend into a distance. Drawn as a flat two-point dataset rather than
    // pulling in the annotation plugin for one dashed line.
    const goalY = (metric === 'weight' && opts.goalKg != null)
      ? Math.round(toDisplayWeight(opts.goalKg, unit) * 10) / 10 : null;
    const goalData = goalY == null ? [] : [{ x: minX, y: goalY }, { x: maxX, y: goalY }];
    const goalColor = readCssColor('--text-tertiary') || '#7d7a6d';

    if (chartInstance) {
      const ds = chartInstance.data.datasets[0];
      ds.data = points;
      ds.borderColor = accent;
      ds.backgroundColor = gradient;
      ds.pointRadius = dotSize;
      ds.pointBackgroundColor = accent;
      ds.pointBorderColor = accent;
      const gd = chartInstance.data.datasets[1];
      gd.data = goalData;
      gd.borderColor = goalColor;
      chartInstance.options.scales.x.min = xRange.min;
      chartInstance.options.scales.x.max = xRange.max;
      chartInstance.options.plugins.tooltip.callbacks.label = (item) => item.datasetIndex === 1 ? null : tooltipLabel(item);
      // Re-measure before drawing. The canvas is frequently laid out after
      // the chart is constructed (a route render, a rotation, an install
      // opening at a different size), and without this the whole series is
      // squeezed into whatever width the canvas had at construction time:
      // measured at 200px of an available 842px on a real 73-entry history.
      chartInstance.resize();
      chartInstance.update('none'); // 'none' = no animation, so rapid toggle taps switch instantly instead of re-animating in
      return chartInstance;
    }

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          data: points,
          borderColor: accent,
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: dotSize,
          pointHoverRadius: 5,
          pointBackgroundColor: accent,
          pointBorderColor: accent,
          borderWidth: 2,
          spanGaps: false,   // honour the nulls inserted for long gaps
        }, {
          // goal line
          data: goalData,
          borderColor: goalColor,
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          tension: 0,
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
              // the flat goal series has no per-point meaning in the tooltip
              label: (item) => item.datasetIndex === 1 ? null : tooltipLabel(item),
            },
          },
        },
      },
    });
    return chartInstance;
  }

  // Normalizes ANY valid CSS color (hex, oklch(), named, ...) to rgba() at the
  // given alpha by painting one pixel and reading it back.
  //
  // This used to read ctx.fillStyle back as a string on the assumption that
  // canvas always returns a plain #hex/rgb() form. That is no longer true:
  // current Chrome round-trips "oklch(76% 0.19 55)" unchanged, so the rgb()
  // regex never matched and every gradient silently fell back to a
  // hardcoded colour. Reading the painted pixel cannot drift that way,
  // because the browser has to rasterise it to RGBA whatever the input
  // syntax.
  let normalizeCtx = null;
  function hexToRgba(cssColor, alpha) {
    if (!normalizeCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      normalizeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    normalizeCtx.clearRect(0, 0, 1, 1);
    normalizeCtx.fillStyle = '#000';
    normalizeCtx.fillStyle = cssColor;   // ignored if the syntax is unsupported
    normalizeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = normalizeCtx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  global.FatterChart = { computeStats, computeGoalProgress, computeBMI, bmiCategory, computeStreak, filterEntriesByRange, deltaDirection, renderChart };
})(window);
