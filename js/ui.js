// ui.js — view rendering, modals/sheets, toasts, and the add/edit entry flow.
// app.js owns routing/bootstrap and calls into the render* functions here.

(function (global) {
  'use strict';

  const { db, getSettings, setSetting, getAllEntriesSorted, getLatestEntry,
    createEntry, updateEntry, deleteEntry, getPhoto, clearAll, suggestWeightKg,
    toDisplayWeight, fromDisplayWeight, getStorageEstimate, requestPersistence,
    FatterError } = FatterDB;

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
      close();
      await onConfirm();
    });
  }

  function simpleConfirm({ title, body, confirmLabel = 'Delete', destructive = true, onConfirm }) {
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
    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="confirm"]').addEventListener('click', async () => { close(); await onConfirm(); });
  }

  // ---------------- Dashboard ----------------

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
    root.innerHTML = `
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
      </div>
      <div class="card">
        <div class="chart-wrap"><canvas id="progress-chart" aria-label="Weight progression chart"></canvas></div>
      </div>
      <div id="recent-strip" style="margin-top:16px"></div>`;

    const canvas = root.querySelector('#progress-chart');
    FatterChart.renderChart(canvas, entries, unit);

    const recent = entries.slice(-4).reverse();
    const stripEl = root.querySelector('#recent-strip');
    if (recent.length) {
      stripEl.innerHTML = `<div class="timeline-month">Recent</div><div class="gallery-grid" style="grid-template-columns:repeat(4,1fr)"></div>`;
      const grid = stripEl.querySelector('.gallery-grid');
      for (const entry of recent) {
        grid.appendChild(await photoTile(entry));
      }
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
      if (entry.hasPhoto) {
        const photo = await getPhoto(entry.id);
        if (photo) thumbEl.innerHTML = `<img src="${viewUrlPool.get('log-' + entry.id, photo.thumbBlob)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
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
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const photo = await getPhoto(entry.id);
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
      <div style="border-radius:var(--r-lg);overflow:hidden;background:var(--surface-sunken)">
        <img id="lb-img" style="width:100%;display:block" alt="">
      </div>
      <div class="row" style="justify-content:center;gap:16px;margin-top:12px">
        <button class="btn btn--secondary" data-act="prev" type="button">Prev</button>
        <button class="btn btn--secondary" data-act="next" type="button">Next</button>
      </div>
    </div>`);
    let currentUrl = null;
    const { close } = openSheet(el, { onClose: () => { if (currentUrl) URL.revokeObjectURL(currentUrl); } });
    async function show(n) {
      i = (n + entries.length) % entries.length;
      const entry = entries[i];
      const photo = await getPhoto(entry.id);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(photo.blob);
      el.querySelector('#lb-img').src = currentUrl;
      const settings = await getSettings();
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
      ${photo ? `<img id="detail-photo" style="width:100%;border-radius:var(--r-lg);margin-bottom:12px" alt="">` : ''}
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
    el.querySelector('[data-act="edit"]').addEventListener('click', () => { close(); openEditEntry(entry); });
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

  let compressingToastTimer = null;
  function showCompressing() {
    const el = h(`<div class="row" style="justify-content:center;padding:24px 0;gap:10px"><div class="spinner"></div><span>Preparing photo…</span></div>`);
    return openDialog(el);
  }

  async function handlePickedFile(file) {
    if (!file) return;
    const loading = showCompressing();
    try {
      const payload = await FatterImage.compressPhoto(file);
      loading.close();
      openAddEntryModal(payload);
    } catch (err) {
      loading.close();
      if (err && err.code === 'UNSUPPORTED_FORMAT') {
        toast(err.message, { type: 'error', duration: 7000 });
      } else {
        toast('Something went wrong processing that photo. Please try another.', { type: 'error' });
      }
    }
  }

  async function openAddEntryModal(photoPayload) {
    const [settings, latest] = await Promise.all([getSettings(), getLatestEntry()]);
    const unit = settings.unit;
    const suggestedKg = await suggestWeightKg(settings.smartVariation);
    const suggestedDisplay = suggestedKg != null ? fmtWeight(toDisplayWeight(suggestedKg, unit)) : '';
    const photoUrl = URL.createObjectURL(photoPayload.blob);

    const el = h(`<div>
      <div class="sheet--form__topbar">
        <button class="sheet--form__topbar-btn" data-act="cancel" type="button">Cancel</button>
        <div class="sheet__title">Add entry</div>
        <div style="width:52px"></div>
      </div>
      <div class="sheet--form__body">
        <img id="entry-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card);margin-bottom:18px" alt="Selected photo">
        <div class="field">
          <label class="field__label">Weight (${unit})</label>
          <input id="entry-weight" class="input input--numeric ${suggestedDisplay ? 'input--suggested' : ''}" type="number" inputmode="decimal" step="0.1" min="0" max="1000" placeholder="e.g. 70.0" value="${suggestedDisplay}">
          ${suggestedDisplay ? `<div id="suggested-hint" class="field__hint"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>From your last entry — type to replace</div>` : ''}
        </div>
        <div class="field">
          <label class="field__label">Date</label>
          <input id="entry-date" class="input" type="date" value="${todayISO()}" max="${todayISO()}">
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
    const hint = el.querySelector('#suggested-hint');
    preventWheelChange(weightInput);
    weightInput.addEventListener('input', () => {
      weightInput.classList.remove('input--suggested');
      if (hint) hint.remove();
    }, { once: true });

    function cleanup() { URL.revokeObjectURL(photoUrl); }
    const { close } = openOverlay(el, { form: true, onClose: cleanup });
    // select suggested text so typing overwrites it immediately
    weightInput.focus();
    weightInput.select();

    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const errEl = el.querySelector('#entry-error');
      const val = parseFloat(weightInput.value);
      const dateVal = el.querySelector('#entry-date').value || todayISO();
      if (!val || val <= 0) {
        errEl.textContent = 'Enter a valid weight.'; errEl.style.display = 'block'; return;
      }
      const weightKg = fromDisplayWeight(val, unit);
      const note = el.querySelector('#entry-note').value.trim();
      try {
        await createEntry({ date: dateVal, weightKg, note, photoPayload }, Date.now());
        close();
        toast('Entry saved.');
        refresh();
      } catch (err) {
        errEl.textContent = err instanceof FatterError ? err.message : 'Could not save this entry.';
        errEl.style.display = 'block';
      }
    });
  }

  async function openEditEntry(entry) {
    const settings = await getSettings();
    const unit = settings.unit;
    const existingPhoto = entry.hasPhoto ? await getPhoto(entry.id) : null;
    let newPhotoPayload = null;
    let previewUrl = existingPhoto ? URL.createObjectURL(existingPhoto.blob) : null;

    const el = h(`<div>
      <div class="sheet--form__topbar">
        <button class="sheet--form__topbar-btn" data-act="cancel" type="button">Cancel</button>
        <div class="sheet__title">Edit entry</div>
        <div style="width:52px"></div>
      </div>
      <div class="sheet--form__body">
        <div style="position:relative;margin-bottom:18px">
          ${previewUrl ? `<img id="edit-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card)" alt="">` : ''}
          <button class="btn btn--secondary btn--sm" data-act="change-photo" type="button" ${previewUrl ? 'style="position:absolute;right:10px;bottom:10px"' : ''}>Change photo</button>
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
    preventWheelChange(el.querySelector('#entry-weight'));

    function cleanup() { if (previewUrl) URL.revokeObjectURL(previewUrl); }
    const { close } = openOverlay(el, { form: true, onClose: () => { cleanup(); teardownEdit(); } });

    el.querySelector('[data-act="change-photo"]').addEventListener('click', () => {
      document.getElementById('photo-input-library').click();
    });
    async function onNewPhotoPicked(e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const loading = showCompressing();
      try {
        newPhotoPayload = await FatterImage.compressPhoto(file);
        loading.close();
        const url = URL.createObjectURL(newPhotoPayload.blob);
        cleanup(); previewUrl = url;
        let img = el.querySelector('#edit-photo-preview');
        if (!img) {
          img = h(`<img id="edit-photo-preview" style="width:100%;height:200px;object-fit:cover;border-radius:var(--r-card)" alt="">`);
          el.querySelector('[data-act="change-photo"]').parentElement.prepend(img);
        }
        img.src = url;
      } catch (err) {
        loading.close();
        toast(err && err.code === 'UNSUPPORTED_FORMAT' ? err.message : 'Could not process that photo.', { type: 'error', duration: 7000 });
      }
    }
    global.__fatterEditPhotoHandler = onNewPhotoPicked; // wired via app.js delegated listener

    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const errEl = el.querySelector('#entry-error');
      const val = parseFloat(el.querySelector('#entry-weight').value);
      if (!val || val <= 0) { errEl.textContent = 'Enter a valid weight.'; errEl.style.display = 'block'; return; }
      const weightKg = fromDisplayWeight(val, unit);
      const dateVal = el.querySelector('#entry-date').value || entry.date;
      const note = el.querySelector('#entry-note').value.trim();
      try {
        await updateEntry(entry.id, { date: dateVal, weightKg, note, photoPayload: newPhotoPayload }, Date.now());
        close();
        toast('Entry updated.');
        refresh();
      } catch (err) {
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
    root.querySelector('#theme-toggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      await setSetting('theme', btn.dataset.val);
      global.FatterApp && global.FatterApp.applyTheme(btn.dataset.val);
      refresh();
    });
    root.querySelector('#smart-variation').addEventListener('change', async (e) => {
      await setSetting('smartVariation', e.target.checked);
    });

    function setRowBusy(el, busy) {
      el.style.pointerEvents = busy ? 'none' : '';
      el.style.opacity = busy ? '0.5' : '';
    }

    root.querySelector('#btn-export-excel').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setRowBusy(btn, true);
      try {
        const s = await getSettings();
        const entries = await getAllEntriesSorted();
        if (!entries.length) { toast('Add at least one entry before exporting.', { type: 'error' }); return; }
        const stats = FatterChart.computeStats(entries, s.unit);
        await FatterExport.exportExcel(entries, s.unit, stats);
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
        const estBytes = await FatterExport.estimateBackupSize(entries);
        if (estBytes > FatterExport.LARGE_BACKUP_WARN_BYTES) {
          const proceed = await new Promise((resolve) => {
            simpleConfirm({
              title: 'Large backup',
              body: `This backup will be roughly ${(estBytes / (1024 * 1024)).toFixed(0)} MB. Continue?`,
              confirmLabel: 'Continue', destructive: false,
              onConfirm: () => resolve(true),
            });
          });
          if (!proceed) return;
        }
        const s = await getSettings();
        const backup = await FatterExport.buildBackup(entries, s);
        FatterExport.downloadJson(backup, `fatter-backup-${FatterExport.todayStamp()}.json`);
        toast('Backup downloaded.');
      } catch (err) {
        toast('Could not create the backup.', { type: 'error' });
      } finally {
        setRowBusy(btn, false);
      }
    });

    root.querySelector('#btn-import-backup').addEventListener('click', () => root.querySelector('#import-file-input').click());
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
        },
      });
    });
  }

  function openImportSummary(obj) {
    const dates = obj.entries.map((e) => e.date).sort();
    const range = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : '—';
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
    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    el.querySelector('[data-act="merge"]').addEventListener('click', async () => {
      close();
      await FatterExport.restoreBackup(obj, 'merge');
      toast('Backup merged.');
      refresh();
    });
    el.querySelector('[data-act="replace"]').addEventListener('click', () => {
      close();
      typedConfirm({
        title: 'Replace all data?',
        body: 'Every existing entry, note, and photo will be deleted and replaced with the contents of this backup.',
        requiredWord: 'REPLACE',
        confirmLabel: 'Replace data',
        onConfirm: async () => {
          await FatterExport.restoreBackup(obj, 'replace');
          toast('Backup restored.');
          location.hash = '#/dashboard';
          refresh();
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
    initGlobalHandlers, toast, closeModal,
  };
})(window);
