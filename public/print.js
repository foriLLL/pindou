// 1:1 打印版 PDF：浏览器内生成，零依赖。
// 每页按 300dpi 渲染成位图，按 A4 实际毫米尺寸放进 PDF，打印时选「实际大小 / 100%」即与拼板孔距一致。

const DPI = 300;
const PAGE_W_MM = 210, PAGE_H_MM = 297;
const MARGIN_MM = 12;
const px = (mm) => (mm * DPI) / 25.4;
const FONT = 'ui-sans-serif, -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

function textColor([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1d1d1f' : '#ffffff';
}

function newPage() {
  const c = document.createElement('canvas');
  c.width = Math.round(px(PAGE_W_MM)); c.height = Math.round(px(PAGE_H_MM));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  return { c, ctx };
}

// 校准尺：打印后应正好 50mm
function drawRuler(ctx, x, y) {
  const L = px(50);
  ctx.strokeStyle = '#111'; ctx.lineWidth = px(0.3);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + L, y); ctx.stroke();
  for (let i = 0; i <= 50; i += 5) {
    const h = i % 10 === 0 ? px(2.5) : px(1.4);
    ctx.beginPath(); ctx.moveTo(x + px(i), y); ctx.lineTo(x + px(i), y - h); ctx.stroke();
  }
  ctx.fillStyle = '#333'; ctx.font = `${px(2.6)}px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('校准尺：打印后这条线应正好 5 cm（不对请检查是否按 100% 实际大小打印）', x + L + px(3), y - px(1));
}

function header(ctx, title, sub) {
  ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${px(5)}px ${FONT}`; ctx.fillText(title, px(MARGIN_MM), px(MARGIN_MM + 5));
  ctx.fillStyle = '#555'; ctx.font = `${px(3)}px ${FONT}`; ctx.fillText(sub, px(MARGIN_MM), px(MARGIN_MM + 10.5));
}

// 计算每页放多少格：优先整块拼板，放不下就再切
function chunking(pattern, pitch, board) {
  const usableW = PAGE_W_MM - 2 * MARGIN_MM - 10; // 左右留坐标
  const usableH = PAGE_H_MM - 2 * MARGIN_MM - 34; // 上方标题 + 下方校准尺
  const fitW = Math.floor(usableW / pitch), fitH = Math.floor(usableH / pitch);
  const cw = Math.min(board, fitW), ch = Math.min(board, fitH);
  const chunks = [];
  for (let y0 = 0; y0 < pattern.height; y0 += ch) for (let x0 = 0; x0 < pattern.width; x0 += cw) {
    chunks.push({ x0, y0, x1: Math.min(pattern.width, x0 + cw), y1: Math.min(pattern.height, y0 + ch) });
  }
  const cols = Math.ceil(pattern.width / cw);
  chunks.forEach((k, i) => { k.row = Math.floor(i / cols) + 1; k.col = (i % cols) + 1; });
  return { chunks, cw, ch, cols, rows: Math.ceil(pattern.height / ch) };
}

function drawChunkPage(p, k, pitch, pageNo, total, title) {
  const { c, ctx } = newPage();
  header(ctx, `${title} · 第 ${k.row} 行第 ${k.col} 块`, `列 ${k.x0 + 1}–${k.x1}，行 ${k.y0 + 1}–${k.y1} · 孔距 ${pitch} mm · 第 ${pageNo} / ${total} 页`);
  const cell = px(pitch);
  const w = k.x1 - k.x0, h = k.y1 - k.y0;
  const ox = Math.round((c.width - w * cell) / 2), oy = px(MARGIN_MM + 18);
  const fs = Math.max(px(0.9), cell * 0.4);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let y = k.y0; y < k.y1; y++) for (let x = k.x0; x < k.x1; x++) {
    const idx = p.cells[y * p.width + x];
    if (idx < 0) continue;
    const col = p.palette.colors[idx];
    const X = ox + (x - k.x0) * cell, Y = oy + (y - k.y0) * cell;
    ctx.fillStyle = col.hex; ctx.fillRect(X, Y, cell + 0.5, cell + 0.5);
    let f = fs; ctx.font = `600 ${f}px ${FONT}`;
    const tw = ctx.measureText(col.code).width;
    if (tw > cell * 0.92) { f = f * cell * 0.92 / tw; ctx.font = `600 ${f}px ${FONT}`; }
    ctx.fillStyle = textColor(col.rgb);
    ctx.fillText(col.code, X + cell / 2, Y + cell / 2 + f * 0.05);
  }
  // 网格线：按整张图的全局坐标画 5/10 粗线，跨页对齐
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  const style = (g) => {
    if (g % 10 === 0) { ctx.strokeStyle = '#111'; ctx.lineWidth = px(0.35); }
    else if (g % 5 === 0) { ctx.strokeStyle = '#555'; ctx.lineWidth = px(0.22); }
    else { ctx.strokeStyle = '#bbb'; ctx.lineWidth = px(0.1); }
  };
  for (let x = k.x0; x <= k.x1; x++) { style(x); line(ox + (x - k.x0) * cell, oy, ox + (x - k.x0) * cell, oy + h * cell); }
  for (let y = k.y0; y <= k.y1; y++) { style(y); line(ox, oy + (y - k.y0) * cell, ox + w * cell, oy + (y - k.y0) * cell); }
  ctx.strokeStyle = '#111'; ctx.lineWidth = px(0.35); ctx.strokeRect(ox, oy, w * cell, h * cell);
  // 坐标
  ctx.fillStyle = '#444'; ctx.font = `${px(2.2)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let x = k.x0; x < k.x1; x++) if ((x + 1) % 5 === 0 || x === k.x0) {
    const X = ox + (x - k.x0 + 0.5) * cell;
    ctx.fillText(x + 1, X, oy - px(2.2)); ctx.fillText(x + 1, X, oy + h * cell + px(2.2));
  }
  for (let y = k.y0; y < k.y1; y++) if ((y + 1) % 5 === 0 || y === k.y0) {
    const Y = oy + (y - k.y0 + 0.5) * cell;
    ctx.fillText(y + 1, ox - px(3.2), Y); ctx.fillText(y + 1, ox + w * cell + px(3.2), Y);
  }
  drawRuler(ctx, px(MARGIN_MM), c.height - px(MARGIN_MM + 2));
  return c;
}

function drawOverviewPage(p, layout, pitch, total, title) {
  const { c, ctx } = newPage();
  const mm = p.palette.beadMm;
  header(ctx, `${title} · 总览与色号清单`, `${p.palette.label} · ${p.width}×${p.height} 格 · ${p.total} 颗 · ${p.legend.length} 色 · 成品约 ${(p.width * pitch / 10).toFixed(1)}×${(p.height * pitch / 10).toFixed(1)} cm · 共 ${total} 页`);
  // 缩略总览 + 分块编号
  const maxW = px(PAGE_W_MM - 2 * MARGIN_MM), maxH = px(110);
  const s = Math.min(maxW / p.width, maxH / p.height);
  const ox = px(MARGIN_MM), oy = px(MARGIN_MM + 16);
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const idx = p.cells[y * p.width + x];
    ctx.fillStyle = idx < 0 ? '#f2f2f2' : p.palette.colors[idx].hex;
    ctx.fillRect(ox + x * s, oy + y * s, s + 0.5, s + 0.5);
  }
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = px(0.4);
  ctx.font = `600 ${px(4)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const k of layout.chunks) {
    ctx.strokeRect(ox + k.x0 * s, oy + k.y0 * s, (k.x1 - k.x0) * s, (k.y1 - k.y0) * s);
    if (layout.chunks.length > 1) {
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      const cx = ox + ((k.x0 + k.x1) / 2) * s, cy = oy + ((k.y0 + k.y1) / 2) * s;
      ctx.fillRect(cx - px(7), cy - px(3), px(14), px(6));
      ctx.fillStyle = '#e5484d'; ctx.fillText(`${k.row}-${k.col}`, cx, cy);
    }
  }
  // 色号清单
  let y = oy + p.height * s + px(10);
  ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${px(4)}px ${FONT}`; ctx.fillText('色号清单', ox, y); y += px(4);
  const colW = px(30), rowH = px(7.5), per = Math.floor(maxW / colW);
  p.legend.forEach((l, i) => {
    const X = ox + (i % per) * colW, Y = y + Math.floor(i / per) * rowH;
    ctx.fillStyle = l.hex; ctx.fillRect(X, Y, px(12), px(5.5));
    ctx.strokeStyle = '#999'; ctx.lineWidth = px(0.15); ctx.strokeRect(X, Y, px(12), px(5.5));
    ctx.fillStyle = textColor(l.rgb); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${px(2.6)}px ${FONT}`; ctx.fillText(l.code, X + px(6), Y + px(2.85), px(11));
    ctx.fillStyle = '#222'; ctx.textAlign = 'left'; ctx.font = `${px(3)}px ${FONT}`;
    ctx.fillText(`× ${l.n}`, X + px(13.5), Y + px(2.85));
  });
  y += Math.ceil(p.legend.length / per) * rowH + px(8);
  // 使用说明
  const tips = [
    '使用方法：',
    '1. 打印时选择「实际大小 / 100%」，不要选「适合页面 / 缩放」。打印后先用尺子量下方校准尺是否正好 5 cm。',
    `2. 每页对应一块拼板（红框编号与页眉一致）。把图纸垫在透明拼板下面，按下面的颜色和色号直接放豆。`,
    `3. 当前孔距 ${pitch} mm（${mm}mm 豆）。若与你的拼板对不齐，量 10 个孔的总长度 ÷ 10 得到实际孔距，在网页上修改后重新导出。`,
    '4. 摆完后盖熨烫纸，中温打圈熨 10–20 秒至豆子微融，趁热压平冷却。',
  ];
  ctx.fillStyle = '#333'; ctx.font = `${px(3)}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const t of tips) { y += px(5.5); if (y < c.height - px(MARGIN_MM + 8)) ctx.fillText(t, ox, y, maxW); }
  drawRuler(ctx, px(MARGIN_MM), c.height - px(MARGIN_MM + 2));
  return c;
}

// ---------- 极简 PDF 写入 ----------
async function canvasToImage(c) {
  const { width: w, height: h } = c;
  if (typeof CompressionStream === 'function') {
    // 无损：RGB 原始像素 + zlib（FlateDecode），小字号色号打印更清晰
    const rgba = c.getContext('2d').getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
    const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    return { w, h, data, filter: 'FlateDecode' };
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  return { w, h, data: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode' };
}

function buildPdf(images) {
  const enc = new TextEncoder();
  const parts = []; const offsets = []; let pos = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); pos += b.length; };
  const W = (PAGE_W_MM / 25.4) * 72, H = (PAGE_H_MM / 25.4) * 72;
  const n = images.length;
  // 对象编号：1 catalog, 2 pages, 每页 3 个对象（page, content, image）
  const pageId = (i) => 3 + i * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (id, body) => { offsets[id] = pos; push(`${id} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  images.forEach((im, i) => {
    const pid = pageId(i), cid = pid + 1, iid = pid + 2;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(3)} ${H.toFixed(3)}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
    const content = `q ${W.toFixed(3)} 0 0 ${H.toFixed(3)} 0 0 cm /Im0 Do Q`;
    obj(cid, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(iid, [`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${im.filter} /Length ${im.data.length} >>\nstream\n`, im.data, '\nendstream']);
  });
  const total = 3 + n * 3;
  const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

export async function buildPrintPdf(pattern, { pitch, board, title = '拼豆图纸', onProgress } = {}) {
  const b = board > 0 ? board : (pattern.palette.beadMm >= 5 ? 29 : 52);
  const layout = chunking(pattern, pitch, b);
  const total = layout.chunks.length + 1;
  // 一页一页画：画完立刻编码并释放画布（每页 A4@300dpi 约 35MB，全部同时存在手机会撑不住）
  const draws = [() => drawOverviewPage(pattern, layout, pitch, total, title), ...layout.chunks.map((k, i) => () => drawChunkPage(pattern, k, pitch, i + 2, total, title))];
  const images = [];
  for (let i = 0; i < draws.length; i++) {
    onProgress?.(i + 1, draws.length);
    const c = draws[i]();
    images.push(await canvasToImage(c));
    c.width = c.height = 0;
  }
  return buildPdf(images);
}
