#!/usr/bin/env node
// gen-icons.js — genera le icone PWA (in icons/) senza dipendenze esterne.
//
//   node tools/gen-icons.js
//
// Non servono ImageMagick/sharp/canvas: un piccolo encoder PNG (via node:zlib)
// e un rasterizzatore con supersampling disegnano un taxi visto dall'alto su un
// incrocio, con la palette del gioco (navy #0d0b28, giallo taxi #ffc832).
// Le PNG risultanti sono asset sorgente: build.js le copia in dist/, quindi
// questo script va rilanciato solo se vuoi ridisegnare l'icona.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'icons');

// ---------------------------------------------------------------- PNG encoder
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // 10,11,12 = compression / filter / interlace = 0
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------- disegno
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];

// composite "source over" (alpha dritto, rgb 0..255, a 0..1)
function over(dst, r, g, b, a) {
  if (a <= 0) return;
  const na = a + dst.a * (1 - a);
  if (na <= 0) { dst.a = 0; return; }
  dst.r = (r * a + dst.r * dst.a * (1 - a)) / na;
  dst.g = (g * a + dst.g * dst.a * (1 - a)) / na;
  dst.b = (b * a + dst.b * dst.a * (1 - a)) / na;
  dst.a = na;
}
// test "dentro" di un rettangolo con angoli arrotondati (coord normalizzate 0..1)
function inRR(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = clamp(u, x0 + r, x1 - r);
  const cy = clamp(v, y0 + r, y1 - r);
  const dx = u - cx, dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}
const inRect = (u, v, x0, y0, x1, y1) => u >= x0 && u <= x1 && v >= y0 && v <= y1;
function inCircle(u, v, cx, cy, r) {
  const dx = u - cx, dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

const NAVY_HI = [0x2b, 0x2c, 0x6e];  // indaco in alto a sinistra
const NAVY_LO = [0x0c, 0x0a, 0x22];  // navy profondo (≈ #0d0b28) in basso a destra
const ASPH = [0x24, 0x27, 0x36];     // asfalto
const DASH = [0xff, 0xc8, 0x32];     // strisce gialle
const TAXI_HI = [0xff, 0xcf, 0x3a];  // giallo taxi chiaro (tetto)
const TAXI_LO = [0xf0, 0xad, 0x0e];  // giallo taxi scuro (coda)
const RIM = [0x8a, 0x5a, 0x08];      // bordo ambra scuro
const GLASS = [0x22, 0x30, 0x49];    // vetri
const WHEEL = [0x14, 0x15, 0x1c];    // gomme
const BEACON = [0xff, 0x50, 0x40];   // luce sul tetto / fari posteriori
const HEAD = [0xff, 0xf3, 0xc4];     // fari anteriori

function bgColor(u, v) {
  const base = lerp3(NAVY_HI, NAVY_LO, clamp((u + v) / 2, 0, 1));
  // alone di luce dietro il taxi
  const dx = u - 0.5, dy = v - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy) / 0.5;
  const glow = Math.pow(clamp(1 - d, 0, 1), 1.6) * 0.32;
  return [
    clamp(base[0] + glow * 70, 0, 255),
    clamp(base[1] + glow * 82, 0, 255),
    clamp(base[2] + glow * 120, 0, 255),
  ];
}

// strisce tratteggiate al centro delle strade, saltando l'incrocio (dove sta il taxi)
function dash(dst, u, v) {
  const segs = [[0.05, 0.13], [0.16, 0.24], [0.76, 0.84], [0.87, 0.95]];
  for (const [a, b] of segs) {
    if (inRect(u, v, 0.492, a, 0.508, b)) over(dst, DASH[0], DASH[1], DASH[2], 0.7);
    if (inRect(u, a, 0.492, v, 0.508, b)) { /* placeholder */ }
    if (inRect(v, u, a, 0.492, b, 0.508)) over(dst, DASH[0], DASH[1], DASH[2], 0.7);
  }
}

// disegna strade + taxi in coordinate modello [0,1]
function foreground(dst, u, v) {
  // asfalto (incrocio)
  if (inRect(u, v, 0.35, 0, 0.65, 1)) over(dst, ASPH[0], ASPH[1], ASPH[2], 1);
  if (inRect(u, v, 0, 0.35, 1, 0.65)) over(dst, ASPH[0], ASPH[1], ASPH[2], 1);
  dash(dst, u, v);

  // ombra morbida (due passate concentriche)
  if (inRR(u, v, 0.33, 0.235, 0.67, 0.80, 0.10)) over(dst, 0, 0, 0, 0.18);
  if (inRR(u, v, 0.345, 0.25, 0.655, 0.79, 0.09)) over(dst, 0, 0, 0, 0.22);

  // gomme (sporgono dai lati; il corpo le coprirà all'interno)
  const wheels = [
    [0.315, 0.31, 0.362, 0.42], [0.638, 0.31, 0.685, 0.42], // anteriori
    [0.315, 0.58, 0.362, 0.69], [0.638, 0.58, 0.685, 0.69], // posteriori
  ];
  for (const [x0, y0, x1, y1] of wheels)
    if (inRR(u, v, x0, y0, x1, y1, 0.016)) over(dst, WHEEL[0], WHEEL[1], WHEEL[2], 1);

  // bordo del corpo (leggermente più grande) + corpo
  if (inRR(u, v, 0.337, 0.217, 0.663, 0.783, 0.088)) over(dst, RIM[0], RIM[1], RIM[2], 1);
  if (inRR(u, v, 0.345, 0.225, 0.655, 0.775, 0.082)) {
    const t = clamp((v - 0.225) / 0.55, 0, 1);
    const c = lerp3(TAXI_HI, TAXI_LO, t);
    over(dst, c[0], c[1], c[2], 1);
  }

  // parabrezza + lunotto
  if (inRR(u, v, 0.388, 0.288, 0.612, 0.40, 0.05)) over(dst, GLASS[0], GLASS[1], GLASS[2], 1);
  if (inRR(u, v, 0.388, 0.60, 0.612, 0.712, 0.05)) over(dst, GLASS[0], GLASS[1], GLASS[2], 1);

  // luce/insegna sul tetto (tocco di rosso al centro)
  if (inRR(u, v, 0.458, 0.455, 0.542, 0.545, 0.02)) over(dst, BEACON[0], BEACON[1], BEACON[2], 1);

  // fari
  if (inCircle(u, v, 0.383, 0.247, 0.023)) over(dst, HEAD[0], HEAD[1], HEAD[2], 1);
  if (inCircle(u, v, 0.617, 0.247, 0.023)) over(dst, HEAD[0], HEAD[1], HEAD[2], 1);
  if (inCircle(u, v, 0.383, 0.753, 0.02)) over(dst, BEACON[0], BEACON[1], BEACON[2], 1);
  if (inCircle(u, v, 0.617, 0.753, 0.02)) over(dst, BEACON[0], BEACON[1], BEACON[2], 1);
}

// opt: { round:bool, rNorm, scale, bleed:bool }
function render(size, opt) {
  const SS = 4;                 // supersampling per lato → 16 campioni/pixel
  const rgba = Buffer.alloc(size * size * 4);
  const scale = opt.scale || 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const dst = { r: 0, g: 0, b: 0, a: 0 };
          if (opt.round && !inRR(u, v, 0, 0, 1, 1, opt.rNorm)) {
            // fuori dagli angoli arrotondati → trasparente
          } else {
            const bc = bgColor(u, v);
            over(dst, bc[0], bc[1], bc[2], 1);
            const uf = 0.5 + (u - 0.5) / scale;
            const vf = 0.5 + (v - 0.5) / scale;
            foreground(dst, uf, vf);
          }
          r += dst.r * dst.a; g += dst.g * dst.a; b += dst.b * dst.a; a += dst.a;
        }
      }
      const n = SS * SS;
      const A = a / n;
      const i = (y * size + x) * 4;
      // de-premultiplica per lo storage (alpha dritto)
      rgba[i] = A > 0 ? Math.round(clamp(r / a, 0, 255)) : 0;
      rgba[i + 1] = A > 0 ? Math.round(clamp(g / a, 0, 255)) : 0;
      rgba[i + 2] = A > 0 ? Math.round(clamp(b / a, 0, 255)) : 0;
      rgba[i + 3] = Math.round(clamp(A * 255, 0, 255));
    }
  }
  return encodePNG(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { round: true, rNorm: 0.20 }],
  ['icon-512.png', 512, { round: true, rNorm: 0.20 }],
  ['icon-maskable-192.png', 192, { bleed: true, scale: 0.78 }],
  ['icon-maskable-512.png', 512, { bleed: true, scale: 0.78 }],
  ['apple-touch-icon.png', 180, { scale: 0.9 }],
  ['favicon-32.png', 32, { round: true, rNorm: 0.20 }],
  ['favicon-16.png', 16, { round: true, rNorm: 0.20 }],
];
for (const [name, size, opt] of jobs) {
  fs.writeFileSync(path.join(OUT, name), render(size, opt));
  console.log(`  icons/${name}  (${size}×${size})`);
}
console.log(`\n${jobs.length} icone generate in icons/`);
