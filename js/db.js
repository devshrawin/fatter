// db.js: IndexedDB access via Dexie. Single source of truth for all
// persisted data. Nothing in this file talks to a network.
//
// Schema:
//   entries:  { id, date('YYYY-MM-DD'), weightKg, note, hasPhoto(0|1), createdAt, updatedAt }
//   photos:   { entryId, blob, thumbBlob, width, height, type, size }
//   settings: { key, value }
//
// Weight is always stored canonically in kg. Every other unit is a display
// concern handled at the edges (js/ui.js, js/export.js).

(function (global) {
  'use strict';

  const db = new Dexie('fatter-db');

  db.version(1).stores({
    entries: '++id, date, createdAt',
    photos: 'entryId',
    settings: 'key',
  });

  // v2 indexes hasPhoto so "which entries have a photo" is an index lookup
  // rather than a full scan. The Gallery and the Log both answer that
  // question on every render, and both were loading every entry to do it.
  //
  // IndexedDB cannot index a boolean, so hasPhoto is stored as 0/1 from v2
  // on. Both remain falsy/truthy in the same places, so every existing
  // `if (entry.hasPhoto)` read still behaves identically; only the writes
  // had to change. The upgrade backfills existing rows.
  //
  // This is also the migration template for this file. Dexie runs every
  // version block a given install has not seen yet, in order, inside one
  // transaction, so an install still on v1 gets this upgrade on next open
  // and an install already on v2 skips it. Never edit a shipped version
  // block: add a new one.
  db.version(2).stores({
    entries: '++id, date, createdAt, hasPhoto',
    photos: 'entryId',
    settings: 'key',
  }).upgrade((tx) => tx.table('entries').toCollection().modify((e) => {
    e.hasPhoto = e.hasPhoto ? 1 : 0;
  }));

  const KG_PER_LB = 0.45359237;

  function kgToLb(kg) { return kg / KG_PER_LB; }
  function lbToKg(lb) { return lb * KG_PER_LB; }

  function toDisplayWeight(kg, unit) {
    return unit === 'lb' ? kgToLb(kg) : kg;
  }
  function fromDisplayWeight(value, unit) {
    return unit === 'lb' ? lbToKg(value) : value;
  }

  const CM_PER_INCH = 2.54;

  // Height display follows the same unit setting as weight (cm alongside
  // kg, inches alongside lb). There is one unit toggle for the whole app,
  // rather than a separate metric/imperial choice just for height.
  function toDisplayHeight(cm, unit) {
    return unit === 'lb' ? cm / CM_PER_INCH : cm;
  }
  function fromDisplayHeight(value, unit) {
    return unit === 'lb' ? value * CM_PER_INCH : value;
  }

  // Imperial height reads as feet and inches, not as a pile of inches: nobody
  // describes themselves as 67 inches tall. Storage stays canonical cm, this
  // is purely the display and entry form of the same number.
  function cmToFeetInches(cm) {
    const totalIn = cm / CM_PER_INCH;
    let ft = Math.floor(totalIn / 12);
    let inch = Math.round((totalIn - ft * 12) * 10) / 10;
    if (inch >= 12) { ft += 1; inch = 0; }   // rounding can tip 11.97 up to a full foot
    return { ft, in: inch };
  }
  function feetInchesToCm(ft, inch) {
    return ((Number(ft) || 0) * 12 + (Number(inch) || 0)) * CM_PER_INCH;
  }
  function fmtFeetInches(cm) {
    const { ft, in: inch } = cmToFeetInches(cm);
    const shown = Number.isInteger(inch) ? inch : inch.toFixed(1);
    return `${ft}' ${shown}"`;
  }

  // ---------------- Settings ----------------

  const DEFAULT_SETTINGS = {
    unit: 'kg',
    theme: 'system',
    smartVariation: false, // default OFF; see plan notes: never fabricate a health number by default
    ocrEnabled: true, // best-effort read of the weight off the photo; always editable, never trusted blindly
    onboarded: false,
    goalWeightKg: null, // canonical kg, like entry weights, converted at display time
    heightCm: null, // canonical cm. Powers BMI; adult height treated as constant over time
    // How height is shown and entered: 'cm' or 'ftin'. Deliberately its own
    // setting rather than following the weight unit, because plenty of people
    // weigh themselves in kg and still describe their height in feet and
    // inches. null means "follow the weight unit" for anyone who never picks.
    heightUnit: null,
    lastNudgeShownDate: null, // caps the "log today?" banner at once per calendar day
  };

  async function getSettings() {
    const rows = await db.settings.toArray();
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  async function setSetting(key, value) {
    await db.settings.put({ key, value });
  }

  // ---------------- Entries ----------------

  // Most recent entry by date, tie-broken by createdAt.
  async function getLatestEntry() {
    const all = await db.entries.toArray();
    if (!all.length) return null;
    all.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
    return all[0];
  }

  async function getAllEntriesSorted() {
    const all = await db.entries.toArray();
    all.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    return all;
  }

  // Index-backed answer to "which entries have a photo", used by the Gallery
  // and by the Log's photo filter. Both previously pulled every entry into
  // memory and filtered in JS.
  async function getEntriesWithPhotosSorted() {
    const all = await db.entries.where('hasPhoto').equals(1).toArray();
    all.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    return all;
  }

  // Total bytes of stored photo data, counted without materialising the rows.
  // Summing this by fetching every photo row first is what made the backup
  // size estimate as expensive as the backup itself.
  async function getPhotoBytes() {
    let total = 0;
    await db.photos.each((p) => {
      total += (p.blob?.size || 0) + (p.thumbBlob?.size || 0);
    });
    return total;
  }

  function isQuotaError(err) {
    return err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
  }

  // photoPayload: { blob, thumbBlob, width, height, type, size } | null
  async function createEntry({ date, weightKg, note, photoPayload }, now) {
    const ts = now;
    try {
      return await db.transaction('rw', db.entries, db.photos, async () => {
        const id = await db.entries.add({
          date,
          weightKg,
          note: note || '',
          hasPhoto: photoPayload ? 1 : 0,
          createdAt: ts,
          updatedAt: ts,
        });
        if (photoPayload) {
          await db.photos.put({ entryId: id, ...photoPayload });
        }
        return id;
      });
    } catch (err) {
      if (isQuotaError(err)) throw new FatterError('QUOTA_EXCEEDED', 'Storage is full. Export a backup and remove old entries.');
      throw err;
    }
  }

  async function updateEntry(id, { date, weightKg, note, photoPayload, removePhoto }, now) {
    try {
      return await db.transaction('rw', db.entries, db.photos, async () => {
        const existing = await db.entries.get(id);
        if (!existing) throw new FatterError('NOT_FOUND', 'Entry no longer exists.');
        const hasPhoto = photoPayload ? 1 : (removePhoto ? 0 : (existing.hasPhoto ? 1 : 0));
        await db.entries.update(id, {
          date, weightKg, note: note || '', hasPhoto, updatedAt: now,
        });
        if (photoPayload) {
          await db.photos.put({ entryId: id, ...photoPayload });
        } else if (removePhoto) {
          await db.photos.delete(id);
        }
      });
    } catch (err) {
      if (isQuotaError(err)) throw new FatterError('QUOTA_EXCEEDED', 'Storage is full. Export a backup and remove old entries.');
      throw err;
    }
  }

  async function deleteEntry(id) {
    await db.transaction('rw', db.entries, db.photos, async () => {
      await db.entries.delete(id);
      await db.photos.delete(id); // no orphaned blobs
    });
  }

  async function getPhoto(entryId) {
    return db.photos.get(entryId);
  }

  async function clearAll() {
    await db.transaction('rw', db.entries, db.photos, db.settings, async () => {
      await db.entries.clear();
      await db.photos.clear();
      const settings = await db.settings.toArray();
      await db.settings.clear();
      // preserve unit/theme preference across a full data clear; those are
      // app preferences, not "data" in the sense the user is clearing.
      // 'onboarded' is deliberately NOT preserved: clearing all data resets
      // the device to a fresh-install state, so first-run onboarding runs
      // again next launch (falls back to DEFAULT_SETTINGS.onboarded = false).
      for (const row of settings) {
        if (row.key === 'unit' || row.key === 'theme') await db.settings.put(row);
      }
    });
  }

  // ---------------- Weight suggestion ----------------

  // Returns a kg value (or null) to pre-fill the Add Entry weight field.
  // Takes the latest entry directly (rather than fetching it itself) so a
  // caller that already needs getLatestEntry() for other reasons doesn't
  // pay for a second identical table scan just to get a suggestion.
  function suggestWeightKg(latest, smartVariation) {
    if (!latest) return null;
    if (!smartVariation) return latest.weightKg;
    // ±0.2–0.5 kg jitter, deterministic sign spread via Math.random (fine:
    // this is cosmetic realism, not a value the user is asked to trust blindly;
    // the field is always editable and clearly marked as a suggestion).
    const magnitude = 0.2 + Math.random() * 0.3;
    const sign = Math.random() < 0.5 ? -1 : 1;
    return Math.round((latest.weightKg + sign * magnitude) * 10) / 10;
  }

  // ---------------- Storage reliability ----------------

  async function requestPersistence() {
    if (!(navigator.storage && navigator.storage.persist)) return false;
    try {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (already) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  async function getStorageEstimate() {
    if (!(navigator.storage && navigator.storage.estimate)) return null;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
      return { usage, quota, persisted };
    } catch {
      return null;
    }
  }

  function isIndexedDBAvailable() {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
      return false;
    }
  }

  class FatterError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  global.FatterDB = {
    db,
    toDisplayWeight,
    fromDisplayWeight,
    toDisplayHeight,
    fromDisplayHeight,
    cmToFeetInches,
    feetInchesToCm,
    fmtFeetInches,
    getSettings,
    setSetting,
    getLatestEntry,
    getAllEntriesSorted,
    getEntriesWithPhotosSorted,
    getPhotoBytes,
    createEntry,
    updateEntry,
    deleteEntry,
    getPhoto,
    clearAll,
    suggestWeightKg,
    requestPersistence,
    getStorageEstimate,
    isIndexedDBAvailable,
    FatterError,
  };
})(window);
