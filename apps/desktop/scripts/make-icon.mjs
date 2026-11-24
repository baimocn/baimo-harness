/**
 * 应用图标生成（第八块）：几何「墨迹」标记——深色圆角方底 + 三道横墨迹
 * （长短参差，呼应「白墨」与代码行）+ 一枚强调色点（模式色蓝）。
 * 纯 Node 手写 PNG 编码（zlib deflate + CRC32），不依赖任何图形库/外部素材。
 * 产出 apps/desktop/assets/icon-{512,256,128,64,32}.png 与 icon.png（512 副本）。
 */
import { deflateSync } from "node:zlib";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "assets");
mkdirSync(outDir, { recursive: true });

/* ---------- 最小 PNG 编码器 ---------- */
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
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 图形：距离场抗锯齿 ---------- */
function hex(rgb) {
  return [
    parseInt(rgb.slice(1, 3), 16),
    parseInt(rgb.slice(3, 5), 16),
    parseInt(rgb.slice(5, 7), 16),
  ];
}
const BG = hex("#14161a");
const BG_EDGE = hex("#2b303a");
const INK = hex("#e8eaee");
const ACCENT = hex("#4370c9");

function sdRoundBox(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, x1, y1, x2, y2) {
  const px = x - x1;
  const py = y - y1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t);
}
function cover(d, aa) {
  return Math.max(0, Math.min(1, 0.5 - d / aa));
}
function blend(dst, i, src, a) {
  dst[i] = Math.round(dst[i] * (1 - a) + src[0] * a);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - a) + src[1] * a);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - a) + src[2] * a);
  dst[i + 3] = Math.round(dst[i + 3] * (1 - a) + 255 * a);
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const aa = size / 512; // 以 512 为设计单位
  const u = (v) => (v / 512) * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 底：圆角方（边距 24/512，圆角 108/512），外圈全透明
      const dBox = sdRoundBox(x, y, size / 2, size / 2, u(232), u(232), u(104));
      const aBox = cover(dBox, aa * 1.2);
      if (aBox <= 0) continue;
      blend(px, i, BG, aBox);
      // 底边描边：距边缘 3 单位内的环
      const aEdge = cover(Math.abs(dBox + u(3)) - u(1.5), aa) * aBox;
      blend(px, i, BG_EDGE, aEdge * 0.9);
      // 三道横墨迹（圆头线段）：长—短—长
      const strokes = [
        [u(128), u(176), u(384), u(176), u(21)],
        [u(128), u(256), u(312), u(256), u(21)],
        [u(128), u(336), u(384), u(336), u(21)],
      ];
      for (const [x1, y1, x2, y2, r] of strokes) {
        const a = cover(sdSegment(x, y, x1, y1, x2, y2) - r, aa * 1.2);
        if (a > 0) blend(px, i, INK, a * aBox);
      }
      // 强调点：第二行行尾
      const aDot = cover(Math.hypot(x - u(356), y - u(256)) - u(24), aa * 1.2);
      if (aDot > 0) blend(px, i, ACCENT, aDot * aBox);
    }
  }
  return encodePng(size, px);
}

for (const size of [512, 256, 128, 64, 32]) {
  const path = join(outDir, `icon-${size}.png`);
  writeFileSync(path, render(size));
  console.log(`icon ${size}: ${path}`);
}
copyFileSync(join(outDir, "icon-512.png"), join(outDir, "icon.png"));
console.log("icon.png = icon-512.png");
