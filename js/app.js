// app.js: bootstrap, hash router, service worker registration, offline
// indicator, theme application. This is the only file that talks to the
// service worker; everything else here is wiring, not business logic.

(function () {
  'use strict';

  // Bump on every release. This is what the Settings footer shows, so it is
  // the only way to tell from inside the app whether an update actually
  // landed. It was previously hardcoded to 1.0.0 and never changed, which
  // made it useless for exactly that purpose.
  const APP_VERSION = '1.2.0';


  const ROUTES = ['dashboard', 'log', 'gallery', 'settings'];
  const DEFAULT_ROUTE = 'dashboard';

  const viewRoot = document.getElementById('view-root');
  const tabItems = [...document.querySelectorAll('.tab-bar__item')];

  function currentRoute() {
    const hash = location.hash.replace(/^#\//, '');
    return ROUTES.includes(hash) ? hash : DEFAULT_ROUTE;
  }

  async function renderRoute() {
    const route = currentRoute();
    tabItems.forEach((a) => a.classList.toggle('is-active', a.dataset.route === route));
    try {
      if (route === 'dashboard') await FatterUI.renderDashboard(viewRoot);
      else if (route === 'log') await FatterUI.renderLog(viewRoot);
      else if (route === 'gallery') await FatterUI.renderGallery(viewRoot);
      else if (route === 'settings') await FatterUI.renderSettings(viewRoot);
    } catch (err) {
      console.error('Render failed for route', route, err);
      viewRoot.innerHTML = `<div class="empty-state"><div class="empty-state__title">Something went wrong</div><div class="empty-state__body">Try reloading the app.</div></div>`;
    }
  }

  // Tracks the last theme setting passed in, so the OS-scheme-change listener
  // below (for theme === 'system') knows whether it should still be reacting.
  let currentThemeSetting = 'system';

  function applyTheme(theme) {
    currentThemeSetting = theme;
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
    else delete root.dataset.theme;

    // These two meta tags were hardcoded for the dark theme and never updated.
    // Switching to Light left the iOS status bar glyphs (black-translucent
    // draws them white) invisible against the now-light content behind them,
    // and the Android address-bar tint stayed black against a white page.
    const isDark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', isDark ? '#0d0d0d' : '#fcfcfc');
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute('content', isDark ? 'black-translucent' : 'default');
  }

  // ---------------- Offline indicator ----------------

  function updateOfflinePill() {
    document.getElementById('offline-pill').hidden = navigator.onLine;
  }

  // ---------------- IndexedDB availability (Safari private mode, etc.) ----------------

  function showIndexedDbUnavailable() {
    document.querySelector('.tab-bar').style.display = 'none';
    document.getElementById('fab-add').style.display = 'none';
    viewRoot.innerHTML = `
      <div class="empty-state card">
        <svg class="empty-state__icon" viewBox="0 0 24 24"><use href="#icon-warning"/></svg>
        <div class="empty-state__title">Local storage isn't available</div>
        <div class="empty-state__body">
          Fatter needs your browser's local storage to keep your data on this device.
          This is usually blocked in Private Browsing mode. Try opening Fatter in a
          normal browser window.
        </div>
      </div>`;
  }

  // ---------------- Service worker + update flow ----------------

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              document.getElementById('update-banner').hidden = false;
            }
          });
        });
      } catch (err) {
        console.warn('Service worker registration failed', err);
      }
    });

    document.getElementById('update-reload-btn').addEventListener('click', () => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      });
    });

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  // ---------------- Boot ----------------

  async function boot() {
    if (!FatterDB.isIndexedDBAvailable()) {
      showIndexedDbUnavailable();
      return;
    }

    const settings = await FatterDB.getSettings();
    applyTheme(settings.theme);

    FatterUI.initGlobalHandlers();
    window.addEventListener('hashchange', renderRoute);
    window.addEventListener('online', updateOfflinePill);
    window.addEventListener('offline', updateOfflinePill);
    updateOfflinePill();

    if (!location.hash) location.hash = `#/${DEFAULT_ROUTE}`;

    // Re-renders the current route automatically whenever entries or
    // settings change anywhere in the app (save, edit, delete, import, any
    // Settings toggle). Replaces the old 'fatter:refresh' CustomEvent that
    // every single mutation site used to have to remember to dispatch by
    // hand (a real, repeatedly-forgotten source of bugs). Dexie's liveQuery
    // tracks which tables the querier touches and only re-runs it (and
    // fires this subscription) when one of those tables actually changes.
    // It also emits once immediately on subscribe, which is what performs
    // the very first render; no separate explicit renderRoute() call needed.
    Dexie.liveQuery(() => Promise.all([FatterDB.getSettings(), FatterDB.getAllEntriesSorted()]))
      .subscribe({
        next: renderRoute,
        error: (err) => console.error('liveQuery error', err),
      });

    // Only relevant while the setting is 'system'; applyTheme() itself
    // re-checks matchMedia every call, this just re-triggers it when the OS
    // flips light/dark out from under an already-open tab.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentThemeSetting === 'system') applyTheme('system');
    });

    FatterOnboarding.maybeShow(settings);

    // Requested only after the app has rendered successfully. Asking for
    // persistence before the user has done anything real just adds a permission
    // prompt with no context.
    FatterDB.requestPersistence();

    registerServiceWorker();
  }

  // Ask the active service worker which cache it is serving from. That is the
  // ground truth for "did the update land", independent of APP_VERSION.
  async function activeCacheVersion() {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return null;
      return await new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1200);
        ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && e.data.version); };
        navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      });
    } catch { return null; }
  }

  window.FatterApp = { applyTheme, APP_VERSION, activeCacheVersion };
  boot();
})();
