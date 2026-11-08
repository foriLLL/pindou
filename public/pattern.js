// 拼豆图纸转换引擎：纯函数，无 DOM 依赖，浏览器与 Node 通用。
// 输入 RGBA 图像 + 色卡，输出每格色号索引（-1 表示空格/不放豆）。

// ---------- 颜色空间 ----------
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  let z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// CIEDE2000 色差
export function deltaE2000(L1, a1, b1, L2, a2, b2) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  let h1p = Math.atan2(b1, a1p) / rad; if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) / rad; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---------- 色卡 ----------
const paletteCache = new Map();

export function preparePalette(def) {
  if (paletteCache.has(def.id)) return paletteCache.get(def.id);
  const colors = def.colors.map(([code, hex, name]) => {
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return { code, hex, name: name || '', rgb, lab: rgbToLab(...rgb) };
  });
  const p = { id: def.id, label: def.label, beadMm: def.beadMm, colors, nearestCache: new Int16Array(1 << 18).fill(-1) };
  paletteCache.set(def.id, p);
  return p;
}

function nearestIndex(p, r, g, b) {
  const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
  let idx = p.nearestCache[key];
  if (idx >= 0) return idx;
  const [L, A, B] = rgbToLab((r & 252) + 2, (g & 252) + 2, (b & 252) + 2);
  let best = 0, bestD = Infinity;
  const cs = p.colors;
  for (let i = 0; i < cs.length; i++) {
    const l = cs[i].lab;
    // 先用 ΔE76 粗筛，避免对明显很远的颜色算 CIEDE2000
    const d76 = (l[0] - L) ** 2 + (l[1] - A) ** 2 + (l[2] - B) ** 2;
    if (d76 > (bestD * 3 + 10) ** 2) continue;
    const d = deltaE2000(L, A, B, l[0], l[1], l[2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  p.nearestCache[key] = best;
  return best;
}

function paletteDE(p, i, j) {
  const a = p.colors[i].lab, b = p.colors[j].lab;
  return deltaE2000(a[0], a[1], a[2], b[0], b[1], b[2]);
}

// ---------- 图像预处理 ----------
// 整数倍盒式缩小，使长边 <= maxSide
function shrink(img, maxSide) {
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxSide));
  if (f === 1) return img;
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const src = img.data, sw = img.width, n = f * f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < f; dy++) {
      let o = ((y * f + dy) * sw + x * f) * 4;
      // 按透明度加权：透明像素（RGB 常为黑色）不参与颜色平均，否则主体边缘会发黑
      for (let dx = 0; dx < f; dx++, o += 4) { const al = src[o + 3]; r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; }
    }
    const q = (y * w + x) * 4;
    if (a > 0) { out[q] = r / a; out[q + 1] = g / a; out[q + 2] = b / a; }
    out[q + 3] = a / n;
  }
  return { width: w, height: h, data: out };
}

// 从四周边缘泛洪，标记与边缘背景色相近且连通的像素为背景
function backgroundMask(img, tol) {
  const { width: w, height: h, data: d } = img;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  // 背景色取边缘“不透明”像素各通道中位数。透明像素的 RGB 通常是 (0,0,0)，
  // 不能参与估计，否则会把黑头发、黑描边当成背景吃掉。
  const ch = [[], [], []];
  let transparent = 0;
  for (const i of border) {
    if (d[i * 4 + 3] < 128) { transparent++; continue; }
    for (let c = 0; c < 3; c++) ch[c].push(d[i * 4 + c]);
  }
  // 边缘大部分透明：只把透明像素当背景
  const colorBg = transparent < border.length / 2 && ch[0].length > 0;
  const bgLab = colorBg ? rgbToLab(...ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1])) : null;
  const tol2 = tol * tol;
  const isBg = (i) => {
    const o = i * 4;
    if (d[o + 3] < 128) return true;
    if (!colorBg) return false;
    const l = rgbToLab(d[o], d[o + 1], d[o + 2]);
    return (l[0] - bgLab[0]) ** 2 + (l[1] - bgLab[1]) ** 2 + (l[2] - bgLab[2]) ** 2 < tol2;
  };
  const mask = new Uint8Array(w * h);
  const stack = [];
  for (const i of border) if (!mask[i] && isBg(i)) { mask[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    if (x > 0 && !mask[i - 1] && isBg(i - 1)) { mask[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !mask[i + 1] && isBg(i + 1)) { mask[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !mask[i - w] && isBg(i - w)) { mask[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !mask[i + w] && isBg(i + w)) { mask[i + w] = 1; stack.push(i + w); }
  }
  return mask;
}

function subjectBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------- 主流程 ----------
export const DEFAULTS = {
  longSide: 52,      // 长边豆数
  maxColors: 20,     // 最多使用颜色数
  removeBg: true,    // 背景不放豆
  bgTolerance: 7,    // 背景判定 ΔE 阈值
  margin: 1,         // 裁切后四周留白豆数
  outline: null,     // 格内深色像素占比超过该值即判为描边色（0 关闭；null 按尺寸自适应）
  outerOutline: true,// 主体外轮廓强制闭合为描边色
  cleanup: 2,        // 孤立豆清理轮数
  cleanupDE: 22,     // 孤立豆与周围颜色色差小于该值才替换（保留眼睛高光等细节）
  sub: 6,            // 每格采样 sub×sub
  grid: true,        // 检测到像素图时按原像素一格一豆（忽略 longSide）
};

export function buildPattern(input, paletteDef, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (o.outline == null) o.outline = o.longSide >= 44 ? 0.45 : 0.5;
  const p = preparePalette(paletteDef);
  const work = shrink(input, 1024);
  const W0 = work.width, H0 = work.height, wd = work.data;
  const mask = o.removeBg ? backgroundMask(work, o.bgTolerance) : new Uint8Array(W0 * H0);
  // 透明的地方一律不放豆：哪怕被主体围住、和四周不连通（比如轮子、甜甜圈中间的洞）
  for (let i = 0, n = W0 * H0; i < n; i++) if (wd[i * 4 + 3] < 128) mask[i] = 1;
  const box = o.removeBg ? subjectBox(mask, W0, H0) : { x: 0, y: 0, w: W0, h: H0 };

  // 像素图：检测到 AI 画的像素网格时，一个像素对应一颗豆
  const grid = o.grid ? pixelGridOf(input) : null;
  if (grid && grid.conf >= GRID_MIN_CONF) return buildFromGrid(o, p, work, mask, box, grid, input.width / work.width);

  // 网格尺寸：长边 = longSide（含留白）
  const inner = Math.max(4, o.longSide - 2 * (o.removeBg ? o.margin : 0));
  let gw, gh;
  if (box.w >= box.h) { gw = inner; gh = Math.max(1, Math.round((inner * box.h) / box.w)); }
  else { gh = inner; gw = Math.max(1, Math.round((inner * box.w) / box.h)); }
  const m = o.removeBg ? o.margin : 0;
  const W = gw + 2 * m, H = gh + 2 * m;
  const cells = new Int16Array(W * H).fill(-1);
  const avgLab = new Float32Array(W * H * 3);

  const k = o.sub, sx = box.w / (gw * k), sy = box.h / (gh * k);
  const counts = new Map();
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    counts.clear();
    let bgCount = 0, fg = 0, dark = 0, ar = 0, ag = 0, ab = 0;
    const darkCounts = new Map();
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      // 子像素区域做盒式平均
      const X0 = box.x + Math.floor((cx * k + i) * sx), X1 = Math.max(X0 + 1, box.x + Math.floor((cx * k + i + 1) * sx));
      const Y0 = box.y + Math.floor((cy * k + j) * sy), Y1 = Math.max(Y0 + 1, box.y + Math.floor((cy * k + j + 1) * sy));
      let r = 0, g = 0, b = 0, n = 0, bgn = 0;
      for (let y = Y0; y < Y1 && y < H0; y++) for (let x = X0; x < X1 && x < W0; x++) {
        const q = y * W0 + x;
        if (mask[q]) { bgn++; continue; }
        r += wd[q * 4]; g += wd[q * 4 + 1]; b += wd[q * 4 + 2]; n++;
      }
      if (n <= bgn) { bgCount++; continue; }
      r /= n; g /= n; b /= n;
      fg++; ar += r; ag += g; ab += b;
      const idx = nearestIndex(p, r | 0, g | 0, b | 0);
      counts.set(idx, (counts.get(idx) || 0) + 1);
      if (p.colors[idx].lab[0] < 28) { dark++; darkCounts.set(idx, (darkCounts.get(idx) || 0) + 1); }
    }
    if (fg === 0 || (o.removeBg && bgCount > fg)) continue;
    let best = -1, bestN = -1;
    for (const [idx, n] of counts) if (n > bestN) { best = idx; bestN = n; }
    // 描边加强：卡通图的黑色描边常不足一格宽，按众数会断线
    if (o.outline > 0 && dark >= o.outline * k * k && p.colors[best].lab[0] >= 28) {
      let bn = -1;
      for (const [idx, n] of darkCounts) if (n > bn) { best = idx; bn = n; }
    }
    const q = (cy + m) * W + cx + m;
    cells[q] = best;
    const lab = rgbToLab(ar / fg, ag / fg, ab / fg);
    avgLab.set(lab, q * 3);
  }

  if (o.removeBg && o.outerOutline) closeOuterOutline(cells, W, H, p);
  limitColors(cells, p, o.maxColors, avgLab);
  for (let pass = 0; pass < o.cleanup; pass++) if (!cleanupPass(cells, W, H, p, o.cleanupDE)) break;

  return summarize(cells, W, H, p);
}

export const GRID_MIN_CONF = 0.12;
const gridCache = new WeakMap();
export const NATIVE_MAX = 160; // 长边不超过这个尺寸的小图，按原图像素一格一豆
export function pixelGridOf(img) {
  if (!gridCache.has(img)) gridCache.set(img, Math.max(img.width, img.height) <= NATIVE_MAX ? nativeGrid(img) : detectPixelGrid(img));
  return gridCache.get(img);
}
// 小像素图（如 32×32 精灵图）：每个像素就是一格
function nativeGrid(img) {
  const xs = Array.from({ length: img.width + 1 }, (_, i) => i);
  const ys = Array.from({ length: img.height + 1 }, (_, i) => i);
  return { p: 1, ox: 0, oy: 0, conf: 1, native: true, cols: img.width, rows: img.height, xs, ys };
}

function buildFromGrid(o, p, work, mask, box, grid, scale) {
  const W0 = work.width, H0 = work.height, wd = work.data;
  // 只保留覆盖主体范围的网格线（换算到缩小后的工作图坐标）
  const pick = (lines, lo, hi) => {
    const L = lines.map((v) => v / scale);
    let i0 = 0; while (i0 < L.length - 1 && L[i0 + 1] <= lo) i0++;
    let i1 = L.length - 1; while (i1 > 0 && L[i1 - 1] >= hi) i1--;
    return L.slice(i0, i1 + 1);
  };
  const xs = pick(grid.xs, box.x, box.x + box.w), ys = pick(grid.ys, box.y, box.y + box.h);
  const gw = xs.length - 1, gh = ys.length - 1;
  const m = o.removeBg ? o.margin : 0;
  const W = gw + 2 * m, H = gh + 2 * m;
  const cells = new Int16Array(W * H).fill(-1);
  const avgLab = new Float32Array(W * H * 3);
  const counts = new Map(), darkCounts = new Map();
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    // 取格子中心约 70% 的区域，避开模糊的边缘
    const cwid = xs[cx + 1] - xs[cx], chei = ys[cy + 1] - ys[cy];
    const X0 = Math.max(0, Math.round(xs[cx] + cwid * 0.15)), X1 = Math.min(W0, Math.max(X0 + 1, Math.round(xs[cx + 1] - cwid * 0.15)));
    const Y0 = Math.max(0, Math.round(ys[cy] + chei * 0.15)), Y1 = Math.min(H0, Math.max(Y0 + 1, Math.round(ys[cy + 1] - chei * 0.15)));
    counts.clear(); darkCounts.clear();
    let bg = 0, fg = 0, dark = 0, ar = 0, ag = 0, ab = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const q = y * W0 + x;
      if (mask[q]) { bg++; continue; }
      const r = wd[q * 4], g = wd[q * 4 + 1], b = wd[q * 4 + 2];
      fg++; ar += r; ag += g; ab += b;
      const idx = nearestIndex(p, r, g, b);
      counts.set(idx, (counts.get(idx) || 0) + 1);
      if (p.colors[idx].lab[0] < 28) { dark++; darkCounts.set(idx, (darkCounts.get(idx) || 0) + 1); }
    }
    if (fg === 0 || bg > fg) continue;
    let best = -1, bn = -1;
    for (const [idx, n] of counts) if (n > bn) { best = idx; bn = n; }
    // 细线保护：描边、瞳孔、眼镜框这类深色细节占到 35% 就保留为深色
    if (dark >= 0.35 * fg && p.colors[best].lab[0] >= 28) {
      let dn = -1;
      for (const [idx, n] of darkCounts) if (n > dn) { best = idx; dn = n; }
    }
    const q = (cy + m) * W + cx + m;
    cells[q] = best;
    avgLab.set(rgbToLab(ar / fg, ag / fg, ab / fg), q * 3);
  }
  if (o.removeBg && o.outerOutline && !grid.native) closeOuterOutline(cells, W, H, p);
  limitColors(cells, p, o.maxColors, avgLab);
  for (let pass = 0; pass < o.cleanup; pass++) if (!cleanupPass(cells, W, H, p, o.cleanupDE)) break;
  const out = summarize(cells, W, H, p);
  out.grid = { pixel: grid.p, conf: grid.conf };
  return out;
}

// 主体外轮廓：与背景相邻的格子统一换成图中最常用的深色（卡通描边色）
function closeOuterOutline(cells, W, H, p) {
  const darkCount = new Map();
  for (const c of cells) if (c >= 0 && p.colors[c].lab[0] < 28) darkCount.set(c, (darkCount.get(c) || 0) + 1);
  if (!darkCount.size) return;
  let dark = -1, dn = -1;
  for (const [c, n] of darkCount) if (n > dn) { dark = c; dn = n; }
  const src = cells.slice();
  const empty = (x, y) => x < 0 || y < 0 || x >= W || y >= H || src[y * W + x] < 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = y * W + x;
    if (src[q] < 0 || p.colors[src[q]].lab[0] < 28) continue;
    if (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1)) cells[q] = dark;
  }
}

// 合并颜色直到不超过 maxColors：每次合并“用量 × 与最近色色差”最小的颜色
function limitColors(cells, p, maxColors, avgLab) {
  const count = new Map();
  for (const c of cells) if (c >= 0) count.set(c, (count.get(c) || 0) + 1);
  if (count.size <= maxColors) return;
  const remap = new Map();
  const deCache = new Map();
  const de = (i, j) => {
    const key = i < j ? i * 4096 + j : j * 4096 + i;
    let v = deCache.get(key);
    if (v === undefined) { v = paletteDE(p, i, j); deCache.set(key, v); }
    return v;
  };
  while (count.size > maxColors) {
    let victim = -1, target = -1, bestCost = Infinity;
    const used = [...count.keys()];
    for (const c of used) {
      let nd = Infinity, nt = -1;
      for (const d of used) if (d !== c) { const v = de(c, d); if (v < nd) { nd = v; nt = d; } }
      const cost = count.get(c) * nd;
      if (cost < bestCost) { bestCost = cost; victim = c; target = nt; }
    }
    count.set(target, count.get(target) + count.get(victim));
    count.delete(victim);
    remap.set(victim, target);
  }
  // 被合并的格子按其原始平均色重新匹配剩余颜色中最接近的一个
  const keep = [...count.keys()];
  for (let q = 0; q < cells.length; q++) {
    const c = cells[q];
    if (c < 0 || !remap.has(c)) continue;
    const L = avgLab[q * 3], A = avgLab[q * 3 + 1], B = avgLab[q * 3 + 2];
    let best = keep[0], bd = Infinity;
    for (const k of keep) {
      const l = p.colors[k].lab;
      const d = deltaE2000(L, A, B, l[0], l[1], l[2]);
      if (d < bd) { bd = d; best = k; }
    }
    cells[q] = best;
  }
}

// 清理孤立豆：8 邻域内没有同色的格子，替换为邻域多数色（色差足够小时）
function cleanupPass(cells, W, H, p, maxDE) {
  const src = cells.slice();
  let changed = 0;
  const tally = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = y * W + x, c = src[q];
    if (c < 0) continue;
    tally.clear();
    let same = false, n4Empty = 0, n4 = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      const v = nx < 0 || ny < 0 || nx >= W || ny >= H ? -1 : src[ny * W + nx];
      if (v === c) same = true;
      if (!dx || !dy) { n4++; if (v < 0) n4Empty++; }
      tally.set(v, (tally.get(v) || 0) + ((!dx || !dy) ? 2 : 1));
    }
    if (same) continue;
    if (n4Empty === n4) { cells[q] = -1; changed++; continue; } // 悬空的单颗豆
    let best = -1, bn = -1;
    for (const [v, n] of tally) if (v >= 0 && n > bn) { best = v; bn = n; }
    if (best >= 0 && paletteDE(p, c, best) < maxDE) { cells[q] = best; changed++; }
  }
  return changed;
}

function summarize(cells, W, H, p) {
  const count = new Map();
  for (const c of cells) if (c >= 0) count.set(c, (count.get(c) || 0) + 1);
  const legend = [...count.entries()]
    .map(([idx, n]) => ({ idx, n, ...p.colors[idx] }))
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  let total = 0;
  for (const l of legend) total += l.n;
  return { width: W, height: H, cells, legend, total, palette: p };
}


// ---------- 像素网格检测 ----------
// AI 画的“像素图”并不是严格网格：像素块大小会有出入、整体会漂移。
// 所以网格线不用等距，而是从边缘强度曲线里找真实的边界峰值，峰之间按平均像素大小补线。
function adaptiveLines(G, p, o, len) {
  const n = G.length;
  const S = new Float64Array(n);
  for (let i = 0; i < n; i++) S[i] = (G[i - 1] || 0) + 2 * G[i] + (G[i + 1] || 0);
  const sorted = [...S].filter((v) => v > 0).sort((a, b) => a - b);
  const thr = 0.2 * (sorted[Math.floor(sorted.length * 0.97)] || 0);
  // 局部极大值，按强度从高到低做非极大值抑制（间距至少 0.55p）
  const cand = [];
  for (let i = 1; i < n - 1; i++) if (S[i] >= thr && S[i] >= S[i - 1] && S[i] > S[i + 1]) cand.push(i);
  cand.sort((a, b) => S[b] - S[a]);
  const taken = [];
  const minGap = 0.55 * p;
  for (const c of cand) if (taken.every((t) => Math.abs(t - c) >= minGap)) taken.push(c);
  const peaks = taken.map((i) => i + 1).sort((a, b) => a - b); // G[i] 是 i 与 i+1 之间的边界
  if (peaks.length < 2) {
    const lines = [];
    for (let x = o % p; x <= len; x += p) lines.push(x);
    return lines;
  }
  const lines = [];
  for (let x = peaks[0]; x > 0; x -= p) lines.unshift(x);
  lines.pop();
  for (let i = 0; i < peaks.length - 1; i++) {
    const a = peaks[i], b = peaks[i + 1], k = Math.max(1, Math.round((b - a) / p));
    for (let j = 0; j < k; j++) lines.push(a + ((b - a) * j) / k);
  }
  for (let x = peaks[peaks.length - 1]; x <= len; x += p) lines.push(x);
  return lines;
}

// AI 画的像素图：边缘只出现在像素边界上。对每列/行的边缘强度做傅里叶分析，
// 找出边界周期 p（像素大小）和相位。p 的约数也会得高分，倍数会抵消，所以取“高分里最大的 p”。
export function detectPixelGrid(img) {
  const { width: w, height: h, data: d } = img;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    // 透明处按白色算，避免透明区 RGB 噪声
    L[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
  }
  const gx = new Float64Array(w), gy = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) gx[x] += Math.abs(L[y * w + x + 1] - L[y * w + x]);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x++) gy[y] += Math.abs(L[(y + 1) * w + x] - L[y * w + x]);
  const spectrum = (G, p) => {
    let re = 0, im = 0, tot = 0;
    const k = (2 * Math.PI) / p;
    for (let x = 0; x < G.length; x++) { const g = G[x]; if (!g) continue; re += g * Math.cos(k * (x + 1)); im += g * Math.sin(k * (x + 1)); tot += g; }
    return { R: Math.hypot(re, im) / (tot || 1), phase: Math.atan2(im, re) };
  };
  const minP = 4, maxP = Math.min(80, Math.min(w, h) / 12);
  const none = { p: 1, ox: 0, oy: 0, conf: 0, cols: w, rows: h, xs: [0, w], ys: [0, h] };
  if (maxP < minP) return none; // 图太小，没法检测网格
  const scores = [];
  let max = 0;
  for (let p = minP; p <= maxP; p += 0.05) {
    const sx = spectrum(gx, p), sy = spectrum(gy, p);
    const s = (sx.R + sy.R) / 2;
    scores.push({ p, s, sx, sy });
    if (s > max) max = s;
  }
  // 高分（≥ 0.6×最高分）的候选里取最大的 p，并在其邻域内取局部最优
  let pick = null;
  for (const c of scores) if (c.s >= 0.6 * max && (!pick || c.p > pick.p + 1)) pick = c;
  if (!pick || !(max > 0)) return none; // 纯色图等没有边缘的情况
  for (const c of scores) if (Math.abs(c.p - pick.p) <= 1 && c.s > pick.s) pick = c;
  const off = (ph, p) => (((ph / (2 * Math.PI)) * p) % p + p) % p;
  const P = pick.p, ox = off(pick.sx.phase, P), oy = off(pick.sy.phase, P);
  return { p: P, ox, oy, conf: pick.s, cols: w / P, rows: h / P, xs: adaptiveLines(gx, P, ox, w), ys: adaptiveLines(gy, P, oy, h) };
}
