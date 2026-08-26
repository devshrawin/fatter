// ocr.js — best-effort weight reading from a progress photo, via a
// self-hosted Tesseract.js (no CDN calls, matches the on-device-only model).
// This is explicitly a *suggestion* source, same tier as "last entry ± jitter"
// in db.js: it pre-fills the weight field, marked as unverified, and the user
// can always overwrite it. Never written to IndexedDB without their Save.
//
// Tuning here is backed by testing against ~110 real photos (scale LCD/LED
// displays, fitness-app screenshots) rather than guessing:
//   - Tesseract's own recognition confidence (data.confidence, 0-100) is the
//     load-bearing signal. A clean, correctly-oriented render scores ~85+; a
//     real photo Tesseract can't actually read scores 0-25 — but WITHOUT a
//     confidence floor, the naive "grab the first digit run" regex still
//     turns that garbage into a plausible-looking (and simply wrong) number.
//     CONFIDENCE_FLOOR below is what stops that: it's the single fix that
//     matters most here.
//   - Swapping Tesseract's language model for the larger "standard" or
//     "best"-accuracy trained data (10-13MB vs our ~2MB "fast" model) did
//     NOT improve confidence on failing real photos — this isn't a model
//     quality problem, so a bigger model isn't shipped here.
//   - What genuinely helps is the display filling more of the frame and
//     being upright — hence the rotation search below, and the manual
//     rotate control in the add-entry UI (ui.js) for cases this can't infer.

(function (global) {
  'use strict';

  const VENDOR_DIR = 'js/vendor/tesseract/';
  const RANGE_BY_UNIT = { kg: [20, 300], lb: [40, 660] };
  const OCR_TIMEOUT_MS = 25000;
  const CONFIDENCE_FLOOR = 60; // see tuning note above — 0-25 is real-world "can't read this", 85+ is a clean read

  let libraryLoadPromise = null;
  function ensureTesseractLib() {
    if (global.Tesseract) return Promise.resolve();
    if (libraryLoadPromise) return libraryLoadPromise;
    libraryLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = VENDOR_DIR + 'tesseract.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load the on-device text reader.'));
      document.head.appendChild(script);
    });
    return libraryLoadPromise;
  }

  // Tesseract.js instantiates its worker from a blob URL, whose base for
  // relative-URL resolution is not the page's location — so workerPath /
  // corePath / langPath must be absolute or importScripts() inside the
  // worker throws "invalid URL".
  const abs = (p) => new URL(p, document.baseURI).href;

  let workerPromise = null;
  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      await ensureTesseractLib();
      const worker = await global.Tesseract.createWorker('eng', 1, {
        workerPath: abs(VENDOR_DIR + 'worker.min.js'),
        corePath: abs(VENDOR_DIR + 'tesseract-core-simd-lstm.wasm.js'),
        langPath: abs(VENDOR_DIR),
        gzip: true,
      });
      // Scale/app displays are just digits and a decimal point — restricting
      // the whitelist meaningfully improves accuracy over general-purpose OCR.
      await worker.setParameters({ tessedit_char_whitelist: '0123456789.,' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; }); // allow retry on next call if setup failed
    return workerPromise;
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), ms)),
    ]);
  }

  // Pulls the most plausible weight-looking number out of raw OCR text.
  // Scale displays commonly show a decimal (e.g. "72.4"); prefer that shape,
  // fall back to a bare integer run.
  function extractCandidate(text) {
    const cleaned = text.replace(/,/g, '.');
    const decimalMatch = cleaned.match(/\d{2,3}\.\d{1,2}/);
    if (decimalMatch) return parseFloat(decimalMatch[0]);
    const intMatch = cleaned.match(/\d{2,3}/);
    if (intMatch) return parseFloat(intMatch[0]);
    return null;
  }

  async function recognizeOnce(worker, blob) {
    const { data } = await withTimeout(worker.recognize(blob), OCR_TIMEOUT_MS);
    return { confidence: data.confidence || 0, value: extractCandidate(data.text || '') };
  }

  // blob: the compressed photo blob. unit: 'kg' | 'lb', used only to sanity
  // check the result is in a plausible human bodyweight range.
  // Resolves to a number (one decimal place) or null — never throws.
  //
  // Tries the image as given first (cheap, covers the common already-upright
  // case); only pays for a 3-way rotation search when that first attempt
  // isn't confident, since real photos are sometimes sideways in ways EXIF
  // orientation doesn't capture (see the tuning note at the top of this file).
  async function readWeightFromImage(blob, unit) {
    try {
      const worker = await withTimeout(getWorker(), OCR_TIMEOUT_MS);
      const [min, max] = RANGE_BY_UNIT[unit] || RANGE_BY_UNIT.kg;

      let best = await recognizeOnce(worker, blob);
      if (best.confidence < CONFIDENCE_FLOOR) {
        // Decode the source blob once and reuse the bitmap for all 3 rotation
        // attempts — rotateBlob() decodes internally, which would otherwise
        // mean 3 redundant createImageBitmap(blob) calls on the same source.
        const bitmap = await FatterImage.decodeBitmap(blob);
        try {
          for (const degrees of [90, 180, 270]) {
            const rotated = await FatterImage.rotateFromBitmap(bitmap, degrees, 0.85, 'image/png');
            const attempt = await recognizeOnce(worker, rotated.blob);
            if (attempt.confidence > best.confidence) best = attempt;
            if (best.confidence >= CONFIDENCE_FLOOR) break;
          }
        } finally {
          bitmap.close();
        }
      }

      if (best.confidence < CONFIDENCE_FLOOR) return null;
      if (best.value == null) return null;
      if (best.value < min || best.value > max) return null;
      return Math.round(best.value * 10) / 10;
    } catch {
      return null; // best-effort: any failure just means "no suggestion from photo"
    }
  }

  global.FatterOCR = { readWeightFromImage };
})(window);
