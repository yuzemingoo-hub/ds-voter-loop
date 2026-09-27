// 生成应用图标：icon.png（预览用）+ icon.ico（Windows 快捷方式用）。零依赖。
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..');

/* ---------- 画图 ---------- */

const BG = [31, 111, 235];      // #1f6feb
const FG = [255, 255, 255];

// 点到线段的距离
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const inRounded = (x, y, size, r) => {
  const m = size * 0.04;                 // 外边距
  const a = m, b = size - m;
  if (x < a || x > b || y < a || y > b) return false;
  const cx = Math.min(Math.max(x, a + r), b - r);
  const cy = Math.min(Math.max(y, a + r), b - r);
  return Math.hypot(x - cx, y - cy) <= r || (x >= a + r && x <= b - r) || (y >= a + r && y <= b - r);
};

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const r = S * 0.22;                                     // 圆角半径
  const lw = Math.max(1.1, S * 0.115);                    // 对勾线宽
  // 对勾三点
  const p1 = [S * 0.27, S * 0.53], p2 = [S * 0.44, S * 0.69], p3 = [S * 0.75, S * 0.33];
  const ss = 2;                                           // 超采样，边缘更顺
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bgHits = 0, fgHits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          if (!inRounded(px, py, S, r)) continue;
          bgHits++;
          const d = Math.min(segDist(px, py, p1[0], p1[1], p2[0], p2[1]), segDist(px, py, p2[0], p2[1], p3[0], p3[1]));
          if (d <= lw / 2) fgHits++;
        }
      }
      const total = ss * ss;
      const cov = bgHits / total;
      const alpha = Math.round(cov * 255);
      const fgRatio = bgHits ? fgHits / bgHits : 0;
      const i = (y * S + x) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BG[c] * (1 - fgRatio) + FG[c] * fgRatio);
      buf[i + 3] = alpha;
    }
  }
  return buf;
}

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function toPng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                    // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO ---------- */

function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + images.length * 16;

  for (const { size, rgba } of images) {
    const bih = Buffer.alloc(40);
    bih.writeUInt32LE(40, 0);
    bih.writeInt32LE(size, 4);
    bih.writeInt32LE(size * 2, 8);      // 高度 = XOR + AND
    bih.writeUInt16LE(1, 12);
    bih.writeUInt16LE(32, 14);
    bih.writeUInt32LE(0, 16);
    bih.writeUInt32LE(size * size * 4, 20);

    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {              // BMP 自下而上
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4;
        const d = (y * size + x) * 4;
        xor[d] = rgba[s + 2];                     // B
        xor[d + 1] = rgba[s + 1];                 // G
        xor[d + 2] = rgba[s];                     // R
        xor[d + 3] = rgba[s + 3];                 // A
      }
    }
    const andRow = Math.ceil(size / 32) * 4;
    const and = Buffer.alloc(andRow * size);

    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    const blob = Buffer.concat([bih, xor, and]);
    e.writeUInt32LE(blob.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += blob.length;
    entries.push(e);
    blobs.push(blob);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------- 输出 ---------- */

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, rgba: draw(size) }));

writeFileSync(path.join(OUT, 'icon.ico'), toIco(images.filter((i) => i.size <= 128).concat(images.filter((i) => i.size === 256))));
writeFileSync(path.join(OUT, 'icon.png'), toPng(images.find((i) => i.size === 256).rgba, 256));
console.log('已生成 icon.ico 和 icon.png');
