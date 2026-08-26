// onboarding.js — first-run intro flow (welcome / how it works / privacy /
// add-to-home-screen), plus the standalone "Add to Home Screen" screen the
// same install content renders into when reopened from Settings.
//
// The install step adapts to the platform, same as any native install UI
// would: iOS has no install API at all (Safari never fires
// beforeinstallprompt), so it gets manual steps; Chrome/Android/desktop get
// a real "Install" button wired to the captured native prompt; anything else
// gets a generic pointer to the browser's own menu. A user already running
// the installed, standalone app skips the install step entirely — there's
// nothing to prompt them for.

(function (global) {
  'use strict';

  // beforeinstallprompt can fire before this script's IIFE finishes
  // evaluating, so the listener is attached at top-level (script parse time)
  // rather than inside a later function — attaching it late would miss the
  // event on the one visit that actually matters.
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; });

  function isStandalone() {
    return (global.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function isIOS() {
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !global.MSStream) return true;
    // iPadOS 13+ reports as "MacIntel" but has touch support a real Mac doesn't.
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function installVariant() {
    if (isIOS()) return 'ios';
    if (deferredInstallPrompt) return 'android';
    return 'fallback';
  }

  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const BRAND_ICON = `<svg width="64" height="64" viewBox="0 0 100 100" class="onboarding-icon"><path d="M22,86 L22,54 L46,54 L46,28 L78,28" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="78" cy="28" r="7" fill="var(--accent)"/></svg>`;

  // ---------------- install-step content (shared by onboarding + Settings) ----------------

  function renderInstallContent(variant) {
    if (variant === 'ios') {
      return `<div class="onboarding-body onboarding-body--install">
        <div class="onboarding-title" style="text-align:left">Add Fatter to your Home Screen</div>
        <div class="install-step-row">
          <div class="install-step-num">1</div>
          <div class="onboarding-text">Tap the <b style="color:var(--text-primary)">Share</b> button in Safari's toolbar
            <svg class="icon install-icon-inline"><use href="#icon-ios-share"/></svg>
          </div>
        </div>
        <div class="install-step-row">
          <div class="install-step-num">2</div>
          <div class="onboarding-text">In the pop-up menu of actions, scroll down and tap on <b style="color:var(--text-primary)">More</b></div>
        </div>
        <div class="install-step-row">
          <div class="install-step-num">3</div>
          <div class="onboarding-text">Scroll and tap <b style="color:var(--text-primary)">Add to Home Screen</b></div>
        </div>
        <div class="install-step-row">
          <div class="install-step-num">4</div>
          <div class="onboarding-text">Tap <b style="color:var(--text-primary)">Add</b> in the top-right corner</div>
        </div>
        <div class="install-divider"></div>
        <div class="onboarding-text" style="margin-bottom:var(--sp-4)">Fatter will then be available on your Home Screen, just like any other app.</div>
        <div class="onboarding-text">If you've already added it, open it by tapping the <span class="install-home-icon"><svg width="14" height="14" viewBox="0 0 100 100"><path d="M22,86 L22,54 L46,54 L46,28 L78,28" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="78" cy="28" r="7" fill="var(--accent)"/></svg></span> icon on your Home Screen.</div>
      </div>`;
    }
    if (variant === 'android') {
      return `<div class="onboarding-body">
        ${BRAND_ICON}
        <div class="onboarding-title">Install Fatter</div>
        <div class="onboarding-text">Get quick access from your home screen — no browser address bar, works offline once installed.</div>
      </div>`;
    }
    return `<div class="onboarding-body">
      ${BRAND_ICON}
      <div class="onboarding-title">Add Fatter to your Home Screen</div>
      <div class="onboarding-text" style="margin-bottom:var(--sp-4)">This browser doesn't offer a one-tap install here — but you can still add Fatter from its menu.</div>
      <div class="onboarding-text">Look for <b style="color:var(--text-primary)">Install Fatter</b>, <b style="color:var(--text-primary)">Add to Home Screen</b>, or <b style="color:var(--text-primary)">Add to Dock</b> — the exact wording depends on your browser.</div>
    </div>`;
  }

  function installButtonLabel(variant) {
    return variant === 'android' ? 'Install' : 'Start using Fatter';
  }

  async function handleInstallButton(variant) {
    if (variant !== 'android' || !deferredInstallPrompt) return;
    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch {
      // ignore — user closing the native prompt isn't an error
    } finally {
      deferredInstallPrompt = null;
    }
  }

  // ---------------- standalone reopen, from Settings ----------------

  function showInstallHelp() {
    const variant = installVariant();
    const el = h(`<div>
      <div class="sheet__header">
        <div class="sheet__title">Add to Home Screen</div>
        <button class="sheet__close" data-act="close" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>
      </div>
      <div id="install-help-content"></div>
      <button class="btn btn--primary btn--block" data-act="done" type="button" style="margin-top:var(--sp-4)">${installButtonLabel(variant)}</button>
    </div>`);
    el.querySelector('#install-help-content').innerHTML = renderInstallContent(variant).replace(/onboarding-body(--install)?/g, '');
    const { close } = global.FatterUI.openSheet(el);
    el.querySelector('[data-act="close"]').addEventListener('click', close);
    el.querySelector('[data-act="done"]').addEventListener('click', async () => {
      await handleInstallButton(variant);
      close();
    });
  }

  // ---------------- first-run flow ----------------

  function maybeShow(settings) {
    if (settings.onboarded) return;
    const skipInstallStep = isStandalone();
    const steps = ['welcome', 'howitworks', 'privacy'];
    if (!skipInstallStep) steps.push('install');
    const variant = installVariant();

    const overlay = h(`<div class="onboarding-overlay">
      <div class="onboarding-top"><button class="onboarding-skip" type="button">Skip</button></div>
      <div id="onboarding-slot"></div>
      <div class="onboarding-footer">
        <div class="onboarding-dots"></div>
        <button class="btn btn--primary btn--block" type="button" id="onboarding-next">Next</button>
      </div>
    </div>`);
    document.body.appendChild(overlay);

    const slot = overlay.querySelector('#onboarding-slot');
    const dotsEl = overlay.querySelector('.onboarding-dots');
    const nextBtn = overlay.querySelector('#onboarding-next');
    let index = 0;

    async function finish() {
      await FatterDB.setSetting('onboarded', true);
      overlay.remove();
    }

    function renderStep() {
      const step = steps[index];
      dotsEl.innerHTML = steps.map((_, i) => `<div class="onboarding-dot ${i === index ? 'is-active' : ''}"></div>`).join('');

      if (step === 'welcome') {
        slot.innerHTML = `<div class="onboarding-body">
          ${BRAND_ICON}
          <div style="font-size:var(--fs-label);font-weight:700;color:var(--accent);letter-spacing:0.14em;margin-bottom:var(--sp-3)">WELCOME TO</div>
          <div style="font-size:36px;font-weight:700;color:var(--text-primary);margin-bottom:var(--sp-4)">Fatter</div>
          <div class="onboarding-text">A simple way to see your progress take shape — one photo and one number at a time.</div>
        </div>`;
        nextBtn.textContent = 'Next';
      } else if (step === 'howitworks') {
        slot.innerHTML = `<div class="onboarding-body">
          <div style="display:flex;align-items:center;gap:var(--sp-4);margin-bottom:var(--sp-7)">
            <div style="width:64px;height:64px;border-radius:var(--r-card);background:var(--surface-raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center"><svg class="icon" style="width:28px;height:28px;color:var(--accent)" viewBox="0 0 24 24"><use href="#icon-camera"/></svg></div>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            <div style="width:64px;height:64px;border-radius:var(--r-card);background:var(--surface-raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center"><svg class="icon" style="width:28px;height:28px;color:var(--accent)" viewBox="0 0 24 24"><use href="#icon-chart"/></svg></div>
          </div>
          <div class="onboarding-title">Snap a photo.<br>Log a number.</div>
          <div class="onboarding-text">Fatter suggests your last weight, or reads it straight off the photo, and even grabs the date for you. Everything's editable before you save.</div>
        </div>`;
        nextBtn.textContent = 'Next';
      } else if (step === 'privacy') {
        slot.innerHTML = `<div class="onboarding-body">
          ${BRAND_ICON}
          <div class="onboarding-title">Everything stays<br>on your device</div>
          <div class="onboarding-text">Fatter stores every photo and weight entry only on this device. No account, no server, no upload — ever.</div>
        </div>`;
        nextBtn.textContent = skipInstallStep ? 'Start using Fatter' : 'Next';
      } else if (step === 'install') {
        slot.innerHTML = renderInstallContent(variant);
        nextBtn.textContent = installButtonLabel(variant);
      }
    }

    overlay.querySelector('.onboarding-skip').addEventListener('click', finish);
    nextBtn.addEventListener('click', async () => {
      const step = steps[index];
      if (step === 'install') { await handleInstallButton(variant); await finish(); return; }
      if (step === 'privacy' && skipInstallStep) { await finish(); return; }
      index++;
      renderStep();
    });

    renderStep();
  }

  global.FatterOnboarding = { maybeShow, showInstallHelp };
})(window);
