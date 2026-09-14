// Dibuja los íconos de la app (una torta azul sobre fondo oscuro) y los guarda como PNG.
// Uso: node tools/generar-iconos.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [14, 16, 20];
// Porciones de la torta, de la más grande a la más chica, en la misma familia de azul
const SEGMENTS = [
  { until: 0.46, color: [148, 196, 230] },
  { until: 0.72, color: [93, 161, 209] },
  { until: 0.88, color: [57, 123, 171] },
  { until: 1.00, color: [43, 82, 110] },
];

function draw(size, safe) {
  const px = Buffer.alloc(size * size * 4);
  const content = size * (1 - 2 * safe);
  const rOut = content * 0.40;
  const rIn = content * 0.235;
  const gap = content * 0.018;
  const c = size / 2;
  const S = 4; // submuestras por lado, para bordes suaves
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const dx = x + (sx + 0.5) / S - c;
          const dy = y + (sy + 0.5) / S - c;
          const dist = Math.hypot(dx, dy);
          let col = BG;
          if (dist >= rIn && dist <= rOut) {
            let frac = Math.atan2(dx, -dy) / (2 * Math.PI);
            if (frac < 0) frac += 1;
            const boundaries = [0, ...SEGMENTS.map(s => s.until)];
            const nearGap = boundaries.some(bd => Math.abs(frac - bd) * 2 * Math.PI * dist < gap / 2 || Math.abs(frac - bd + 1) * 2 * Math.PI * dist < gap / 2);
            if (!nearGap) col = SEGMENTS.find(s => frac < s.until).color;
          }
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const i = (y * size + x) * 4;
      px[i] = r / (S * S); px[i + 1] = g / (S * S); px[i + 2] = b / (S * S); px[i + 3] = 255;
    }
  }
  return png(size, px);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
const targets = [
  ['apple-touch-icon.png', 180, 0.06],
  ['icon-192.png', 192, 0.06],
  ['icon-512.png', 512, 0.06],
  ['icon-maskable-512.png', 512, 0.14],
];
for (const [name, size, safe] of targets) {
  fs.writeFileSync(path.join(out, name), draw(size, safe));
  console.log('listo', name);
}
