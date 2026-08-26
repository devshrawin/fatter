// app.js — bootstrap, hash router, service worker registration, offline
// indicator, theme application. This is the only file that talks to the
// service worker; everything else here is wiring, not business logic.

(function () {
  'use strict';

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

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
    else delete root.dataset.theme;
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
    window.addEventListener('fatter:refresh', renderRoute);
    window.addEventListener('hashchange', renderRoute);
    window.addEventListener('online', updateOfflinePill);
    window.addEventListener('offline', updateOfflinePill);
    updateOfflinePill();

    if (!location.hash) location.hash = `#/${DEFAULT_ROUTE}`;
    await renderRoute();

    FatterOnboarding.maybeShow(settings);

    // Requested only after the app has rendered successfully — asking for
    // persistence before the user has done anything real just adds a permission
    // prompt with no context.
    FatterDB.requestPersistence();

    registerServiceWorker();
  }

  window.FatterApp = { applyTheme };
  boot();
})();
