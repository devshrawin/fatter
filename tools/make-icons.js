#!/usr/bin/env node
// Generates PNG app icons from the brand mark chosen in Claude Design
// (Fatter.dc.html, section 11, "Concept A": an ascending step-line that
// doubles as the stem+bars of an "F"). Uses only Node's built-in zlib plus
// a minimal raw PNG encoder: no canvas dependency. Re-run after any brand
// color or mark change.
//
// Usage: node tools/make-icons.js

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');

// From the design handoff (oklch(16% 0 0) surface / oklch(76% .19 55) accent),
// converted to sRGB (see the conversion in PLAN notes). Keep in sync with the
// --surface / --accent tokens in css/style.css.
const BG = [0x0d, 0x0d, 0x0d];
const ACCENT = [0xff, 0x89, 0x00];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Anti-aliased circle stamp, used for round line-caps/joins and the accent dot.
function paintCircle(px, size, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const a = d <= 0 ? 1 : d >= 1 ? 0 : 1 - d;
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2];
      px[i + 3] = Math.max(px[i + 3], Math.round(a * 255));
    }
  }
}

// Anti-aliased axis-aligned thick segment (the path is built entirely from
// horizontal/vertical strokes, so a padded-rect fill + round caps/joins via
// paintCircle at every vertex reproduces the SVG stroke faithfully).
function paintSegment(px, size, x0, y0, x1, y1, halfWidth, color) {
  const left = Math.min(x0, x1) - halfWidth, right = Math.max(x0, x1) + halfWidth;
  const top = Math.min(y0, y1) - halfWidth, bottom = Math.max(y0, y1) + halfWidth;
  const xs = Math.max(0, Math.floor(left)), xe = Math.min(size - 1, Math.ceil(right));
  const ys = Math.max(0, Math.floor(top)), ye = Math.min(size - 1, Math.ceil(bottom));
  for (let y = ys; y <= ye; y++) {
    for (let x = xs; x <= xe; x++) {
      if (x + 0.5 < left || x + 0.5 > right || y + 0.5 < top || y + 0.5 > bottom) continue;
      const i = (y * size + x) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
    }
  }
  paintCircle(px, size, x0, y0, halfWidth, color);
  paintCircle(px, size, x1, y1, halfWidth, color);
}

// Renders the brand mark (100x100 source space: M22,86 L22,54 L46,54 L46,28
// L78,28, stroke-width 9 round cap/join, + accent dot r7 at the tip) scaled
// and centered into `size`, with `pad` px of margin (maskable icons need the
// mark inside the OS's circular-crop safe zone, so they get extra padding).
function renderIcon(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = BG[0]; px[i + 1] = BG[1]; px[i + 2] = BG[2]; px[i + 3] = 255;
  }

  const markFrac = maskable ? 0.42 : 0.55; // fraction of `size` the 100-unit mark maps to
  const scale = (size * markFrac) / 100;
  const offset = (size - 100 * scale) / 2;
  const P = (v) => v * scale + offset;

  const pts = [[22, 86], [22, 54], [46, 54], [46, 28], [78, 28]];
  const halfWidth = 9 * scale / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    paintSegment(px, size, P(ax), P(ay), P(bx), P(by), halfWidth, ACCENT);
  }
  paintCircle(px, size, P(78), P(28), 7 * scale, ACCENT);

  return px;
}

function encodePNG(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // raw scanlines, each prefixed with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(px.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeIcon(name, size, opts) {
  const png = encodePNG(renderIcon(size, opts), size);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`  wrote icons/${name} (${size}x${size}, ${png.length}B)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('Generating brand icons...');
writeIcon('icon-192.png', 192);
writeIcon('icon-512.png', 512);
writeIcon('icon-maskable-512.png', 512, { maskable: true });
writeIcon('apple-touch-icon-180.png', 180);
writeIcon('favicon-32.png', 32);
writeIcon('favicon-16.png', 16);

// Vector favicon (crisp at any size): same mark, accent stroke so the
// browser-tab icon reads as the same brand mark as the installed app icon
// and the in-app header logo (all three draw from --accent).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0d0d0d"/>
  <path d="M9,27.5 L9,17.5 L14.5,17.5 L14.5,9 L25,9" fill="none" stroke="#ff8900" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), svg);
console.log('  wrote icons/favicon.svg');
console.log('Done.');
