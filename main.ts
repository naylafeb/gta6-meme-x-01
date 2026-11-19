// gta6-meme-x-01 entry — main.ts (Node 22, standard library only).
//
// The entry is the X post itself: the meme is drawn by this program,
// deterministically, from the scene below (no network, no wall clock,
// no files outside the repository). Running it writes:
//   /output/POST.json  — the post's address, copied from this repo's POST.json
//   /output/meme.png   — the meme, rendered pixel-for-pixel from the scene
// Two runs write the same bytes.
//
// The meme: "LEONIDA DMV — NOW SERVING #13". The make.fun ghost is the
// clerk at Window 6 of the Leonida DMV, calling the number after a
// 13-year wait. The ticket stub says the fee was paid by the entrant's
// AI agent on make.fun.
//
// Outside the grader's container, MAKEFUN_BOT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /bot and /output:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// Pixel buffer + raster primitives (integer math, fully deterministic)
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;

type RGB = [number, number, number];

const buf = new Uint8Array(W * H * 3);

function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

function hspan(x0: number, x1: number, y: number, c: RGB): void {
  if (y < 0 || y >= H) return;
  const a = Math.max(0, x0);
  const b = Math.min(W - 1, x1);
  for (let x = a; x <= b; x++) setPx(x, y, c);
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) hspan(x0, x1, y, c);
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  for (let dy = -r; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    hspan(cx - dx, cx + dx, cy + dy, c);
  }
}

type Pt = [number, number];

// Scanline polygon fill, even-odd, top-inclusive rule.
function fillPoly(pts: Pt[], c: RGB): void {
  let minY = H;
  let maxY = -1;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  const n = pts.length;
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      if (y0 === y1) continue;
      const lo = Math.min(y0, y1);
      const hi = Math.max(y0, y1);
      if (y >= lo && y < hi) {
        xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      hspan(Math.ceil(xs[k]), Math.floor(xs[k + 1]), y, c);
    }
  }
}

// Thick line as a polygon (square-ish caps are fine at this scale).
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  fillPoly(
    [
      [Math.round(x0 + nx), Math.round(y0 + ny)],
      [Math.round(x1 + nx), Math.round(y1 + ny)],
      [Math.round(x1 - nx), Math.round(y1 - ny)],
      [Math.round(x0 - nx), Math.round(y0 - ny)],
    ],
    c,
  );
}

function lerp(a: number, b: number, t: number): number {
  return Math.floor(a + (b - a) * t + 0.5);
}

function lerpColor(c0: RGB, c1: RGB, t: number): RGB {
  return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
}

// Vertical gradient between stops: [y, color][].
function vgrad(stops: [number, RGB][], y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    let c: RGB = stops[stops.length - 1][1];
    for (let i = 0; i + 1 < stops.length; i++) {
      const [ya, ca] = stops[i];
      const [yb, cb] = stops[i + 1];
      if (y >= ya && y <= yb) {
        c = lerpColor(ca, cb, yb === ya ? 0 : (y - ya) / (yb - ya));
        break;
      }
    }
    hspan(0, W - 1, y, c);
  }
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font (uppercase + digits + punctuation), drawn as rectangles.
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#..##', '#.#.#', '##..#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '(': ['...##', '..#..', '.#...', '.#...', '.#...', '..#..', '...##'],
  ')': ['##...', '..#..', '...#.', '...#.', '...#.', '..#..', '##...'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '#.##.', '#..##'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
};

function textWidth(s: string, scale: number): number {
  if (s.length === 0) return 0;
  return s.length * 6 * scale - scale;
}

function drawText(s: string, x: number, y: number, scale: number, c: RGB): void {
  const up = s.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const g = FONT[up[i]] ?? FONT[' '];
    const ox = x + i * 6 * scale;
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] === '#') {
          fillRect(ox + col * scale, y + r * scale, ox + col * scale + scale - 1, y + r * scale + scale - 1, c);
        }
      }
    }
  }
}

// 4-point sparkle (the ghost's eyes).
function sparkle(cx: number, cy: number, hw: number, hh: number, c: RGB): void {
  fillPoly(
    [
      [cx, cy - hh],
      [cx + 5, cy - 5],
      [cx + hw, cy],
      [cx + 5, cy + 5],
      [cx, cy + hh],
      [cx - 5, cy + 5],
      [cx - hw, cy],
      [cx - 5, cy - 5],
    ],
    c,
  );
}

// 5-point star.
function star(cx: number, cy: number, r: number, c: RGB): void {
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push([Math.round(cx + rr * Math.cos(ang)), Math.round(cy + rr * Math.sin(ang))]);
  }
  fillPoly(pts, c);
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const INK: RGB = [25, 20, 25];
const CREAM: RGB = [255, 246, 216];
const MAGENTA: RGB = [196, 28, 131];
const TEAL: RGB = [15, 118, 110];
const AMBER: RGB = [255, 176, 0];
const SUNY: RGB = [255, 210, 63];
const WHITE: RGB = [255, 255, 255];
const PAPER: RGB = [255, 253, 245];
const NIGHT: RGB = [27, 16, 53];
const GROUND: RGB = [36, 20, 51];
const OCEAN: RGB = [20, 66, 92];

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------

function palm(cx: number, baseY: number, h: number, lean: number, flip: number): void {
  const topX = cx + lean;
  const topY = baseY - h;
  // Trunk: two segments, slightly curved.
  thickLine(cx, baseY, cx + lean * 0.5, baseY - h * 0.55, 15, NIGHT);
  thickLine(cx + lean * 0.5, baseY - h * 0.55, topX, topY, 12, NIGHT);
  // Six fronds fanning out from the crown.
  const fronds: [number, number][] = [
    [-150, -70],
    [-120, -110],
    [-70, -130],
    [10, -135],
    [80, -110],
    [140, -60],
  ];
  for (const [dx, dy] of fronds) {
    const tipX = topX + dx * flip;
    const tipY = topY + dy;
    const midX = topX + dx * 0.55 * flip;
    const midY = topY + dy * 0.45 - 26;
    fillPoly(
      [
        [topX - 9, topY + 5],
        [midX, midY],
        [tipX, tipY],
        [midX + 11 * flip, midY + 22],
        [topX + 9, topY + 7],
      ],
      NIGHT,
    );
  }
  // Coconuts.
  fillCircle(topX - 12, topY + 14, 7, NIGHT);
  fillCircle(topX + 10, topY + 16, 7, NIGHT);
}

// The make.fun ghost clerk, in a DMV visor, holding its magenta star coin.
// Ghost box: x0..x0+260, y0..y0+281 (local 100x108 at scale 2.6).
function ghost(x0: number, y0: number): void {
  const s = 2.6;
  const px = (lx: number) => Math.round(x0 + lx * s);
  const py = (ly: number) => Math.round(y0 + ly * s);
  // Body outline, then white body.
  const body: Pt[] = [
    [50, 2], [30, 6], [16, 18], [10, 36], [8, 60], [6, 78], [6, 98],
    [18, 106], [28, 96], [38, 106], [50, 95], [62, 106], [72, 96],
    [82, 106], [94, 98], [94, 78], [92, 60], [90, 36], [84, 18], [70, 6],
  ].map(([lx, ly]) => [px(lx), py(ly)] as Pt);
  const grow = 5;
  const outline: Pt[] = body.map(([x, y]) => {
    const cx = px(50);
    const cy = py(55);
    return [Math.round(x + Math.sign(x - cx) * grow), Math.round(y + Math.sign(y - cy) * grow)] as Pt;
  });
  fillPoly(outline, INK);
  fillPoly(body, WHITE);
  // Left arm bump.
  // (removed: read as a floating ball; the ghost is cleaner without it)
  // Visor: teal band across the forehead, brim to the right.
  fillPoly(
    [
      [px(14), py(22)], [px(30), py(13)], [px(50), py(10)], [px(70), py(13)],
      [px(86), py(22)], [px(86), py(30)], [px(70), py(22)], [px(50), py(19)],
      [px(30), py(22)], [px(14), py(30)],
    ],
    TEAL,
  );
  fillPoly([[px(82), py(20)], [px(100), py(16)], [px(100), py(26)], [px(82), py(28)]], TEAL);
  // Sparkle eyes.
  sparkle(px(35), py(44), 15, 21, INK);
  sparkle(px(63), py(44), 15, 21, INK);
  // Star coin held at the ghost's right side.
  fillCircle(px(104), py(72), 46, INK);
  fillCircle(px(104), py(72), 40, MAGENTA);
  star(px(104), py(72), 26, WHITE);
}

// ---------------------------------------------------------------------------
// The meme
// ---------------------------------------------------------------------------

function render(): void {
  // Header bar.
  fillRect(0, 0, W - 1, 95, INK);
  drawText('LEONIDA DMV', 48, 28, 5, CREAM);
  const w6 = textWidth('WINDOW 6', 5);
  drawText('WINDOW 6', W - 48 - w6, 28, 5, CREAM);

  // Vice City sunset.
  vgrad(
    [
      [96, [42, 16, 82]],
      [200, [107, 30, 122]],
      [300, MAGENTA],
      [380, [255, 94, 98]],
      [440, [255, 158, 79]],
      [480, SUNY],
    ],
    96,
    479,
  );

  // Stars in the upper sky.
  sparkle(210, 150, 5, 7, CREAM);
  sparkle(820, 140, 4, 6, CREAM);
  sparkle(700, 210, 3, 5, CREAM);
  sparkle(330, 240, 3, 5, CREAM);
  // Birds.
  thickLine(280, 190, 292, 182, 3, NIGHT);
  thickLine(292, 182, 304, 190, 3, NIGHT);
  thickLine(720, 170, 732, 162, 3, NIGHT);
  thickLine(732, 162, 744, 170, 3, NIGHT);

  // Synthwave sun with slits (wide, so it frames the ghost).
  fillCircle(512, 440, 170, [255, 223, 107]);
  const slits: [number, number][] = [
    [295, 6],
    [320, 7],
    [400, 7],
    [425, 9],
    [450, 11],
    [470, 13],
  ];
  for (const [sy, sh] of slits) {
    const rowC = (() => {
      // Sample the sky gradient at this row: reuse the stop table.
      const stops: [number, RGB][] = [
        [96, [42, 16, 82]],
        [200, [107, 30, 122]],
        [300, MAGENTA],
        [380, [255, 94, 98]],
        [440, [255, 158, 79]],
        [480, SUNY],
      ];
      for (let i = 0; i + 1 < stops.length; i++) {
        const [ya, ca] = stops[i];
        const [yb, cb] = stops[i + 1];
        if (sy >= ya && sy <= yb) return lerpColor(ca, cb, yb === ya ? 0 : (sy - ya) / (yb - ya));
      }
      return SUNY;
    })();
    fillRect(512 - 170, sy, 512 + 170, sy + sh - 1, rowC);
  }

  // Queue board: NOW SERVING #13.
  fillRect(262, 120, 762, 268, INK);
  fillRect(262, 120, 762, 126, AMBER);
  fillRect(262, 262, 762, 268, AMBER);
  fillRect(262, 120, 268, 268, AMBER);
  fillRect(756, 120, 762, 268, AMBER);
  const ns = textWidth('NOW SERVING', 4);
  drawText('NOW SERVING', 512 - Math.floor(ns / 2), 140, 4, AMBER);
  const n13 = textWidth('#13', 11);
  drawText('#13', 512 - Math.floor(n13 / 2), 178, 11, SUNY);

  // Ocean + sun reflection.
  fillRect(0, 480, W - 1, 569, OCEAN);
  fillRect(452, 505, 572, 509, SUNY);
  fillRect(422, 530, 602, 534, [255, 158, 79]);
  fillRect(392, 552, 632, 556, [255, 158, 79]);

  // Ground.
  fillRect(0, 570, W - 1, 639, GROUND);
  fillRect(0, 570, W - 1, 575, [58, 32, 96]);

  // Palm silhouettes.
  palm(110, 640, 250, -24, 1);
  palm(920, 640, 260, 22, -1);

  // The ghost clerk at the counter.
  ghost(382, 330);

  // Counter.
  fillRect(40, 560, 984, 639, TEAL);
  fillRect(40, 560, 984, 570, CREAM);
  const np = textWidth('NEXT PLEASE', 3);
  drawText('NEXT PLEASE', 512 - Math.floor(np / 2), 592, 3, CREAM);
  // Service bell on the counter.
  fillCircle(820, 546, 18, [255, 176, 0]);
  fillRect(798, 560, 842, 567, [255, 176, 0]);
  fillRect(812, 526, 828, 534, [255, 176, 0]);

  // Ticket slip.
  fillRect(60, 664, 964, 1000, PAPER);
  fillRect(60, 664, 964, 667, INK);
  fillRect(60, 997, 964, 1000, INK);
  fillRect(60, 664, 63, 1000, INK);
  fillRect(961, 664, 964, 1000, INK);
  // Tear dashes along the top.
  for (let x = 76; x < 950; x += 28) fillRect(x, 678, x + 14, 682, INK);
  drawText('TICKET #13', 110, 706, 6, MAGENTA);
  drawText('WAIT TIME: 13 YEARS', 110, 772, 4, INK);
  drawText('GAME: GTA VI (PS5)', 110, 824, 4, INK);
  drawText('FEE: PAID BY MY AI AGENT', 110, 876, 4, INK);
  drawText('MAKE.FUN', 110, 928, 5, MAGENTA);
  // Star-coin stamp, top right of the slip.
  fillCircle(884, 736, 34, INK);
  fillCircle(884, 736, 29, MAGENTA);
  star(884, 736, 19, WHITE);
  // Barcode, bottom right.
  const bars = [3, 1, 2, 1, 1, 3, 2, 2, 1, 1, 3, 1, 2, 1, 4, 1, 1, 2, 3, 1, 1, 1, 2, 2, 1, 3, 1, 2];
  let bx = 690;
  for (const bw of bars) {
    if (bw % 2 === 1) fillRect(bx, 920, bx + bw * 3 - 1, 972, INK);
    bx += bw * 3 + 3;
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (filter 0, zlib level 9) — deterministic output.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function pngEncode(): Uint8Array {
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIR, { recursive: true });
render();
const png = pngEncode();
// Verify the encoded meme before writing it: PNG signature, the 'IHDR'
// chunk tag, and its dimensions (width/height as big-endian uint32 at
// offsets 16 and 20), plus the 'IEND' trailer at the end.
const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
const tag = (off: number) => String.fromCharCode(png[off], png[off + 1], png[off + 2], png[off + 3]);
if (png[0] !== 137 || png[1] !== 80 || tag(12) !== 'IHDR' || tag(png.length - 8) !== 'IEND') {
  console.error('meme.png failed PNG structure checks');
  process.exit(1);
}
if (dv.getUint32(16) !== W || dv.getUint32(20) !== H) {
  console.error(`meme.png has wrong dimensions: ${dv.getUint32(16)}x${dv.getUint32(20)}, expected ${W}x${H}`);
  process.exit(1);
}
writeFileSync(join(OUTPUT_DIR, 'meme.png'), png);
try {
  copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
} catch (err) {
  console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
  process.exit(1);
}
