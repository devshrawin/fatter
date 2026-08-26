// ui.js — view rendering, modals/sheets, toasts, and the add/edit entry flow.
// app.js owns routing/bootstrap and calls into the render* functions here.

(function (global) {
  'use strict';

  const { db, getSettings, setSetting, getAllEntriesSorted, getLatestEntry,
    createEntry, updateEntry, deleteEntry, getPhoto, clearAll, suggestWeightKg,
    toDisplayWeight, fromDisplayWeight, toDisplayHeight, fromDisplayHeight,
    getStorageEstimate, FatterError } = FatterDB;

  // Object URLs created while rendering the *current* view. Revoked wholesale
  // whenever a view re-renders or the route changes, so scrolling a gallery
  // of dozens of thumbnails never leaks a URL per photo.
  let viewUrlPool = FatterImage.createObjectUrlPool();
  function freshViewPool() {
    viewUrlPool.revokeAll();
    viewUrlPool = FatterImage.createObjectUrlPool();
    return viewUrlPool;
  }

  function refresh() {
    window.dispatchEvent(new CustomEvent('fatter:refresh'));
  }

  // ---------------- small DOM helpers ----------------

  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function fmtDate(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtMonth(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function fmtWeight(n) { return round1(n).toFixed(1); }
  function fmtHeight(n) { return round1(n).toFixed(1); }
  function fmtEta(etaDate) {
    const days = Math.max(1, Math.round((etaDate - Date.now()) / 86400000));
    if (days < 14) return `~${days}d`;
    const weeks = Math.round(days / 7);
    if (weeks < 9) return `~${weeks}w`;
    return `~${Math.round(days / 30)}mo`;
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Same accent color regardless of direction — gaining isn't "bad" here.
  // Direction is carried only by the arrow glyph, never by color.
  function deltaSpan(deltaValue, unit) {
    const dir = FatterChart.deltaDirection(deltaValue);
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
    const cls = dir === 'flat' ? 'delta--flat' : '';
    const val = deltaValue === 0 ? '0.0' : `${deltaValue > 0 ? '+' : ''}${fmtWeight(deltaValue)}`;
    return `<span class="delta ${cls}"><span class="delta__arrow">${arrow}</span>${val} ${unit}</span>`;
  }

  // ---------------- toasts ----------------

  function toast(message, { type = 'info', duration = 4200 } = {}) {
    const root = document.getElementById('toast-root');
    const el = h(`<div class="toast ${type === 'error' ? 'toast--error' : ''}" role="status">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${type === 'error' ? 'warning' : 'check'}"/></svg>
      <span>${escapeHtml(message)}</span>
    </div>`);
    root.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // Chromium/Firefox change a focused <input type=number>'s value on mouse
  // wheel / trackpad scroll. For a weight log, an incidental scroll silently
  // corrupting the number is worse than losing that native convenience.
  function preventWheelChange(input) {
    input.addEventListener('wheel', (e) => { if (document.activeElement === input) e.preventDefault(); }, { passive: false });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- modal / sheet host ----------------

  let activeModal = null;

  function openOverlay(innerEl, { dialog = false, form = false, onClose = null } = {}) {
    closeModal();
    const trigger = document.activeElement;
    const overlay = h(`<div class="modal-overlay" role="dialog" aria-modal="true"></div>`);
    if (dialog) innerEl.classList.add('modal-dialog');
    else if (form) innerEl.classList.add('sheet', 'sheet--form');
    else innerEl.classList.add('sheet');
    if (!dialog && !form) {
      const handle = h('<div class="sheet__handle"></div>');
      innerEl.prepend(handle);
    }
    overlay.appendChild(innerEl);
    document.getElementById('modal-root').appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-open'));

    function onKeydown(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'Tab') trapFocus(e, innerEl);
    }
    function onOverlayClick(e) { if (e.target === overlay) close(); }
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    function close() {
      overlay.classList.remove('is-open');
      document.removeEventListener('keydown', onKeydown);
      setTimeout(() => overlay.remove(), 260);
      if (trigger && trigger.focus) trigger.focus();
      activeModal = null;
      if (onClose) onClose();
    }
    const firstFocusable = innerEl.querySelector('input, textarea, button, select, [tabindex]');
    if (firstFocusable) firstFocusable.focus();
    activeModal = { close };
    return { el: innerEl, close };
  }

  function trapFocus(e, container) {
    const focusables = [...container.querySelectorAll('input, textarea, button, select, [tabindex]')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function closeModal() { if (activeModal) activeModal.close(); }

  function openSheet(innerEl, opts = {}) { return openOverlay(innerEl, { ...opts, dialog: false }); }
  function openDialog(innerEl, opts = {}) { return openOverlay(innerEl, { ...opts, dialog: true }); }

  function typedConfirm({ title, body, requiredWord, confirmLabel = 'Confirm', destructive = true, onConfirm }) {
    const el = h(`
      <div>
        <div class="sheet__title" style="margin-bottom:8px">${escapeHtml(title)}</div>
        <p class="text-secondary" style="margin-top:0">${body}</p>
        <div class="field">
          <label class="field__label">Type <strong>${requiredWord}</strong> to confirm</label>
          <input class="input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="row" style="gap:10px;margin-top:16px">
          <button class="btn btn--secondary" style="flex:1" data-act="cancel" type="button">Cancel</button>
          <button class="btn ${destructive ? 'btn--destructive-solid' : 'btn--primary'}" style="flex:1" data-act="confirm" type="button" disabled>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`);
    const input = el.querySelector('input');
    const confirmBtn = el.querySelector('[data-act="confirm"]');
    input.addEventListener('input', () => { confirmBtn.disabled = input.value !== requiredWord; });
    const { close } = openDialog(el);
    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return; // typing the word enables it; a fast double-tap right after otherwise re-runs onConfirm
      confirmBtn.disabled = true;
      close();
      try {
        await onConfirm();
      } catch (err) {
        // onConfirm used to run unguarded — a rejection (e.g. clearAll()
        // hitting a quota/transaction error) vanished silently with no
        // feedback at all, since the dialog was already closed.
        toast(err instanceof FatterError ? err.message : 'Something went wrong. Please try again.', { type: 'error' });
      }
    });
  }

  function simpleConfirm({ title, body, confirmLabel = 'Delete', destructive = true, onConfirm, onCancel }) {
    const el = h(`
      <div>
        <div class="sheet__title" style="margin-bottom:8px">${escapeHtml(title)}</div>
        <p class="text-secondary" style="margin-top:0">${body}</p>
        <div class="row" style="gap:10px;margin-top:16px">
          <button class="btn btn--secondary" style="flex:1" data-act="cancel" type="button">Cancel</button>
          <button class="btn ${destructive ? 'btn--destructive-solid' : 'btn--primary'}" style="flex:1" data-act="confirm" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`);
    const { close } = openDialog(el);
    const confirmBtn = el.querySelector('[data-act="confirm"]');
    // onCancel fires synchronously (not awaited) — Cancel should feel instant,
    // and callers using it to resolve a pending Promise (see the "large
    // backup" confirmation) need it to run even though nothing here awaits it.
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => { close(); if (onCancel) onCancel(); });
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      close();
      try {
        await onConfirm();
      } catch (err) {
        toast(err instanceof FatterError ? err.message : 'Something went wrong. Please try again.', { type: 'error' });
      }
    });
  }

  // ---------------- Dashboard ----------------

  // Persisted across renders (module scope, not per-call) so saving/editing/
  // deleting an entry — which re-renders the whole dashboard via refresh() —
  // doesn't silently reset a chart view the user just picked.
  let dashboardChartMetric = 'weight';
  let dashboardChartRange = 'all';

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
      root.querySelector('#empty-add-btn').addEventListener('click', startAddEntryFlow);
      return;
    }

    const stats = FatterChart.computeStats(entries, unit);
    const goalProgress = FatterChart.computeGoalProgress(stats, settings.goalWeightKg, unit);
    const nudgeMessage = FatterNudge.pickMessage(entries, settings);
    // Height may have been cleared since the metric toggle was last set to
    // BMI — fall back rather than rendering a BMI view with no height.
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
          ${settings.heightCm ? `<div class="segmented" id="chart-metric-toggle" style="width:auto">
            <button class="segmented__item ${dashboardChartMetric === 'weight' ? 'is-active' : ''}" data-val="weight" type="button">Weight</button>
            <button class="segmented__item ${dashboardChartMetric === 'bmi' ? 'is-active' : ''}" data-val="bmi" type="button">BMI</button>
          </div>` : '<div></div>'}
          <div class="segmented" id="chart-range-toggle" style="width:auto">
            <button class="segmented__item ${dashboardChartRange === '7' ? 'is-active' : ''}" data-val="7" type="button">7d</button>
            <button class="segmented__item ${dashboardChartRange === '30' ? 'is-active' : ''}" data-val="30" type="button">30d</button>
            <button class="segmented__item ${dashboardChartRange === '90' ? 'is-active' : ''}" data-val="90" type="button">90d</button>
            <button class="segmented__item ${dashboardChartRange === 'all' ? 'is-active' : ''}" data-val="all" type="button">All</button>
          </div>
        </div>
        <div class="chart-wrap" id="chart-wrap">
          <canvas id="progress-chart" aria-label="Weight progression chart"></canvas>
          <div id="chart-empty" class="text-tertiary" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;padding:0 24px">No entries in this range.</div>
        </div>
      </div>
      <div id="recent-strip" style="margin-top:16px"></div>`;

    if (nudgeMessage) {
      await FatterNudge.markShownToday();
      root.querySelector('#nudge-dismiss').addEventListener('click', () => {
        root.querySelector('#nudge-banner')?.remove();
      });
    }

    const canvas = root.querySelector('#progress-chart');
    const chartEmpty = root.querySelector('#chart-empty');
    function rerenderChart() {
      const scoped = FatterChart.filterEntriesByRange(entries, dashboardChartRange === 'all' ? 'all' : Number(dashboardChartRange));
      // filterEntriesByRange can legitimately return nothing (e.g. "7d" picked
      // after a week-plus gap in logging) even though there ARE entries
      // overall — without this, the chart area just goes blank with no
      // explanation of why.
      chartEmpty.style.display = scoped.length ? 'none' : 'flex';
      FatterChart.renderChart(canvas, scoped, unit, dashboardChartMetric === 'bmi' ? { metric: 'bmi', heightCm: settings.heightCm } : {});
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

    const recent = entries.slice(-4).reverse();
    const stripEl = root.querySelector('#recent-strip');
    if (recent.length) {
      stripEl.innerHTML = `<div class="timeline-month">Recent</div><div class="gallery-grid" style="grid-template-columns:repeat(4,1fr)"></div>`;
      const grid = stripEl.querySelector('.gallery-grid');
      // Promise.all instead of a sequential loop — each photoTile() awaits its
      // own getPhoto(), and there's no ordering dependency between tiles.
      // Promise.all preserves array order regardless of resolution order.
      const tiles = await Promise.all(recent.map(photoTile));
      tiles.forEach((tile) => grid.appendChild(tile));
    }
  }

  async function photoTile(entry) {
    const tile = h(`<div class="gallery-tile"></div>`);
    if (entry.hasPhoto) {
      const photo = await getPhoto(entry.id);
      if (photo) {
        const url = viewUrlPool.get('thumb-' + entry.id, photo.thumbBlob);
        tile.innerHTML = `<img src="${url}" alt="Progress photo, ${fmtDate(entry.date)}" loading="lazy">
          <div class="gallery-tile__overlay">${fmtDate(entry.date)}</div>`;
      }
    } else {
      tile.innerHTML = `<div class="row" style="height:100%;justify-content:center;color:var(--text-tertiary)"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-image"/></svg></div>`;
    }
    tile.addEventListener('click', () => openEntryDetail(entry.id));
    return tile;
  }

  // ---------------- Log / timeline ----------------

  async function renderLog(root) {
    freshViewPool();
    const [settings, entries] = await Promise.all([getSettings(), getAllEntriesSorted()]);
    const unit = settings.unit;

    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No entries yet</div><div class="empty-state__body">Entries you add will show up here in a timeline.</div></div>`;
      return;
    }

    root.innerHTML = '';
    const desc = [...entries].reverse();

    // Fetch every photo up front in parallel instead of one-at-a-time inside
    // the render loop below — a sequential await per row serializes dozens
    // of independent IndexedDB reads for no reason.
    const withPhoto = desc.filter((e) => e.hasPhoto);
    const photos = await Promise.all(withPhoto.map((e) => getPhoto(e.id)));
    const photoById = new Map(withPhoto.map((e, i) => [e.id, photos[i]]));

    let lastMonth = null;
    for (let i = 0; i < desc.length; i++) {
      const entry = desc[i];
      const chronoIndex = entries.length - 1 - i;
      const month = fmtMonth(entry.date);
      if (month !== lastMonth) {
        root.appendChild(h(`<div class="timeline-month">${month}</div>`));
        lastMonth = month;
      }
      const prevChrono = entries[chronoIndex - 1];
      const deltaDisplay = prevChrono ? round1(toDisplayWeight(entry.weightKg - prevChrono.weightKg, unit)) : null;

      const row = h(`
        <div class="timeline-row" tabindex="0" role="button">
          <div class="timeline-row__thumb"></div>
          <div class="timeline-row__body">
            <div class="timeline-row__date">${fmtDate(entry.date)}</div>
            ${entry.note ? `<div class="timeline-row__note">${escapeHtml(entry.note)}</div>` : ''}
          </div>
          <div>
            <div class="timeline-row__weight">${fmtWeight(toDisplayWeight(entry.weightKg, unit))} ${unit}</div>
            ${deltaDisplay != null ? deltaSpan(deltaDisplay, unit) : ''}
          </div>
        </div>`);
      const thumbEl = row.querySelector('.timeline-row__thumb');
      const photo = entry.hasPhoto ? photoById.get(entry.id) : null;
      if (photo) {
        thumbEl.innerHTML = `<img src="${viewUrlPool.get('log-' + entry.id, photo.thumbBlob)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      } else {
        thumbEl.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><use href="#icon-image"/></svg>`;
      }
      row.addEventListener('click', () => openEntryDetail(entry.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEntryDetail(entry.id); });
      root.appendChild(row);
    }
  }

  // ---------------- Gallery ----------------

  async function renderGallery(root) {
    freshViewPool();
    const entries = (await getAllEntriesSorted()).filter((e) => e.hasPhoto).reverse();
    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No photos yet</div><div class="empty-state__body">Photos from your entries will appear here.</div></div>`;
      return;
    }
    root.innerHTML = '<div class="gallery-grid"></div>';
    const grid = root.querySelector('.gallery-grid');
    // Parallel fetch — see renderLog for why (Promise.all preserves order).
    const photos = await Promise.all(entries.map((e) => getPhoto(e.id)));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const photo = photos[i];
      if (!photo) continue;
      const tile = h(`<div class="gallery-tile">
        <img src="${viewUrlPool.get('gal-' + entry.id, photo.thumbBlob)}" alt="Progress photo, ${fmtDate(entry.date)}" loading="lazy">
        <div class="gallery-tile__overlay">${fmtDate(entry.date)}</div>
      </div>`);
      tile.addEventListener('click', () => openLightbox(entries, i));
      grid.appendChild(tile);
    }
  }

  async function openLightbox(entries, index) {
    let i = index;
    const el = h(`<div>
      <div class="row row--between" style="margin-bottom:8px">
        <div id="lb-caption" class="text-secondary"></div>
        <button class="sheet__close" data-act="close" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>
      </div>
      <div style="border-radius:var(--r-card);overflow:hidden;background:var(--surface-sunken)">
        <img id="lb-img" style="width:100%;display:block" alt="">
      </div>
      <div class="row" style="justify-content:center;gap:16px;margin-top:12px">
        <button class="btn btn--secondary" data-act="prev" type="button">Prev</button>
        <button class="btn btn--secondary" data-act="next" type="button">Next</button>
      </div>
    </div>`);
    let currentUrl = null;
    let requestId = 0; // rapid Prev/Next fires overlapping getPhoto() calls with no ordering guarantee — only the latest request may touch shared state
    const { close } = openSheet(el, { onClose: () => { if (currentUrl) URL.revokeObjectURL(currentUrl); } });
    const settings = await getSettings(); // unit doesn't change while the lightbox is open — fetch once, not per navigation
    async function show(n) {
      i = (n + entries.length) % entries.length;
      const myRequest = ++requestId;
      const entry = entries[i];
      const photo = await getPhoto(entry.id);
      if (myRequest !== requestId) return; // superseded by a later Prev/Next click while this await was pending
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(photo.blob);
      el.querySelector('#lb-img').src = currentUrl;
      el.querySelector('#lb-caption').textContent = `${fmtDate(entry.date)} · ${fmtWeight(toDisplayWeight(entry.weightKg, settings.unit))} ${settings.unit}`;
    }
    el.querySelector('[data-act="close"]').addEventListener('click', close);
    el.querySelector('[data-act="prev"]').addEventListener('click', () => show(i - 1));
    el.querySelector('[data-act="next"]').addEventListener('click', () => show(i + 1));
    show(i);
  }

  // ---------------- Entry detail / edit / delete ----------------

  async function openEntryDetail(id) {
    const entry = await db.entries.get(id);
    if (!entry) return toast('That entry no longer exists.', { type: 'error' });
    const settings = await getSettings();
    const photo = entry.hasPhoto ? await getPhoto(id) : null;
    let photoUrl = null;
    const el = h(`<div>
      <div class="sheet__header">
        <div class="sheet__title">${fmtDate(entry.date)}</div>
        <button class="sheet__close" data-act="close" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>
      </div>
      ${photo ? `<img id="detail-photo" style="width:100%;border-radius:var(--r-card);margin-bottom:12px" alt="">` : ''}
      <div class="stat-card__value" style="margin-bottom:4px">${fmtWeight(toDisplayWeight(entry.weightKg, settings.unit))}<span class="stat-card__unit">${settings.unit}</span></div>
      ${entry.note ? `<p class="text-secondary">${escapeHtml(entry.note)}</p>` : ''}
      <div class="row" style="gap:8px;margin-top:16px">
        <button class="btn btn--secondary btn--block" data-act="edit" type="button"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-edit"/></svg> Edit</button>
        <button class="btn btn--destructive btn--block" data-act="delete" type="button"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg> Delete</button>
      </div>
    </div>`);
    if (photo) { photoUrl = URL.createObjectURL(photo.blob); el.querySelector('#detail-photo').src = photoUrl; }
    const cleanup = () => { if (photoUrl) URL.revokeObjectURL(photoUrl); };
    const { close } = openSheet(el, { onClose: cleanup });
    el.querySelector('[data-act="close"]').addEventListener('click', close);
    el.querySelector('[data-act="edit"]').addEventListener('click', () => { close(); openEditEntry(entry, settings); });
    el.querySelector('[data-act="delete"]').addEventListener('click', () => {
      close();
      simpleConfirm({
        title: 'Delete this entry?',
        body: `The weight, note, and photo for ${fmtDate(entry.date)} will be permanently removed.`,
        confirmLabel: 'Delete entry',
        onConfirm: async () => {
          await deleteEntry(id);
          toast('Entry deleted.');
          refresh();
        },
      });
    });
  }

  // ---------------- Add / Edit entry flow ----------------

  function openPhotoSourceSheet() {
    const el = h(`<div>
      <div class="sheet__title" style="margin-bottom:12px">Add a photo</div>
      <div class="stack">
        <button class="btn btn--secondary btn--block" data-act="camera" type="button"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-camera"/></svg> Take photo</button>
        <button class="btn btn--secondary btn--block" data-act="library" type="button"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-image"/></svg> Choose from library</button>
        <button class="btn btn--ghost btn--block" data-act="cancel" type="button">Cancel</button>
      </div>
    </div>`);
    const { close } = openSheet(el);
    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="camera"]').addEventListener('click', () => { close(); document.getElementById('photo-input-camera').click(); });
    el.querySelector('[data-act="library"]').addEventListener('click', () => { close(); document.getElementById('photo-input-library').click(); });
  }

  function startAddEntryFlow() { openPhotoSourceSheet(); }

  // Deliberately bypasses openOverlay/openDialog — those call closeModal()
  // first thing, which would silently close an Add/Edit Entry sheet still
  // open behind this spinner (e.g. Edit Entry's "Change photo" picks a file
  // while the edit sheet is up; this needs to show ON TOP of it, not evict
  // it — that eviction was a real bug: the edit sheet vanished mid-flow and
  // whatever was typed got lost). Manages its own overlay element instead.
  function showCompressing() {
    const overlay = h(`<div class="modal-overlay" role="status" aria-live="polite">
      <div class="modal-dialog"><div class="row" style="justify-content:center;padding:24px 0;gap:10px"><div class="spinner"></div><span>Preparing photo…</span></div></div>
    </div>`);
    document.getElementById('modal-root').appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    return {
      close: () => {
        overlay.classList.remove('is-open');
        setTimeout(() => overlay.remove(), 260);
      },
    };
  }

  async function handlePickedFile(file) {
    if (!file) return;
    const loading = showCompressing();
    try {
      // readExifDateTaken never throws (it resolves null on any parse issue),
      // so pairing it with compressPhoto in Promise.all is safe.
      const [payload, exifDate] = await Promise.all([
        FatterImage.compressPhoto(file),
        FatterImage.readExifDateTaken(file),
      ]);
      loading.close();
      openAddEntryModal(payload, { suggestedDate: exifDate });
    } catch (err) {
      loading.close();
      if (err && err.code === 'UNSUPPORTED_FORMAT') {
        toast(err.message, { type: 'error', duration: 7000 });
      } else {
        toast('Something went wrong processing that photo. Please try another.', { type: 'error' });
      }
    }
  }

  async function openAddEntryModal(photoPayload, { suggestedDate = null } = {}) {
    const [settings, latest] = await Promise.all([getSettings(), getLatestEntry()]);
    const unit = settings.unit;
    const suggestedKg = suggestWeightKg(latest, settings.smartVariation);
    const suggestedDisplay = suggestedKg != null ? fmtWeight(toDisplayWeight(suggestedKg, unit)) : '';
    let photoUrl = URL.createObjectURL(photoPayload.blob);
    const dateValue = suggestedDate && suggestedDate <= todayISO() ? suggestedDate : todayISO();
    const ocrPending = !!settings.ocrEnabled;
    const initialHint = ocrPending
      ? 'Reading weight from photo…'
      : (suggestedDisplay ? 'From your last entry — type to replace' : '');

    const el = h(`<div>
      <div class="sheet--form__topbar">
        <button class="sheet--form__topbar-btn" data-act="cancel" type="button">Cancel</button>
        <div class="sheet__title">Add entry</div>
        <div style="width:52px"></div>
      </div>
      <div class="sheet--form__body">
        <div style="position:relative;margin-bottom:18px">
          <img id="entry-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card);display:block" alt="Selected photo">
          <button id="entry-photo-rotate" class="btn btn--secondary btn--sm" type="button" aria-label="Rotate photo 90 degrees" style="position:absolute;top:8px;right:8px;width:36px;height:36px;padding:0;border-radius:var(--r-pill)">
            <svg class="icon" viewBox="0 0 24 24"><use href="#icon-rotate"/></svg>
          </button>
        </div>
        <div class="field">
          <label class="field__label">Weight (${unit})</label>
          <input id="entry-weight" class="input input--numeric ${suggestedDisplay ? 'input--suggested' : ''}" type="number" inputmode="decimal" step="0.1" min="0" max="1000" placeholder="e.g. 70.0" value="${suggestedDisplay}">
          <div id="weight-hint" class="field__hint" ${initialHint ? '' : 'style="display:none"'}>
            <svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg><span id="weight-hint-text">${escapeHtml(initialHint)}</span>
          </div>
        </div>
        <div class="field">
          <label class="field__label">Date</label>
          <input id="entry-date" class="input" type="date" value="${dateValue}" max="${todayISO()}">
          ${suggestedDate ? `<div class="field__hint"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-calendar"/></svg>From the photo's date taken</div>` : ''}
        </div>
        <div class="field">
          <label class="field__label">Note (optional)</label>
          <textarea id="entry-note" class="textarea" placeholder="How are you feeling today?"></textarea>
        </div>
        <div id="entry-error" class="field__error" style="display:none"></div>
      </div>
      <div class="sheet--form__footer">
        <button class="btn btn--primary btn--block" data-act="save" type="button">Save entry</button>
      </div>
    </div>`);
    el.querySelector('#entry-photo-preview').src = photoUrl;

    const weightInput = el.querySelector('#entry-weight');
    const hint = el.querySelector('#weight-hint');
    const hintText = el.querySelector('#weight-hint-text');
    let weightEdited = false;
    preventWheelChange(weightInput);
    weightInput.addEventListener('input', () => {
      weightEdited = true;
      weightInput.classList.remove('input--suggested');
      hint.style.display = 'none';
    });

    function cleanup() { URL.revokeObjectURL(photoUrl); }
    const { close } = openOverlay(el, { form: true, onClose: cleanup });
    // select suggested text so typing overwrites it immediately
    weightInput.focus();
    weightInput.select();

    const rotateBtn = el.querySelector('#entry-photo-rotate');
    const photoPreviewImg = el.querySelector('#entry-photo-preview');
    rotateBtn.addEventListener('click', async () => {
      rotateBtn.disabled = true;
      try {
        photoPayload = await FatterImage.rotatePhotoPayload(photoPayload, 90);
        const oldUrl = photoUrl;
        photoUrl = URL.createObjectURL(photoPayload.blob);
        photoPreviewImg.src = photoUrl;
        URL.revokeObjectURL(oldUrl);
      } catch {
        toast('Could not rotate that photo.', { type: 'error' });
      } finally {
        rotateBtn.disabled = false;
      }
    });

    // Best-effort: read the number off the scale/app display in the photo.
    // Runs in the background — never blocks opening the modal, and never
    // overwrites a value the user has already started typing.
    if (ocrPending) {
      FatterOCR.readWeightFromImage(photoPayload.blob, unit).then((ocrValue) => {
        if (weightEdited) return;
        if (ocrValue != null) {
          weightInput.value = fmtWeight(ocrValue);
          weightInput.classList.add('input--suggested');
          hint.style.display = 'flex';
          hintText.textContent = "Read from photo — check it's correct";
        } else if (suggestedDisplay) {
          hint.style.display = 'flex';
          hintText.textContent = 'From your last entry — type to replace';
        } else {
          hint.style.display = 'none';
        }
      });
    }

    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    const saveBtn = el.querySelector('[data-act="save"]');
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return; // a fast double-tap fires twice before the first Save resolves — guard against duplicate entries
      const errEl = el.querySelector('#entry-error');
      const val = parseFloat(weightInput.value);
      const dateVal = el.querySelector('#entry-date').value || todayISO();
      if (!val || val <= 0 || val > parseFloat(weightInput.max)) {
        errEl.textContent = 'Enter a valid weight.'; errEl.style.display = 'block'; return;
      }
      const weightKg = fromDisplayWeight(val, unit);
      const note = el.querySelector('#entry-note').value.trim();
      saveBtn.disabled = true;
      try {
        await createEntry({ date: dateVal, weightKg, note, photoPayload }, Date.now());
        close();
        toast('Entry saved.');
        refresh();
      } catch (err) {
        errEl.textContent = err instanceof FatterError ? err.message : 'Could not save this entry.';
        errEl.style.display = 'block';
        saveBtn.disabled = false;
      }
    });
  }

  // settings: caller (openEntryDetail) already has a fresh copy — reuse it
  // instead of re-fetching, since unit can't have changed in the interim.
  async function openEditEntry(entry, settings) {
    const unit = settings.unit;
    const existingPhoto = entry.hasPhoto ? await getPhoto(entry.id) : null;
    let newPhotoPayload = null;
    let previewUrl = existingPhoto ? URL.createObjectURL(existingPhoto.blob) : null;
    let photoRemoved = false;

    const el = h(`<div>
      <div class="sheet--form__topbar">
        <button class="sheet--form__topbar-btn" data-act="cancel" type="button">Cancel</button>
        <div class="sheet__title">Edit entry</div>
        <div style="width:52px"></div>
      </div>
      <div class="sheet--form__body">
        <div id="edit-photo-container" style="position:relative;margin-bottom:18px">
          ${previewUrl ? `<img id="edit-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card)" alt="">` : ''}
          <div style="position:absolute;right:10px;bottom:10px;display:flex;gap:8px">
            ${previewUrl ? `<button id="entry-photo-rotate" class="btn btn--secondary btn--sm" type="button" aria-label="Rotate photo 90 degrees" style="width:36px;height:36px;padding:0;border-radius:var(--r-pill)"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-rotate"/></svg></button>
            <button id="entry-photo-remove" class="btn btn--secondary btn--sm" type="button" aria-label="Remove photo" style="width:36px;height:36px;padding:0;border-radius:var(--r-pill)"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>` : ''}
            <button class="btn btn--secondary btn--sm" data-act="change-photo" type="button">Change photo</button>
          </div>
        </div>
        <div class="field">
          <label class="field__label">Weight (${unit})</label>
          <input id="entry-weight" class="input input--numeric" type="number" inputmode="decimal" step="0.1" min="0" max="1000" value="${fmtWeight(toDisplayWeight(entry.weightKg, unit))}">
        </div>
        <div class="field">
          <label class="field__label">Date</label>
          <input id="entry-date" class="input" type="date" value="${entry.date}" max="${todayISO()}">
        </div>
        <div class="field">
          <label class="field__label">Note (optional)</label>
          <textarea id="entry-note" class="textarea">${escapeHtml(entry.note || '')}</textarea>
        </div>
        <div id="entry-error" class="field__error" style="display:none"></div>
      </div>
      <div class="sheet--form__footer">
        <button class="btn btn--primary btn--block" data-act="save" type="button">Save entry</button>
      </div>
    </div>`);
    if (previewUrl) el.querySelector('#edit-photo-preview').src = previewUrl;
    const weightInput = el.querySelector('#entry-weight');
    preventWheelChange(weightInput);

    function cleanup() { if (previewUrl) URL.revokeObjectURL(previewUrl); }
    const { close } = openOverlay(el, { form: true, onClose: () => { cleanup(); teardownEdit(); } });
    // openOverlay's default "first focusable" is the Cancel button (it's
    // earlier in the DOM than the weight field) — override it, matching Add
    // Entry's behavior, so the field a user most often changes is ready to type.
    weightInput.focus();
    weightInput.select();

    // A rotate and a "change photo" pick are both async and both end by
    // overwriting newPhotoPayload/previewUrl — if a user fires both close
    // together (tap rotate, then quickly pick a new photo before it
    // resolves), whichever finishes last silently clobbers the other's
    // result. A shared token makes each operation check, after its await,
    // whether it's still the most recent one before touching shared state.
    let photoOpToken = 0;
    function setPhotoButtonsBusy(busy) {
      el.querySelector('[data-act="change-photo"]').disabled = busy;
      const rotateBtn = el.querySelector('#entry-photo-rotate');
      if (rotateBtn) rotateBtn.disabled = busy;
      const removeBtn = el.querySelector('#entry-photo-remove');
      if (removeBtn) removeBtn.disabled = busy;
    }

    el.querySelector('[data-act="change-photo"]').addEventListener('click', () => {
      document.getElementById('photo-input-library').click();
    });
    // Ensures both the rotate and remove buttons exist — needed after
    // Remove-photo has torn them down and the user then picks a new photo.
    function ensurePhotoActionButtons() {
      const btnRow = el.querySelector('#edit-photo-container > div');
      let rotateBtn = el.querySelector('#entry-photo-rotate');
      if (!rotateBtn) {
        rotateBtn = h(`<button id="entry-photo-rotate" class="btn btn--secondary btn--sm" type="button" aria-label="Rotate photo 90 degrees" style="width:36px;height:36px;padding:0;border-radius:var(--r-pill)"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-rotate"/></svg></button>`);
        btnRow.prepend(rotateBtn);
        wireRotateButton(rotateBtn);
      }
      if (!el.querySelector('#entry-photo-remove')) {
        const removeBtn = h(`<button id="entry-photo-remove" class="btn btn--secondary btn--sm" type="button" aria-label="Remove photo" style="width:36px;height:36px;padding:0;border-radius:var(--r-pill)"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>`);
        rotateBtn.after(removeBtn);
        wireRemoveButton(removeBtn);
      }
    }
    function wireRotateButton(btn) {
      btn.addEventListener('click', async () => {
        const myOp = ++photoOpToken;
        setPhotoButtonsBusy(true);
        try {
          const source = newPhotoPayload || existingPhoto;
          if (!source) return;
          const rotated = await FatterImage.rotatePhotoPayload(source, 90);
          if (myOp !== photoOpToken) { return; } // a photo pick finished first — don't clobber it with a rotation of the old photo
          newPhotoPayload = rotated;
          const url = URL.createObjectURL(rotated.blob);
          cleanup(); previewUrl = url;
          el.querySelector('#edit-photo-preview').src = url;
        } catch {
          toast('Could not rotate that photo.', { type: 'error' });
        } finally {
          if (myOp === photoOpToken) setPhotoButtonsBusy(false);
        }
      });
    }
    // Synchronous, but still bumps the token to invalidate any in-flight
    // rotate/pick so it can't silently resurrect a photo the user just removed.
    function wireRemoveButton(btn) {
      btn.addEventListener('click', () => {
        ++photoOpToken;
        cleanup();
        previewUrl = null;
        newPhotoPayload = null;
        photoRemoved = true;
        el.querySelector('#edit-photo-preview')?.remove();
        el.querySelector('#entry-photo-rotate')?.remove();
        el.querySelector('#entry-photo-remove')?.remove();
      });
    }
    const initialRotateBtn = el.querySelector('#entry-photo-rotate');
    if (initialRotateBtn) wireRotateButton(initialRotateBtn);
    const initialRemoveBtn = el.querySelector('#entry-photo-remove');
    if (initialRemoveBtn) wireRemoveButton(initialRemoveBtn);

    async function onNewPhotoPicked(e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const myOp = ++photoOpToken;
      setPhotoButtonsBusy(true);
      const loading = showCompressing();
      try {
        const compressed = await FatterImage.compressPhoto(file);
        loading.close();
        if (myOp !== photoOpToken) { return; } // superseded by a rotate that started after this pick
        newPhotoPayload = compressed;
        photoRemoved = false; // picking a new photo un-does a prior Remove-photo
        const url = URL.createObjectURL(newPhotoPayload.blob);
        cleanup(); previewUrl = url;
        let img = el.querySelector('#edit-photo-preview');
        if (!img) {
          img = h(`<img id="edit-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card)" alt="">`);
          el.querySelector('#edit-photo-container').prepend(img);
        }
        img.src = url;
        ensurePhotoActionButtons();
      } catch (err) {
        loading.close();
        toast(err && err.code === 'UNSUPPORTED_FORMAT' ? err.message : 'Could not process that photo.', { type: 'error', duration: 7000 });
      } finally {
        if (myOp === photoOpToken) setPhotoButtonsBusy(false);
      }
    }
    global.__fatterEditPhotoHandler = onNewPhotoPicked; // wired via app.js delegated listener

    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    const editSaveBtn = el.querySelector('[data-act="save"]');
    editSaveBtn.addEventListener('click', async () => {
      if (editSaveBtn.disabled) return;
      const errEl = el.querySelector('#entry-error');
      const weightField = el.querySelector('#entry-weight');
      const val = parseFloat(weightField.value);
      if (!val || val <= 0 || val > parseFloat(weightField.max)) { errEl.textContent = 'Enter a valid weight.'; errEl.style.display = 'block'; return; }
      const weightKg = fromDisplayWeight(val, unit);
      const dateVal = el.querySelector('#entry-date').value || entry.date;
      const note = el.querySelector('#entry-note').value.trim();
      editSaveBtn.disabled = true;
      try {
        await updateEntry(entry.id, { date: dateVal, weightKg, note, photoPayload: newPhotoPayload, removePhoto: photoRemoved && !newPhotoPayload }, Date.now());
        close();
        toast('Entry updated.');
        refresh();
      } catch (err) {
        editSaveBtn.disabled = false;
        errEl.textContent = err instanceof FatterError ? err.message : 'Could not save this entry.';
        errEl.style.display = 'block';
      }
    });
    function teardownEdit() { global.__fatterEditPhotoHandler = null; }
  }

  // ---------------- Settings ----------------

  async function renderSettings(root) {
    freshViewPool();
    const settings = await getSettings();
    const estimate = await getStorageEstimate();
    const usagePct = estimate && estimate.quota ? Math.min(100, Math.round((estimate.usage / estimate.quota) * 100)) : 0;
    const usageMB = estimate ? (estimate.usage / (1024 * 1024)).toFixed(1) : '—';
    const quotaMB = estimate ? (estimate.quota / (1024 * 1024)).toFixed(0) : '—';

    root.innerHTML = `
      <div class="settings-group">
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row__label">Units</div>
            <div class="segmented" id="unit-toggle" style="width:auto">
              <button class="segmented__item ${settings.unit === 'kg' ? 'is-active' : ''}" data-val="kg" type="button">kg</button>
              <button class="segmented__item ${settings.unit === 'lb' ? 'is-active' : ''}" data-val="lb" type="button">lbs</button>
            </div>
          </div>
          <div class="settings-row" id="btn-goal-weight" style="cursor:pointer">
            <div class="settings-row__label">Goal weight</div>
            <div class="row" style="gap:6px">
              <span class="text-secondary">${settings.goalWeightKg != null ? fmtWeight(toDisplayWeight(settings.goalWeightKg, settings.unit)) + ' ' + settings.unit : 'Not set'}</span>
              <svg class="icon" style="width:16px;height:16px;color:var(--text-tertiary)" viewBox="0 0 24 24"><use href="#icon-chevron"/></svg>
            </div>
          </div>
          <div class="settings-row" id="btn-height" style="cursor:pointer">
            <div class="settings-row__label">Height</div>
            <div class="row" style="gap:6px">
              <span class="text-secondary">${settings.heightCm != null ? fmtHeight(toDisplayHeight(settings.heightCm, settings.unit)) + ' ' + (settings.unit === 'lb' ? 'in' : 'cm') : 'Not set'}</span>
              <svg class="icon" style="width:16px;height:16px;color:var(--text-tertiary)" viewBox="0 0 24 24"><use href="#icon-chevron"/></svg>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row__label">Theme</div>
            <div class="segmented" id="theme-toggle" style="width:auto">
              <button class="segmented__item ${settings.theme === 'system' ? 'is-active' : ''}" data-val="system" type="button">System</button>
              <button class="segmented__item ${settings.theme === 'dark' ? 'is-active' : ''}" data-val="dark" type="button">Dark</button>
              <button class="segmented__item ${settings.theme === 'light' ? 'is-active' : ''}" data-val="light" type="button">Light</button>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row__label">Suggest my last weight</div>
              <div class="settings-row__desc">Adds a small ±0.2–0.5 variation instead of repeating the exact value. Off by default — the suggestion is always editable either way.</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="smart-variation" ${settings.smartVariation ? 'checked' : ''}>
              <span class="toggle__track"><span class="toggle__thumb"></span></span>
            </label>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row__label">Read weight from photo</div>
              <div class="settings-row__desc">Tries to read the number off a scale or app display in the photo — works best when the display is upright and fills more of the frame (use the rotate button when adding a photo). Deliberately conservative: if it isn't confident, it says nothing rather than guess. First use downloads a ~6 MB on-device text reader, cached after that.</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="ocr-enabled" ${settings.ocrEnabled ? 'checked' : ''}>
              <span class="toggle__track"><span class="toggle__thumb"></span></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-card">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
            <div class="row row--between">
              <span class="settings-row__label">Storage used</span>
              <span class="text-secondary" style="font-size:12px">${usageMB} MB${quotaMB !== '—' ? ' of ' + quotaMB + ' MB' : ''}</span>
            </div>
            <div class="meter"><div class="meter__fill" style="width:${usagePct}%"></div></div>
            <div class="row" style="gap:6px;font-size:11px;color:${estimate && estimate.persisted ? 'var(--accent)' : 'var(--text-tertiary)'}">
              <svg class="icon" style="width:12px;height:12px" viewBox="0 0 24 24"><use href="#icon-${estimate && estimate.persisted ? 'check' : 'info'}"/></svg>
              ${estimate && estimate.persisted ? "Storage is persistent — won't be cleared automatically" : 'Storage is not yet marked persistent'}
            </div>
          </div>
          <div class="settings-row" id="btn-export-excel" style="cursor:pointer">
            <div class="settings-row__label">Download Excel</div>
            <svg class="icon" style="width:16px;height:16px;color:var(--text-secondary)" viewBox="0 0 24 24"><use href="#icon-download"/></svg>
          </div>
          <div class="settings-row" id="btn-export-backup" style="cursor:pointer">
            <div class="settings-row__label">Export full backup</div>
            <svg class="icon" style="width:16px;height:16px;color:var(--text-secondary)" viewBox="0 0 24 24"><use href="#icon-download"/></svg>
          </div>
          <div class="settings-row" id="btn-import-backup" style="cursor:pointer">
            <div class="settings-row__label">Import backup</div>
            <svg class="icon" style="width:16px;height:16px;color:var(--text-secondary)" viewBox="0 0 24 24"><use href="#icon-upload"/></svg>
          </div>
          <div class="settings-row" id="btn-add-to-home-screen" style="cursor:pointer">
            <div class="row" style="gap:10px">
              <svg class="icon" style="width:18px;height:18px;color:var(--accent)" viewBox="0 0 24 24"><use href="#icon-add-home"/></svg>
              <div class="settings-row__label">Add to Home Screen</div>
            </div>
            <svg class="icon" style="width:16px;height:16px;color:var(--text-tertiary)" viewBox="0 0 24 24"><use href="#icon-chevron"/></svg>
          </div>
          <input type="file" id="import-file-input" accept="application/json" hidden>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-card settings-card--danger">
          <div class="settings-row" id="btn-clear-all" style="cursor:pointer">
            <div class="settings-row__label">Clear all data</div>
          </div>
        </div>
      </div>

      <p class="text-tertiary" style="font-size:11px;text-align:center;line-height:1.6;margin-top:24px">
        Your photos and weights never leave this device.<br>Fatter v1.0.0
      </p>`;

    root.querySelector('#unit-toggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      await setSetting('unit', btn.dataset.val);
      refresh();
    });
    root.querySelector('#btn-goal-weight').addEventListener('click', () => {
      const currentDisplay = settings.goalWeightKg != null ? fmtWeight(toDisplayWeight(settings.goalWeightKg, settings.unit)) : '';
      const el = h(`<div>
        <div class="sheet__title" style="margin-bottom:16px">Goal weight</div>
        <div class="field">
          <label class="field__label">Target (${settings.unit})</label>
          <input id="goal-weight-input" class="input input--numeric" type="number" inputmode="decimal" step="0.1" min="0" max="1000" placeholder="e.g. 70.0" value="${currentDisplay}">
        </div>
        <div class="row" style="gap:8px;margin-top:8px">
          ${settings.goalWeightKg != null ? '<button class="btn btn--ghost btn--block" data-act="clear" type="button">Clear goal</button>' : ''}
          <button class="btn btn--primary btn--block" data-act="save" type="button">Save</button>
        </div>
      </div>`);
      const { close } = openDialog(el);
      const input = el.querySelector('#goal-weight-input');
      preventWheelChange(input);
      input.focus();
      el.querySelector('[data-act="clear"]')?.addEventListener('click', async () => {
        await setSetting('goalWeightKg', null);
        close(); refresh();
      });
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const val = parseFloat(input.value);
        if (!val || val <= 0 || val > parseFloat(input.max)) { toast('Enter a valid target weight.', { type: 'error' }); return; }
        await setSetting('goalWeightKg', fromDisplayWeight(val, settings.unit));
        close(); refresh();
      });
    });
    root.querySelector('#btn-height').addEventListener('click', () => {
      const heightUnit = settings.unit === 'lb' ? 'in' : 'cm';
      const currentDisplay = settings.heightCm != null ? fmtHeight(toDisplayHeight(settings.heightCm, settings.unit)) : '';
      const el = h(`<div>
        <div class="sheet__title" style="margin-bottom:16px">Height</div>
        <div class="field">
          <label class="field__label">Height (${heightUnit})</label>
          <input id="height-input" class="input input--numeric" type="number" inputmode="decimal" step="0.1" min="0" max="300" placeholder="e.g. ${heightUnit === 'cm' ? '170' : '67'}" value="${currentDisplay}">
          <div class="field__hint"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>Used only to show your BMI — a rough measure that doesn't account for muscle, frame, or age.</div>
        </div>
        <div class="row" style="gap:8px;margin-top:8px">
          ${settings.heightCm != null ? '<button class="btn btn--ghost btn--block" data-act="clear" type="button">Clear height</button>' : ''}
          <button class="btn btn--primary btn--block" data-act="save" type="button">Save</button>
        </div>
      </div>`);
      const { close } = openDialog(el);
      const input = el.querySelector('#height-input');
      preventWheelChange(input);
      input.focus();
      el.querySelector('[data-act="clear"]')?.addEventListener('click', async () => {
        await setSetting('heightCm', null);
        close(); refresh();
      });
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const val = parseFloat(input.value);
        if (!val || val <= 0 || val > parseFloat(input.max)) { toast('Enter a valid height.', { type: 'error' }); return; }
        await setSetting('heightCm', fromDisplayHeight(val, settings.unit));
        close(); refresh();
      });
    });
    root.querySelector('#theme-toggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      await setSetting('theme', btn.dataset.val);
      global.FatterApp && global.FatterApp.applyTheme(btn.dataset.val);
      refresh();
    });
    root.querySelector('#smart-variation').addEventListener('change', async (e) => {
      await setSetting('smartVariation', e.target.checked);
    });
    root.querySelector('#ocr-enabled').addEventListener('change', async (e) => {
      await setSetting('ocrEnabled', e.target.checked);
    });

    function setRowBusy(el, busy) {
      el.style.pointerEvents = busy ? 'none' : '';
      el.style.opacity = busy ? '0.5' : '';
    }

    root.querySelector('#btn-export-excel').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setRowBusy(btn, true);
      try {
        // settings is already fresh here — every setting change triggers a
        // full refresh(), which re-invokes renderSettings with a new closure.
        const entries = await getAllEntriesSorted();
        if (!entries.length) { toast('Add at least one entry before exporting.', { type: 'error' }); return; }
        const stats = FatterChart.computeStats(entries, settings.unit);
        await FatterExport.exportExcel(entries, settings.unit, stats);
        toast('Excel file ready.');
      } catch (err) {
        toast(err.message || 'Could not generate the Excel file.', { type: 'error' });
      } finally {
        setRowBusy(btn, false);
      }
    });

    root.querySelector('#btn-export-backup').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setRowBusy(btn, true);
      try {
        const entries = await getAllEntriesSorted();
        if (!entries.length) { toast('Nothing to back up yet.', { type: 'error' }); return; }
        // Fetch every photo once and reuse it for both the size estimate and
        // the actual backup build — previously each fetched independently.
        const withPhoto = entries.filter((en) => en.hasPhoto);
        const photos = await Promise.all(withPhoto.map((en) => getPhoto(en.id)));
        const photosById = new Map(withPhoto.map((en, i) => [en.id, photos[i]]));
        const estBytes = await FatterExport.estimateBackupSize(entries, photosById);
        if (estBytes > FatterExport.LARGE_BACKUP_WARN_BYTES) {
          const proceed = await new Promise((resolve) => {
            simpleConfirm({
              title: 'Large backup',
              body: `This backup will be roughly ${(estBytes / (1024 * 1024)).toFixed(0)} MB. Continue?`,
              confirmLabel: 'Continue', destructive: false,
              onConfirm: () => resolve(true),
              onCancel: () => resolve(false), // previously unset — Cancel never resolved this Promise, leaving the Export row disabled forever
            });
          });
          if (!proceed) return;
        }
        const backup = await FatterExport.buildBackup(entries, settings, photosById);
        FatterExport.downloadJson(backup, `fatter-backup-${FatterExport.todayStamp()}.json`);
        toast('Backup downloaded.');
      } catch (err) {
        toast('Could not create the backup.', { type: 'error' });
      } finally {
        setRowBusy(btn, false);
      }
    });

    root.querySelector('#btn-import-backup').addEventListener('click', () => root.querySelector('#import-file-input').click());
    root.querySelector('#btn-add-to-home-screen').addEventListener('click', () => FatterOnboarding.showInstallHelp());
    root.querySelector('#import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const obj = FatterExport.validateBackup(JSON.parse(text));
        openImportSummary(obj);
      } catch (err) {
        toast(err.message || 'Could not read that backup file.', { type: 'error' });
      }
    });

    root.querySelector('#btn-clear-all').addEventListener('click', () => {
      typedConfirm({
        title: 'Clear all data?',
        body: 'This permanently deletes every entry, note, and photo on this device. This cannot be undone.',
        requiredWord: 'DELETE',
        confirmLabel: 'Clear all data',
        onConfirm: async () => {
          await clearAll();
          toast('All data cleared.');
          location.hash = '#/dashboard';
          refresh();
          FatterOnboarding.maybeShow(await getSettings());
        },
      });
    });
  }

  function openImportSummary(obj) {
    const dates = obj.entries.map((e) => e.date).sort();
    // Dates come straight from an untrusted backup file (validateBackup only
    // checks format/version/that entries is an array) — escape before this
    // reaches innerHTML, same as every other user-controlled string in this file.
    const range = dates.length ? `${escapeHtml(dates[0])} to ${escapeHtml(dates[dates.length - 1])}` : '—';
    const el = h(`<div>
      <div class="sheet__title" style="margin-bottom:8px">Import backup</div>
      <p class="text-secondary" style="margin-top:0">${obj.entries.length} entries · ${range}</p>
      <div class="stack" style="margin-top:12px">
        <button class="btn btn--primary btn--block" data-act="merge" type="button">Merge with existing data</button>
        <button class="btn btn--destructive btn--block" data-act="replace" type="button">Replace all existing data</button>
        <button class="btn btn--ghost btn--block" data-act="cancel" type="button">Cancel</button>
      </div>
    </div>`);
    const { close } = openSheet(el);
    let handled = false;
    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="merge"]').addEventListener('click', async () => {
      if (handled) return; // a fast double-tap otherwise imports the whole backup twice
      handled = true;
      close();
      try {
        await FatterExport.restoreBackup(obj, 'merge');
        toast('Backup merged.');
        refresh();
      } catch (err) {
        // restoreBackup can throw (e.g. a corrupted/hand-edited photo.data
        // field failing atob()) — this used to fail with no toast at all,
        // the sheet already closed, so the user saw nothing happen.
        toast('Could not import that backup — the file may be corrupted.', { type: 'error' });
      }
    });
    el.querySelector('[data-act="replace"]').addEventListener('click', () => {
      close();
      typedConfirm({
        title: 'Replace all data?',
        body: 'Every existing entry, note, and photo will be deleted and replaced with the contents of this backup.',
        requiredWord: 'REPLACE',
        confirmLabel: 'Replace data',
        onConfirm: async () => {
          try {
            await FatterExport.restoreBackup(obj, 'replace');
            toast('Backup restored.');
            location.hash = '#/dashboard';
            refresh();
          } catch (err) {
            toast('Could not import that backup — the file may be corrupted.', { type: 'error' });
          }
        },
      });
    });
  }

  // ---------------- global handlers (FAB, hidden file inputs) ----------------

  function initGlobalHandlers() {
    document.getElementById('fab-add').addEventListener('click', startAddEntryFlow);
    document.getElementById('photo-input-camera').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = '';
      handlePickedFile(file);
    });
    document.getElementById('photo-input-library').addEventListener('change', (e) => {
      if (global.__fatterEditPhotoHandler) { global.__fatterEditPhotoHandler(e); return; }
      const file = e.target.files[0]; e.target.value = '';
      handlePickedFile(file);
    });
  }

  global.FatterUI = {
    renderDashboard, renderLog, renderGallery, renderSettings,
    initGlobalHandlers, openSheet,
  };
})(window);
