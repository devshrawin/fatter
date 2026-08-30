// ui-core.js: DOM/formatting helpers and the modal/sheet host shared by
// every view file (js/views/*.js) and by ui.js itself. Must load before all
// of those; nothing here depends on any view file.

(function (global) {
  'use strict';

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Same accent color regardless of direction, since gaining isn't "bad" here.
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
        // onConfirm used to run unguarded, so a rejection (e.g. clearAll()
        // hitting a quota/transaction error) vanished silently with no
        // feedback at all, since the dialog was already closed.
        toast(err instanceof FatterDB.FatterError ? err.message : 'Something went wrong. Please try again.', { type: 'error' });
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
    // onCancel fires synchronously (not awaited): Cancel should feel instant,
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
        toast(err instanceof FatterDB.FatterError ? err.message : 'Something went wrong. Please try again.', { type: 'error' });
      }
    });
  }

  // ---------------- per-view object URL pool ----------------
  //
  // Object URLs created while rendering a *view*. Each render* function
  // (in js/views/*.js) calls freshViewPool() at the start of its own
  // render. This revokes whatever pool the PREVIOUS render left behind
  // (whichever view that was) and hands back a new one, so scrolling a
  // gallery of dozens of thumbnails never leaks a URL per photo, and
  // switching views/routes doesn't leak the outgoing view's URLs either.
  let currentViewPool = FatterImage.createObjectUrlPool();
  function freshViewPool() {
    currentViewPool.revokeAll();
    currentViewPool = FatterImage.createObjectUrlPool();
    return currentViewPool;
  }

  global.FatterUICore = {
    h, fmtDate, fmtMonth, round1, fmtWeight, fmtHeight, fmtEta, todayISO,
    escapeHtml, deltaSpan, toast, preventWheelChange,
    openOverlay, openSheet, openDialog, closeModal,
    typedConfirm, simpleConfirm, freshViewPool,
  };
  // openSheet is also part of the public FatterUI contract: onboarding.js
  // calls FatterUI.openSheet directly to reopen the install-help content.
  global.FatterUI = global.FatterUI || {};
  global.FatterUI.openSheet = openSheet;
})(window);
