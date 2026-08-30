# Fatter

A private, offline progress tracker. Take a photo, log your weight, watch the
line move.

## Privacy

**All your photos and weight data never leave your device.** Fatter has no
server, no account, and no cloud sync of any kind. Every entry (including
photo blobs) is stored locally in your browser's IndexedDB (via
[Dexie.js](https://dexie.org)). Nothing is ever uploaded, and there is no
analytics or tracking of any kind. Clearing your browser's site data for
Fatter deletes it permanently. The app cannot recover it, because it never
had a second copy.

The only way your data leaves the device is if *you* explicitly export it
(as an Excel file or a JSON backup) using the buttons in Settings.

## First run

The first time you open Fatter (and again any time you fully clear its data),
a short 4-step intro runs: **Welcome → How it works → Everything stays on
your device → Add to Home Screen** (skipped if you're already running the
installed, standalone app). "Skip" jumps straight past all of it. The install
step adapts to your platform: a real one-tap **Install** button on
Chrome/Android and desktop, manual step-by-step instructions on iOS Safari
(which has no install API at all), and a generic pointer to the browser's own
menu everywhere else. You can reopen the same install instructions any time
from **Settings → Add to Home Screen**.

**Clearing all data (Settings → Clear all data) resets `onboarded` along with
everything else**, so the app looks and behaves like a fresh install on next
launch, first-run intro included.

## Running locally

Service workers and IndexedDB require a real HTTP origin. Opening
`index.html` directly (`file://`) will not work.

```bash
cd Fatter
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Any other static file server works too (`npx serve`, `php -S`, etc.). There
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

The suggested value is always just a starting point: it's clearly marked and
fully editable, and the moment you start typing, the "suggested" styling
disappears since it's now your entered value.

There's also an optional **"Vary suggested weight slightly"** toggle in
Settings, off by default. When enabled, it adds a small random ±0.2–0.5
variation to the suggestion instead of repeating your last weight exactly.
Some people find an identical number every time looks unrealistic. It's off
by default deliberately: this app logs your actual health data, and a
suggested number should never be mistaken for something you measured.
Nothing is ever saved until you tap Save, regardless of this setting.

### Reading the photo itself

Two more suggestions come from the photo you just picked, both on by default
and both overridden the instant you edit the field they fill:

- **Date**: if the photo has EXIF "date taken" metadata (basically any
  camera photo), the date field defaults to that instead of today. Screenshots
  and photos without EXIF just fall back to today, as before.
- **Weight**: pick a photo and a **Read from the scale** button appears under
  the weight field. It opens your photo with a box over the display, already
  positioned where Fatter thinks the numbers are. Drag the box over them and
  the reading updates live, so you can see exactly what is being read before
  you accept it. Tap **Use this** and it fills the weight field. Turn the
  whole thing off in Settings ("Read weight from photo").

### How the reading actually works

Fatter does not use general-purpose OCR for this, because general-purpose OCR
cannot do it. Tesseract is trained on printed type, and a seven-segment
display is glowing bars with gaps between them. Measured on a real photo from
this project: a perfectly cropped, upright, upscaled image of a display
reading `142.7` came back as `"2"`. That is not a tuning problem, and a bigger
model does not fix it either; a purpose-built seven-segment model still
returned `146.7`.

So instead of recognising a shape, Fatter decodes the geometry. A
seven-segment digit is not really a glyph, it is a seven-bit code with only
ten valid values, so once a digit is isolated you test which of the seven bars
are lit and look the answer up. That is exact by construction, runs instantly,
and needs **no model, no download and no network**. The whole reader is
[`js/sevenseg.js`](js/sevenseg.js), a few hundred lines with no dependencies.

Two deliberate choices worth knowing about:

- **You position the box; Fatter never reads a photo unsupervised.** Finding a
  display that can occupy under 1% of a cluttered photo is the genuinely hard
  part, and automatic detection is not reliable enough to trust. When it lands
  off the display, whatever marks it does find can still decode cleanly and
  score high, so it hands back a *confident wrong number*. On a real photo of
  a scale reading 142.7, the automatic crop confidently produced 111.1. A
  wrong weight written into a health log is worse than no suggestion, so the
  automatic guess only ever seeds the box you confirm.
- **A reading has to be plausible as well as clear.** Every reading is checked
  for a sane digit count and a value inside human bodyweight range for your
  unit, on top of the per-digit confidence. Anything that fails is shown as
  "no reading" rather than offered.

## Goal weight & BMI

Both optional, both set in Settings, both entirely local:

- **Goal weight** adds a stat card showing how much is left and, only when
  your recent trend is actually heading toward it, a rough ETA. Direction-
  neutral: it never assumes losing (or gaining) is "the" goal.
- **Height** unlocks a BMI stat card and a Weight/BMI toggle on the
  dashboard chart. BMI is a crude population-level measure that ignores
  muscle mass, frame, age, and sex, so it's shown as context (with its
  standard WHO category label), not as something to optimize for.

## Streaks, chart range, and reminders

- A **streak** stat card appears once you've logged at least one day:
  consecutive calendar days with an entry, not reset by a day that just
  hasn't happened yet.
- The dashboard chart has a **7d / 30d / 90d / All** toggle. It only scopes
  the chart; the stat cards stay all-time, so a zoomed-in chart view can't
  make your starting weight look like it moved.
- If it's been a few days since your last entry, the dashboard shows a
  small dismissible reminder (one of ~15 rotating messages, at most once a
  day). This is **not a push notification**. Fatter has no server to send
  one from, so it only ever appears while you actually have the app open,
  the same way the rest of the app works.

## Backup & restore

- **Download Excel** (Settings) generates a real `.xlsx` with your full entry
  log and a summary sheet, good for sharing with a coach or just having a
  spreadsheet copy.
- **Export full backup** generates a JSON file containing every entry, note,
  and photo, suitable for moving to a new device or just as a safety copy.
- **Import backup** reads that JSON back in, either merging with what's
  already on the device or fully replacing it (replacing requires typing
  `REPLACE` to confirm; it's irreversible).

## Limitations, honestly

- **No sync, by design.** If you use Fatter on your phone and your laptop,
  those are two independent, unconnected data sets. Use backup/restore to
  move data between devices.
- **Browser storage can be evicted.** Mobile browsers can clear IndexedDB
  under storage pressure if a site hasn't been granted persistent storage.
  Fatter requests persistent storage automatically, and Settings shows
  whether it was granted, but no browser guarantees storage forever. Export
  a backup occasionally if your data matters to you.
- **iOS installed-PWA storage is its own thing.** Storage for a PWA added to
  the iOS home screen is generally more durable than a regular Safari tab, but
  Apple's rules here have changed over iOS versions and aren't fully in an
  app's control.
- **HEIC photos need a HEIC-capable browser.** iPhones often shoot HEIC/HEIF.
  Safari (and any WebKit-based iOS browser) transparently converts these to
  JPEG when you pick them from a file input, so this is rarely visible on
  iPhone. Desktop Chrome/Firefox and most of Android have no built-in HEIC
  decoder. If you hand Fatter a raw `.heic` file there, it will show a clear
  error asking you to convert it or take a new photo instead of silently
  failing.

## Tech stack

Vanilla HTML/CSS/JS, no build step, no framework. Vendored libraries, pinned
versions in [`js/vendor/VERSIONS.txt`](js/vendor/VERSIONS.txt):

| Library | Version | License | Use |
|---|---|---|---|
| [Dexie.js](https://dexie.org) | 4.0.11 | Apache-2.0 | IndexedDB access |
| [Chart.js](https://www.chartjs.org) | 4.4.7 | MIT | Progress line chart |
| [SheetJS (xlsx)](https://sheetjs.com) | 0.18.5 | Apache-2.0 | Excel export |

Full pinned sources are in
[`js/vendor/VERSIONS.txt`](js/vendor/VERSIONS.txt). SheetJS is lazy-loaded on
the first Excel export rather than sitting in the startup path, and is cached
after that. Reading the scale needs no library at all: it is plain geometry in
[`js/sevenseg.js`](js/sevenseg.js).

## Project structure

```
Fatter/
├── index.html          app shell + inline SVG icon sprite
├── sw.js                service worker (root scope; see note in the file)
├── manifest.json        PWA manifest
├── css/style.css         design tokens + all components, dark-first
├── js/
│   ├── app.js           bootstrap, router, service worker, offline indicator
│   ├── db.js            Dexie schema, CRUD, settings, backup/restore, quota handling
│   ├── image.js         client-side compression, EXIF-orientation/date, HEIC handling
│   ├── sevenseg.js       reads a seven-segment scale display, no model needed
│   ├── chart.js         stats + Chart.js rendering
│   ├── export.js        Excel export + JSON backup/restore
│   ├── ui.js             views, modals, add/edit flow, toasts
│   ├── onboarding.js     first-run intro + "Add to Home Screen" (Settings)
│   ├── nudge.js          "haven't logged in a while" dashboard banner
│   └── vendor/           pinned third-party libraries
│       ├── dexie.min.js
│       ├── chart.umd.min.js
│       ├── xlsx.full.min.js
│       ├── VERSIONS.txt          pinned versions, sources, licenses
├── icons/               PWA icons (brand mark from the Claude Design handoff;
│                         icons/logo.png is a gitignored local design source,
│                         not part of the generated/shipped icon set)
└── tools/make-icons.js  regenerates the icons (dev-only, not shipped)
```
