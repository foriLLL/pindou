// 用法: node tools/try.mjs in.rgba W H out.ppm [longSide] [maxColors] [paletteId]
import fs from 'node:fs';
import { buildPattern } from '../public/pattern.js';
const [inp, w, h, out, ls = '52', mc = '20', pid = 'mard-221-alfonse-doudou'] = process.argv.slice(2);
const pals = JSON.parse(fs.readFileSync(new URL('../public/palettes.json', import.meta.url)));
const img = { width: +w, height: +h, data: new Uint8ClampedArray(fs.readFileSync(inp)) };
const t = performance.now();
const r = buildPattern(img, pals.find((p) => p.id === pid), { longSide: +ls, maxColors: +mc, outline: process.env.OUTLINE ? +process.env.OUTLINE : null, grid: process.env.GRID !== '0' });
console.log(`${r.grid ? 'GRID p=' + r.grid.pixel.toFixed(1) + ' ' : ''}${r.width}x${r.height} beads=${r.total} colors=${r.legend.length} ${Math.round(performance.now() - t)}ms`);
console.log(r.legend.map((l) => `${l.code}:${l.n}`).join(' '));
const S = 12, W = r.width * S, H = r.height * S, buf = Buffer.alloc(W * H * 3, 255);
for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
  const c = r.cells[y * r.width + x];
  const rgb = c < 0 ? [235, 235, 235] : r.palette.colors[c].rgb;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const edge = i === 0 || j === 0; const o = ((y * S + j) * W + x * S + i) * 3;
    buf[o] = edge ? rgb[0] * 0.85 : rgb[0]; buf[o + 1] = edge ? rgb[1] * 0.85 : rgb[1]; buf[o + 2] = edge ? rgb[2] * 0.85 : rgb[2];
  }
}
fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6 ${W} ${H} 255\n`), buf]));
