// entry-form.js holds the Add/Edit Entry flow, the entry detail sheet, and
// the photo-source picker that starts it. Depends on ui-core.js (loaded
// first). It exposes openEntryDetail/startAddEntryFlow/handlePickedFile on
// FatterUI; those are the only pieces of this file other views
// (dashboard.js, log-gallery.js) or ui.js's global FAB/file-input handlers
// call into.

(function (global) {
  'use strict';

  const { h, toast, escapeHtml, preventWheelChange, todayISO, fmtWeight, fmtDate,
    openOverlay, openSheet, simpleConfirm } = FatterUICore;
  const { db, getSettings, getLatestEntry, createEntry, updateEntry, deleteEntry,
    getPhoto, suggestWeightKg, toDisplayWeight, fromDisplayWeight, FatterError } = FatterDB;

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

  // Deliberately bypasses openOverlay/openDialog, because those call
  // closeModal() first thing, which would silently close an Add/Edit Entry
  // sheet still open behind this spinner (e.g. Edit Entry's "Change photo"
  // picks a file while the edit sheet is up; this needs to show ON TOP of
  // it, not evict it. That eviction was a real bug: the edit sheet vanished
  // mid-flow and whatever was typed got lost). Manages its own overlay
  // element instead.
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
    const initialHint = suggestedDisplay ? 'From your last entry. Type to replace' : '';

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
          <button id="entry-read-scale" class="btn btn--secondary btn--sm" type="button" hidden style="margin-top:8px">
            <svg class="icon" viewBox="0 0 24 24"><use href="#icon-camera"/></svg> Read from the scale
          </button>
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

    // Read the number off the scale display. This runs in the background and
    // never blocks the modal, and it never overwrites a value the user has
    // already started typing.
    //
    // It only fills the field on its own when the reading is unambiguous.
    // Anything less offers the "point at the display" sheet instead, because
    // an automatic crop that lands off the display can still decode cleanly
    // and hand back a confident wrong number, and a silently wrong weight in
    // a health log is worse than no suggestion at all.
    function applyReading(value, certain) {
      if (weightEdited) return;
      weightInput.value = fmtWeight(value);
      weightInput.classList.add('input--suggested');
      hint.style.display = 'flex';
      hintText.textContent = certain ? "Read from your scale. Check it's correct" : "Check this against your scale";
    }

    function offerScaleReader() {
      const readBtn = el.querySelector('#entry-read-scale');
      if (readBtn) readBtn.hidden = false;
    }

    el.querySelector('#entry-read-scale').addEventListener('click', () => {
      FatterScaleReader.open(photoPayload.blob, unit, (value) => {
        weightEdited = false;
        applyReading(value, true);
        weightEdited = true;   // treat a deliberate pick as user-entered
      });
    });

    // Deliberately no automatic fill from an automatically located crop.
    // Automatic localisation is not reliable enough to trust unsupervised:
    // when it lands off the display, whatever marks it does find can still
    // decode cleanly and score high, so it hands back a confident wrong
    // number. Measured on a real photo of a scale reading 142.7, the
    // automatic crop confidently produced 111.1. A wrong weight written into
    // a health log is worse than no suggestion, so a reading is only ever
    // taken from a crop the user has actually confirmed.
    if (ocrPending) {
      offerScaleReader();
      if (!weightEdited) {
        hint.style.display = 'flex';
        hintText.textContent = suggestedDisplay
          ? 'From your last entry. Type to replace, or read it from the scale'
          : 'Type your weight, or read it from the scale';
      }
    }

    el.querySelector('[data-act="cancel"]').addEventListener('click', close);
    const saveBtn = el.querySelector('[data-act="save"]');
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return; // a fast double-tap fires twice before the first Save resolves, so guard against duplicate entries
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
      } catch (err) {
        errEl.textContent = err instanceof FatterError ? err.message : 'Could not save this entry.';
        errEl.style.display = 'block';
        saveBtn.disabled = false;
      }
    });
  }

  // settings: caller (openEntryDetail) already has a fresh copy. Reuse it
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
    // earlier in the DOM than the weight field). Override it, matching Add
    // Entry's behavior, so the field a user most often changes is ready to type.
    weightInput.focus();
    weightInput.select();

    // A rotate and a "change photo" pick are both async and both end by
    // overwriting newPhotoPayload/previewUrl. If a user fires both close
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
    // Ensures both the rotate and remove buttons exist, which is needed
    // after Remove-photo has torn them down and the user then picks a new photo.
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
          if (myOp !== photoOpToken) { return; } // a photo pick finished first, so don't clobber it with a rotation of the old photo
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
    global.__fatterEditPhotoHandler = onNewPhotoPicked; // wired via ui.js's delegated listener

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
      } catch (err) {
        editSaveBtn.disabled = false;
        errEl.textContent = err instanceof FatterError ? err.message : 'Could not save this entry.';
        errEl.style.display = 'block';
      }
    });
    function teardownEdit() { global.__fatterEditPhotoHandler = null; }
  }

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
        },
      });
    });
  }

  global.FatterUI = global.FatterUI || {};
  Object.assign(global.FatterUI, { openEntryDetail, startAddEntryFlow, handlePickedFile });
})(window);
