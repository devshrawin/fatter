// dashboard.js implements the Dashboard route: stat cards, goal/BMI/streak,
// and the progress chart. Depends on ui-core.js and
// on FatterUI.openEntryDetail / FatterUI.startAddEntryFlow, both defined in
// entry-form.js, so load order in index.html must reflect that.

(function (global) {
  'use strict';

  const { h, fmtWeight, fmtEta, round1, escapeHtml, deltaSpan, freshViewPool } = FatterUICore;
  const { getSettings, getAllEntriesSorted } = FatterDB;

  // Persisted across renders (module scope, not per-call) so saving/editing/
  // deleting an entry, which re-renders the whole dashboard via the
  // liveQuery subscription in app.js, doesn't silently reset a chart view
  // the user just picked.
  let dashboardChartMetric = 'weight';
  let dashboardChartRange = 'all';
  // Tracks the nudge-banner decision for this page-load. See renderDashboard.
  let nudgeState = null;

  async function renderDashboard(root) {
    freshViewPool();
    const [settings, entries] = await Promise.all([getSettings(), getAllEntriesSorted()]);
    const unit = settings.unit;

    if (!entries.length) {
      root.innerHTML = `
        <div class="privacy-banner">
          <svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
          <div>Your photos and weight data never leave this device. No account, no server, no sync.</div>
        </div>
        <div class="empty-state card">
          <svg class="empty-state__icon" viewBox="0 0 24 24"><use href="#icon-chart"/></svg>
          <div class="empty-state__title">Start your progress log</div>
          <div class="empty-state__body">Add a photo and your weight to see your trend line grow here.</div>
          <button class="btn btn--primary" id="empty-add-btn" type="button">
            <svg class="icon" viewBox="0 0 24 24"><use href="#icon-plus"/></svg> Add your first entry
          </button>
        </div>`;
      root.querySelector('#empty-add-btn').addEventListener('click', () => FatterUI.startAddEntryFlow());
      return;
    }

    const stats = FatterChart.computeStats(entries, unit);
    const goalProgress = FatterChart.computeGoalProgress(stats, settings.goalWeightKg, unit);
    // The nudge decision is made ONCE per page-load and then reused on every
    // subsequent re-render (dashboard re-renders constantly now, via the
    // liveQuery subscription in app.js: any entry/settings write anywhere
    // triggers one). markShownToday() below is itself a settings write, so
    // recomputing from FatterNudge.pickMessage() on every render would have
    // the banner call markShownToday() -> trigger its own re-render ->
    // pickMessage() now sees today's date already recorded -> returns null
    // -> the banner would flicker onto the screen and vanish immediately.
    // Deciding once and caching the result keeps it stable for the session,
    // matching the intended "shown until dismissed" behavior.
    const isFirstNudgeDecision = nudgeState === null;
    if (isFirstNudgeDecision) nudgeState = FatterNudge.pickMessage(entries, settings) || false;
    const nudgeMessage = nudgeState || null;
    // Height may have been cleared since the metric toggle was last set to
    // BMI, so fall back rather than rendering a BMI view with no height.
    if (!settings.heightCm) dashboardChartMetric = 'weight';
    root.innerHTML = `
      ${nudgeMessage ? `<div class="privacy-banner" id="nudge-banner">
        <svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
        <div style="flex:1">${escapeHtml(nudgeMessage)}</div>
        <button id="nudge-dismiss" type="button" aria-label="Dismiss" style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;padding:14px;margin:-14px;flex:none">
          <svg class="icon" style="width:16px;height:16px" viewBox="0 0 24 24"><use href="#icon-close"/></svg>
        </button>
      </div>` : ''}
      <div class="stat-grid">
        <div class="card stat-card stat-card--hero">
          <div class="stat-card__label">Current</div>
          <div class="stat-card__value">${fmtWeight(stats.current)}<span class="stat-card__unit">${unit}</span></div>
        </div>
        <div class="card stat-card">
          <div class="stat-card__label">Starting</div>
          <div class="stat-card__value" style="font-size:20px">${fmtWeight(stats.start)}<span class="stat-card__unit">${unit}</span></div>
        </div>
        <div class="card stat-card">
          <div class="stat-card__label">Total change</div>
          <div style="margin-top:4px">${deltaSpan(stats.totalChange, unit)}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-card__label">Avg weekly</div>
          <div style="margin-top:4px">${deltaSpan(round1(stats.avgWeeklyChange), unit)}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-card__label">Entries</div>
          <div class="stat-card__value" style="font-size:20px">${stats.count}</div>
        </div>
        ${goalProgress ? `<div class="card stat-card">
          <div class="stat-card__label">Goal</div>
          ${goalProgress.reached
            ? `<div class="row" style="gap:5px;margin-top:4px;color:var(--accent);font-weight:600"><svg class="icon" style="width:16px;height:16px" viewBox="0 0 24 24"><use href="#icon-check"/></svg>Reached</div>`
            : `<div class="stat-card__value" style="font-size:20px">${fmtWeight(goalProgress.remaining)}<span class="stat-card__unit">${unit} to go</span></div>
               ${goalProgress.etaDate ? `<div class="text-tertiary" style="font-size:11px;margin-top:2px">${fmtEta(goalProgress.etaDate)} at this pace</div>` : ''}`}
        </div>` : ''}
        ${settings.heightCm ? (() => {
          const bmi = FatterChart.computeBMI(entries[entries.length - 1].weightKg, settings.heightCm);
          return `<div class="card stat-card">
            <div class="stat-card__label">BMI</div>
            <div class="stat-card__value" style="font-size:20px">${round1(bmi).toFixed(1)}</div>
            <div class="text-tertiary" style="font-size:11px;margin-top:2px">${FatterChart.bmiCategory(bmi)}</div>
          </div>`;
        })() : ''}
        ${(() => {
          const streak = FatterChart.computeStreak(entries);
          if (streak < 1) return '';
          return `<div class="card stat-card">
            <div class="stat-card__label">Streak</div>
            <div class="stat-card__value" style="font-size:20px">${streak}<span class="stat-card__unit">day${streak === 1 ? '' : 's'}</span></div>
          </div>`;
        })()}
      </div>
      <div class="card">
        <div class="row row--between" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div class="segmented" id="chart-range-toggle" style="width:auto">
            <button class="segmented__item ${dashboardChartRange === '7' ? 'is-active' : ''}" data-val="7" type="button">7d</button>
            <button class="segmented__item ${dashboardChartRange === '30' ? 'is-active' : ''}" data-val="30" type="button">30d</button>
            <button class="segmented__item ${dashboardChartRange === '90' ? 'is-active' : ''}" data-val="90" type="button">90d</button>
            <button class="segmented__item ${dashboardChartRange === 'all' ? 'is-active' : ''}" data-val="all" type="button">All</button>
          </div>
          <div class="segmented" id="chart-metric-toggle" style="width:auto">
            <button class="segmented__item ${dashboardChartMetric === 'weight' ? 'is-active' : ''}" data-val="weight" type="button">Weight</button>
            ${settings.heightCm ? `<button class="segmented__item ${dashboardChartMetric === 'bmi' ? 'is-active' : ''}" data-val="bmi" type="button">BMI</button>` : ''}
            <button class="segmented__item ${dashboardChartMetric === 'rate' ? 'is-active' : ''}" data-val="rate" type="button">Rate</button>
          </div>
        </div>
        <div class="chart-wrap" id="chart-wrap">
          <canvas id="progress-chart" aria-label="Weight progression chart"></canvas>
          <div id="chart-empty" class="text-tertiary" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;padding:0 24px">No entries in this range.</div>
        </div>
      </div>
      `;

    if (nudgeMessage) {
      // Only on the first decision. See the comment above nudgeState. On a
      // reused decision this would otherwise re-write the same value on
      // every re-render and keep re-triggering the liveQuery subscription.
      if (isFirstNudgeDecision) await FatterNudge.markShownToday();
      root.querySelector('#nudge-dismiss').addEventListener('click', () => {
        root.querySelector('#nudge-banner')?.remove();
        nudgeState = false; // don't resurrect it on a later re-render this session
      });
    }

    const canvas = root.querySelector('#progress-chart');
    const chartEmpty = root.querySelector('#chart-empty');
    function rerenderChart() {
      const scoped = FatterChart.filterEntriesByRange(entries, dashboardChartRange === 'all' ? 'all' : Number(dashboardChartRange));
      // filterEntriesByRange can legitimately return nothing (e.g. "7d" picked
      // after a week-plus gap in logging) even though there ARE entries
      // overall. Without this, the chart area just goes blank with no
      // explanation of why.
      chartEmpty.style.display = scoped.length ? 'none' : 'flex';
      const chartOpts = dashboardChartMetric === 'bmi'
        ? { metric: 'bmi', heightCm: settings.heightCm }
        : dashboardChartMetric === 'rate'
          ? { metric: 'rate' }
          : { goalKg: settings.goalWeightKg };
      FatterChart.renderChart(canvas, scoped, unit, chartOpts);
    }
    rerenderChart();

    const metricToggle = root.querySelector('#chart-metric-toggle');
    if (metricToggle) {
      metricToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-val]'); if (!btn) return;
        metricToggle.querySelectorAll('.segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
        dashboardChartMetric = btn.dataset.val;
        rerenderChart();
      });
    }
    root.querySelector('#chart-range-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      root.querySelectorAll('#chart-range-toggle .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      dashboardChartRange = btn.dataset.val;
      rerenderChart();
    });

  }


  // Called by settings.js after Clear All Data / Replace-backup, both of
  // which wipe and (for replace) repopulate every entry. A nudge decision
  // cached from before that wipe would otherwise be reused incorrectly.
  function resetNudgeState() { nudgeState = null; }

  global.FatterUI = global.FatterUI || {};
  Object.assign(global.FatterUI, { renderDashboard, resetNudgeState });
})(window);
