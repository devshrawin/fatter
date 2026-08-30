// sevenseg.js: reads a seven-segment scale display straight off a photo,
// using plain geometry rather than a trained OCR model.
//
// Why not general OCR: Tesseract is trained on printed type and cannot read
// seven-segment glyphs at all. Measured on real scale photos from this
// project, a perfectly framed, upright, upscaled crop of a display reading
// 142.7 came back as "2" with confidence 16. That is not a tuning problem,
// it is the wrong tool. A bigger model does not help either; a purpose-built
// seven-segment model got "146.7", still one digit wrong.
//
// What works instead: a seven-segment digit is not a shape to be recognised,
// it is a seven-bit code. There are exactly seven bars in fixed positions and
// only ten valid combinations, so once a digit is isolated you test which
// bars are lit and look the answer up. That is exact by construction, needs
// no model, no download and no network, and it gives a per-digit confidence
// that means something (how cleanly each bar reads as on or off) rather than
// a score that can be high on nonsense.
//
// The pipeline is: isolate lit pixels by local contrast, find the row of
// glyphs, split it into digits, decode each digit's bars.

(function (global) {
  'use strict';

  // ---------------- small helpers ----------------

  function toCanvas(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
    return c;
  }

  // How strongly a pixel reads as a lit segment. The scales in use are either
  // a white/blue backlit LCD or a red LED on near-black, so take the stronger
  // of plain luminance and red dominance.
  function litResponse(d, i) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const redDom = Math.max(0, r - Math.max(g, b));
    return Math.min(255, Math.max(lum, redDom * 1.6));
  }

  // Binary mask of lit pixels, thresholded against each pixel's own
  // neighbourhood instead of a global cutoff.
  //
  // A global threshold does not work: a sunlit floor or bare skin is as
  // bright as the readout, so the mask saturates and the display is lost in
  // it. What actually distinguishes a lit display is LOCAL contrast, bright
  // bars sitting directly against a dark panel. Mean and standard deviation
  // per neighbourhood come from integral images, so this stays O(1) per pixel
  // regardless of window size. Requiring the neighbourhood to be high
  // variance is what rejects large flat bright areas.
  function litMask(src, W, opts) {
    opts = opts || {};
    const H = Math.max(1, Math.round((src.height / src.width) * W));
    const c = toCanvas(src, W, H);
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;

    const val = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) val[i] = litResponse(d, i * 4);

    const IW = W + 1;
    const s1 = new Float64Array(IW * (H + 1));
    const s2 = new Float64Array(IW * (H + 1));
    for (let y = 0; y < H; y++) {
      let r1 = 0, r2 = 0;
      for (let x = 0; x < W; x++) {
        const v = val[y * W + x];
        r1 += v; r2 += v * v;
        s1[(y + 1) * IW + (x + 1)] = s1[y * IW + (x + 1)] + r1;
        s2[(y + 1) * IW + (x + 1)] = s2[y * IW + (x + 1)] + r2;
      }
    }
    const box = (S, x0, y0, x1, y1) =>
      S[y1 * IW + x1] - S[y0 * IW + x1] - S[y1 * IW + x0] + S[y0 * IW + x0];

    const r = Math.max(4, Math.round(W * (opts.windowFrac || 0.035)));
    const kStd = opts.kStd != null ? opts.kStd : 0.6;
    const minStd = opts.minStd != null ? opts.minStd : 18;
    const absFloor = opts.absFloor != null ? opts.absFloor : 45;

    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const area = (x1 - x0) * (y1 - y0);
        const m = box(s1, x0, y0, x1, y1) / area;
        const sd = Math.sqrt(Math.max(0, box(s2, x0, y0, x1, y1) / area - m * m));
        const v = val[y * W + x];
        mask[y * W + x] = (sd >= minStd && v >= absFloor && v > m + kStd * sd) ? 1 : 0;
      }
    }
    return { mask, W, H };
  }

  // Grow the mask by a radius, separably (a horizontal pass then a vertical
  // one) so cost stays linear in the radius rather than quadratic. Used to
  // fuse a digit's separate bars into a single blob before locating.
  function dilate(mask, W, H, rx, ry) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let on = 0;
      for (let k = -rx; k <= rx && !on; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < W && mask[y * W + xx]) on = 1;
      }
      tmp[y * W + x] = on;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let on = 0;
      for (let k = -ry; k <= ry && !on; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < H && tmp[yy * W + x]) on = 1;
      }
      out[y * W + x] = on;
    }
    return out;
  }

  function components(mask, W, H) {
    const lab = new Int32Array(W * H);
    const out = [];
    const qx = new Int32Array(W * H), qy = new Int32Array(W * H);
    let next = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i] || lab[i]) continue;
      const id = next++;
      let head = 0, tail = 0;
      qx[0] = x; qy[0] = y; tail = 1; lab[i] = id;
      let minX = x, maxX = x, minY = y, maxY = y, n = 0;
      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++; n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (mask[ni] && !lab[ni]) { lab[ni] = id; qx[tail] = nx; qy[tail] = ny; tail++; }
        }
      }
      out.push({ id, minX, maxX, minY, maxY, n, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
    return { comps: out, lab };
  }

  // Remove everything in the crop that is not glyph-like. Panel-edge glare and
  // backlight bleed appear as large solid blobs, and a single one of those
  // spans every column and collapses the whole readout into one run.
  function cleanGlyphs(mask, W, H) {
    const { comps, lab } = components(mask, W, H);
    if (!comps.length) return mask;
    for (const c of comps) {
      let lit = 0;
      for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) if (mask[y * W + x]) lit++;
      c.fill = lit / Math.max(1, c.w * c.h);
    }
    const strokeish = comps.filter((c) => c.fill < 0.70 && c.h < H * 0.98 && c.w < W * 0.9 && c.n > 4);
    if (!strokeish.length) return mask;
    const refH = Math.max(...strokeish.map((c) => c.h));
    const keep = new Set();
    for (const c of comps) {
      if (c.fill >= 0.80 && c.n > refH * refH * 0.25) continue;
      if (c.h > refH * 1.35) continue;
      if (c.w > refH * 2.2) continue;
      if (c.n <= 3) continue;
      keep.add(c.id);
    }
    if (!keep.size) return mask;
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (mask[i] && keep.has(lab[i])) out[i] = 1;
    return out;
  }

  // ---------------- digit decoding ----------------
  //
  //   --a--
  //  |f   b|
  //   --g--
  //  |e   c|
  //   --d--
  //
  // Zones are expressed as fractions of the glyph box. They deliberately stop
  // short of the edges so a slight box misalignment does not bleed a
  // neighbouring glyph's vertical bar into the e/f zones.
  const ZONES = {
    a: [0.28, 0.00, 0.72, 0.16],
    b: [0.70, 0.12, 1.00, 0.44],
    c: [0.70, 0.56, 1.00, 0.88],
    d: [0.28, 0.84, 0.72, 1.00],
    e: [0.00, 0.56, 0.30, 0.88],
    f: [0.00, 0.12, 0.30, 0.44],
    g: [0.30, 0.42, 0.70, 0.58],
  };
  // Several digits have more than one common rendering on real hardware, so
  // each maps to a list of acceptable bar codes and a glyph is scored against
  // the best-fitting variant. The 7 matters most: many displays draw it with
  // the top-left bar lit, and without that variant a correct 7 scores barely
  // above 4 and the whole reading gets thrown out.
  const PATTERNS = {
    '0': ['abcdef'],
    '1': ['bc'],
    '2': ['abdeg'],
    '3': ['abcdg'],
    '4': ['bcfg'],
    '5': ['acdfg'],
    '6': ['acdefg', 'cdefg'],   // some panels leave the top bar off a 6
    '7': ['abc', 'abcf'],       // 7 with and without the top-left bar
    '8': ['abcdefg'],
    '9': ['abcdfg', 'abcfg'],   // 9 with and without the bottom bar
  };
  const KEYS = Object.keys(ZONES);

  function zoneFills(sub, w, h) {
    const on = {};
    for (const k of KEYS) {
      const z = ZONES[k];
      const x0 = Math.floor(z[0] * w), x1 = Math.max(x0 + 1, Math.ceil(z[2] * w));
      const y0 = Math.floor(z[1] * h), y1 = Math.max(y0 + 1, Math.ceil(z[3] * h));
      let lit = 0, tot = 0;
      for (let y = y0; y < y1 && y < h; y++) for (let x = x0; x < x1 && x < w; x++) { tot++; if (sub[y * w + x]) lit++; }
      on[k] = tot ? lit / tot : 0;
    }
    return on;
  }

  // Score each of the ten valid codes against the measured bar occupancy.
  // The gap between the best and second-best code is the useful confidence
  // signal: a clean digit matches one code far better than any other, while
  // a smeared or half-lit one sits between two and should not be trusted.
  function classify(sub, w, h) {
    const on = zoneFills(sub, w, h);
    const scored = [];
    for (const dch in PATTERNS) {
      let best = -1;
      for (const want of PATTERNS[dch]) {
        let s = 0;
        for (const k of KEYS) s += want.indexOf(k) >= 0 ? on[k] : (1 - on[k]);
        s /= KEYS.length;
        if (s > best) best = s;
      }
      scored.push({ digit: dch, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return { digit: scored[0].digit, score: scored[0].score, margin: scored[0].score - scored[1].score, on };
  }

  // ---------------- read a crop that contains only the readout ----------------

  function decode(rawMask, W, H) {
    const mask = cleanGlyphs(rawMask, W, H);

    // Vertical extent of the glyph band. The threshold has to scale with how
    // much ink the busiest row holds: a fixed low cutoff lets a faint
    // one-pixel smear across the panel count as part of the band, which
    // inflates the measured glyph height and misaligns every zone.
    const rowCount = new Int32Array(H);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) if (mask[y * W + x]) s++; rowCount[y] = s; }
    let maxRow = 0; for (let y = 0; y < H; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
    if (!maxRow) return null;
    const rowMin = Math.max(3, maxRow * 0.18);
    let bandTop = -1, bandBot = -1;
    for (let y = 0; y < H; y++) if (rowCount[y] >= rowMin) { if (bandTop < 0) bandTop = y; bandBot = y; }
    if (bandTop < 0) return null;
    const bandH = bandBot - bandTop + 1;
    if (bandH < 8) return null;

    // Column profile over the upper part of the band only. A decimal point
    // sits on the baseline directly between two digits, so a full-height
    // profile is bridged by it and the digits either side fuse into one run.
    const upperBot = Math.min(H - 1, bandTop + Math.round(bandH * 0.78));
    const col = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = bandTop; y <= upperBot; y++) if (mask[y * W + x]) s++;
      col[x] = s;
    }
    const colMin = Math.max(1, Math.round(bandH * 0.05));

    const runs = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && col[x] >= colMin;
      if (on && start < 0) start = x;
      else if (!on && start >= 0) { runs.push({ x0: start, x1: x - 1 }); start = -1; }
    }
    if (!runs.length) return null;

    for (const r of runs) {
      let minY = H, maxY = -1;
      for (let y = bandTop; y <= bandBot; y++) for (let x = r.x0; x <= r.x1; x++) {
        if (mask[y * W + x]) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      r.minY = minY; r.maxY = maxY; r.h = maxY - minY + 1; r.w = r.x1 - r.x0 + 1;
    }

    const tallH = Math.max(...runs.map((r) => r.h));
    const digitRuns = runs.filter((r) => r.h > tallH * 0.60 && r.w >= Math.max(2, tallH * 0.05));
    if (!digitRuns.length) return null;

    const baseTop = Math.min(...digitRuns.map((r) => r.minY));
    const baseBot = Math.max(...digitRuns.map((r) => r.maxY));
    const digitH = baseBot - baseTop + 1;

    // A run much wider than one digit holds several glyphs the profile could
    // not separate, so divide it evenly. Expected width comes from the glyph
    // HEIGHT, not from the narrowest run, because "1" is legitimately narrow
    // and would otherwise set the unit far too small and shred the rest.
    const expectW = digitH * 0.58;
    const split = [];
    for (const r of digitRuns) {
      const k = r.w > expectW * 1.45 ? Math.max(1, Math.round(r.w / expectW)) : 1;
      if (k === 1) { split.push({ x0: r.x0, x1: r.x1 }); continue; }
      const step = r.w / k;
      for (let i = 0; i < k; i++) {
        split.push({ x0: Math.round(r.x0 + i * step), x1: Math.round(r.x0 + (i + 1) * step) - 1 });
      }
    }
    split.sort((a, b) => a.x0 - b.x0);

    // Find decimal points as their own connected blobs rather than by
    // measuring ink in the gaps between digits. Gap-based detection fails
    // both ways here: a one-pixel sliver of a neighbouring bar looks like a
    // point, while a real point is masked by any glyph overhang sharing the
    // gap. A point is instead identified by its shape, small, roughly square,
    // compact and sitting on the baseline, which nothing else on the readout
    // resembles.
    const dotAfter = new Set();
    const band = new Uint8Array(W * H);
    for (let y = bandTop; y <= bandBot; y++) for (let x = 0; x < W; x++) band[y * W + x] = mask[y * W + x];
    for (const c of components(band, W, H).comps) {
      if (c.w > digitH * 0.30 || c.h > digitH * 0.30) continue;
      const ar = c.w / Math.max(1, c.h);
      if (ar < 0.45 || ar > 2.2) continue;                   // a bar sliver is long and thin
      if (c.n / Math.max(1, c.w * c.h) < 0.45) continue;     // a point is solid
      const cy = (c.minY + c.maxY) / 2;
      if ((cy - baseTop) / digitH < 0.62) continue;          // it sits on the baseline
      const cx = (c.minX + c.maxX) / 2;
      let after = -1;
      for (let i = 0; i < split.length; i++) if (split[i].x0 <= cx) after = i;
      // a point belongs after a digit, never before the first one
      if (after >= 0 && after < split.length - 1) dotAfter.add(after);
    }

    const digits = [];
    for (let i = 0; i < split.length; i++) {
      const r = split[i];
      const w = r.x1 - r.x0 + 1;
      if (w < 2) continue;
      const sub = new Uint8Array(w * digitH);
      for (let y = 0; y < digitH; y++) for (let x = 0; x < w; x++) {
        sub[y * w + x] = mask[(baseTop + y) * W + (r.x0 + x)];
      }
      let res;
      // "1" is the one digit with no horizontal bar, so it is far narrower
      // than the rest and cannot be scored against the zone layout, which
      // assumes a full-width cell. It still has to EARN its score rather than
      // be handed one: any thin vertical mark (a table edge, a shadow, the
      // gap between two toes) is narrow, and asserting high confidence for
      // narrowness alone turns those into a confident "111". So measure how
      // much this really looks like a single full-height solid bar.
      if (w / digitH < 0.34) {
        let lit = 0;
        const rowHit = new Uint8Array(digitH);
        for (let y = 0; y < digitH; y++) for (let x = 0; x < w; x++) {
          if (sub[y * w + x]) { lit++; rowHit[y] = 1; }
        }
        let rows = 0; for (let y = 0; y < digitH; y++) if (rowHit[y]) rows++;
        const coverage = rows / digitH;              // a bar spans the full cell height
        const solidity = lit / Math.max(1, w * digitH); // and is filled, not wispy
        const score = 0.5 * coverage + 0.5 * Math.min(1, solidity / 0.75);
        res = { digit: '1', score, margin: Math.max(0, (score - 0.75) * 2), on: null, narrow: true };
      } else res = classify(sub, w, digitH);
      digits.push({ ...res, x0: r.x0, x1: r.x1, w, h: digitH, dot: dotAfter.has(i) });
    }
    if (!digits.length) return null;

    let text = '';
    for (const d of digits) { text += d.digit; if (d.dot) text += '.'; }
    const score = digits.reduce((s, d) => s + d.score, 0) / digits.length;
    const margin = Math.min(...digits.map((d) => d.margin));
    return { text, score, margin, digits, bandTop, bandBot, baseTop, digitH, mask, W, H };
  }

  // ---------------- public API ----------------

  // Calibrated against real photos rather than picked by feel. The useful
  // signal turned out to be MARGIN, not score: a correct reading of a display
  // showing 142.7 scores 0.83, while wrong readings pulled from crops that
  // missed the display entirely score as high as 0.88. What separates them is
  // that a correct digit beats its runner-up clearly, whereas a digit decoded
  // out of noise sits almost tied between two candidates (margins of 0.01 to
  // 0.02). So the score bar is set low enough not to reject correct readings,
  // and the margin does the actual work.
  const MIN_SCORE = 0.80;   // mean per-bar agreement across the digits
  const MIN_MARGIN = 0.06;  // worst digit must still clearly beat its runner-up

  // Reads the readout inside `rect` (pixel coords in the source image). The
  // crop is scaled so the glyphs land near TARGET_H tall, which is where the
  // zone sampling behaves best.
  function readRegion(src, rect, opts) {
    opts = opts || {};
    const TARGET_H = opts.targetH || 190;
    const sw = Math.max(1, Math.round(rect.w)), sh = Math.max(1, Math.round(rect.h));
    if (sw < 8 || sh < 8) return { ok: false, reason: 'region too small' };
    const scale = Math.max(0.15, Math.min(8, TARGET_H / sh));
    const cw = Math.max(8, Math.round(sw * scale)), ch = Math.max(8, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, rect.x, rect.y, sw, sh, 0, 0, cw, ch);

    const m = litMask(c, cw, { windowFrac: 0.18, kStd: 0.25, minStd: 10, absFloor: 35 });
    const dec = decode(m.mask, m.W, m.H);
    if (!dec) return { ok: false, reason: 'no digits found', crop: c };

    const cleanText = dec.text.replace(/[^0-9.]/g, '');
    const value = parseFloat(cleanText);
    const digitCount = cleanText.replace(/\./g, '').length;

    // Confidence alone is not enough to trust a reading. If the crop is off
    // the display entirely, whatever glyph-like marks it does contain can
    // still decode cleanly and score high, so a wrong crop can produce a
    // confident wrong number. A plausibility check on the value is what
    // actually catches that, which is why the unit range is required here
    // rather than left to the caller.
    const range = opts.unit === 'lb' ? [40, 660] : [20, 300];
    const plausible = Number.isFinite(value) &&
      digitCount >= 2 && digitCount <= 5 &&
      value >= range[0] && value <= range[1];

    return {
      ok: true,
      text: dec.text,
      value: Number.isFinite(value) ? value : null,
      score: dec.score,
      margin: dec.margin,
      plausible,
      confident: dec.score >= MIN_SCORE && dec.margin >= MIN_MARGIN && plausible,
      digits: dec.digits,
      crop: c,
      debug: dec,
    };
  }

  // ---------------- localisation ----------------
  //
  // Proposes candidate readout rectangles. It does NOT try to be right first
  // time; read() decodes every candidate and lets the decoder pick, because
  // the decoder can actually tell a row of digits from a bright smudge and a
  // geometric heuristic cannot.
  //
  // The important detail is the dilation. Connected components on the raw
  // mask finds individual SEGMENTS, a horizontal bar here, a vertical bar
  // there, so any attempt to group "similar sized blobs on a baseline" is
  // meaningless: the bars of a single digit have nothing in common
  // dimensionally. Dilating first fuses each digit, and at a larger radius
  // fuses the whole readout, which is what makes the shape tests below mean
  // anything at all.
  function locateCandidates(bmp, opts) {
    opts = opts || {};
    const AW = opts.analysisWidth || 900;
    const { mask, W, H } = litMask(bmp, AW);
    const S = bmp.width / W;
    const rects = [];
    const seen = new Set();

    const fillOf = (b) => {
      let lit = 0;
      for (let y = b.minY; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) if (mask[y * W + x]) lit++;
      return lit / Math.max(1, b.w * b.h);
    };

    const push = (minX, minY, maxX, maxY, unitH) => {
      for (const padMul of [0.22, 0.45, 0.75]) {
        const padX = (maxX - minX) * 0.05 + unitH * padMul;
        const padY = unitH * padMul;
        const x = Math.max(0, (minX - padX) * S);
        const y = Math.max(0, (minY - padY) * S);
        const w = Math.min(bmp.width - x, (maxX - minX + 2 * padX) * S);
        const h = Math.min(bmp.height - y, (maxY - minY + 2 * padY) * S);
        if (w < 12 || h < 12) continue;
        const key = [x, y, w, h].map((v) => Math.round(v / 4)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        rects.push({ x, y, w, h });
      }
    };

    // Two dilation scales: the smaller one tends to fuse each digit on its
    // own, the larger one tends to fuse a whole readout into one blob. Which
    // of the two wins depends on how big the display is in frame, so try both.
    for (const radFrac of [0.004, 0.009]) {
      const r = Math.max(1, Math.round(AW * radFrac));
      const dil = dilate(mask, W, H, r, r);
      const { comps } = components(dil, W, H);

      // (a) a blob that is itself readout-shaped: wide, not too tall, and
      // hollow rather than a solid highlight
      for (const b of comps) {
        if (b.h < H * 0.010 || b.h > H * 0.35) continue;
        if (b.w < b.h * 0.8 || b.w > W * 0.85) continue;
        const ar = b.w / b.h;
        if (ar < 1.2 || ar > 9) continue;
        const f = fillOf(b);
        if (f < 0.10 || f > 0.80) continue;
        push(b.minX, b.minY, b.maxX, b.maxY, b.h);
      }

      // (b) several digit-shaped blobs sharing a baseline
      const digits = comps.filter((b) => {
        if (b.h < H * 0.010 || b.h > H * 0.35) return false;
        if (b.w < 1 || b.w > W * 0.35) return false;
        const ar = b.w / b.h;
        if (ar < 0.12 || ar > 1.6) return false;   // a digit is taller than wide
        const f = fillOf(b);
        return f >= 0.10 && f <= 0.85;
      });
      for (const seed of digits) {
        const cy = (seed.minY + seed.maxY) / 2;
        const grp = digits.filter((b) => {
          const by = (b.minY + b.maxY) / 2;
          return Math.abs(by - cy) < seed.h * 0.5 && b.h > seed.h * 0.55 && b.h < seed.h * 1.9;
        });
        if (grp.length < 2) continue;
        const minX = Math.min(...grp.map((b) => b.minX)), maxX = Math.max(...grp.map((b) => b.maxX));
        const minY = Math.min(...grp.map((b) => b.minY)), maxY = Math.max(...grp.map((b) => b.maxY));
        const ar = (maxX - minX) / Math.max(1, maxY - minY);
        if (ar < 0.8 || ar > 10) continue;
        const meanH = grp.reduce((s, b) => s + b.h, 0) / grp.length;
        push(minX, minY, maxX, maxY, meanH);
      }
    }
    return rects;
  }

  // A single geometric guess, used ONLY to seed the crop box the user then
  // confirms. It deliberately does not decode anything.
  //
  // Picking the seed by "decode every candidate and keep the most confident"
  // was tried and is actively harmful. Searching dozens of crops for the best
  // looking result is a multiple-comparisons trap: across 25 real photos it
  // reliably found some crop whose noise happened to decode cleanly, turning
  // readings that had correctly been rejected into confident wrong answers
  // (68, 196 and 96 kg among them). More candidates means more chances to get
  // unlucky, so the seed is chosen on shape alone and the decoding only ever
  // happens on the box the user has confirmed.
  function locate(bmp, opts) {
    const cands = locateCandidates(bmp, opts);
    if (!cands.length) return null;
    // Prefer the most readout-shaped proposal: wide relative to its height,
    // and reasonably large, since a scale readout is the dominant lit thing
    // in a photo of a scale.
    let best = null;
    for (const r of cands) {
      const ar = r.w / Math.max(1, r.h);
      if (ar < 1.1 || ar > 8) continue;
      const shape = 1 - Math.min(1, Math.abs(ar - 3) / 5);   // readouts cluster near 3:1
      const q = shape * Math.sqrt(r.w * r.h);
      if (!best || q > best.q) best = { q, r };
    }
    return best ? best.r : cands[0];
  }

  // Reads whatever is inside `rect`. There is no whole-photo read(): a
  // reading is only ever taken from a region the user has confirmed, for the
  // reason given above.
  function read(bmp, opts) {
    const rect = locate(bmp, opts);
    if (!rect) return { ok: false, reason: 'display not found' };
    const r = readRegion(bmp, rect, opts);
    r.rect = rect;
    return r;
  }

  global.FatterSevenSeg = {
    read, readRegion, locate, locateCandidates, decode, litMask, cleanGlyphs, classify, components, dilate,
    MIN_SCORE, MIN_MARGIN, ZONES, PATTERNS,
  };
})(window);
