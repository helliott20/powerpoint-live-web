/**
 * Writes placeholder PNG icons (32/64/128) to addin/public/assets.
 * No dependencies: a tiny PNG encoder on top of node:zlib.
 * Replace the output files with your own artwork whenever you like.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets");
mkdirSync(out, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size: number): Buffer {
  const accent = [196, 62, 28];
  const white = [255, 255, 255];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.18; // corner radius
  const inside = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let rgba = [0, 0, 0, 0];
      if (inside(px, py)) {
        rgba = [...accent, 255];
        // a simple "browser window": white panel with a title bar and globe-ish circle
        const m = size * 0.16;
        const inPanel = px > m && px < size - m && py > m && py < size - m;
        const bar = py < m + size * 0.14;
        if (inPanel) {
          rgba = bar ? [255, 226, 214, 255] : [...white, 255];
          const gx = size / 2, gy = size * 0.58, gr = size * 0.2;
          const d = Math.hypot(px - gx, py - gy);
          const ring = Math.abs(d - gr) < Math.max(1, size * 0.035);
          const meridian = d < gr && Math.abs(px - gx) < Math.max(0.6, size * 0.025);
          const equator = d < gr && Math.abs(py - gy) < Math.max(0.6, size * 0.025);
          if (!bar && (ring || meridian || equator)) rgba = [...accent, 255];
        }
      }
      raw.set(rgba, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 64, 80, 128]) {
  writeFileSync(join(out, `icon-${size}.png`), icon(size));
  console.log(`wrote assets/icon-${size}.png`);
}
