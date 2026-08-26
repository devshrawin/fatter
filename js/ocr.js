// ocr.js — best-effort weight reading from a progress photo, via a
// self-hosted Tesseract.js (no CDN calls, matches the on-device-only model).
// This is explicitly a *suggestion* source, same tier as "last entry ± jitter"
// in db.js: it pre-fills the weight field, marked as unverified, and the user
// can always overwrite it. Never written to IndexedDB without their Save.

(function (global) {
  'use strict';

  const VENDOR_DIR = 'js/vendor/tesseract/';
  const RANGE_BY_UNIT = { kg: [20, 300], lb: [40, 660] };
  const OCR_TIMEOUT_MS = 25000;

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

  // blob: the compressed photo blob. unit: 'kg' | 'lb', used only to sanity
  // check the result is in a plausible human bodyweight range.
  // Resolves to a number (one decimal place) or null — never throws.
  async function readWeightFromImage(blob, unit) {
    try {
      const worker = await withTimeout(getWorker(), OCR_TIMEOUT_MS);
      const { data } = await withTimeout(worker.recognize(blob), OCR_TIMEOUT_MS);
      const value = extractCandidate(data.text || '');
      if (value == null) return null;
      const [min, max] = RANGE_BY_UNIT[unit] || RANGE_BY_UNIT.kg;
      if (value < min || value > max) return null;
      return Math.round(value * 10) / 10;
    } catch {
      return null; // best-effort: any failure just means "no suggestion from photo"
    }
  }

  global.FatterOCR = { readWeightFromImage };
})(window);
