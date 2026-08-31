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
  // ---------------- Calendar-aware ticks for the linear (epoch-ms) x axis ----------------
  //
  // A linear scale places ticks at even NUMERIC intervals from the data
  // minimum, which on timestamps lands them on meaningless dates: a 21-month
  // history produced "Mar 9 / Jul 3 / Oct 27 / Feb 20", four arbitrary days
  // no reader can anchor to, with no year anywhere despite the range spanning
  // three of them. These helpers snap ticks to real calendar boundaries
  // (day / Monday / month-aligned-to-step / January) and label them with the
  // least text that still disambiguates.
  //
  // This is the reason for NOT using Chart.js's own 'time' scale, which does
  // all of the above: it requires a separate date-adapter library, and the
  // whole app is dependency-frugal by design.

  const DAY_MS = 86400000;

  function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }

  function pickDateStep(spanDays, target) {
    // Month steps are constrained to divisors of 12 so the ticks land on
    // recognisable boundaries (quarters, halves) rather than every 5 months.
    if (spanDays <= 21) return { unit: 'day', step: Math.max(1, Math.ceil(spanDays / target)) };
    if (spanDays <= 120) return { unit: 'week', step: Math.max(1, Math.ceil(spanDays / 7 / target)) };
    if (spanDays <= 1100) {
      const rawStep = Math.max(1, Math.ceil(spanDays / 30.44 / target));
      const step = [1, 2, 3, 6, 12].find((s) => s >= rawStep) || 12;
      return { unit: 'month', step };
    }
    return { unit: 'year', step: Math.max(1, Math.ceil(spanDays / 365 / target)) };
  }

  function buildDateTicks(minX, maxX, target) {
    const spanDays = (maxX - minX) / DAY_MS;
    const { unit, step } = pickDateStep(spanDays, target);
    const ticks = [];
    const d = startOfDay(minX);

    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    if (unit === 'month' || unit === 'year') d.setDate(1);
    if (unit === 'month') {
      // Align to January so a step of 3 gives Jan/Apr/Jul/Oct, not Feb/May/...
      d.setMonth(Math.floor(d.getMonth() / step) * step);
    }
    if (unit === 'year') d.setMonth(0);

    const advance = () => {
      if (unit === 'day') d.setDate(d.getDate() + step);
      else if (unit === 'week') d.setDate(d.getDate() + step * 7);
      else if (unit === 'month') d.setMonth(d.getMonth() + step);
      else d.setFullYear(d.getFullYear() + step);
    };

    // Guard the loop independently of the date maths so a bad step can never
    // hang the render.
    let guard = 0;
    while (d.getTime() <= maxX && guard++ < 500) {
      if (d.getTime() >= minX) ticks.push(d.getTime());
      advance();
    }
    return { ticks, unit };
  }

  // Labels carry the year only where it actually changes meaning: on the
  // first tick, and on any tick that opens a new year. Repeating "2025" on
  // every label is noise on a phone-width axis.
  function makeTickFormatter(unit, ticks) {
    const years = new Set(ticks.map((t) => new Date(t).getFullYear()));
    const multiYear = years.size > 1;
    return (value, index) => {
      const d = new Date(value);
      const yr = `'${String(d.getFullYear()).slice(2)}`;
      if (unit === 'year') return String(d.getFullYear());
      if (unit === 'month') {
        const m = d.toLocaleDateString(undefined, { month: 'short' });
        const opensYear = index === 0 || d.getMonth() === 0;
        return multiYear && opensYear ? `${m} ${yr}` : m;
      }
      const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return multiYear && index === 0 ? `${md} ${yr}` : md;
    };
  }

  // Trailing average over a real time window (not a fixed number of points),
  // so a week with four weigh-ins and a week with one are weighted by date
  // rather than by how often the user happened to step on the scale.
  function trailingAverage(pts, windowDays) {
    const win = windowDays * DAY_MS;
    let head = 0, sum = 0;
    return pts.map((p, i) => {
      sum += p.y;
      while (pts[head].x < p.x - win) { sum -= pts[head].y; head++; }
      return { x: p.x, y: Math.round((sum / (i - head + 1)) * 10) / 10 };
    });
  }

  // Inserts a null wherever consecutive points are more than gapMs apart, so
  // the line breaks instead of drawing straight through a period with no
  // measurements at all (which reads as steady progress that was never
  // recorded).
  function breakGaps(pts, gapMs) {
    const out = [];
    pts.forEach((p, i) => {
      if (i && p.x - pts[i - 1].x > gapMs) out.push({ x: pts[i - 1].x + 1, y: null });
      out.push(p);
    });
    return out;
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

    const xs = raw.map((p) => p.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const spanDays = (maxX - minX) / DAY_MS;

    // A linear scale has no natural tick range from a single x value (or a
    // single repeated date). Pin a small explicit window around the lone
    // point(s) rather than letting it auto-range to nonsense.
    const single = minX === maxX;
    const xMin = single ? minX - 3 * DAY_MS : minX;
    const xMax = single ? maxX + 3 * DAY_MS : maxX;

    // Over a long history, connecting 70-odd weigh-ins directly draws every
    // day-to-day fluctuation (water weight, time of day, what you ate) at the
    // same visual weight as the actual trend, and dense clusters collapse
    // into blobs. Past a quarter of history, the smoothed trend becomes the
    // line and the real measurements become a lighter scatter behind it, so
    // both the direction and the individual readings stay legible. Short
    // ranges keep the plain connected line: a 7-day average over a 7-day
    // window is a flat line that says nothing.
    const useTrend = spanDays > 75 && raw.length >= 12;
    const trendWindow = spanDays > 400 ? 21 : 10;

    const GAP_MS = (opts.gapDays || 21) * DAY_MS;
    const lineSource = useTrend ? trailingAverage(raw, trendWindow) : raw;
    const linePoints = breakGaps(lineSource, GAP_MS);
    const scatterPoints = useTrend ? raw : [];

    // The area fill is dropped whenever the series has real gaps in it. Fill
    // drops to the axis floor at every break, so a history with a few months
    // off turns into a row of solid columns that look like a bar chart nobody
    // asked for. Continuous ranges (which is what 7d/30d almost always are)
    // still get the gradient.
    const hasGaps = linePoints.some((p) => p.y === null);
    const gradient = ctxGradient(canvas, accent);

    const tooltipLabel = (item) => metric === 'bmi'
      ? `BMI ${item.parsed.y} · ${bmiCategory(item.parsed.y)}`
      : `${item.parsed.y} ${unit}`;

    const dotSize = raw.length > 120 ? 1.5 : raw.length > 40 ? 2 : 3;

    // A goal line is worth far more on the chart than in a stat card: it turns
    // the trend into a distance. Drawn as a flat two-point dataset rather than
    // pulling in the annotation plugin for one dashed line.
    const goalY = (metric === 'weight' && opts.goalKg != null)
      ? Math.round(toDisplayWeight(opts.goalKg, unit) * 10) / 10 : null;
    const goalData = goalY == null ? [] : [{ x: xMin, y: goalY }, { x: xMax, y: goalY }];
    const goalColor = readCssColor('--text-tertiary') || '#7d7a6d';

    const { ticks: tickValues, unit: tickUnit } = buildDateTicks(xMin, xMax, canvas.clientWidth < 420 ? 5 : 8);
    const tickFormat = makeTickFormatter(tickUnit, tickValues);

    const datasets = [
      { // 0: trend (or the plain series on short ranges)
        data: linePoints,
        borderColor: accent,
        backgroundColor: gradient,
        fill: hasGaps ? false : 'origin',
        tension: 0.35,
        pointRadius: useTrend ? 0 : dotSize,
        pointHoverRadius: useTrend ? 0 : 5,
        pointBackgroundColor: accent,
        pointBorderColor: accent,
        borderWidth: useTrend ? 2.5 : 2,
        spanGaps: false,
      },
      { // 1: raw weigh-ins behind the trend
        data: scatterPoints,
        showLine: false,
        pointRadius: Math.min(dotSize, 2),
        pointHoverRadius: 5,
        pointBackgroundColor: hexToRgba(accent, 0.32),
        pointBorderColor: 'transparent',
        pointBorderWidth: 0,
      },
      { // 2: goal line
        data: goalData,
        borderColor: goalColor,
        borderDash: [6, 5],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        tension: 0,
      },
    ];

    // The trend line is a derived value, so pointing at it and reading off a
    // weight the user never recorded would be a lie. Only the raw series (or
    // the plain line, which IS the raw series) answers the tooltip.
    const tooltipCallbacks = {
      title: (items) => new Date(items[0].parsed.x).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      label: (item) => {
        if (item.datasetIndex === 2) return null;
        if (useTrend && item.datasetIndex === 0) return null;
        return tooltipLabel(item);
      },
    };

    if (chartInstance) {
      datasets.forEach((d, i) => Object.assign(chartInstance.data.datasets[i], d));
      const x = chartInstance.options.scales.x;
      x.min = xMin; x.max = xMax;
      x.afterBuildTicks = (axis) => { axis.ticks = tickValues.map((v) => ({ value: v })); };
      x.ticks.callback = (value, index) => tickFormat(value, index);
      chartInstance.options.plugins.tooltip.callbacks = tooltipCallbacks;
      // Re-measure before drawing. The canvas is frequently laid out after
      // the chart is constructed (a route render, a rotation, an install
      // opening at a different size), and without this the whole series is
      // squeezed into whatever width the canvas had at construction time:
      // measured at 200px of an available 842px on a real 73-entry history.
      chartInstance.resize();
      chartInstance.update('none'); // 'none' = no animation, so rapid toggle taps switch instantly instead of re-animating in
      return chartInstance;
    }

    chartInstance = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400 },
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: xMin,
            max: xMax,
            grid: { display: false },
            border: { color: border },
            // Explicit calendar ticks; autoSkip is off because these are
            // already the exact set we want and skipping would reintroduce
            // uneven spacing.
            afterBuildTicks: (axis) => { axis.ticks = tickValues.map((v) => ({ value: v })); },
            ticks: {
              color: textSecondary,
              maxRotation: 0,
              autoSkip: false,
              includeBounds: false,
              padding: 6,
              callback: (value, index) => tickFormat(value, index),
            },
          },
          y: {
            // Gridlines are deliberately SOLID. They were briefly dashed,
            // which made them visually identical to the dashed goal line:
            // the one reference line that carries meaning disappeared into
            // four that carry none. Dashed now means "goal" and nothing else.
            grid: { color: border, drawTicks: false, lineWidth: 1 },
            border: { display: false },
            // A little headroom so the line and the goal marker do not touch
            // the top and bottom edges. Kept small: at 8% the rounding to
            // nice tick values pushed a 95-147 kg history out to an 80-160
            // axis, spending a third of the plot height on empty space and
            // flattening the very trend the chart exists to show.
            grace: '3%',
            ticks: { color: textSecondary, padding: 8, maxTicksLimit: 7 },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: tooltipCallbacks },
        },
      },
    });
    return chartInstance;
  }

  // Vertical gradient for the area fill, rebuilt per render because it is
  // bound to the canvas height at creation time.
  function ctxGradient(canvas, accent) {
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 220);
    g.addColorStop(0, hexToRgba(accent, 0.28));
    g.addColorStop(1, hexToRgba(accent, 0.02));
    return g;
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
