// log-gallery.js implements the Log (timeline) and Gallery (photo grid +
// lightbox + compare) routes. Depends on ui-core.js and on
// FatterUI.openEntryDetail, defined in entry-form.js, so load order in
// index.html must reflect that.

(function (global) {
  'use strict';

  const { h, fmtDate, fmtMonth, fmtWeight, round1, escapeHtml, deltaSpan,
    freshViewPool, openSheet } = FatterUICore;
  const { getSettings, getAllEntriesSorted, getEntriesWithPhotosSorted, getPhoto,
    toDisplayWeight } = FatterDB;

  // Rows appended per batch. The Log used to build a DOM row for every entry
  // and decode every thumbnail before showing anything: fine at 70 entries,
  // a multi-second freeze and a large memory spike at several hundred with
  // photos. Batches are appended as the user reaches them instead.
  const LOG_PAGE = 40;
  const GALLERY_PAGE = 60;

  // Filter state lives at module scope, not per render. Any write anywhere in
  // the app re-renders the current route through the liveQuery subscription
  // in app.js, and a search the user just typed must survive that.
  let logQuery = '';
  let logFilter = 'all'; // 'all' | 'photo' | 'note'

  // Paging.
  //
  // The visible control is a real "Show more" button, and auto-paging is only
  // an enhancement layered on top of it: a throttled scroll listener that
  // presses the button early when the user gets near it. That ordering is
  // deliberate. Both IntersectionObserver callbacks and scroll events are
  // delivered on the rendering steps, so both go silent whenever the page is
  // not compositing (a backgrounded tab, an offscreen webview). Hanging the
  // ONLY route to rows 41+ off an event that can stop firing would mean a
  // list that silently ends, with nothing on screen to say otherwise. The
  // same suspension already bit the scale reader, which had to move its
  // debounce off requestAnimationFrame.
  //
  // loadMore() resolves true while more pages remain. Returns a handle whose
  // detach() removes the listeners; the handler also self-detaches once the
  // button leaves the document, which is what happens when the route
  // re-renders under the liveQuery subscription.
  function attachInfiniteScroll(sentinel, loadMore) {
    const NEAR_PX = 600;
    let loading = false;
    let done = false;
    let queued = false;

    function detach() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    }

    async function page() {
      if (loading || done) return;
      loading = true;
      let more = false;
      try {
        more = await loadMore();
      } finally {
        loading = false;
      }
      if (!more) { done = true; detach(); }
      return more;
    }

    async function check() {
      if (loading || done) return;
      if (!sentinel.isConnected) { done = true; detach(); return; }
      if (sentinel.getBoundingClientRect().top > window.innerHeight + NEAR_PX) return;
      const more = await page();
      // One page may not be enough to push the button back off screen on a
      // tall viewport, so keep going until it is.
      if (more) check();
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; check(); }, 100);
    }

    sentinel.addEventListener('click', () => { page(); });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    check();
    return { detach, check, page };
  }

  function matchesFilters(entry) {
    if (logFilter === 'photo' && !entry.hasPhoto) return false;
    if (logFilter === 'note' && !(entry.note || '').trim()) return false;
    const q = logQuery.trim().toLowerCase();
    if (!q) return true;
    // Match the note, the raw ISO date and the formatted date, so both
    // "2025-03" and "Mar" find the same rows.
    return (entry.note || '').toLowerCase().includes(q)
      || entry.date.includes(q)
      || fmtDate(entry.date).toLowerCase().includes(q);
  }

  async function renderLog(root) {
    const pool = freshViewPool();
    const [settings, entries] = await Promise.all([getSettings(), getAllEntriesSorted()]);
    const unit = settings.unit;

    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No entries yet</div><div class="empty-state__body">Entries you add will show up here in a timeline.</div></div>`;
      return;
    }

    // Chronological position by id, so a row's delta is always measured
    // against the previous entry in real time rather than the previous
    // VISIBLE row, which would silently change meaning under a filter.
    const chronoIndexById = new Map(entries.map((e, i) => [e.id, i]));

    root.innerHTML = `
      <div class="log-controls">
        <div class="log-search">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-search"/></svg>
          <input id="log-search-input" type="search" placeholder="Search" autocomplete="off" value="${escapeHtml(logQuery)}">
        </div>
        <div class="segmented" id="log-filter-toggle">
          <button class="segmented__item ${logFilter === 'all' ? 'is-active' : ''}" data-val="all" type="button">All</button>
          <button class="segmented__item ${logFilter === 'photo' ? 'is-active' : ''}" data-val="photo" type="button">Photos</button>
          <button class="segmented__item ${logFilter === 'note' ? 'is-active' : ''}" data-val="note" type="button">Notes</button>
        </div>
      </div>
      <div id="log-list"></div>
      <button id="log-sentinel" class="btn btn--secondary show-more" type="button" hidden></button>`;

    const list = root.querySelector('#log-list');
    const sentinel = root.querySelector('#log-sentinel');
    const searchInput = root.querySelector('#log-search-input');

    let visible = [];
    let cursor = 0;
    let lastMonth = null;
    let infinite = null;

    async function appendPage() {
      const slice = visible.slice(cursor, cursor + LOG_PAGE);
      if (!slice.length) return false;
      cursor += slice.length;

      // Only this page's photos are read, in parallel. Reading the whole
      // library up front was the actual cost in the old version.
      const withPhoto = slice.filter((e) => e.hasPhoto);
      const photos = await Promise.all(withPhoto.map((e) => getPhoto(e.id)));
      const photoById = new Map(withPhoto.map((e, i) => [e.id, photos[i]]));

      const frag = document.createDocumentFragment();
      for (const entry of slice) {
        const month = fmtMonth(entry.date);
        if (month !== lastMonth) {
          frag.appendChild(h(`<div class="timeline-month">${month}</div>`));
          lastMonth = month;
        }
        const prevChrono = entries[chronoIndexById.get(entry.id) - 1];
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
          thumbEl.innerHTML = `<img src="${pool.get('log-' + entry.id, photo.thumbBlob)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
        } else {
          thumbEl.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><use href="#icon-image"/></svg>`;
        }
        row.addEventListener('click', () => FatterUI.openEntryDetail(entry.id));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') FatterUI.openEntryDetail(entry.id); });
        frag.appendChild(row);
      }
      list.appendChild(frag);
      const remaining = visible.length - cursor;
      sentinel.hidden = remaining <= 0;
      sentinel.textContent = `Show ${Math.min(LOG_PAGE, remaining)} more`;
      return remaining > 0;
    }

    async function applyFilters() {
      if (infinite) { infinite.detach(); infinite = null; }
      visible = [...entries].reverse().filter(matchesFilters);
      cursor = 0;
      lastMonth = null;
      list.innerHTML = '';
      if (!visible.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state__title">Nothing matches</div><div class="empty-state__body">Try a different search or filter.</div></div>`;
        return;
      }
      infinite = attachInfiniteScroll(sentinel, appendPage);
    }

    // Debounced so each keystroke does not rebuild the list.
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { logQuery = searchInput.value; applyFilters(); }, 160);
    });
    root.querySelector('#log-filter-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      root.querySelectorAll('#log-filter-toggle .segmented__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      logFilter = btn.dataset.val;
      applyFilters();
    });

    await applyFilters();
  }

  // ---------------- Gallery ----------------

  // Selection state for compare mode. Reset on every route render so it
  // cannot outlive the tiles it refers to.
  let compareMode = false;
  let compareIds = [];

  async function renderGallery(root) {
    const pool = freshViewPool();
    // Index lookup rather than loading every entry and filtering in JS.
    const entries = (await getEntriesWithPhotosSorted()).reverse();
    compareMode = false;
    compareIds = [];

    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No photos yet</div><div class="empty-state__body">Photos from your entries will appear here.</div></div>`;
      return;
    }

    root.innerHTML = `
      <div class="log-controls log-controls--gallery">
        <div class="text-tertiary" style="font-size:12px">${entries.length} photo${entries.length === 1 ? '' : 's'}</div>
        <button class="btn btn--secondary btn--sm" id="gallery-compare-btn" type="button">Compare</button>
      </div>
      <div id="compare-hint" class="privacy-banner" hidden>
        <svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
        <div style="flex:1" id="compare-hint-text">Pick two photos to compare.</div>
      </div>
      <div class="gallery-grid"></div>
      <button id="gallery-sentinel" class="btn btn--secondary show-more" type="button" hidden></button>`;

    const grid = root.querySelector('.gallery-grid');
    const sentinel = root.querySelector('#gallery-sentinel');
    const compareBtn = root.querySelector('#gallery-compare-btn');
    const hint = root.querySelector('#compare-hint');
    const hintText = root.querySelector('#compare-hint-text');

    let cursor = 0;

    function updateHint() {
      hintText.textContent = compareIds.length === 0
        ? 'Pick two photos to compare.'
        : compareIds.length === 1
          ? 'Pick one more.'
          : 'Opening comparison...';
    }

    function onTileClick(entry, indexInList, tile) {
      if (!compareMode) { openLightbox(entries, indexInList); return; }
      const at = compareIds.indexOf(entry.id);
      if (at >= 0) {
        compareIds.splice(at, 1);
        tile.classList.remove('is-selected');
      } else {
        if (compareIds.length === 2) return; // already have a pair; deselect one first
        compareIds.push(entry.id);
        tile.classList.add('is-selected');
      }
      updateHint();
      if (compareIds.length === 2) {
        const [a, b] = compareIds.map((id) => entries.find((e) => e.id === id));
        // Always show the older photo on the left, whatever order they were tapped in.
        const pair = a.date <= b.date ? [a, b] : [b, a];
        openCompare(pair[0], pair[1]);
        exitCompare();
      }
    }

    function exitCompare() {
      compareMode = false;
      compareIds = [];
      compareBtn.textContent = 'Compare';
      compareBtn.classList.remove('btn--primary');
      compareBtn.classList.add('btn--secondary');
      hint.hidden = true;
      grid.querySelectorAll('.gallery-tile').forEach((t) => t.classList.remove('is-selected'));
      grid.classList.remove('gallery-grid--selecting');
    }

    compareBtn.addEventListener('click', () => {
      if (compareMode) { exitCompare(); return; }
      compareMode = true;
      compareIds = [];
      compareBtn.textContent = 'Cancel';
      compareBtn.classList.remove('btn--secondary');
      compareBtn.classList.add('btn--primary');
      hint.hidden = false;
      grid.classList.add('gallery-grid--selecting');
      updateHint();
    });

    async function appendPage() {
      const slice = entries.slice(cursor, cursor + GALLERY_PAGE);
      if (!slice.length) return false;
      const startIndex = cursor;
      cursor += slice.length;
      const photos = await Promise.all(slice.map((e) => getPhoto(e.id)));
      const frag = document.createDocumentFragment();
      slice.forEach((entry, i) => {
        const photo = photos[i];
        if (!photo) return;
        const tile = h(`<div class="gallery-tile">
          <img src="${pool.get('gal-' + entry.id, photo.thumbBlob)}" alt="Progress photo, ${fmtDate(entry.date)}" loading="lazy">
          <div class="gallery-tile__overlay">${fmtDate(entry.date)}</div>
          <div class="gallery-tile__check"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg></div>
        </div>`);
        tile.addEventListener('click', () => onTileClick(entry, startIndex + i, tile));
        frag.appendChild(tile);
      });
      grid.appendChild(frag);
      const remaining = entries.length - cursor;
      sentinel.hidden = remaining <= 0;
      sentinel.textContent = `Show ${Math.min(GALLERY_PAGE, remaining)} more`;
      return remaining > 0;
    }

    attachInfiniteScroll(sentinel, appendPage);
  }

  // ---------------- Compare ----------------

  async function openCompare(older, newer) {
    const settings = await getSettings();
    const unit = settings.unit;
    const [photoA, photoB] = await Promise.all([getPhoto(older.id), getPhoto(newer.id)]);
    if (!photoA || !photoB) return;

    const days = Math.round(
      (new Date(newer.date + 'T00:00:00') - new Date(older.date + 'T00:00:00')) / 86400000
    );
    const deltaDisplay = round1(toDisplayWeight(newer.weightKg - older.weightKg, unit));
    const weeks = days / 7;
    const perWeek = weeks >= 1 ? round1(deltaDisplay / weeks) : null;

    const el = h(`<div>
      <div class="row row--between" style="margin-bottom:10px">
        <div class="sheet__title">Compare</div>
        <button class="sheet__close" data-act="close" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>
      </div>
      <div class="compare-pair">
        <figure class="compare-side">
          <img id="cmp-a" alt="Progress photo, ${fmtDate(older.date)}">
          <figcaption>
            <div class="compare-side__date">${fmtDate(older.date)}</div>
            <div class="compare-side__weight">${fmtWeight(toDisplayWeight(older.weightKg, unit))} ${unit}</div>
          </figcaption>
        </figure>
        <figure class="compare-side">
          <img id="cmp-b" alt="Progress photo, ${fmtDate(newer.date)}">
          <figcaption>
            <div class="compare-side__date">${fmtDate(newer.date)}</div>
            <div class="compare-side__weight">${fmtWeight(toDisplayWeight(newer.weightKg, unit))} ${unit}</div>
          </figcaption>
        </figure>
      </div>
      <div class="compare-summary">
        <div>${days} day${days === 1 ? '' : 's'} apart</div>
        <div>${deltaSpan(deltaDisplay, unit)}</div>
        ${perWeek != null ? `<div class="text-tertiary" style="font-size:11px">${perWeek > 0 ? '+' : ''}${perWeek} ${unit}/week</div>` : ''}
      </div>
    </div>`);

    // Both object URLs are revoked together on close; the sheet is the only
    // thing holding them.
    const urlA = URL.createObjectURL(photoA.blob);
    const urlB = URL.createObjectURL(photoB.blob);
    el.querySelector('#cmp-a').src = urlA;
    el.querySelector('#cmp-b').src = urlB;

    const { close } = openSheet(el, {
      onClose: () => { URL.revokeObjectURL(urlA); URL.revokeObjectURL(urlB); },
    });
    el.querySelector('[data-act="close"]').addEventListener('click', close);
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
    let requestId = 0; // rapid Prev/Next fires overlapping getPhoto() calls with no ordering guarantee, so only the latest request may touch shared state
    const { close } = openSheet(el, { onClose: () => { if (currentUrl) URL.revokeObjectURL(currentUrl); } });
    const settings = await getSettings(); // unit doesn't change while the lightbox is open, so fetch once, not per navigation
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

  global.FatterUI = global.FatterUI || {};
  Object.assign(global.FatterUI, { renderLog, renderGallery });
})(window);
