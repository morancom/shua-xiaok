'use strict';
/**
 * 生成「刷小课」图标(纯 Node,无依赖)
 * 设计:圆角方块渐变底 + 中心书本符号。用 raw RGBA → PNG 编码。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- 最小 PNG 编码器 ----
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
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // 每行前加 filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 画布 ----
function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // 圆角半径
  // 渐变两端色(蓝紫)
  const c1 = [0x6c, 0x8c, 0xff], c2 = [0x8f, 0x6c, 0xff];
  const cx = size / 2, cy = size / 2;

  // 书本几何(相对 size 归一化)
  const bx = size * 0.28, by = size * 0.30, bw = size * 0.44, bh = size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 圆角裁剪
      const dx = Math.max(0, Math.max(r - x, x - (size - 1 - r)));
      const dy = Math.max(0, Math.max(r - y, y - (size - 1 - r)));
      if (dx * dx + dy * dy > r * r) { rgba[i + 3] = 0; continue; }

      // 渐变(沿对角线)
      const t = (x + y) / (2 * size);
      let cr = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      let cg = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      let cb = Math.round(c1[2] + (c2[2] - c1[2]) * t);

      // 画"书":左右两页 + 中缝
      const inBook = x >= bx && x < bx + bw && y >= by && y < by + bh;
      if (inBook) {
        const midX = bx + bw / 2;
        const pageInset = size * 0.02;
        // 中缝(深色竖线)
        if (Math.abs(x - midX) < size * 0.012) { cr = 0x2a; cg = 0x2f; cb = 0x47; }
        else {
          // 页面(浅色)
          cr = 0xf2; cg = 0xf4; cb = 0xff;
          // 每页几条"文字"横线
          const localY = y - by;
          const lineH = size * 0.045;
          const lineIdx = Math.floor(localY / lineH);
          const inLine = (localY % lineH) < lineH * 0.4;
          const isLeft = x < midX;
          const lineX0 = isLeft ? bx + pageInset : midX + size * 0.02;
          const lineX1 = isLeft ? midX - size * 0.02 : bx + bw - pageInset;
          if (inLine && lineIdx > 0 && lineIdx < 6 && x >= lineX0 && x < lineX1) { cr = 0xb8; cg = 0xc0; cb = 0xe0; }
        }
      }

      rgba[i] = cr; rgba[i + 1] = cg; rgba[i + 2] = cb; rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

// ---- 输出 ----
const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [48, 128]) {
  const png = makeIcon(s);
  const f = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(f, png);
  console.log(`生成 ${f} (${png.length} bytes)`);
}
