// image.js — client-side image compression. Takes a File from the photo
// picker and produces two small blobs (full + thumbnail) ready for
// IndexedDB. Nothing here ever leaves the device.

(function (global) {
  'use strict';

  const FULL_MAX_EDGE = 1200;
  const THUMB_MAX_EDGE = 320;
  const FULL_QUALITY = 0.82;
  const THUMB_QUALITY = 0.7;

  function scaledSize(w, h, maxEdge) {
    if (w <= maxEdge && h <= maxEdge) return { w, h };
    const scale = maxEdge / Math.max(w, h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  }

  class UnsupportedImageError extends Error {
    constructor(message) { super(message); this.code = 'UNSUPPORTED_FORMAT'; }
  }

  function looksLikeHeic(file) {
    return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
  }

  // Loads a File into a decoded, EXIF-rotated bitmap-like source.
  // Returns { source, width, height, close }.
  //
  // HEIC/HEIF note: iOS Safari transcodes HEIC to JPEG before handing the
  // File to the page, so photos picked via <input type=file> on an iPhone
  // normally arrive already decodable. Desktop Chrome/Firefox and most of
  // Android have no native HEIC decoder, so a raw .heic file (e.g. AirDropped
  // to a Mac, then picked in a non-Safari browser) will fail both decode
  // paths below — that's a real format gap, not a bug, so it's surfaced as
  // a specific, actionable error rather than a silent broken image.
  async function loadOriented(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        // fall through to <img> fallback
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode failed'));
        el.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } catch {
      if (looksLikeHeic(file)) {
        throw new UnsupportedImageError(
          "This browser can't open HEIC/HEIF photos. On iPhone, choosing it in Safari usually works — otherwise convert it to JPEG first, or take a new photo with the camera option."
        );
      }
      throw new UnsupportedImageError("Couldn't read this photo — the file may be corrupted or in an unsupported format.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  async function canvasToBlob(canvas, type, quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), type, quality);
    });
  }

  async function pickOutputType() {
    // Probe WebP support once; fall back to JPEG (no transparency needed for photos).
    if (global.__fatterWebpSupport !== undefined) return global.__fatterWebpSupport ? 'image/webp' : 'image/jpeg';
    try {
      const c = makeCanvas(2, 2);
      const ctx = c.getContext('2d');
      ctx.fillRect(0, 0, 2, 2);
      const blob = await canvasToBlob(c, 'image/webp', 0.8);
      global.__fatterWebpSupport = blob && blob.type === 'image/webp';
    } catch {
      global.__fatterWebpSupport = false;
    }
    return global.__fatterWebpSupport ? 'image/webp' : 'image/jpeg';
  }

  function drawScaled(source, w, h) {
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    return canvas;
  }

  // Rotates an already-decoded bitmap by a multiple of 90°, re-encoding at
  // the given quality. Does NOT close the bitmap — callers that decode once
  // and try several rotations (ocr.js's rotation search) own that lifecycle.
  async function rotateFromBitmap(bitmap, degrees, quality, type) {
    const swap = ((degrees % 180) + 180) % 180 !== 0;
    const w = swap ? bitmap.height : bitmap.width;
    const h = swap ? bitmap.width : bitmap.height;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.translate(w / 2, h / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    const outBlob = await canvasToBlob(canvas, type, quality);
    return { blob: outBlob, width: w, height: h };
  }

  // Rotates an already-compressed blob by a multiple of 90°, re-encoding at
  // the given quality. Used for the user-facing "rotate photo" control —
  // real photos routinely come out sideways with no usable EXIF fix, so a
  // manual override is the only reliable escape hatch.
  async function rotateBlob(blob, degrees, quality, type) {
    const bitmap = await createImageBitmap(blob);
    try {
      return await rotateFromBitmap(bitmap, degrees, quality, type || blob.type);
    } finally {
      bitmap.close();
    }
  }

  // Decodes a blob once so a caller can try multiple rotateFromBitmap() calls
  // against it without re-decoding per attempt (ocr.js's rotation search).
  // Caller must call bitmap.close() when done.
  function decodeBitmap(blob) {
    return createImageBitmap(blob);
  }

  // Rotates both the full and thumbnail blobs of a photoPayload together by
  // the same number of degrees (must be a multiple of 90), returning a new
  // payload shaped like compressPhoto's return value.
  async function rotatePhotoPayload(payload, degrees) {
    const norm = ((degrees % 360) + 360) % 360;
    if (norm === 0) return payload;
    const [full, thumb] = await Promise.all([
      rotateBlob(payload.blob, norm, FULL_QUALITY, payload.type),
      rotateBlob(payload.thumbBlob, norm, THUMB_QUALITY, payload.type),
    ]);
    return {
      blob: full.blob,
      thumbBlob: thumb.blob,
      width: full.width,
      height: full.height,
      type: full.blob.type,
      size: full.blob.size,
    };
  }

  // Main entry point: File -> { blob, thumbBlob, width, height, type, size }
  async function compressPhoto(file) {
    const loaded = await loadOriented(file);
    try {
      const type = await pickOutputType();
      const full = scaledSize(loaded.width, loaded.height, FULL_MAX_EDGE);
      const thumb = scaledSize(loaded.width, loaded.height, THUMB_MAX_EDGE);

      const fullCanvas = drawScaled(loaded.source, full.w, full.h);
      const blob = await canvasToBlob(fullCanvas, type, FULL_QUALITY);

      const thumbCanvas = drawScaled(loaded.source, thumb.w, thumb.h);
      const thumbBlob = await canvasToBlob(thumbCanvas, type, THUMB_QUALITY);

      return {
        blob,
        thumbBlob,
        width: full.w,
        height: full.h,
        type: blob.type,
        size: blob.size,
      };
    } finally {
      loaded.close();
    }
  }

  // Tracks object URLs created for display so views can revoke them on
  // teardown instead of leaking one URL per rendered photo.
  function createObjectUrlPool() {
    const urls = new Map();
    return {
      get(key, blob) {
        if (urls.has(key)) return urls.get(key);
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      },
      revokeAll() {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
      },
    };
  }

  // ---------------- EXIF date-taken (JPEG only, no dependency) ----------------
  //
  // iOS Safari transcodes HEIC to JPEG (preserving EXIF) before handing the
  // File to the page, so this covers the common phone-camera case even though
  // it only parses the JPEG/EXIF container. PNG screenshots and any file
  // without a readable EXIF block simply resolve to null — the date field
  // then falls back to today, exactly as before this feature existed.
  const EXIF_TAG_DATETIME = 0x0132;
  const EXIF_TAG_DATETIME_ORIGINAL = 0x9003;
  const EXIF_TAG_SUBIFD_POINTER = 0x8769;
  const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readAsciiString(dv, offset, count) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + offset, count);
    let end = bytes.indexOf(0);
    if (end === -1) end = count;
    return new TextDecoder('ascii').decode(bytes.subarray(0, end));
  }

  function readIfdDates(dv, tiffStart, ifdOffset, littleEndian, out) {
    if (ifdOffset + 2 > dv.byteLength) return;
    const entryCount = dv.getUint16(ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > dv.byteLength) break;
      const tag = dv.getUint16(entryOffset, littleEndian);
      const type = dv.getUint16(entryOffset + 2, littleEndian);
      const count = dv.getUint32(entryOffset + 4, littleEndian);
      const valueFieldOffset = entryOffset + 8;
      const typeSize = TYPE_SIZES[type] || 1;
      const totalSize = typeSize * count;
      const dataOffset = totalSize <= 4 ? valueFieldOffset : tiffStart + dv.getUint32(valueFieldOffset, littleEndian);

      if ((tag === EXIF_TAG_DATETIME || tag === EXIF_TAG_DATETIME_ORIGINAL) && type === 2) {
        if (dataOffset + count <= dv.byteLength) {
          out.push(readAsciiString(dv, dataOffset, count));
        }
      } else if (tag === EXIF_TAG_SUBIFD_POINTER) {
        const subIfdOffset = tiffStart + dv.getUint32(valueFieldOffset, littleEndian);
        readIfdDates(dv, tiffStart, subIfdOffset, littleEndian, out);
      }
    }
  }

  // Returns 'YYYY-MM-DD' or null.
  function exifDateStringToIso(s) {
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    const [, y, mo, d] = m;
    const year = +y;
    if (year < 1990 || year > 2200) return null; // sanity guard against garbage bytes
    const iso = `${y}-${mo}-${d}`;
    const parsed = new Date(iso + 'T00:00:00');
    if (Number.isNaN(parsed.getTime())) return null;
    if (parsed.getTime() > Date.now() + 86400000) return null; // ignore future-dated garbage
    return iso;
  }

  async function readExifDateTaken(file) {
    try {
      // EXIF/APP1 segments are capped at 64KB by the JPEG marker format;
      // reading the first 256KB comfortably covers it without loading
      // multi-MB photos in full just to check their metadata.
      const head = await file.slice(0, 262144).arrayBuffer();
      const dv = new DataView(head);
      if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return null; // not a JPEG

      let offset = 2;
      while (offset + 4 <= dv.byteLength) {
        const marker = dv.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00) break;
        if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; }
        if (marker === 0xffda) break; // start of scan — no more APPn markers follow
        const segLength = dv.getUint16(offset + 2);
        if (marker === 0xffe1 && offset + 4 + 6 <= dv.byteLength) {
          const sig = readAsciiString(dv, offset + 4, 4);
          if (sig === 'Exif') {
            const tiffStart = offset + 4 + 6;
            const bo = dv.getUint16(tiffStart);
            const littleEndian = bo === 0x4949;
            if (littleEndian || bo === 0x4d4d) {
              const ifd0Offset = tiffStart + dv.getUint32(tiffStart + 4, littleEndian);
              const dates = [];
              readIfdDates(dv, tiffStart, ifd0Offset, littleEndian, dates);
              for (const raw of dates) {
                const iso = exifDateStringToIso(raw);
                if (iso) return iso;
              }
            }
          }
        }
        offset += 2 + segLength;
      }
      return null;
    } catch {
      return null; // best-effort — any parse hiccup just means "no date suggestion"
    }
  }

  global.FatterImage = { compressPhoto, createObjectUrlPool, readExifDateTaken, rotatePhotoPayload, decodeBitmap, rotateFromBitmap };
})(window);
