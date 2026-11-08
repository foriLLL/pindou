// 数据看板：读取 /api/admin/stats（需要管理口令），全部用原生 SVG/HTML 绘制
const $ = (id) => document.getElementById(id);
const KEY = 'pindou.admin';
let days = 7;
let paletteLabel = {};
fetch('palettes.json').then((r) => r.json()).then((ps) => { paletteLabel = Object.fromEntries(ps.map((p) => [p.id, p.label])); }).catch(() => {});

const EVENT_LABEL = {
  page_view: '打开页面', route_view: '切换页面', mode_select: '切换玩法', image_pick: '选择图片', style_select: '选择风格',
  prompt_edit: '修改提示词', example_click: '点文字示例', generate_click: '点「生成」', job_submit: '提交生成', job_done: '生成成功',
  job_fail: '生成失败', result_view: '查看结果', regen_click: '重新生成', palette_change: '换色卡', size_change: '点尺寸按钮',
  view_tab: '切换图纸/成品预览', zoom: '放大', highlight: '高亮同色', download: '下载', history_item_open: '打开历史作品',
  history_delete: '删除作品', me_open: '打开「我的 ID」', sync_copy_id: '复制 ID', sync_copy_link: '复制同步链接', id_switch: '切换 ID',
  error_shown: '出现错误提示', resume_banner: '看到「上次的图」提醒', resume_open: '从提醒打开上次的图', param_colors: '调颜色数', param_outline: '调描边', param_removeBg: '切换去背景',
  param_outer: '切换外轮廓', param_cleanup: '切换清理杂豆', param_gridMode: '切换一格一豆',
};
const DOWNLOAD_LABEL = { pdf: '1:1 打印 PDF', png: '图纸 PNG', preview: '成品预览', csv: '色号清单 CSV', ai_image: 'AI 原图' };
const MODE_LABEL = { photo: '照片转换', text: '文字创作', direct: '直接转换', ai: '照片转换' };

const fmt = (n) => (n ?? 0).toLocaleString('zh-CN');
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
const dur = (sec) => {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};
const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function token() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }

async function load() {
  if (!Object.keys(paletteLabel).length) await fetch('palettes.json').then((r) => r.json()).then((ps) => { paletteLabel = Object.fromEntries(ps.map((p) => [p.id, p.label])); }).catch(() => {});
  const t = token();
  if (!t) return showLogin();
  const r = await fetch(`api/admin/stats?days=${days}`, { headers: { 'X-Admin-Token': t } }).catch(() => null);
  if (!r) return showLogin('网络错误，请稍后重试');
  if (r.status === 401 || r.status === 404) { try { localStorage.removeItem(KEY); } catch {} return showLogin(r.status === 404 ? '服务器没有配置管理口令' : '口令不对'); }
  if (!r.ok) return showLogin((await r.json().catch(() => ({}))).error || `加载失败（HTTP ${r.status}）`);
  render(await r.json());
}

function showLogin(err = '') {
  $('login').hidden = false; $('board').hidden = true; $('loginErr').textContent = err;
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  try { localStorage.setItem(KEY, $('token').value.trim()); } catch {}
  $('login').hidden = true;
  load();
});
$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]'); if (!b) return;
  days = +b.dataset.days;
  for (const x of $('ranges').children) x.classList.toggle('on', x === b);
  load();
});

function tiles(el, items) {
  el.innerHTML = items.map(([label, value, note]) => `<div class="tile"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`).join('');
}

// 单序列柱状图：按天补齐空日期，悬停显示数值
function barChart(el, rows, sinceMs) {
  const map = new Map(rows.map((r) => [r.d, r.n]));
  const daysList = [];
  for (let t = sinceMs; t <= Date.now(); t += 86400_000) daysList.push(new Date(t + 8 * 3600_000).toISOString().slice(0, 10));
  const data = daysList.map((d) => ({ d, n: map.get(d) || 0 }));
  const max = Math.max(1, ...data.map((x) => x.n));
  if (!data.some((x) => x.n)) { el.innerHTML = '<div class="empty">这段时间还没有数据</div>'; return; }
  const W = 600, H = 220, padL = 32, padB = 22, padT = 10;
  const step = (W - padL) / data.length, bw = Math.max(2, Math.min(28, step - 2));
  const y = (v) => H - padB - ((H - padB - padT) * v) / max;
  const ticks = [0, Math.round(max / 2), max];
  const labelEvery = Math.ceil(data.length / 7);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每天数量柱状图">
    ${ticks.map((t) => `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join('')}
    ${data.map((x, i) => {
      const h = Math.max(0, H - padB - y(x.n));
      const cx = padL + i * step + (step - bw) / 2;
      return `<g><rect class="bar" x="${cx}" y="${y(x.n)}" width="${bw}" height="${h}" rx="${Math.min(4, bw / 2)}"><title>${x.d}：${x.n}</title></rect>
        ${i % labelEvery === 0 ? `<text class="axis" x="${cx + bw / 2}" y="${H - 6}" text-anchor="middle">${x.d.slice(5)}</text>` : ''}</g>`;
    }).join('')}
  </svg>`;
}

function hbars(el, rows) {
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...rows.map((r) => r[1]));
  el.innerHTML = rows.map(([label, v, note]) => `<div class="hbar" title="${esc(label)}：${v}">
    <span class="label">${esc(label)}</span>
    <span class="track"><span class="fill" style="width:${max ? (v / max) * 100 : 0}%"></span></span>
    <span class="val">${fmt(v)}${note ? ` · ${note}` : ''}</span></div>`).join('');
}

function propsCount(data, name, key, labelMap = {}) {
  const out = {};
  for (const r of data.props) {
    if (r.name !== name) continue;
    let p; try { p = JSON.parse(r.props); } catch { continue; }
    const k = p?.[key]; if (k == null || k === '') continue;
    const label = labelMap[k] || String(k);
    out[label] = (out[label] || 0) + r.n;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}

function render(d) {
  $('login').hidden = true; $('board').hidden = false;
  const T = d.totals;
  const sessionsOf = (name) => d.events.find((e) => e.name === name)?.s || 0;
  const countOf = (name) => d.events.find((e) => e.name === name)?.n || 0;

  tiles($('trafficTiles'), [
    ['打开次数（PV）', fmt(T.pv)],
    ['访客数', fmt(T.visitors), '按匿名 ID 去重'],
    ['会话数', fmt(T.sessions), '一次打开页面算一次'],
    ['新建账号', fmt(T.newUsers), `累计 ${fmt(T.totalUsers)}`],
    ['活跃账号', fmt(T.activeUsers)],
    ['平均停留', dur(T.avgActiveSec), '只算页面在前台的时间'],
    ['停留中位数', dur(median(T.activeSecs))],
  ]);
  tiles($('jobTiles'), [
    ['AI 生成次数', fmt(T.jobs)],
    ['成功', fmt(T.jobsDone), `成功率 ${pct(T.jobsDone, T.jobs)}`],
    ['失败', fmt(T.jobsError)],
    ['生成过的账号', fmt(T.jobUsers)],
    ['人均生成', T.jobUsers ? (T.jobs / T.jobUsers).toFixed(1) : '—', '生成次数 ÷ 生成过的账号'],
    ['平均耗时', T.avgGenSec ? `${Math.round(T.avgGenSec)} 秒` : '—'],
    ['直接转换', fmt(countOf('generate_click') ? propsCount(d, 'generate_click', 'mode').find(([k]) => k === 'direct')?.[1] || 0 : 0), '不消耗 AI 次数'],
  ]);

  barChart($('chartVisitors'), d.daily.visitors, d.since);
  barChart($('chartJobs'), d.daily.jobs, d.since);

  const open = sessionsOf('page_view');
  const steps = [['打开页面', open], ['点「生成」', sessionsOf('generate_click')], ['看到结果', sessionsOf('result_view')], ['下载图纸', sessionsOf('download')]];
  hbars($('funnel'), steps.map(([l, v]) => [l, v, pct(v, open)]));

  $('events').innerHTML = `<thead><tr><th>操作</th><th class="num">次数</th><th class="num">会话数</th></tr></thead><tbody>${
    d.events.map((e) => `<tr><td>${esc(EVENT_LABEL[e.name] || e.name)}</td><td class="num">${fmt(e.n)}</td><td class="num">${fmt(e.s)}</td></tr>`).join('')
  }</tbody>`;

  hbars($('distStyle'), Object.entries(d.styles).sort((a, b) => b[1] - a[1]));
  hbars($('distDownload'), propsCount(d, 'download', 'kind', DOWNLOAD_LABEL));
  hbars($('distPalette'), propsCount(d, 'download', 'palette', paletteLabel));
  hbars($('distMode'), d.byMode.map((r) => [MODE_LABEL[r.mode] || r.mode, r.n]).concat(propsCount(d, 'generate_click', 'mode').filter(([k]) => k === 'direct').map(([, v]) => ['直接转换', v])));
  hbars($('distDevice'), d.devices.map((r) => [r.device === 'mobile' ? '手机' : '电脑', r.n]));
  hbars($('distSource'), d.sources.map((r) => [r.source, r.n]));

  $('foot').textContent = `统计范围：最近 ${d.days} 天（北京时间，自 ${new Date(d.since + 8 * 3600_000).toISOString().slice(0, 10)} 起）。埋点只记录匿名 ID 和操作，不含照片与描述内容。`;
}

load();
