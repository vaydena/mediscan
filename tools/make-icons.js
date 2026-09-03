// Erzeugt die PWA-Icons (PNG) ohne externe Abhängigkeiten.
// Motiv: Tablettenkapsel + Scanlinie auf Petrol (MediScan). KEIN rotes Kreuz (markenrechtlich geschützt).
// Aufruf: node tools/make-icons.js  → assets/icons/*.png
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// abgerundete Rechtecke (x,y,w,h,r als Anteile der Kantenlänge) mit Supersampling
function render(size, shapes, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  const inside = (sh, px, py) => {
    const x = sh.x * size, y = sh.y * size, w = sh.w * size, h = sh.h * size, r = Math.min(sh.r * size, w / 2, h / 2);
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.max(x + r, Math.min(px, x + w - r)), cy = Math.max(y + r, Math.min(py, y + h - r));
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (const sh of shapes) {
      let cov = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (inside(sh, x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) cov++;
      cov /= ss * ss; if (!cov) continue;
      const a = cov * (sh.a == null ? 1 : sh.a);
      R = sh.c[0] * a + R * (1 - a); G = sh.c[1] * a + G * (1 - a); B = sh.c[2] * a + B * (1 - a); A = a + A * (1 - a);
    }
    const o = (y * size + x) * 4;
    buf[o] = Math.round(R); buf[o + 1] = Math.round(G); buf[o + 2] = Math.round(B); buf[o + 3] = Math.round(A * 255);
  }
  return buf;
}
const PETROL = [0, 105, 92], DARK = [0, 77, 64], CYAN = [0, 172, 193], WHITE = [255, 255, 255];
function shapes(maskable) {
  const s = [];
  s.push({ x: 0, y: 0, w: 1, h: 1, r: maskable ? 0 : 0.22, c: PETROL });
  // Kapsel (weiße Tablette), horizontal
  const cw = 0.56, ch = 0.20, cx = (1 - cw) / 2, cy = (1 - ch) / 2;
  s.push({ x: cx, y: cy, w: cw, h: ch, r: ch / 2, c: WHITE });
  // rechte Kapselhälfte cyan
  s.push({ x: cx + cw / 2, y: cy, w: cw / 2, h: ch, r: ch / 2, c: CYAN });
  // Trennfuge (dünn, petrol) in der Mitte
  s.push({ x: 0.49, y: cy, w: 0.02, h: ch, c: PETROL });
  // Scanlinie (cyan) quer über die Kapsel, leicht oberhalb der Mitte
  s.push({ x: cx - 0.07, y: 0.5 - 0.017, w: cw + 0.14, h: 0.034, r: 0.017, c: CYAN, a: 0.85 });
  return s;
}
const out = path.join(__dirname, "..", "assets", "icons");
fs.mkdirSync(out, { recursive: true });
const jobs = [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["icon-maskable-512.png", 512, true], ["apple-touch-icon.png", 180, true], ["favicon-32.png", 32, false]];
for (const [name, size, mask] of jobs) {
  const png = encodePNG(size, size, render(size, shapes(mask), size <= 64 ? 8 : 4));
  fs.writeFileSync(path.join(out, name), png);
  console.log(name, png.length, "bytes");
}
