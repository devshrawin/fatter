// log-gallery.js implements the Log (timeline) and Gallery (photo grid +
// lightbox) routes. Depends on ui-core.js and on FatterUI.openEntryDetail,
// defined in entry-form.js, so load order in index.html must reflect that.

(function (global) {
  'use strict';

  const { h, fmtDate, fmtMonth, fmtWeight, round1, escapeHtml, deltaSpan,
    freshViewPool, openSheet } = FatterUICore;
  const { getSettings, getAllEntriesSorted, getPhoto, toDisplayWeight } = FatterDB;

  async function renderLog(root) {
    const pool = freshViewPool();
    const [settings, entries] = await Promise.all([getSettings(), getAllEntriesSorted()]);
    const unit = settings.unit;

    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No entries yet</div><div class="empty-state__body">Entries you add will show up here in a timeline.</div></div>`;
      return;
    }

    root.innerHTML = '';
    const desc = [...entries].reverse();

    // Fetch every photo up front in parallel instead of one-at-a-time inside
    // the render loop below. A sequential await per row serializes dozens
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
        thumbEl.innerHTML = `<img src="${pool.get('log-' + entry.id, photo.thumbBlob)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      } else {
        thumbEl.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><use href="#icon-image"/></svg>`;
      }
      row.addEventListener('click', () => FatterUI.openEntryDetail(entry.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') FatterUI.openEntryDetail(entry.id); });
      root.appendChild(row);
    }
  }

  async function renderGallery(root) {
    const pool = freshViewPool();
    const entries = (await getAllEntriesSorted()).filter((e) => e.hasPhoto).reverse();
    if (!entries.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state__title">No photos yet</div><div class="empty-state__body">Photos from your entries will appear here.</div></div>`;
      return;
    }
    root.innerHTML = '<div class="gallery-grid"></div>';
    const grid = root.querySelector('.gallery-grid');
    // Parallel fetch. See renderLog for why (Promise.all preserves order).
    const photos = await Promise.all(entries.map((e) => getPhoto(e.id)));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const photo = photos[i];
      if (!photo) continue;
      const tile = h(`<div class="gallery-tile">
        <img src="${pool.get('gal-' + entry.id, photo.thumbBlob)}" alt="Progress photo, ${fmtDate(entry.date)}" loading="lazy">
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
