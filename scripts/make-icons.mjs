// Draws the app icons (rounded square + play triangle) as PNGs without any dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * (maskable ? 0 : 0.22);
  const inset = size * 0.0;
  const cx = size * 0.52, cy = size / 2, h = size * (maskable ? 0.2 : 0.26), w = h * 1.7;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // rounded-square coverage with 1px antialiasing
      const dx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - inset - r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - inset - r), 0);
      const d = Math.hypot(dx, dy) - r;
      const a = maskable ? 1 : Math.max(0, Math.min(1, 0.5 - d));
      // background gradient
      const t = (x + y) / (2 * size);
      let R = 24 + 18 * t, G = 28 + 14 * t, B = 40 + 30 * t;
      // play triangle: points (cx-w/2, cy-h) (cx-w/2, cy+h) (cx+w/2, cy)
      const px = x + 0.5, py = y + 0.5, lx = cx - w / 2;
      if (px >= lx && px <= cx + w / 2) {
        const half = h * (1 - (px - lx) / w);
        if (Math.abs(py - cy) <= half) { R = 255; G = 138; B = 36; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, false));
writeFileSync('public/icons/icon-512.png', png(512, false));
writeFileSync('public/icons/maskable-512.png', png(512, true));
writeFileSync('public/icons/apple-touch-icon.png', png(180, true));
console.log('icons written');
