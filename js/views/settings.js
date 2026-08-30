// settings.js implements the Settings route: units/goal/height/theme,
// the two OCR/suggestion toggles, storage usage, Excel/backup export,
// backup import, and Clear All Data. Depends on ui-core.js.

(function (global) {
  'use strict';

  const { h, fmtWeight, fmtHeight, escapeHtml, preventWheelChange, toast,
    openDialog, openSheet, typedConfirm, simpleConfirm, freshViewPool } = FatterUICore;
  const { getSettings, setSetting, getAllEntriesSorted, getPhoto, clearAll,
    toDisplayWeight, fromDisplayWeight, toDisplayHeight, fromDisplayHeight,
    getStorageEstimate, fmtFeetInches, cmToFeetInches, feetInchesToCm } = FatterDB;

  async function renderSettings(root) {
    freshViewPool(); // this view has no photos of its own, but keep the convention: revoke whatever the previously-rendered view left pooled
    const settings = await getSettings();
    const estimate = await getStorageEstimate();
    const usagePct = estimate && estimate.quota ? Math.min(100, Math.round((estimate.usage / estimate.quota) * 100)) : 0;
    const usageMB = estimate ? (estimate.usage / (1024 * 1024)).toFixed(1) : null;
    const quotaMB = estimate ? (estimate.quota / (1024 * 1024)).toFixed(0) : null;
    const storageLabel = usageMB == null
      ? 'Unknown'
      : `${usageMB} MB${quotaMB != null ? ' of ' + quotaMB + ' MB' : ''}`;

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
              <span class="text-secondary">${settings.heightCm == null ? 'Not set'
                : (settings.unit === 'lb' ? fmtFeetInches(settings.heightCm) : fmtHeight(settings.heightCm) + ' cm')}</span>
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
              <div class="settings-row__desc">Adds a small ±0.2–0.5 variation instead of repeating the exact value. Off by default. The suggestion is always editable either way.</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="smart-variation" ${settings.smartVariation ? 'checked' : ''}>
              <span class="toggle__track"><span class="toggle__thumb"></span></span>
            </label>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row__label">Read weight from photo</div>
              <div class="settings-row__desc">Adds a "Read from the scale" button when you add a photo. You drag a box over your scale's display and the number is read straight off it, on this device, with nothing to download. It never fills the weight in on its own; you always confirm what it read.</div>
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
              <span class="text-secondary" style="font-size:12px">${storageLabel}</span>
            </div>
            <div class="meter"><div class="meter__fill" style="width:${usagePct}%"></div></div>
            <div class="row" style="gap:6px;font-size:11px;color:${estimate && estimate.persisted ? 'var(--accent)' : 'var(--text-tertiary)'}">
              <svg class="icon" style="width:12px;height:12px" viewBox="0 0 24 24"><use href="#icon-${estimate && estimate.persisted ? 'check' : 'info'}"/></svg>
              ${estimate && estimate.persisted ? "Storage is persistent, so it won't be cleared automatically" : 'Storage is not yet marked persistent'}
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
        Your photos and weights never leave this device.<br><span id="app-version">Fatter</span>
      </p>`;

    root.querySelector('#unit-toggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      await setSetting('unit', btn.dataset.val);
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
        close();
      });
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const val = parseFloat(input.value);
        if (!val || val <= 0 || val > parseFloat(input.max)) { toast('Enter a valid target weight.', { type: 'error' }); return; }
        await setSetting('goalWeightKg', fromDisplayWeight(val, settings.unit));
        close();
      });
    });
    root.querySelector('#btn-height').addEventListener('click', () => {
      // Imperial gets two fields, feet and inches, because that is how people
      // actually know their height. A single "inches" box asking for 67 is
      // a conversion the user should not have to do in their head.
      const imperial = settings.unit === 'lb';
      const fi = settings.heightCm != null ? cmToFeetInches(settings.heightCm) : null;
      const currentCm = settings.heightCm != null ? fmtHeight(settings.heightCm) : '';
      const el = h(`<div>
        <div class="sheet__title" style="margin-bottom:16px">Height</div>
        <div class="field">
          ${imperial ? `
            <label class="field__label">Height</label>
            <div class="row" style="gap:10px;align-items:flex-end">
              <div style="flex:1">
                <input id="height-ft" class="input input--numeric" type="number" inputmode="numeric" step="1" min="0" max="8" placeholder="5" value="${fi ? fi.ft : ''}">
                <div class="text-tertiary" style="font-size:11px;margin-top:4px;text-align:center">feet</div>
              </div>
              <div style="flex:1">
                <input id="height-in" class="input input--numeric" type="number" inputmode="decimal" step="0.5" min="0" max="11.9" placeholder="7" value="${fi ? fi.in : ''}">
                <div class="text-tertiary" style="font-size:11px;margin-top:4px;text-align:center">inches</div>
              </div>
            </div>
          ` : `
            <label class="field__label">Height (cm)</label>
            <input id="height-input" class="input input--numeric" type="number" inputmode="decimal" step="0.1" min="0" max="300" placeholder="e.g. 170" value="${currentCm}">
          `}
          <div class="field__hint" style="margin-top:10px"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>Used only to show your BMI, a rough measure that doesn't account for muscle, frame, or age.</div>
        </div>
        <div class="row" style="gap:8px;margin-top:8px">
          ${settings.heightCm != null ? '<button class="btn btn--ghost btn--block" data-act="clear" type="button">Clear height</button>' : ''}
          <button class="btn btn--primary btn--block" data-act="save" type="button">Save</button>
        </div>
      </div>`);
      const { close } = openDialog(el);
      const inputs = [...el.querySelectorAll('input')];
      inputs.forEach(preventWheelChange);
      inputs[0].focus();
      el.querySelector('[data-act="clear"]')?.addEventListener('click', async () => {
        await setSetting('heightCm', null);
        close();
      });
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        let cm;
        if (imperial) {
          const ft = parseFloat(el.querySelector('#height-ft').value);
          const inch = parseFloat(el.querySelector('#height-in').value) || 0;
          if (!(ft > 0) || ft > 8 || inch < 0 || inch >= 12) { toast('Enter a valid height.', { type: 'error' }); return; }
          cm = feetInchesToCm(ft, inch);
        } else {
          const input = el.querySelector('#height-input');
          const val = parseFloat(input.value);
          if (!val || val <= 0 || val > parseFloat(input.max)) { toast('Enter a valid height.', { type: 'error' }); return; }
          cm = val;
        }
        if (!(cm > 50 && cm < 260)) { toast('Enter a valid height.', { type: 'error' }); return; }
        await setSetting('heightCm', cm);
        close();
      });
    });
    // Show the app version, plus the cache the service worker is actually
    // serving from. The version alone was hardcoded and never bumped, so it
    // could not answer "did my install update"; the cache name can.
    (async () => {
      const el = root.querySelector('#app-version');
      if (!el || !global.FatterApp) return;
      el.textContent = `Fatter v${global.FatterApp.APP_VERSION}`;
      try {
        const cache = await global.FatterApp.activeCacheVersion();
        if (cache) el.textContent += ` (${cache})`;
      } catch { /* offline or no controller yet; the version alone is fine */ }
    })();

    root.querySelector('#theme-toggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-val]'); if (!btn) return;
      await setSetting('theme', btn.dataset.val);
      global.FatterApp && global.FatterApp.applyTheme(btn.dataset.val);
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
        // settings is already fresh here: every setting change triggers a
        // full re-render of this view (via the liveQuery subscription in
        // app.js), which re-invokes renderSettings with a new closure.
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
        // the actual backup build. Previously each fetched independently.
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
              onCancel: () => resolve(false), // previously unset, so Cancel never resolved this Promise, leaving the Export row disabled forever
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
          if (global.FatterUI && global.FatterUI.resetNudgeState) global.FatterUI.resetNudgeState();
          toast('All data cleared.');
          location.hash = '#/dashboard';
          FatterOnboarding.maybeShow(await getSettings());
        },
      });
    });
  }

  function openImportSummary(obj) {
    const dates = obj.entries.map((e) => e.date).sort();
    // Dates come straight from an untrusted backup file (validateBackup only
    // checks format/version/that entries is an array), so escape before this
    // reaches innerHTML, same as every other user-controlled string in this file.
    const range = dates.length ? `${escapeHtml(dates[0])} to ${escapeHtml(dates[dates.length - 1])}` : 'no dates';
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
      } catch (err) {
        // restoreBackup can throw (e.g. a corrupted/hand-edited photo.data
        // field failing atob()). This used to fail with no toast at all,
        // the sheet already closed, so the user saw nothing happen.
        toast('Could not import that backup. The file may be corrupted.', { type: 'error' });
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
            if (global.FatterUI && global.FatterUI.resetNudgeState) global.FatterUI.resetNudgeState();
            toast('Backup restored.');
            location.hash = '#/dashboard';
          } catch (err) {
            toast('Could not import that backup. The file may be corrupted.', { type: 'error' });
          }
        },
      });
    });
  }

  global.FatterUI = global.FatterUI || {};
  global.FatterUI.renderSettings = renderSettings;
})(window);
