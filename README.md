# Fatter

**[Open the app: devshrawin.github.io/fatter](https://devshrawin.github.io/fatter/)**

Track your weight with a photo next to every number, and watch the line move.

Everything stays on your phone. No account, no sign-up, no server, no sync.
Nothing you put in Fatter is ever uploaded anywhere, because there is nowhere
for it to go.

## Getting it on your phone

Open [the link](https://devshrawin.github.io/fatter/) and add it to your home
screen. On iPhone that is Share, then **Add to Home Screen**. On Android your
browser offers an **Install** button. Fatter walks you through it the first
time you open it, and you can bring those instructions back any time from
**Settings → Add to Home Screen**.

Once it is on your home screen it behaves like any other app, including
working with no signal at all.

## What you can do with it

**Log a weight with a photo.** Tap the **+** button, take a photo or pick one,
and enter the number. Fatter pre-fills your last weight so most days you just
tap Save. It also reads the date off the photo, so logging yesterday's weigh-in
picks the right day on its own.

**Read the number off your scale.** Instead of typing it, tap **Read from the
scale**. Your photo opens with a box over the display; drag the box onto the
numbers and Fatter reads them for you. The reading updates as you move the box,
so you can see exactly what it has read before you accept it. It never fills
the number in on its own, so it can never quietly record a weight you did not
take. (You can switch this off in Settings.)

**See your progress.** The dashboard shows your current and starting weight,
total change, weekly average, and a chart you can scope to the last 7, 30 or 90
days. **Log** is a timeline of every entry with the change since the one
before. **Gallery** is just the photos, tap any one to step through them.

**Set a goal.** Add a goal weight and Fatter shows how far you have to go, plus
a rough estimate of when you will get there, but only when your recent trend is
actually heading that way. It never assumes losing weight is the goal.

**See your BMI.** Add your height (in cm, or in feet and inches) and you get a
BMI card and a Weight/BMI toggle on the chart. BMI is a crude measure that
ignores muscle, frame and age, so it is shown as context rather than a target.

**Keep a streak.** Consecutive days with an entry, which does not break just
because today has not happened yet.

**Get a nudge.** If it has been a few days, the dashboard shows a small
reminder you can dismiss. It is not a push notification and never will be:
those need a server, and Fatter does not have one, so it only appears while the
app is open.

## Your data is yours

Every photo and every number lives in your browser's storage on that one
device. There is no copy anywhere else, which is the point, and also the thing
to be careful about:

- **Export a backup now and then.** Settings → **Export full backup** saves a
  single file with every entry, note and photo. **Import backup** puts it back,
  either merged with what is there or replacing it entirely.
- **Get it as a spreadsheet.** Settings → **Download Excel** produces a real
  `.xlsx` with your full log and a summary sheet, handy for sharing with a
  coach or just keeping a copy.
- **Clearing your browser's data for this site deletes everything.** Fatter
  cannot get it back, because it never had a second copy.

## Honest limitations

- **It does not sync.** Fatter on your phone and Fatter on your laptop are two
  separate logs. Use a backup file to move between them.
- **Browsers can evict storage.** If a phone runs very low on space, browsers
  can clear site data. Fatter asks for persistent storage and Settings tells
  you whether it was granted, but no browser promises forever. This is the real
  reason to export a backup occasionally.
- **iPhone storage rules are Apple's.** An installed home-screen app gets more
  durable storage than a Safari tab, but the specifics have changed across iOS
  versions and are not in an app's control.
- **Reading the scale needs a hand.** Fatter puts the box where it thinks the
  display is, but finding a small readout in a busy photo is genuinely hard and
  it is often wrong, so you position it. It reads correctly once pointed at the
  display, and would rather say "no reading" than guess.
- **Some raw HEIC files will not open.** iPhones shoot HEIC. Safari converts
  them for you so this rarely comes up on iPhone, but desktop Chrome, Firefox
  and most of Android cannot decode a raw `.heic`. Fatter says so clearly
  instead of failing silently.

---

# For developers

Vanilla HTML, CSS and JavaScript. No build step, no framework, no bundler. Open
`index.html` over HTTP and it runs.

## Running locally

Service workers and IndexedDB need a real HTTP origin, so `file://` will not
work.

```bash
cd Fatter
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Any static server works.

## Deploying

Push to `main`, then set **Settings → Pages** to deploy from `main` at the
root. `.nojekyll` stops Jekyll from touching the files. Every path in the app
is relative, so the same build works from a repo subpath, a domain root, or
localhost with no configuration.

Bump `CACHE_VERSION` in [`sw.js`](sw.js) on any deploy that changes a cached
file. It is the only thing that makes an existing install fetch anything new,
because browsers decide whether to re-run a service worker install purely by
byte-diffing that file. Bump `APP_VERSION` in [`js/app.js`](js/app.js) too; it
is what Settings shows, alongside the cache the service worker is actually
serving from, so an install can be checked from inside the app.

## Reading a seven-segment display

This is the one genuinely unusual part, in [`js/sevenseg.js`](js/sevenseg.js).

General OCR cannot do this job. Tesseract is trained on printed type, and a
seven-segment display is glowing bars with gaps between them. Measured on a
real photo from this project, a perfectly cropped, upright, upscaled image of a
display reading `142.7` came back as `"2"`. A purpose-built seven-segment model
still returned `146.7`. So Tesseract was removed, along with 5.8 MB of WASM and
trained data.

What replaced it decodes geometry instead of recognising shapes. A
seven-segment digit is a seven-bit code with ten valid values, so once a digit
is isolated you test which bars are lit and look the answer up. Exact by
construction, no model, no download, no network. The pipeline: threshold lit
pixels by local contrast (a global threshold saturates on a sunlit floor),
strip panel glare, find the glyph band, split digits on a projection profile
taken over the upper band only (a decimal point bridges digits in a full-height
profile), then decode each digit's bars.

Two findings worth preserving, both from measuring rather than guessing:

- **Margin matters, score does not.** A correct reading and a reading pulled
  out of noise score about the same (0.83 versus 0.88). What separates them is
  that a correct digit beats its runner-up clearly while a noise digit sits
  nearly tied. Thresholds are set accordingly.
- **Searching many crops for the most confident reading makes things worse.**
  It is a multiple-comparisons trap: across 25 photos it reliably found some
  crop whose noise decoded cleanly, turning correctly-rejected readings into
  confident wrong answers. Automatic detection therefore only ever seeds the
  box the user confirms.

`tools/sevenseg-lab.html` and `tools/sevenseg-eval.html` are the harnesses
those numbers came from. They expect sample photos in `_test-photos/`, which is
gitignored and not shipped.

## Libraries

Pinned and vendored, sources and licences in
[`js/vendor/VERSIONS.txt`](js/vendor/VERSIONS.txt):

| Library | Version | License | Use |
|---|---|---|---|
| [Dexie.js](https://dexie.org) | 4.0.11 | Apache-2.0 | IndexedDB access |
| [Chart.js](https://www.chartjs.org) | 4.4.7 | MIT | Progress line chart |
| [SheetJS (xlsx)](https://sheetjs.com) | 0.18.5 | Apache-2.0 | Excel export |

SheetJS is lazy-loaded on the first Excel export rather than sitting in the
startup path.

## Structure

```
Fatter/
├── index.html            app shell and inline SVG icon sprite
├── sw.js                 service worker, root scope (see the note in the file)
├── manifest.json         PWA manifest
├── css/style.css         design tokens and components, dark-first
├── js/
│   ├── app.js            bootstrap, router, service worker, theme, liveQuery
│   ├── db.js             Dexie schema, CRUD, settings, unit conversion
│   ├── image.js          compression, EXIF orientation and date, HEIC handling
│   ├── sevenseg.js       reads a seven-segment display, no model needed
│   ├── chart.js          stats and Chart.js rendering
│   ├── export.js         Excel export, JSON backup and restore
│   ├── ui-core.js        DOM helpers, modal and sheet host, toasts
│   ├── ui.js             global wiring (the + button, photo inputs)
│   ├── onboarding.js     first-run intro and Add to Home Screen
│   ├── nudge.js          the "log today?" banner
│   ├── views/
│   │   ├── dashboard.js    stat cards, chart, recent photos
│   │   ├── log-gallery.js  timeline, photo grid, lightbox
│   │   ├── entry-form.js   add and edit an entry, photo handling
│   │   ├── settings.js     every setting, export, import, clear
│   │   └── scale-reader.js the drag-a-box scale reading sheet
│   └── vendor/           pinned third-party libraries
├── icons/                PWA icons
└── tools/                icon generator and the seven-segment harnesses
```

Views re-render automatically through a Dexie `liveQuery` subscription in
`app.js`, so any write to entries or settings refreshes whatever route is on
screen. There is no manual refresh call to forget.

## License

MIT. See [LICENSE](LICENSE).
