// Generates app-icon.png (1024x1024) with pure Node (zlib), no image deps.
// Draws a dark rounded square with a green ">" prompt and blue cursor bar.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// distance from point to segment
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const cx = x1 + t * dx,
    cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const R = 180; // corner radius
const bg = [26, 27, 38]; // #1a1b26
const green = [158, 206, 106]; // #9ecD6a -> prompt
const blue = [122, 162, 247]; // #7aa2f7 -> cursor
const panel = [36, 38, 54]; // inner panel

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 3 + 1);
  raw[rowStart] = 0; // filter none
  for (let x = 0; x < W; x++) {
    // rounded-rect mask
    const cx = Math.min(Math.max(x, R), W - R);
    const cy = Math.min(Math.max(y, R), H - R);
    const dCorner = Math.hypot(x - cx, y - cy);
    let c = bg;
    if (dCorner <= R) {
      // inner panel inset 90
      const inX = x >= 110 && x < W - 110 && y >= 260 && y < H - 180;
      const R2 = 40;
      const cx2 = Math.min(Math.max(x, 110 + R2), W - 110 - R2);
      const cy2 = Math.min(Math.max(y, 260 + R2), H - 180 - R2);
      const d2 = Math.hypot(x - cx2, y - cy2);
      const inPanel = inX ? true : d2 <= R2 && x > 110 && x < W - 110 && y > 260 && y < H - 180;
      const insidePanel =
        x > 110 && x < W - 110 && y > 260 && y < H - 180 && Math.hypot(x - cx2, y - cy2) <= R2 + 0.5;
      c = insidePanel ? panel : bg;
      if (insidePanel) {
        // prompt chevron: two thick segments
        const d1 = distSeg(x, y, 300, 400, 430, 512);
        const d2 = distSeg(x, y, 430, 512, 300, 624);
        // cursor bar
        const bar = x >= 500 && x <= 700 && y >= 580 && y <= 630;
        if (d1 < 36 || d2 < 36) c = green;
        else if (bar) c = blue;
      }
    }
    const i = rowStart + 1 + x * 3;
    raw[i] = c[0];
    raw[i + 1] = c[1];
    raw[i + 2] = c[2];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("app-icon.png", png);
console.log("wrote app-icon.png", png.length, "bytes");
