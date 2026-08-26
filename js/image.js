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

  global.FatterImage = { compressPhoto, createObjectUrlPool, UnsupportedImageError };
})(window);
