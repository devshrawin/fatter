// export.js — Excel export (SheetJS, lazy-loaded) and full JSON backup/restore.
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
      ['Starting weight', stats.start != null ? `${round1(stats.start)} ${unit}` : '—'],
      ['Current weight', stats.current != null ? `${round1(stats.current)} ${unit}` : '—'],
      ['Total change', stats.totalChange != null ? `${signed(round1(stats.totalChange))} ${unit}` : '—'],
      ['Avg weekly change', stats.avgWeeklyChange != null ? `${signed(round1(stats.avgWeeklyChange))} ${unit}/wk` : '—'],
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

  // photosById: optional Map<entryId, photo> — the Settings "Export full
  // backup" flow calls this and buildBackup back-to-back on the same entry
  // list, so the caller fetches every photo once and passes the map to both
  // instead of each function re-querying IndexedDB independently.
  async function estimateBackupSize(entries, photosById) {
    let total = 0;
    for (const e of entries) {
      if (!e.hasPhoto) continue;
      const photo = photosById ? photosById.get(e.id) : await FatterDB.getPhoto(e.id);
      if (photo) total += (photo.blob?.size || 0) + (photo.thumbBlob?.size || 0);
    }
    return Math.round(total * 1.37); // base64 overhead
  }

  async function buildBackup(entries, settings, photosById) {
    const out = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      entries: [],
    };
    for (const e of entries) {
      const row = {
        date: e.date,
        weightKg: e.weightKg,
        note: e.note,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
      if (e.hasPhoto) {
        const photo = photosById ? photosById.get(e.id) : await FatterDB.getPhoto(e.id);
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
      out.entries.push(row);
    }
    return out;
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    downloadBlob(blob, filename);
  }

  function validateBackup(obj) {
    if (!obj || obj.format !== BACKUP_FORMAT) throw new Error('This file is not a Fatter backup.');
    if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Fatter.');
    if (!Array.isArray(obj.entries)) throw new Error('This backup file looks corrupted.');
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
          hasPhoto: !!row.photo,
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
    buildBackup,
    downloadJson,
    validateBackup,
    restoreBackup,
    estimateBackupSize,
    LARGE_BACKUP_WARN_BYTES,
    todayStamp,
  };
})(window);
