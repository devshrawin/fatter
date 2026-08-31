// export.js: Excel export (SheetJS, lazy-loaded) and full JSON backup/restore.
// SheetJS is ~860KB, so it's injected on first use rather than at startup.

(function (global) {
  'use strict';

  let sheetjsLoadPromise = null;
  function ensureSheetJS() {
    if (global.XLSX) return Promise.resolve();
    if (sheetjsLoadPromise) return sheetjsLoadPromise;
    sheetjsLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'js/vendor/xlsx.full.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load the Excel export library.'));
      document.head.appendChild(script);
    });
    return sheetjsLoadPromise;
  }

  function todayStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // entries: ascending by date, each { date, weightKg, note, hasPhoto }
  async function exportExcel(entries, unit, stats) {
    await ensureSheetJS();
    const { toDisplayWeight } = FatterDB;
    const XLSX = global.XLSX;

    const rows = [['Date', 'Weight', 'Unit', 'Note', 'Has Photo']];
    entries.forEach((e) => {
      rows.push([
        new Date(e.date + 'T00:00:00'),
        Math.round(toDisplayWeight(e.weightKg, unit) * 10) / 10,
        unit,
        e.note || '',
        e.hasPhoto ? 'Yes' : 'No',
      ]);
    });

    const entriesSheet = XLSX.utils.aoa_to_sheet(rows);
    entriesSheet['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 40 }, { wch: 10 }];
    for (let r = 1; r < rows.length; r++) {
      const dateCell = entriesSheet[XLSX.utils.encode_cell({ r, c: 0 })];
      if (dateCell) { dateCell.t = 'd'; dateCell.z = 'yyyy-mm-dd'; }
      const weightCell = entriesSheet[XLSX.utils.encode_cell({ r, c: 1 })];
      if (weightCell) { weightCell.t = 'n'; weightCell.z = '0.0'; }
    }

    const summaryRows = [
      ['Metric', 'Value'],
      ['Starting weight', stats.start != null ? `${round1(stats.start)} ${unit}` : 'N/A'],
      ['Current weight', stats.current != null ? `${round1(stats.current)} ${unit}` : 'N/A'],
      ['Total change', stats.totalChange != null ? `${signed(round1(stats.totalChange))} ${unit}` : 'N/A'],
      ['Avg weekly change', stats.avgWeeklyChange != null ? `${signed(round1(stats.avgWeeklyChange))} ${unit}/wk` : 'N/A'],
      ['Entries', stats.count],
      ['Exported', new Date().toLocaleString()],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet['!cols'] = [{ wch: 22 }, { wch: 20 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, entriesSheet, 'Entries');
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

    const filename = `ProgressLog_${todayStamp()}.xlsx`;
    await writeWorkbook(XLSX, wb, filename);
  }

  async function writeWorkbook(XLSX, wb, filename) {
    // iOS Safari: an anchor download for a large blob can open in-tab instead
    // of saving. Prefer navigator.share with a File when it can accept one.
    const arrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    if (navigator.canShare && navigator.share) {
      try {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      } catch {
        // fall through to anchor download
      }
    }
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function round1(n) { return Math.round(n * 10) / 10; }
  function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

  // ---------------- JSON backup / restore ----------------

  const BACKUP_FORMAT = 'fatter-backup';
  const BACKUP_VERSION = 1;
  const LARGE_BACKUP_WARN_BYTES = 50 * 1024 * 1024;

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [meta, base64] = dataUrl.split(',');
    const type = /data:(.*);base64/.exec(meta)[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  // Sums stored photo bytes straight off the photos table, without
  // materialising a Map of every photo row first. Applying the base64
  // overhead here gives the size of the file that will actually be written.
  async function estimateBackupSize(includePhotos = true) {
    if (!includePhotos) return 0;
    const bytes = await FatterDB.getPhotoBytes();
    return Math.round(bytes * 1.37); // base64 overhead
  }

  // Number of entries encoded between Blob flushes. Small enough that the
  // JS heap only ever holds a handful of base64 photos, large enough that
  // a photo-free backup is not thousands of Blob constructions.
  const FLUSH_EVERY = 8;

  // Writes the backup straight into a Blob, flushing every few entries.
  //
  // This used to build one plain object holding every photo as a base64 data
  // URL and then JSON.stringify it. Both the object graph and the resulting
  // string sat in the JS heap at once, at roughly 1.37x the raw photo bytes
  // each: a 300 MB photo library needed the better part of a gigabyte of
  // heap to export, and mobile Safari kills the tab well before that. Since
  // IndexedDB is the ONLY copy of the user's data, an export that dies at
  // scale is the worst possible failure in this app.
  //
  // Blob parts are references, not copies, and the browser is free to keep
  // them on disk, so accumulating into a Blob keeps peak heap flat at a few
  // photos regardless of library size.
  //
  // onProgress is called with (done, total) so the caller can show progress
  // on what is now a genuinely long operation.
  async function buildBackupBlob({ entries, settings, includePhotos = true, onProgress } = {}) {
    let acc = new Blob([]);
    let parts = [];
    const flush = () => {
      if (!parts.length) return;
      acc = new Blob([acc, ...parts], { type: 'application/json' });
      parts = [];
    };

    parts.push(JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      photosIncluded: !!includePhotos,
      settings,
    }).slice(0, -1)); // drop the closing brace; entries are appended into it
    parts.push(',"entries":[');

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const row = {
        date: e.date,
        weightKg: e.weightKg,
        note: e.note,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
      if (includePhotos && e.hasPhoto) {
        // Fetched one at a time and released immediately after encoding,
        // rather than pre-loading every photo in the library up front.
        const photo = await FatterDB.getPhoto(e.id);
        if (photo) {
          row.photo = {
            data: await blobToDataUrl(photo.blob),
            thumbData: await blobToDataUrl(photo.thumbBlob),
            width: photo.width,
            height: photo.height,
            type: photo.type,
          };
        }
      }
      parts.push((i ? ',' : '') + JSON.stringify(row));
      if (i % FLUSH_EVERY === FLUSH_EVERY - 1) {
        flush();
        // Yield so a long export cannot lock the UI thread outright.
        await new Promise((r) => setTimeout(r, 0));
        if (onProgress) onProgress(i + 1, entries.length);
      }
    }

    parts.push(']}');
    flush();
    if (onProgress) onProgress(entries.length, entries.length);
    return acc;
  }

  function downloadBackupBlob(blob, filename) {
    downloadBlob(blob, filename);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Beyond the top-level shape, each entry's date/weightKg used to go
  // unvalidated. A hand-edited or corrupted backup would import
  // "successfully" and then render literal "NaN" (Log/Dashboard weight) or
  // "Invalid Date" (Log/detail sheet date) for that row with no error ever
  // surfaced. Rejecting up front is safer than importing corrupted rows
  // silently.
  function validateBackup(obj) {
    if (!obj || obj.format !== BACKUP_FORMAT) throw new Error('This file is not a Fatter backup.');
    if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Fatter.');
    if (!Array.isArray(obj.entries)) throw new Error('This backup file looks corrupted.');
    for (const e of obj.entries) {
      if (!e || typeof e.date !== 'string' || !DATE_RE.test(e.date) || Number.isNaN(Date.parse(e.date))) {
        throw new Error('This backup file looks corrupted (invalid entry date).');
      }
      if (typeof e.weightKg !== 'number' || !Number.isFinite(e.weightKg) || e.weightKg <= 0) {
        throw new Error('This backup file looks corrupted (invalid entry weight).');
      }
    }
    return obj;
  }

  // mode: 'merge' | 'replace'
  async function restoreBackup(obj, mode) {
    const { db } = FatterDB;
    await db.transaction('rw', db.entries, db.photos, db.settings, async () => {
      if (mode === 'replace') {
        await db.entries.clear();
        await db.photos.clear();
      }
      if (obj.settings) {
        for (const [key, value] of Object.entries(obj.settings)) {
          await db.settings.put({ key, value });
        }
      }
      for (const row of obj.entries) {
        const id = await db.entries.add({
          date: row.date,
          weightKg: row.weightKg,
          note: row.note || '',
          hasPhoto: row.photo ? 1 : 0,
          createdAt: row.createdAt || Date.parse(obj.exportedAt) || 0,
          updatedAt: row.updatedAt || row.createdAt || 0,
        });
        if (row.photo) {
          await db.photos.put({
            entryId: id,
            blob: dataUrlToBlob(row.photo.data),
            thumbBlob: dataUrlToBlob(row.photo.thumbData),
            width: row.photo.width,
            height: row.photo.height,
            type: row.photo.type,
            size: 0,
          });
        }
      }
    });
  }

  global.FatterExport = {
    exportExcel,
    buildBackupBlob,
    downloadBackupBlob,
    validateBackup,
    restoreBackup,
    estimateBackupSize,
    LARGE_BACKUP_WARN_BYTES,
    todayStamp,
  };
})(window);
