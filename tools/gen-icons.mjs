#!/usr/bin/env node
/**
 * 生成 PWA 所需的 PNG 图标（不依赖任何第三方库）
 *   node tools/gen-icons.mjs
 *
 * 做法：2 倍超采样绘制 → 平均降采样 → 手写 PNG 编码（zlib + CRC32）
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'icons');

/* ══════════ PNG 编码 ══════════ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ══════════ 绘制 ══════════ */
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
];

function makeCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(cv, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= cv.size || y >= cv.size || a <= 0) return;
  const i = (y * cv.size + x) * 4;
  const d = cv.data;
  const sa = a, da = d[i + 3];
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  d[i]     = (r * sa + d[i]     * da * (1 - sa)) / oa;
  d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
  d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
  d[i + 3] = oa;
}

function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function roundRect(cv, x, y, w, h, r, color) {
  const [R, G, B] = hex(color);
  const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(cv.size, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(cv.size, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      if (inRoundRect(px + .5, py + .5, x, y, w, h, r)) blend(cv, px, py, R, G, B, 1);
    }
  }
}

function tri(cv, p1, p2, p3, color) {
  const [R, G, B] = hex(color);
  const minX = Math.max(0, Math.floor(Math.min(p1[0], p2[0], p3[0])));
  const maxX = Math.min(cv.size, Math.ceil(Math.max(p1[0], p2[0], p3[0])));
  const minY = Math.max(0, Math.floor(Math.min(p1[1], p2[1], p3[1])));
  const maxY = Math.min(cv.size, Math.ceil(Math.max(p1[1], p2[1], p3[1])));
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const p = [x + .5, y + .5];
      const d1 = sign(p, p1, p2), d2 = sign(p, p2, p3), d3 = sign(p, p3, p1);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) blend(cv, x, y, R, G, B, 1);
    }
  }
}

function draw(size, maskable) {
  const SS = 2;
  const S = size * SS;
  const cv = makeCanvas(S);

  const pad = maskable ? S * 0.14 : 0;
  const scale = maskable ? 0.74 : 1;
  const off = maskable ? S * 0.13 : 0;

  // 背景
  roundRect(cv, 0, 0, S, S, maskable ? 0 : S * 0.219, '#2b2723');

  // 纸页（设计坐标基于 512 视口，按超采样倍率换算）
  const k = (S / 512) * scale;
  const P = (v) => off + v * k;
  const W = (v) => v * k;

  roundRect(cv, P(134), P(90), W(244), W(332), W(14), '#fbf8f1');

  // 折角
  tri(cv, [P(306), P(90)], [P(378), P(162)], [P(306), P(162)], '#d8d0be');

  // 文字行
  const lines = [[212, 168], [246, 140], [280, 168], [314, 96]];
  for (const [yy, ww] of lines) {
    roundRect(cv, P(176), P(yy), W(ww), W(13), W(6.5), '#cbc2af');
  }

  // 朱砂笔迹（用几段圆角矩形模拟）
  const ink = [[178, 372, 60, 14], [232, 356, 52, 14], [280, 368, 46, 14], [320, 352, 44, 14]];
  for (const [x, y, w, h] of ink) {
    roundRect(cv, P(x), P(y + 4), W(w), W(h), W(h / 2), '#b1553c');
  }

  // 书脊阴影
  roundRect(cv, P(134), P(90), W(16), W(332), W(6), '#d0c7b4');

  return cv;
}

function downsample(cv, target) {
  const S = cv.size, f = S / target;
  const out = Buffer.alloc(target * target * 4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const i = ((y * f + sy) * S + (x * f + sx)) * 4;
          const al = cv.data[i + 3];
          r += cv.data[i] * al; g += cv.data[i + 1] * al; b += cv.data[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * target + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ══════════ 输出 ══════════ */
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: true }
];

for (const j of jobs) {
  const cv = draw(j.size, j.maskable);
  const rgba = downsample(cv, j.size);
  const png = encodePNG(j.size, j.size, rgba);
  fs.writeFileSync(path.join(OUT, j.name), png);
  console.log(`✓ icons/${j.name}  ${j.size}×${j.size}  ${(png.length / 1024).toFixed(1)} KB`);
}

/* ── Android launcher 图标 ── */
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const ANDROID = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
];

if (fs.existsSync(path.join(__dirname, '..', 'android'))) {
  for (const [dir, size] of ANDROID) {
    const outDir = path.join(RES, dir);
    fs.mkdirSync(outDir, { recursive: true });
    const cv = draw(Math.max(size, 96), false);
    const rgba = downsample(cv, size);
    const png = encodePNG(size, size, rgba);
    fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), png);
    fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), png);
    console.log(`✓ android/${dir}/ic_launcher.png  ${size}×${size}`);
  }
}

console.log('图标生成完毕。');
