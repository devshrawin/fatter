// db.js — IndexedDB access via Dexie. Single source of truth for all
// persisted data. Nothing in this file talks to a network.
//
// Schema:
//   entries:  { id, date('YYYY-MM-DD'), weightKg, note, hasPhoto, createdAt, updatedAt }
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

  const KG_PER_LB = 0.45359237;

  function kgToLb(kg) { return kg / KG_PER_LB; }
  function lbToKg(lb) { return lb * KG_PER_LB; }

  function toDisplayWeight(kg, unit) {
    return unit === 'lb' ? kgToLb(kg) : kg;
  }
  function fromDisplayWeight(value, unit) {
    return unit === 'lb' ? lbToKg(value) : value;
  }

  // ---------------- Settings ----------------

  const DEFAULT_SETTINGS = {
    unit: 'kg',
    theme: 'system',
    smartVariation: false, // default OFF — see plan notes: never fabricate a health number by default
    ocrEnabled: true, // best-effort read of the weight off the photo; always editable, never trusted blindly
    onboarded: false,
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
          hasPhoto: !!photoPayload,
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
        const hasPhoto = photoPayload ? true : (removePhoto ? false : existing.hasPhoto);
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
      // preserve unit/theme preference across a full data clear — those are
      // app preferences, not "data" in the sense the user is clearing.
      for (const row of settings) {
        if (row.key === 'unit' || row.key === 'theme') await db.settings.put(row);
      }
    });
  }

  // ---------------- Weight suggestion ----------------

  // Returns a kg value (or null) to pre-fill the Add Entry weight field.
  async function suggestWeightKg(smartVariation) {
    const latest = await getLatestEntry();
    if (!latest) return null;
    if (!smartVariation) return latest.weightKg;
    // ±0.2–0.5 kg jitter, deterministic sign spread via Math.random (fine —
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
    KG_PER_LB,
    kgToLb,
    lbToKg,
    toDisplayWeight,
    fromDisplayWeight,
    getSettings,
    setSetting,
    getLatestEntry,
    getAllEntriesSorted,
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
