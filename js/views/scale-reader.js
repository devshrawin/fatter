// scale-reader.js: the "point at the display" sheet.
//
// Locating a readout that can be under 1% of a cluttered photo is the hard
// half of reading a scale, and no automatic detector gets it right every
// time. The user already knows exactly where the display is, so this asks
// them: a box is placed over the app's best guess, and dragging it takes one
// gesture. That turns an unsolved computer-vision problem into a gesture, and
// it is honest, because the number shown updates live from whatever is inside
// the box. Nothing is guessed at silently.

(function (global) {
  'use strict';

  const { h, toast } = FatterUICore;

  const MIN_BOX = 24;   // px, in displayed coordinates

  // photoBlob: the compressed photo. unit: 'kg' | 'lb'.
  // onAccept(value) fires when the user takes the reading.
  async function open(photoBlob, unit, onAccept) {
    let bmp;
    try {
      bmp = await createImageBitmap(photoBlob);
    } catch {
      toast('Could not open that photo.', { type: 'error' });
      return;
    }

    const el = h(`<div>
      <div class="sheet__header">
        <div class="sheet__title">Point at the display</div>
        <button class="sheet__close" data-act="close" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>
      </div>
      <p class="text-secondary" style="margin:0 0 12px;font-size:13px">Drag the box over the numbers on your scale. The reading updates as you move it.</p>
      <div id="sr-stage" style="position:relative;width:100%;background:var(--surface-sunken);border-radius:var(--r-card);overflow:hidden;touch-action:none;user-select:none">
        <img id="sr-img" style="width:100%;display:block;pointer-events:none" alt="">
        <div id="sr-box" style="position:absolute;border:2px solid var(--accent);border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);cursor:move">
          <div data-h="nw" style="position:absolute;left:-11px;top:-11px;width:26px;height:26px;border-radius:50%;background:var(--accent);cursor:nwse-resize"></div>
          <div data-h="se" style="position:absolute;right:-11px;bottom:-11px;width:26px;height:26px;border-radius:50%;background:var(--accent);cursor:nwse-resize"></div>
        </div>
      </div>
      <div class="row" style="gap:10px;margin-top:14px;align-items:center;min-height:52px">
        <div id="sr-preview" style="flex:none;height:44px;border-radius:6px;background:var(--surface-sunken);display:flex;align-items:center;justify-content:center;padding:0 6px;min-width:74px;overflow:hidden"></div>
        <div style="flex:1">
          <div id="sr-value" style="font-size:22px;font-weight:700;line-height:1.1">Reading…</div>
          <div id="sr-note" class="text-tertiary" style="font-size:11px;margin-top:2px"></div>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:14px">
        <button class="btn btn--ghost btn--block" data-act="skip" type="button">Enter it myself</button>
        <button class="btn btn--primary btn--block" data-act="use" type="button" disabled>Use this</button>
      </div>
    </div>`);

    const url = URL.createObjectURL(photoBlob);
    el.querySelector('#sr-img').src = url;

    // Deliberately NOT routed through FatterUICore.openSheet. That closes
    // whatever modal is currently open before showing itself, which would
    // dismiss the Add Entry form sitting underneath and throw away everything
    // typed into it. This sheet has to stack on top of that form and hand a
    // value back to it, so it manages its own overlay.
    const overlay = h('<div class="modal-overlay" role="dialog" aria-modal="true"></div>');
    el.classList.add('sheet');
    el.prepend(h('<div class="sheet__handle"></div>'));
    overlay.appendChild(el);
    document.getElementById('modal-root').appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    setTimeout(() => overlay.classList.add('is-open'), 0);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      overlay.classList.remove('is-open');
      document.removeEventListener('keydown', onKeydown);
      setTimeout(() => overlay.remove(), 260);
      URL.revokeObjectURL(url);
    }
    function onKeydown(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const stage = el.querySelector('#sr-stage');
    const boxEl = el.querySelector('#sr-box');
    const valueEl = el.querySelector('#sr-value');
    const noteEl = el.querySelector('#sr-note');
    const previewEl = el.querySelector('#sr-preview');
    const useBtn = el.querySelector('[data-act="use"]');

    // Box position is kept in displayed pixels and mapped to source pixels
    // only when reading, so it survives the image being laid out at any size.
    let box = null;
    let lastValue = null;

    function stageSize() {
      const r = stage.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }

    function seedBox() {
      const s = stageSize();
      if (!s.w || !s.h) return;
      const scale = s.w / bmp.width;
      let guess = null;
      try { guess = FatterSevenSeg.locate(bmp); } catch { guess = null; }
      if (guess) {
        box = { x: guess.x * scale, y: guess.y * scale, w: guess.w * scale, h: guess.h * scale };
      } else {
        // no guess: a wide, short box across the middle, roughly the shape of
        // a readout, so the user is adjusting rather than drawing from scratch
        box = { w: s.w * 0.5, h: s.h * 0.14 };
        box.x = (s.w - box.w) / 2;
        box.y = (s.h - box.h) / 2;
      }
      clampBox();
      drawBox();
      schedule();
    }

    function clampBox() {
      const s = stageSize();
      box.w = Math.max(MIN_BOX, Math.min(box.w, s.w));
      box.h = Math.max(MIN_BOX, Math.min(box.h, s.h));
      box.x = Math.max(0, Math.min(box.x, s.w - box.w));
      box.y = Math.max(0, Math.min(box.y, s.h - box.h));
    }

    function drawBox() {
      boxEl.style.left = box.x + 'px';
      boxEl.style.top = box.y + 'px';
      boxEl.style.width = box.w + 'px';
      boxEl.style.height = box.h + 'px';
    }

    // ---- dragging ----
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (!box) return;
      const handle = e.target.dataset && e.target.dataset.h;
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const inside = px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
      if (!handle && !inside) return;
      drag = { mode: handle || 'move', px, py, start: { ...box } };
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const dx = (e.clientX - r.left) - drag.px, dy = (e.clientY - r.top) - drag.py;
      const s = drag.start;
      if (drag.mode === 'move') { box.x = s.x + dx; box.y = s.y + dy; }
      else if (drag.mode === 'se') { box.w = s.w + dx; box.h = s.h + dy; }
      else if (drag.mode === 'nw') { box.x = s.x + dx; box.y = s.y + dy; box.w = s.w - dx; box.h = s.h - dy; }
      clampBox(); drawBox(); schedule();
      e.preventDefault();
    });
    const endDrag = (e) => { if (drag) { drag = null; if (e && e.pointerId != null) { try { stage.releasePointerCapture(e.pointerId); } catch {} } } };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // ---- live reading ----
    // Reading is cheap but not free, so coalesce while the box is actively
    // moving. This debounces on a timer rather than requestAnimationFrame,
    // because rAF stops firing whenever the page is not compositing (a
    // backgrounded tab, for one) and the reading would silently never update.
    let timer = null;
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; runRead(); }, 60);
    }

    function runRead() {
      if (!box) return;
      const s = stageSize();
      if (!s.w) return;
      const k = bmp.width / s.w;
      const rect = { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k };
      let r;
      try { r = FatterSevenSeg.readRegion(bmp, rect, { unit }); }
      catch { r = { ok: false, reason: 'read failed' }; }

      previewEl.innerHTML = '';
      if (r.crop) {
        r.crop.style.cssText = 'height:44px;image-rendering:pixelated;display:block';
        previewEl.appendChild(r.crop);
      }

      if (r.ok && r.value != null && r.plausible) {
        lastValue = r.value;
        valueEl.textContent = `${r.value} ${unit}`;
        valueEl.style.color = r.confident ? 'var(--accent)' : 'var(--text-primary)';
        noteEl.textContent = r.confident ? 'Clear reading' : 'Looks unclear, check it before using';
        useBtn.disabled = false;
      } else {
        lastValue = null;
        valueEl.textContent = 'No reading';
        valueEl.style.color = 'var(--text-tertiary)';
        noteEl.textContent = r.ok && r.value != null
          ? 'That number is not a plausible weight'
          : 'Move the box over the numbers on the display';
        useBtn.disabled = true;
      }
    }

    el.querySelector('[data-act="close"]').addEventListener('click', close);
    el.querySelector('[data-act="skip"]').addEventListener('click', close);
    useBtn.addEventListener('click', () => {
      if (lastValue == null) return;
      close();
      onAccept(lastValue);
    });

    // The stage needs a layout pass before it has a size to seed into, and the
    // image may finish loading either side of this point. Rather than depend
    // on catching the load event at exactly the right moment, seed from
    // whichever trigger arrives first and make it idempotent.
    let seeded = false;
    function trySeed() {
      if (seeded) return;
      const s = stageSize();
      if (!s.w || !s.h) return;   // no layout yet, wait for a size
      seeded = true;
      if (ro) ro.disconnect();
      seedBox();
    }
    // Seed as soon as the stage actually has a size. Fixed delays are not
    // enough: the sheet animates in, the image decodes on its own schedule,
    // and layout can be deferred entirely while the tab is not being painted,
    // so any hardcoded timeout races one of those. Observing the element is
    // the only trigger that reliably corresponds to "there is a box to seed
    // into now". Also reseed the box on later resizes, since the stored
    // coordinates are in displayed pixels and a rotation would invalidate them.
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => trySeed());
      ro.observe(stage);
    }
    const img = el.querySelector('#sr-img');
    img.addEventListener('load', () => trySeed(), { once: true });
    setTimeout(trySeed, 0);
    setTimeout(trySeed, 200);
    setTimeout(trySeed, 600);
  }

  global.FatterScaleReader = { open };
})(window);
