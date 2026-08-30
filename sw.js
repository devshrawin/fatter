// sw.js: service worker, at repo root so its scope covers the whole app
// (a worker under /js/ can't control or cache index.html without a
// Service-Worker-Allowed header, which GitHub Pages can't send).
//
// Strategy: navigations are network-first with an index.html cache fallback
// (so a normal visit always gets the latest shell when online, and still
// boots offline); everything else is cache-first (static assets don't change
// without a new cache version).

// Bump this on every deploy that changes a precached file. It's the ONLY
// thing that makes an existing install fetch anything new. Browsers decide
// whether to run a new service-worker install purely by byte-diffing this
// file, so if sw.js itself doesn't change, returning users keep whatever
// was cached on their very first visit, forever, with no update banner ever
// firing. (This bit twice now: it sat at 'fatter-v1' through ~8 feature
// commits before the first bump, then a whole second round of fixes to
// chart.js/ui.js/export.js/image.js/ocr.js/style.css/index.html shipped
// without a bump, and existing installs kept running the pre-fix code the
// entire time. Bump this EVERY time any precached file changes, no
// exceptions, even for a "small" fix.)
const CACHE_VERSION = 'fatter-v6';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/image.js',
  './js/chart.js',
  './js/export.js',
  './js/sevenseg.js',
  './js/ui-core.js',
  './js/views/scale-reader.js',
  './js/views/entry-form.js',
  './js/views/dashboard.js',
  './js/views/log-gallery.js',
  './js/views/settings.js',
  './js/ui.js',
  './js/onboarding.js',
  './js/nudge.js',
  './js/vendor/dexie.min.js',
  './js/vendor/chart.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon.svg',
];
// xlsx.full.min.js is intentionally NOT precached: it's lazy-loaded only
// when the user taps "Download Excel", and gets cache-first treatment via
// the fetch handler the first time it's actually requested.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  // Lets Settings show which cache is actually serving the app, so "did the
  // update land" has a real answer rather than a hardcoded version string.
  if (event.data && event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          return (await cache.match('./index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        return Response.error();
      }
    })()
  );
});
