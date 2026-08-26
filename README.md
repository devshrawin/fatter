# Fatter

A private, offline progress tracker. Take a photo, log your weight, watch the
line move.

## Privacy

**All your photos and weight data never leave your device.** Fatter has no
server, no account, and no cloud sync of any kind. Every entry — including
photo blobs — is stored locally in your browser's IndexedDB (via
[Dexie.js](https://dexie.org)). Nothing is ever uploaded, and there is no
analytics or tracking of any kind. Clearing your browser's site data for
Fatter deletes it permanently — the app cannot recover it, because it never
had a second copy.

The only way your data leaves the device is if *you* explicitly export it —
as an Excel file or a JSON backup — using the buttons in Settings.

## Running locally

Service workers and IndexedDB require a real HTTP origin — opening
`index.html` directly (`file://`) will not work.

```bash
cd Fatter
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Any other static file server works too (`npx serve`, `php -S`, etc.) — there
is no build step and nothing to install.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   branch `main`, folder `/ (root)`.
4. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

The `.nojekyll` file in this repo tells GitHub Pages to serve files as-is
(Jekyll would otherwise ignore folders starting with an underscore and mangle
some file handling). All paths in the app are relative, so it works whether
it's served from a repo subpath, a custom domain root, or `localhost`.

## How the weight suggestion works

When you add a new entry, the weight field is pre-filled to save you a step:

- **If you have previous entries**, it suggests your most recent weight.
- **If this is your first entry**, the field is left empty with a placeholder.

The suggested value is always just a starting point — it's clearly marked and
fully editable, and the moment you start typing, the "suggested" styling
disappears since it's now your entered value.

There's also an optional **"Vary suggested weight slightly"** toggle in
Settings, off by default. When enabled, it adds a small random ±0.2–0.5
variation to the suggestion instead of repeating your last weight exactly —
some people find an identical number every time looks unrealistic. It's off
by default deliberately: this app logs your actual health data, and a
suggested number should never be mistaken for something you measured.
Nothing is ever saved until you tap Save, regardless of this setting.

## Backup & restore

- **Download Excel** (Settings) generates a real `.xlsx` with your full entry
  log and a summary sheet — good for sharing with a coach or just having a
  spreadsheet copy.
- **Export full backup** generates a JSON file containing every entry, note,
  and photo, suitable for moving to a new device or just as a safety copy.
- **Import backup** reads that JSON back in, either merging with what's
  already on the device or fully replacing it (replacing requires typing
  `REPLACE` to confirm — it's irreversible).

## Limitations, honestly

- **No sync, by design.** If you use Fatter on your phone and your laptop,
  those are two independent, unconnected data sets. Use backup/restore to
  move data between devices.
- **Browser storage can be evicted.** Mobile browsers can clear IndexedDB
  under storage pressure if a site hasn't been granted persistent storage.
  Fatter requests persistent storage automatically, and Settings shows
  whether it was granted — but no browser guarantees storage forever. Export
  a backup occasionally if your data matters to you.
- **iOS installed-PWA storage is its own thing.** Storage for a PWA added to
  the iOS home screen is generally more durable than a regular Safari tab, but
  Apple's rules here have changed over iOS versions and aren't fully in an
  app's control.
- **HEIC photos need a HEIC-capable browser.** iPhones often shoot HEIC/HEIF.
  Safari (and any WebKit-based iOS browser) transparently converts these to
  JPEG when you pick them from a file input, so this is rarely visible on
  iPhone. Desktop Chrome/Firefox and most of Android have no built-in HEIC
  decoder — if you hand Fatter a raw `.heic` file there, it will show a clear
  error asking you to convert it or take a new photo instead of silently
  failing.

## Tech stack

Vanilla HTML/CSS/JS, no build step, no framework. Three vendored libraries
(pinned versions in [`js/vendor/VERSIONS.txt`](js/vendor/VERSIONS.txt)):

| Library | Version | License | Use |
|---|---|---|---|
| [Dexie.js](https://dexie.org) | 4.0.11 | Apache-2.0 | IndexedDB access |
| [Chart.js](https://www.chartjs.org) | 4.4.7 | MIT | Progress line chart |
| [SheetJS (xlsx)](https://sheetjs.com) | 0.18.5 | Apache-2.0 | Excel export |

## Project structure

```
Fatter/
├── index.html          app shell + inline SVG icon sprite
├── sw.js                service worker (root scope — see note in the file)
├── manifest.json        PWA manifest
├── css/style.css         design tokens + all components, dark-first
├── js/
│   ├── app.js           bootstrap, router, service worker, offline indicator
│   ├── db.js            Dexie schema, CRUD, settings, backup/restore, quota handling
│   ├── image.js         client-side compression, EXIF-orientation, HEIC handling
│   ├── chart.js         stats + Chart.js rendering
│   ├── export.js        Excel export + JSON backup/restore
│   ├── ui.js             views, modals, add/edit flow, toasts
│   └── vendor/           pinned third-party libraries
├── icons/               placeholder PWA icons (swap in a real logo any time)
└── tools/make-icons.js  regenerates the placeholder icons — dev-only, not shipped
```
