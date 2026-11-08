import { buildPattern, pixelGridOf, GRID_MIN_CONF } from './pattern.js';
import { buildPrintPdf } from './print.js';
import { solvePow } from './pow.js';
import { track, trackOnce } from './track.js';

const $ = (id) => document.getElementById(id);
const state = {
  palettes: [], cartoonBlob: null, cartoonImg: null, srcBlob: null, pattern: null,
  view: 'chart', zoom: 0 /* 0=适应 */, highlight: -1, outlineTouched: false, jobId: null,
};

// ---------- 初始化 ----------
let ready;
function init() {
  // 先绑定上传事件，数据异步加载（慢网络下也不会漏掉用户的第一次选择）
  bindUpload();
  bindControls();
  $('sizeChips').innerHTML = [29, 40, 52, 64, 78, 104].map((n) => `<button type="button" data-n="${n}">${n}</button>`).join('');
  syncLabels();
  ready = (async () => {
    const [pals, cfg] = await Promise.all([
      fetch('palettes.json').then((r) => r.json()),
      fetch('api/config').then((r) => r.json()).catch(() => ({ models: [] })),
    ]);
    state.palettes = pals;
    $('palette').innerHTML = pals.map((p) => `<option value="${p.id}">${p.label}${p.beadMm === 5 ? '（5mm）' : ''}</option>`).join('');
    try { const saved = localStorage.getItem('pindou.palette'); if (saved && pals.some((p) => p.id === saved)) $('palette').value = saved; } catch {}
    initStyle(cfg);
    state.cfg = cfg;
    if (cfg.srcKeepDays) $('keepDays').textContent = cfg.srcKeepDays;
  })();
  ready.catch((e) => showError(`初始化失败：${e.message}`));
  bindAccount();
  userReady = initUser().catch((e) => { showError(e.message); throw e; });
  window.addEventListener('popstate', renderRoute);
  userReady.then(async () => {
    const sync = location.hash.match(/^#sync=([0-9A-Za-z-]{10,12})$/);
    if (sync) return handleSyncLink(sync[1]);
    renderRoute();
  });
}

// ---------- 页面路由：生成页 / #works / #job=…，浏览器和手机的「返回」都能用 ----------
function navigate(hash, replace = false) {
  const url = hash || location.pathname + location.search;
  if ((location.hash || '') !== (hash || '')) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  renderRoute();
}

function renderRoute() {
  const h = location.hash;
  track('route_view', { route: h === '#works' ? 'works' : h.startsWith('#job=') ? 'job' : 'create' });
  if (h === '#works') return openHistory();
  const m = h.match(/^#job=([0-9a-f-]{36})$/);
  if (m) return openJob(m[1]);
  showCreate();
}

// 回到生成页：保留已选的图片和风格
function showCreate() {
  state.jobId = null;
  show('upload');
  checkLastJob();
}

// ---------- 上次的任务：关掉页面再回来时提醒 ----------
// 生成在服务器上异步进行；浏览器记住最近一次提交的任务，回到首页时告诉用户它的状态
const LAST_JOB = 'pindou.lastJob';
const getLastJob = () => { try { return JSON.parse(localStorage.getItem(LAST_JOB) || 'null'); } catch { return null; } };
const setLastJob = (v) => { try { v ? localStorage.setItem(LAST_JOB, JSON.stringify(v)) : localStorage.removeItem(LAST_JOB); } catch {} };
let lastJobTimer = null;
async function checkLastJob() {
  clearTimeout(lastJobTimer);
  const last = getLastJob();
  $('resumeBanner').hidden = true;
  if (!last || Date.now() - last.at > 3 * 86400_000) return setLastJob(null);
  await userReady;
  const r = await fetch(`api/jobs/${last.id}`).catch(() => null);
  if (!r || location.hash || $('upload').hidden) return;
  if (r.status === 404) return setLastJob(null);
  if (!r.ok) return;
  const j = await r.json();
  const show = (dot, title, sub, btn) => {
    $('resumeDot').className = `resume-dot ${dot}`;
    $('resumeTitle').textContent = title; $('resumeSub').textContent = sub;
    $('resumeGo').textContent = btn; $('resumeGo').hidden = !btn;
    $('resumeBanner').hidden = false;
  };
  if (j.status === 'queued' || j.status === 'running') {
    show('busy', '有一张图正在生成', j.status === 'queued' ? `排队中，前面还有 ${j.ahead} 个` : `已经画了 ${j.elapsed} 秒，画好会保存在「我的作品」`, '查看进度');
    lastJobTimer = setTimeout(checkLastJob, 5000); // 画好后提醒自动变成“已经好了”
  } else if (j.status === 'done') {
    show('done', '上次生成的图已经好了', '点一下就能看到图纸', '查看');
  } else {
    show('fail', '上次生成没有成功', j.error || '可以换张图再试一次', '');
    setLastJob(null);
  }
  track('resume_banner', { status: j.status });
}

function setNav(which) {
  $('navCreate').classList.toggle('on', which === 'create');
  $('navHistory').classList.toggle('on', which === 'works');
}

// ---------- 用户 ID ----------
// 同一设备：服务端下发的 Cookie（400 天）+ localStorage 备份；换设备：扫码 / 同步链接 / 输入 ID
let userReady;
const fmtId = (id) => `${id.slice(0, 5)}-${id.slice(5)}`;

async function initUser() {
  let saved = '';
  try { saved = localStorage.getItem('pindou.uid') || ''; } catch {}
  const r = await fetch(`api/me${saved ? `?restore=${encodeURIComponent(saved)}` : ''}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || '无法获取用户 ID，请刷新重试');
  setUser(d);
}

function setUser(d) {
  state.user = d.id; state.usage = d.usage;
  try { localStorage.setItem('pindou.uid', d.id); } catch {}
  $('meId').textContent = fmtId(d.id);
  renderUsage();
  prefetchPow();
}

function renderUsage() {
  const u = state.usage; if (!u) return;
  const left = Math.max(0, Math.min(u.userDaily - u.today, u.ipDaily - u.ipToday));
  $('quotaLine').textContent = currentMode() === 'direct' ? '直接转换不消耗次数' : `今天还可以 AI 生成 ${left} 次`;
  $('meUsage').textContent = `今天已 AI 生成 ${u.today} / ${u.userDaily} 次（每天 0 点重置）`;
}

async function refreshUsage() {
  const r = await fetch('api/me').catch(() => null);
  if (r?.ok) { const d = await r.json(); state.usage = d.usage; renderUsage(); }
}

function bindAccount() {
  $('navMe').addEventListener('click', openMe);
  $('meClose').addEventListener('click', () => $('meDialog').close());
  $('meDialog').addEventListener('click', (e) => { if (e.target === $('meDialog')) $('meDialog').close(); });
  $('meCopyId').addEventListener('click', () => { track('sync_copy_id'); copyText(fmtId(state.user), '已复制 ID'); });
  $('meCopyLink').addEventListener('click', () => { track('sync_copy_link'); copyText(syncLink(), '已复制同步链接，在另一台设备打开即可'); });
  $('meSwitchBtn').addEventListener('click', () => switchUser($('meSwitchInput').value));
  $('meSwitchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') switchUser($('meSwitchInput').value); });
  $('navHistory').addEventListener('click', () => navigate('#works'));
  $('navCreate').addEventListener('click', () => navigate(''));
  $('brand').addEventListener('click', () => navigate(''));
  $('histNew').addEventListener('click', () => navigate(''));
  $('histEmptyGo').addEventListener('click', () => navigate(''));
  $('resumeGo').addEventListener('click', () => { const l = getLastJob(); if (l) { track('resume_open'); navigate(`#job=${l.id}`); } });
  $('resumeClose').addEventListener('click', () => { $('resumeBanner').hidden = true; clearTimeout(lastJobTimer); setLastJob(null); });
  $('histGrid').addEventListener('click', onHistoryClick);
}

const syncLink = () => `${location.origin}${location.pathname}#sync=${fmtId(state.user)}`;

function openMe() {
  if (!state.user) return;
  track('me_open');
  $('meIdBig').textContent = fmtId(state.user);
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(syncLink()); qr.make();
    $('meQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { $('meQr').textContent = ''; }
  renderUsage();
  $('meDialog').showModal();
}

async function copyText(t, msg) {
  try { await navigator.clipboard.writeText(t); showToast(msg); }
  catch { prompt('复制下面的内容：', t); }
}

async function switchUser(raw, silent) {
  const id = String(raw || '').trim();
  if (!id) return;
  const r = await fetch('api/me/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const d = await r.json().catch(() => ({}));
  track('id_switch', { ok: r.ok });
  if (!r.ok) { showToast(d.error || '切换失败'); return false; }
  setUser(d);
  $('meDialog').close();
  if (!silent) showToast(`已切换到 ${fmtId(d.id)}`);
  navigate('#works');
  return true;
}

async function handleSyncLink(raw) {
  history.replaceState(null, '', location.pathname);
  const id = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (id === state.user) { showToast('已经是这个 ID 了'); return navigate('#works'); }
  if (confirm(`切换到 ID ${fmtId(id)}？\n\n切换后这台设备会显示该 ID 的作品。当前 ID 是 ${fmtId(state.user)}，如果它名下有作品，请先记下。`)) {
    await switchUser(id);
  }
}

// ---------- 工作量证明（防脚本刷接口）：后台提前算好，点生成时直接用 ----------
let powPromise = null, powAt = 0;
function prefetchPow() {
  powAt = Date.now();
  powPromise = fetch('api/pow').then((r) => r.ok ? r.json() : Promise.reject(new Error('pow'))).then(solvePow);
  powPromise.catch(() => {});
}
async function takePow() {
  if (!powPromise || Date.now() - powAt > 8 * 60_000) prefetchPow();
  const p = powPromise;
  prefetchPow(); // 下一次用的
  return p.catch(() => '');
}

// ---------- 我的作品 ----------
async function openHistory() {
  await userReady;
  state.jobId = null;
  for (const id of ['upload', 'working', 'result']) $(id).hidden = true;
  $('historyView').hidden = false; $('error').hidden = true;
  setNav('works');
  window.scrollTo(0, 0);
  const r = await fetch('api/history').catch(() => null);
  const d = r?.ok ? await r.json().catch(() => null) : null;
  if (!d) {
    $('histGrid').innerHTML = '';
    $('histEmpty').hidden = false;
    $('histEmpty').querySelector('p').textContent = '作品列表加载失败，请检查网络后重试。';
    $('histEmptyGo').textContent = '重试';
    $('histEmptyGo').onclick = () => openHistory();
    return;
  }
  $('histEmpty').querySelector('p').textContent = '还没有作品，去生成第一张吧。';
  $('histEmptyGo').textContent = '去生成';
  $('histEmptyGo').onclick = null;
  if (d.usage) { state.usage = d.usage; renderUsage(); }
  const items = d.items || [];
  $('histEmpty').hidden = items.length > 0;
  const fmtTime = (t) => { const x = new Date(t); return `${x.getMonth() + 1}/${x.getDate()} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
  const styleName = (style) => state.presets?.find((p) => p.prompt === style)?.name || '自定义风格';
  $('histGrid').innerHTML = items.map((j) => `
    <div class="hcard" data-id="${j.id}" data-status="${j.status}">
      <div class="hthumb">${j.status === 'done' ? `<img loading="lazy" src="api/jobs/${j.id}/${j.has_thumb ? 'thumb' : 'image'}" alt="">`
        : j.status === 'error' ? '<span class="hstat err">失败</span>' : '<span class="hstat">生成中…</span>'}</div>
      <div class="hmeta">
        <span>${j.mode === 'text' ? '文字' : '照片'} · ${escapeHtml(styleName(j.style))}</span>
        <small>${fmtTime(j.created_at)}</small>
      </div>
      <button class="hdel" data-del="${j.id}" aria-label="删除">✕</button>
    </div>`).join('');
}

function escapeHtml(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

async function onHistoryClick(e) {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('删除这张作品？删除后无法恢复。')) return;
    track('history_delete');
    await fetch(`api/jobs/${del.dataset.del}`, { method: 'DELETE' });
    del.closest('.hcard').remove();
    $('histEmpty').hidden = $('histGrid').children.length > 0;
    return;
  }
  const card = e.target.closest('.hcard');
  if (!card) return;
  if (card.dataset.status === 'error') return showToast('这张生成失败了，可以重新生成一张');
  track('history_item_open');
  navigate(`#job=${card.dataset.id}`);
}

// 打开某个任务：未完成就继续等，已完成直接显示
async function openJob(id) {
  // 已经在显示这张作品（比如从别处返回）就不用重新加载
  if (state.job?.id === id && state.cartoonImg) { show('result'); return; }
  show('working');
  $('srcPreview').removeAttribute('src');
  await pollJob(id);
}

// ---------- 风格提示词 ----------
// 每次进入默认选第一个预设；用户在「自定义」里写的内容单独记在浏览器里
const STYLE_KEY = 'pindou.custom-style';
function initStyle(cfg) {
  state.presets = cfg.presets || [];
  state.cfg = cfg;
  syncTech(currentMode() === 'text' ? 'text' : 'photo');
  $('presetChips').innerHTML = state.presets.map((p, i) => `
    <button type="button" class="scard" data-preset="${p.id}">
      <span class="scard-img">${p.demo ? `<img src="${p.demo}" alt="" loading="lazy">` : ''}</span>
      <span class="scard-name">${p.name}${i === 0 ? '<em>默认</em>' : ''}</span>
    </button>`).join('') + `
    <button type="button" class="scard" data-preset="custom">
      <span class="scard-img custom">✎</span>
      <span class="scard-name">自定义</span>
    </button>`;
  try { state.customText = localStorage.getItem(STYLE_KEY) || ''; } catch { state.customText = ''; }
  applyPreset(state.presets[0]?.id);
  syncStyle();
  $('presetChips').addEventListener('click', (e) => {
    const id = e.target.closest('[data-preset]')?.dataset.preset; if (!id) return;
    track('style_select', { preset: id });
    if (id === 'custom') {
      $('style').value = state.customText; state.basePreset = 'custom';
      $('promptDetails').open = true; $('style').focus();
    } else applyPreset(id);
    syncStyle();
  });
  $('style').addEventListener('input', () => {
    if (state.basePreset === 'custom') {
      state.customText = $('style').value;
      try { localStorage.setItem(STYLE_KEY, state.customText); } catch {}
    }
    trackOnce('prompt_edit', { preset: state.basePreset });
    syncStyle();
  });
  $('styleReset').addEventListener('click', () => { applyPreset(state.basePreset); syncStyle(); });
}

function applyPreset(id) {
  const p = state.presets.find((x) => x.id === id) || state.presets[0];
  if (!p) return;
  $('style').value = p.prompt; state.basePreset = p.id;
}

// 高亮当前预设；文字被改过就显示“已修改”
function syncStyle() {
  const text = $('style').value.trim();
  const exact = state.presets.find((p) => p.prompt === text);
  const active = exact ? exact.id : (state.basePreset === 'custom' || !text ? 'custom' : state.basePreset);
  for (const b of $('presetChips').children) {
    b.classList.toggle('on', b.dataset.preset === active);
    b.classList.toggle('edited', b.dataset.preset === active && !exact && active !== 'custom');
  }
  const base = state.presets.find((p) => p.id === state.basePreset);
  $('styleReset').hidden = !base || base.prompt === text;
  $('styleCount').textContent = `${$('style').value.length} / ${state.cfg?.maxStyle ?? 1000}${!exact && base ? ' · 已修改预设' : ''}`;
}

// 风格编辑框只有一份：上传页放在上传卡片里，结果页放在侧栏“换个风格”里
function placeStyleBox(which) {
  const slot = $(which === 'result' ? 'styleSlotResult' : 'styleSlotUpload');
  if ($('styleBox').parentElement !== slot) slot.appendChild($('styleBox'));
  // 文字创作的结果页，“换个风格”里也能改描述
  const sslot = $(which === 'result' && state.lastMode === 'text' ? 'subjectSlotResult' : 'subjectSlotUpload');
  if ($('subjectBox').parentElement !== sslot) sslot.appendChild($('subjectBox'));
  if (which === 'result') {
    syncTech(state.lastMode === 'text' ? 'text' : 'photo');
    $('regen').textContent = state.lastMode === 'direct' ? '用 AI 卡通化' : '重新生成';
    $('regen2').textContent = state.lastMode === 'text' ? '按新描述 / 风格重新生成' : '按新风格重新生成';
  } else syncMode();
}

// ---------- 上传 ----------
const isImageFile = (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name);
function bindUpload() {
  const drop = $('drop');
  $('file').addEventListener('change', (e) => e.target.files[0] && pick(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find(isImageFile);
    if (f) pick(f);
  });
  window.addEventListener('paste', (e) => {
    if (!$('upload').hidden && currentMode() !== 'text') {
      const f = [...(e.clipboardData?.files || [])].find(isImageFile);
      if (f) pick(f);
    }
  });
  $('repick').addEventListener('click', () => $('file').click());
  $('genBtn').addEventListener('click', generate);
  $('subject').addEventListener('input', () => { syncGenBtn(); for (const c of $('subjectExamples').children) c.classList.toggle('on', c.dataset.text === $('subject').value.trim()); });
  $('subject').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); });
  // 文字创作示例：效果图均为用默认风格「像素萌系」实际生成
  const EXAMPLES = [
    ['spongebob', '海绵宝宝和派大星祝章鱼哥生日快乐'],
    ['doraemon', '哆啦A梦开着一辆银色带青绿色条纹的 F1 赛车，侧前方视角'],
    ['shinchan', '蜡笔小新开着深蓝红黄配色的 F1 赛车，表情得意'],
    ['tomjerry', '猫和老鼠里的汤姆猫和杰瑞一起抱着一块奶酪蛋糕'],
    ['orangecat', '一只胖橘猫戴着圣诞帽，抱着一个红色礼物盒'],
  ];
  $('subjectExamples').innerHTML = EXAMPLES.map(([img, t]) => `
    <button type="button" class="excard" data-text="${t}">
      <img src="examples/${img}.webp" alt="" loading="lazy">
      <span>${t}</span>
    </button>`).join('');
  for (const img of $('subjectExamples').querySelectorAll('img')) img.addEventListener('error', () => img.remove());
  $('subjectExamples').addEventListener('click', (e) => {
    const card = e.target.closest('.excard'); if (!card) return;
    track('example_click', { idx: [...card.parentElement.children].indexOf(card) });
    $('subject').value = card.dataset.text; syncGenBtn();
    for (const c of $('subjectExamples').children) c.classList.toggle('on', c === card);
  });
  // 结果页的“重新生成”：文字创作按描述重画，照片按原图重画
  const toAi = () => {
    track('regen_click', { mode: state.lastMode || '' });
    setDirect(false);
    if (state.lastMode === 'direct') { state.job = null; return state.srcBlob ? cartoonize(state.srcBlob) : reset(); }
    return rerunCurrent();
  };
  $('regen').addEventListener('click', toAi);
  $('toAi').addEventListener('click', toAi);
  $('regen2').addEventListener('click', toAi);
  for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', () => { syncMode(); track('mode_select', { mode: currentMode() }); });
  // 手机浏览器返回/恢复页面时可能沿用上次的选项，每次进入都重置为照片转换
  window.addEventListener('pageshow', () => { document.querySelector('input[name=mode][value=ai]').checked = true; syncMode(); });
}

// 第 1 步：选好图片只做预览，不开始生成
async function pick(file) {
  $('error').hidden = true;
  const gen = $('genBtn'); gen.disabled = true; gen.textContent = '正在读取图片…';
  try {
    const blob = await normalizeImage(file);
    state.srcBlob = blob;
    // 直接转换用原文件：保留透明背景，也避免像素图被 JPEG 压出杂色
    state.srcOriginal = /^image\/(png|gif|webp|bmp)$/.test(file.type) ? file : blob;
    if (state.pickedUrl) URL.revokeObjectURL(state.pickedUrl);
    state.pickedUrl = URL.createObjectURL(blob);
    track('image_pick', { mode: currentMode(), type: (file.type || file.name.split('.').pop() || '').slice(0, 20), kb: Math.round(file.size / 1024) });
    $('pickedImg').src = state.pickedUrl;
    $('pickedMeta').textContent = file.name || '粘贴的图片';
    $('picked').hidden = false; $('drop').hidden = true;
  } catch (e) {
    showError(e.message);
  } finally {
    $('file').value = '';
    syncGenBtn();
  }
}

// 第 3 步：点击生成
async function generate() {
  const mode = currentMode();
  if ($('genBtn').disabled) return;
  track('generate_click', { mode, preset: mode === 'direct' ? '' : (styleEdited() ? 'edited:' : '') + state.basePreset });
  if (mode === 'text') return textGenerate();
  if (!state.srcBlob) return;
  if (mode === 'direct') {
    state.lastMode = 'direct'; state.job = null;
    await setCartoon(state.srcOriginal || state.srcBlob);
    setDirect(true);
    return;
  }
  setDirect(false);
  state.job = null;
  await cartoonize(state.srcBlob);
}

const styleEdited = () => !state.presets?.some((p) => p.prompt === $('style').value.trim());

function syncGenBtn() {
  const mode = currentMode();
  const ready = mode === 'text' ? !!$('subject').value.trim() : !!state.srcBlob;
  const btn = $('genBtn');
  btn.disabled = !ready;
  btn.textContent = mode === 'direct' ? '转换成图纸'
    : ready ? '生成拼豆图纸' : mode === 'text' ? '先写下想画什么' : '先选择一张图片';
}

function currentMode() {
  return document.querySelector('input[name=mode]:checked').value; // ai | text | direct
}

const MODE_HINTS = {
  ai: '上传照片，AI 按你选的风格重画，再转成拼豆图纸',
  text: '不用图片：描述想画的角色和场景，AI 直接画出来再转成图纸',
  direct: '图片已经是像素画或卡通图时用：不经过 AI，直接转成图纸（照片会很乱）',
};
function syncMode() {
  const mode = currentMode();
  $('stepImage').hidden = mode === 'text';
  $('stepSubject').hidden = mode !== 'text';
  $('stepStyle').hidden = mode === 'direct';
  $('stepStyle').querySelector('.step-title i').textContent = '2';
  $('modeHint').textContent = MODE_HINTS[mode];
  const hasPick = !!state.srcBlob;
  $('picked').hidden = !hasPick; $('drop').hidden = hasPick;
  syncTech(mode === 'text' ? 'text' : 'photo');
  syncGenBtn();
  renderUsage();
}

// 只读展示最终会附加的固定部分：照片模式多一条“忠于参考图”
function syncTech() {} // 技术提示词不再展示给用户

function setDirect(direct) {
  // 像素画本来就适合直接转换，不必提醒；只有看起来像照片时才提示改用 AI
  const isPixel = !!state.cartoonImg && pixelGridOf(state.cartoonImg).conf >= GRID_MIN_CONF;
  $('directNotice').hidden = !direct || isPixel;
  $('regen').textContent = direct ? '用 AI 卡通化' : '重新卡通化';
  $('regen').classList.toggle('primary', direct);
  $('regen').classList.toggle('ghost', !direct);
}

function reset() {
  state.srcBlob = null; state.srcOriginal = null; state.job = null; state.cartoonImg = null;
  $('file').value = '';
  navigate('');
}

function show(which) {
  for (const id of ['upload', 'working', 'result']) $(id).hidden = id !== which;
  $('historyView').hidden = true;
  setNav(which === 'upload' ? 'create' : '');
  if (which === 'upload') syncMode();
  if (which !== 'working') placeStyleBox(which);
  $('error').hidden = true;
}

function showError(msg) {
  if (isNetErr(msg)) msg = '网络不太稳定，请检查网络后重试';
  track('error_shown', { msg: String(msg).slice(0, 40) });
  $('error').textContent = msg; $('error').hidden = false;
}

// 浏览器端先缩到长边 1536 的 JPEG，减小上传体积
async function normalizeImage(file) {
  let bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) {
    // 浏览器解码不了（常见于 Chrome 打开 iPhone 的 HEIC 照片）：交给服务器转成 JPEG
    await userReady;
    const res = await fetch('api/convert', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '无法读取这张图片，请换成 JPG / PNG 格式');
    bmp = await createImageBitmap(await res.blob()).catch(() => null);
    if (!bmp) throw new Error('无法读取这张图片，请换成 JPG / PNG 格式');
  }
  const s = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}

async function cartoonize(blob) {
  state.lastMode = 'photo';
  show('working');
  setObjectUrl('srcPreview', blob);
  $('workMsg').textContent = '正在上传…';
  await submitJob(blob, blob.type);
}

async function textGenerate() {
  state.job = null;
  const subject = $('subject').value.trim();
  if (!subject) { showError('先写下想画的内容'); $('subject').focus(); return; }
  state.lastMode = 'text';
  setDirect(false);
  show('working');
  $('srcPreview').removeAttribute('src');
  $('workMsg').textContent = '正在提交…';
  await submitJob(JSON.stringify({ subject }), 'application/json');
}

async function submitJob(body, type, rerunOf) {
  await userReady;
  $('workMsg').textContent = '正在准备…';
  const proof = await takePow();
  const q = new URLSearchParams({ style: $('style').value.trim() });
  const url = rerunOf ? `api/jobs/${rerunOf}/rerun?${q}` : `api/jobs?${q}`;
  // 同一次提交带同一个编号：网络断了自动重发，服务器认出是同一次，不会重复生成、重复扣次数
  const rid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  $('workMsg').textContent = '正在上传…';
  const res = await fetchRetry(url, { method: 'POST', body, headers: { 'Content-Type': type, 'X-Pow': proof, 'X-Request-Id': rid } },
    { tries: 3, timeout: 60_000, onRetry: (n) => { $('workMsg').textContent = `网络不稳定，正在重试（${n}）…`; } }).catch(() => null);
  const data = await res?.json().catch(() => ({})) ?? {};
  track('job_submit', { ok: !!res?.ok, code: res?.status || 0, rerun: !!rerunOf });
  if (!res?.ok) {
    show(rerunOf && state.cartoonImg ? 'result' : 'upload');
    return showError(data.error || `提交失败（${res ? `HTTP ${res.status}` : '网络错误'}）`);
  }
  history.pushState(null, '', `#job=${data.id}`);
  setLastJob({ id: data.id, at: Date.now() });
  refreshUsage();
  await pollJob(data.id);
}

// 基于当前作品重新生成（换风格 / 改描述），不用重新上传
async function rerunCurrent() {
  const job = state.job;
  if (!job) return state.srcBlob ? cartoonize(state.srcBlob) : reset();
  if (job.mode === 'photo' && !job.hasSrc && !state.srcBlob) return showError(`原图已过期（只保留 ${state.cfg?.srcKeepDays ?? 30} 天），请重新上传`);
  state.lastMode = job.mode;
  show('working');
  $('srcPreview').removeAttribute('src');
  const body = job.mode === 'text' ? JSON.stringify({ subject: $('subject').value.trim() || job.subject }) : '{}';
  await submitJob(body, 'application/json', job.id);
}

async function resumeJob(id) {
  show('working');
  $('srcPreview').removeAttribute('src');
  await pollJob(id);
}

let pollSeq = 0;
async function pollJob(id) {
  state.jobId = id;
  const seq = ++pollSeq; // 后退/前进时可能重复进入同一个任务，只让最新的一次轮询继续
  const alive = () => seq === pollSeq && state.jobId === id;
  const t0 = Date.now();
  let backoff = 1500;
  // 已等待时间在本地每秒刷新，不依赖网络请求的快慢
  let status = 'running', ahead = 0, base = 0, baseAt = Date.now();
  $('workRetry').hidden = true; $('workSub').textContent = '通常需要 20～60 秒，请不要关闭页面';
  const tick = setInterval(() => {
    if (!alive()) return clearInterval(tick);
    const sec = Math.round(base + (Date.now() - baseAt) / 1000);
    $('workMsg').textContent = status === 'queued' ? `排队中（前面 ${ahead} 个）… ${Math.round((Date.now() - t0) / 1000)}s` : `AI 正在画… ${sec}s`;
  }, 1000);
  try {
  for (;;) {
    if (!alive()) return;
    let r, j;
    try { r = await fetch(`api/jobs/${id}`, { signal: AbortSignal.timeout(10_000) }); j = await r.json(); }
    catch { await sleep(2000); continue; }
    if (!alive()) return;
    if (r.status === 404) { navigate('', true); return showError(j.error || '作品不存在或已删除'); }
    if (!r.ok) { await sleep(backoff); backoff = Math.min(10_000, backoff * 1.6); continue; } // 限流等临时错误：等一会儿再查
    backoff = 1500;
    if (j.status === 'done') { track('job_done', { mode: j.mode, secs: j.elapsed }); break; }
    if (j.status === 'error' || j.status === 'cancelled') { track('job_fail', { mode: j.mode }); navigate('', true); return showError(j.error || '生成失败'); }
    status = j.status; ahead = j.ahead; base = j.elapsed; baseAt = Date.now();
    await sleep(1500);
  }
  } finally { clearInterval(tick); }
  if (!alive() || location.hash !== `#job=${id}`) { refreshUsage(); return; } // 用户已离开，结果在「我的作品」里
  $('workMsg').textContent = '画好了，正在下载图片…';
  const job = await fetchRetry(`api/jobs/${id}`, {}, { tries: 3 }).then((r) => r.json()).catch(() => null);
  let blob = null, notFound = false;
  try {
    const r = await fetchRetry(`api/jobs/${id}/image`, {}, { tries: 4, timeout: 90_000, onRetry: (n) => { $('workMsg').textContent = `网络不稳定，正在重新下载图片（${n}）…`; } });
    if (r.status === 404) notFound = true; else if (r.ok) blob = await r.blob();
  } catch {}
  if (!alive()) return;
  if (notFound) { navigate('', true); return showError('作品不存在或已删除'); }
  if (!blob) {
    // 图片已经生成并保存在「我的作品」里，只是这次没下载下来：原地给重试按钮
    track('error_shown', { msg: 'image_download_failed' });
    $('workMsg').textContent = '图片已生成，但网络不稳定没下载下来';
    $('workSub').textContent = '作品已保存在「我的作品」里，可以点重试，或稍后再打开';
    $('workRetry').hidden = false;
    $('workRetry').onclick = () => pollJob(id);
    return;
  }
  state.job = job;
  if (getLastJob()?.id === id) setLastJob(null); // 已经看到结果，不再提醒
  state.lastMode = job?.mode === 'text' ? 'text' : 'photo';
  if (job?.mode === 'text' && job.subject) $('subject').value = job.subject;
  if (job?.style) { $('style').value = job.style; syncStyle(); }
  await setCartoon(blob, job);
  if (job && !job.hasThumb) uploadThumb(job.id);
  refreshUsage();
}

// 作品缩略图：浏览器生成 256px WebP 传给服务器，「我的作品」列表就不用加载大图
async function uploadThumb(id) {
  try {
    const bmp = await createImageBitmap(state.cartoonBlob);
    const s = 256 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85));
    if (blob?.type === 'image/webp') await fetch(`api/jobs/${id}/thumb`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/webp' } });
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带超时、网络错误自动重试的 fetch（跨境网络偶尔丢包，单次失败很常见）
async function fetchRetry(url, opts = {}, { tries = 3, timeout = 15_000, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      last = e;
      if (i < tries - 1) { onRetry?.(i + 1); await sleep(1000 * 2 ** i); }
    }
  }
  throw last;
}
const isNetErr = (msg) => /load failed|failed to fetch|networkerror|network error|timed? ?out|aborted/i.test(String(msg));

async function setCartoon(blob, job) {
  track('result_view', { mode: state.lastMode || '' });
  await ready;
  if (job?.params) applyParams(job.params);
  state.cartoonBlob = blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  state.cartoonImg = ctx.getImageData(0, 0, c.width, c.height);
  const url = setObjectUrl('cartoon', blob);
  $('dlCartoon').download = blob.type === 'image/webp' ? 'cartoon.webp' : 'cartoon.png';
  $('cartoon').src = url; $('dlCartoon').href = url;
  state.highlight = -1;
  show('result');
  regenerate();
}

// ---------- 参数 ----------
function bindControls() {
  const rerun = debounce(regenerate, 120);
  for (const id of ['palette', 'size', 'colors', 'outline', 'removeBg', 'outer', 'cleanup', 'gridMode']) {
    $(id).addEventListener('input', () => {
      if (id === 'outline') state.outlineTouched = true;
      if (id === 'palette') track('palette_change', { palette: $('palette').value });
      else if (id !== 'size') trackOnce(`param_${id}`);
      if (id === 'size') leaveGridMode(); // 手动改尺寸 = 不再按 AI 像素一格一豆
      if (id === 'palette') { try { localStorage.setItem('pindou.palette', $('palette').value); } catch {} state.highlight = -1; }
      syncLabels(); rerun();
    });
  }
  $('sizeChips').addEventListener('click', (e) => {
    const n = e.target.dataset?.n; if (!n) return;
    leaveGridMode();
    track('size_change', { size: +n });
    $('size').value = n; syncLabels(); regenerate();
  });
  for (const id of ['board', 'showCodes']) $(id).addEventListener('input', () => { renderStats(); draw(); });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => {
    state.view = t.dataset.view;
    track('view_tab', { view: state.view });
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    draw();
  });
  // 第一次放大直接到能看清色号的大小（手机上「适应」时格子只有 6～8 点）
  $('zoomIn').addEventListener('click', () => { track('zoom', { dir: 'in' }); const c = state.zoom || fitCell(); state.zoom = Math.min(48, c < 14 ? 15 : c * 1.4); draw(); });
  $('zoomOut').addEventListener('click', () => { state.zoom = Math.max(4, (state.zoom || fitCell()) / 1.4); draw(); });
  $('zoomFit').addEventListener('click', () => { state.zoom = 0; draw(); });
  window.addEventListener('resize', debounce(() => state.zoom === 0 && draw(), 150));
  $('legend').addEventListener('click', (e) => {
    const el = e.target.closest('[data-idx]'); if (!el) return;
    const idx = +el.dataset.idx;
    track('highlight', { from: 'legend' });
    state.highlight = state.highlight === idx ? -1 : idx;
    renderLegend(); draw();
  });
  $('clearHl').addEventListener('click', () => { state.highlight = -1; renderLegend(); draw(); });
  $('view').addEventListener('mousemove', onHover);
  $('view').addEventListener('click', (e) => {
    const c = onHover(e);
    if (c === undefined) return;
    track('highlight', { from: 'chart' });
    state.highlight = c < 0 || state.highlight === c ? -1 : c;
    renderLegend(); draw();
  });
  $('dlChart').addEventListener('click', () => { track('download', dlProps('png')); download(exportChart(), 'pindou-chart.png'); });
  $('dlBeads').addEventListener('click', () => { track('download', dlProps('preview')); download(renderBeads(state.pattern, 16), 'pindou-preview.png'); });
  $('dlCsv').addEventListener('click', () => { track('download', dlProps('csv')); downloadCsv(); });
  $('dlPdf').addEventListener('click', () => { track('download', dlProps('pdf')); downloadPdf(); });
  $('dlCartoon').addEventListener('click', (e) => {
    track('download', dlProps('ai_image'));
    if (isIOS && state.cartoonBlob) { e.preventDefault(); saveBlob(state.cartoonBlob, $('dlCartoon').download); }
  });
  $('saveClose').addEventListener('click', () => $('saveDialog').close());
  $('saveDialog').addEventListener('click', (e) => { if (e.target === $('saveDialog')) $('saveDialog').close(); });
  // 按钮点击是新的用户手势，分享菜单一定能弹出来（菜单里有「存储图像」）
  $('saveShare').addEventListener('click', async () => {
    if (!saveFile) return;
    track('save_share_click');
    try { await navigator.share({ files: [saveFile] }); } catch {}
  });
  $('pitch').addEventListener('input', () => { state.pitchTouched = true; });
}

function leaveGridMode() {
  if (!$('gridOpt').hidden && $('gridMode').checked) {
    $('gridMode').checked = false;
    showToast('已改为自定义尺寸（取消了「按像素一格一豆」）');
  }
}

let toastTimer;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function outlineThreshold() {
  const s = +$('outline').value;
  return s === 0 ? 0 : 0.62 - s * 0.042;
}

function syncLabels() {
  const size = +$('size').value;
  if (!state.outlineTouched) $("outline").value = size >= 44 ? 4 : 3;
  $('outline').max = 10;
  $('sizeVal').textContent = size;
  $('colorsVal').textContent = $('colors').value;
  const s = +$('outline').value;
  $('outlineVal').textContent = s === 0 ? '关' : s;
  for (const b of $('sizeChips').children) b.classList.toggle('on', +b.dataset.n === size);
}

function regenerate() {
  if (!state.cartoonImg) return;
  const pal = state.palettes.find((p) => p.id === $('palette').value) || state.palettes[0];
  if (!state.pitchTouched) $('pitch').value = pal.beadMm;
  // 检测是否为像素图：是的话默认一格一豆，尺寸由 AI 的像素决定
  const g = pixelGridOf(state.cartoonImg);
  const isPixel = g.conf >= GRID_MIN_CONF;
  $('gridOpt').hidden = !isPixel;
  const useGrid = isPixel && $('gridMode').checked;
  state.pattern = buildPattern(state.cartoonImg, pal, {
    grid: useGrid,
    longSide: +$('size').value,
    maxColors: +$('colors').value,
    outline: outlineThreshold(),
    removeBg: $('removeBg').checked,
    outerOutline: $('outer').checked,
    cleanup: $('cleanup').checked ? 2 : 0,
  });
  if (state.highlight >= 0 && !state.pattern.legend.some((l) => l.idx === state.highlight)) state.highlight = -1;
  $('gridInfo').textContent = isPixel ? `（检测到 ${state.pattern.grid ? `${state.pattern.width}×${state.pattern.height}` : '像素图'}）` : '';
  // 一格一豆时尺寸由 AI 的像素决定；尺寸控件仍可点，点了就自动切到自定义尺寸
  $('sizeLabel').classList.toggle('dim', !!state.pattern.grid);
  $('sizeVal').textContent = state.pattern.grid ? `按像素 · 点下方可改` : $('size').value;
  for (const b of $('sizeChips').children) b.classList.toggle('on', !state.pattern.grid && +b.dataset.n === +$('size').value);
  renderStats(); renderLegend(); draw();
  if (state.job) saveParams();
}

// 图纸参数跟作品一起存到服务器：换设备打开同一作品，图纸一样
const PARAM_IDS = ['palette', 'size', 'colors', 'outline', 'board'];
const PARAM_CHECKS = ['removeBg', 'outer', 'cleanup', 'gridMode'];
const saveParams = debounce(() => {
  const job = state.job; if (!job) return;
  const p = { outlineTouched: !!state.outlineTouched };
  for (const id of PARAM_IDS) p[id] = $(id).value;
  for (const id of PARAM_CHECKS) p[id] = $(id).checked;
  const json = JSON.stringify(p);
  if (json === state.lastParams) return;
  state.lastParams = json;
  job.params = p;
  fetch(`api/jobs/${job.id}/params`, { method: 'PUT', body: json, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}, 1000);

function applyParams(p) {
  for (const id of PARAM_IDS) {
    if (p[id] == null) continue;
    // 下拉框的值不在选项里（例如色卡以后改名）就保持当前值
    if ($(id).tagName === 'SELECT' && ![...$(id).options].some((o) => o.value === String(p[id]))) continue;
    $(id).value = p[id];
  }
  for (const id of PARAM_CHECKS) if (typeof p[id] === 'boolean') $(id).checked = p[id];
  state.outlineTouched = !!p.outlineTouched;
  state.lastParams = JSON.stringify(p);
  syncLabels();
}

// ---------- 统计 / 色号 ----------
function renderStats() {
  const p = state.pattern, mm = p.palette.beadMm;
  const cm = (n) => (n * mm / 10).toFixed(1);
  const board = +$('board').value || (mm === 5 ? 29 : 52);
  const boards = Math.ceil(p.width / board) * Math.ceil(p.height / board);
  $('stats').innerHTML = [
    ['尺寸', `${p.width} × ${p.height} 格`],
    ['豆子总数', `${p.total.toLocaleString()} 颗`],
    ['颜色数', `${p.legend.length} 色`],
    ['成品大小', `约 ${cm(p.width)} × ${cm(p.height)} cm（${mm}mm 豆）`],
    ['需要拼板', `${boards} 块 ${board}×${board}`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

function renderLegend() {
  const p = state.pattern;
  $('legend').innerHTML = p.legend.map((l) => `
    <button class="lg ${state.highlight === l.idx ? 'on' : ''} ${state.highlight >= 0 && state.highlight !== l.idx ? 'dim' : ''}" data-idx="${l.idx}" title="${l.name || l.code} ${l.hex}">
      <span class="sw" style="background:${l.hex};color:${textColor(l.rgb)}">${l.code}</span>
      <span class="n">${l.n}</span>
    </button>`).join('');
  $('clearHl').hidden = state.highlight < 0;
}

function textColor([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1d1d1f' : '#ffffff';
}

// ---------- 绘制 ----------
const AXIS = 26;

function fitCell() {
  const p = state.pattern; if (!p) return 12;
  const avail = $('canvasWrap').clientWidth - 2 - AXIS * 2;
  return Math.max(4, Math.min(28, Math.floor(avail / p.width)));
}

function draw() {
  const p = state.pattern; if (!p) return;
  const cell = state.zoom || fitCell();
  // 画布边长控制在 4096 以内（iOS Safari 单个画布约 1670 万像素上限），超了就降低清晰度
  const side = Math.max(p.width, p.height) * cell + AXIS * 2;
  const dpr = Math.max(0.5, Math.min(2, window.devicePixelRatio || 1, 4096 / side));
  const src = state.view === 'chart'
    ? renderChart(p, { cell: cell * dpr, axis: AXIS * dpr, showCodes: $('showCodes').checked && cell >= 12, highlight: state.highlight, board: +$('board').value })
    : renderBeads(p, cell * dpr, state.highlight);
  const v = $('view');
  v.width = src.width; v.height = src.height;
  v.style.width = `${src.width / dpr}px`; v.style.height = `${src.height / dpr}px`;
  v.getContext('2d').drawImage(src, 0, 0);
  v.dataset.cell = cell; v.dataset.axis = state.view === 'chart' ? AXIS : 0;
}

function onHover(e) {
  const p = state.pattern; if (!p) return;
  const v = $('view'), r = v.getBoundingClientRect();
  const cell = +v.dataset.cell, axis = +v.dataset.axis;
  const x = Math.floor((e.clientX - r.left - axis) / cell), y = Math.floor((e.clientY - r.top - axis) / cell);
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return;
  const c = p.cells[y * p.width + x];
  $('hover').textContent = `第 ${y + 1} 行，第 ${x + 1} 列：${c < 0 ? '空' : `${p.palette.colors[c].code}  ${p.palette.colors[c].hex}`}`;
  return c;
}

// 图纸：格子 + 色号 + 5/10 格粗线 + 坐标 + 拼板分割线
function renderChart(p, { cell, axis, showCodes = true, highlight = -1, board = 0 }) {
  const W = p.width, H = p.height;
  const c = document.createElement('canvas');
  c.width = W * cell + axis * 2; c.height = H * cell + axis * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.save(); ctx.translate(axis, axis);
  const fontSize = Math.max(6, Math.floor(cell * 0.4));
  const codes = showCodes && cell >= 11;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const idx = p.cells[y * W + x];
    if (idx < 0) continue;
    const col = p.palette.colors[idx];
    const dim = highlight >= 0 && idx !== highlight;
    ctx.fillStyle = dim ? mix(col.rgb, 0.85) : col.hex;
    ctx.fillRect(x * cell, y * cell, cell, cell);
    if (codes && !dim) {
      let fs = fontSize;
      ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
      const w = ctx.measureText(col.code).width;
      if (w > cell * 0.9) { fs = Math.max(5, Math.floor(fs * cell * 0.9 / w)); ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`; }
      ctx.fillStyle = textColor(col.rgb);
      ctx.fillText(col.code, x * cell + cell / 2, y * cell + cell / 2 + 0.5);
    }
  }
  // 网格线
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  for (let i = 0; i <= W; i++) {
    ctx.strokeStyle = i % 10 === 0 ? '#222' : i % 5 === 0 ? '#777' : '#d4d4d4';
    ctx.lineWidth = i % 10 === 0 ? Math.max(1.5, cell / 10) : i % 5 === 0 ? Math.max(1, cell / 16) : 1;
    line(i * cell, 0, i * cell, H * cell);
  }
  for (let j = 0; j <= H; j++) {
    ctx.strokeStyle = j % 10 === 0 ? '#222' : j % 5 === 0 ? '#777' : '#d4d4d4';
    ctx.lineWidth = j % 10 === 0 ? Math.max(1.5, cell / 10) : j % 5 === 0 ? Math.max(1, cell / 16) : 1;
    line(0, j * cell, W * cell, j * cell);
  }
  ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(1.5, cell / 10); ctx.strokeRect(0, 0, W * cell, H * cell);
  if (board > 0) {
    ctx.strokeStyle = '#e5484d'; ctx.lineWidth = Math.max(2, cell / 6); ctx.setLineDash([cell / 2, cell / 3]);
    for (let i = board; i < W; i += board) line(i * cell, 0, i * cell, H * cell);
    for (let j = board; j < H; j += board) line(0, j * cell, W * cell, j * cell);
    ctx.setLineDash([]);
  }
  ctx.restore();
  // 坐标（每 5 格标一次，小格子时每 10 格）
  const step = cell >= 14 ? 5 : 10;
  ctx.fillStyle = '#555'; ctx.font = `${Math.max(9, Math.floor(axis * 0.42))}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 1; i <= W; i++) if (i === 1 || i % step === 0) {
    const x = axis + (i - 0.5) * cell;
    ctx.fillText(i, x, axis / 2); ctx.fillText(i, x, c.height - axis / 2);
  }
  for (let j = 1; j <= H; j++) if (j === 1 || j % step === 0) {
    const y = axis + (j - 0.5) * cell;
    ctx.fillText(j, axis / 2, y); ctx.fillText(j, c.width - axis / 2, y);
  }
  return c;
}

function mix([r, g, b], t) {
  return `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`;
}

// 成品预览：熨烫后的圆豆效果
function renderBeads(p, cell, highlight = -1) {
  const pad = cell;
  const c = document.createElement('canvas');
  c.width = p.width * cell + pad * 2; c.height = p.height * cell + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3efe8'; ctx.fillRect(0, 0, c.width, c.height);
  const r = cell * 0.47, hole = cell * 0.16;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const idx = p.cells[y * p.width + x];
    const cx = pad + x * cell + cell / 2, cy = pad + y * cell + cell / 2;
    if (idx < 0) { ctx.fillStyle = '#e4ded4'; ctx.beginPath(); ctx.arc(cx, cy, cell * 0.08, 0, Math.PI * 2); ctx.fill(); continue; }
    const col = p.palette.colors[idx];
    ctx.fillStyle = highlight >= 0 && idx !== highlight ? mix(col.rgb, 0.85) : col.hex;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.arc(cx, cy, hole, 0, Math.PI * 2, true); ctx.fill('evenodd');
    if (cell >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = Math.max(0.5, cell / 24);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
  }
  return c;
}

// 导出：标题 + 图纸 + 色号清单，合成一张大图
function exportChart() {
  const p = state.pattern;
  const cell = Math.max(22, Math.min(36, Math.floor(2600 / p.width)));
  const axis = Math.round(cell * 1.2);
  const chart = renderChart(p, { cell, axis, showCodes: true, board: +$('board').value });
  const W = Math.max(chart.width, 900);
  const sw = Math.round(cell * 2.6), sh = Math.round(cell * 1.5), gap = Math.round(cell * 0.5);
  const per = Math.max(1, Math.floor((W - 80 + gap) / (sw + 70 + gap)));
  const rows = Math.ceil(p.legend.length / per);
  const headH = 120, legendH = rows * (sh + gap) + 80;
  const c = document.createElement('canvas');
  c.width = W; c.height = headH + chart.height + legendH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#1d1d1f'; ctx.font = '700 40px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('拼豆图纸', 40, 62);
  ctx.font = '22px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = '#555';
  const mm = p.palette.beadMm;
  ctx.fillText(`${p.palette.label} · ${p.width}×${p.height} 格 · ${p.total} 颗 · ${p.legend.length} 色 · 成品约 ${(p.width * mm / 10).toFixed(1)}×${(p.height * mm / 10).toFixed(1)} cm`, 40, 100);
  ctx.drawImage(chart, Math.round((W - chart.width) / 2), headH);
  let y0 = headH + chart.height + 50;
  ctx.font = '700 26px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = '#1d1d1f';
  ctx.fillText('色号清单', 40, y0); y0 += 24;
  p.legend.forEach((l, i) => {
    const x = 40 + (i % per) * (sw + 70 + gap), y = y0 + Math.floor(i / per) * (sh + gap);
    ctx.fillStyle = l.hex; ctx.fillRect(x, y, sw, sh);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, sw - 1, sh - 1);
    ctx.fillStyle = textColor(l.rgb); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(sh * 0.48)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(l.code, x + sw / 2, y + sh / 2 + 1, sw - 6);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.font = `${Math.round(sh * 0.5)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`× ${l.n}`, x + sw + 8, y + sh / 2 + 1);
  });
  return c;
}

// iPhone / iPad 的 Safari 下载的图片只进「文件」App，进不了相册：改为弹出图片，长按或用分享菜单保存
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function download(canvas, name) {
  canvas.toBlob((b) => saveBlob(b, name), 'image/png');
}

function saveBlob(blob, name) {
  if (isIOS && blob.type.startsWith('image/')) return showSaveSheet(blob, name);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

let saveFile = null;
function showSaveSheet(blob, name) {
  saveFile = new File([blob], name, { type: blob.type });
  $('saveImg').src = setObjectUrl('saveSheet', blob);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [saveFile] }));
  $('saveShare').hidden = !canShare;
  $('saveDialog').showModal();
  track('save_sheet_open');
}

async function downloadPdf() {
  const p = state.pattern; if (!p) return;
  const pitch = Math.min(10, Math.max(2, parseFloat($('pitch').value) || p.palette.beadMm));
  const btn = $('dlPdf'), label = btn.textContent;
  btn.disabled = true;
  try {
    const blob = await buildPrintPdf(p, {
      pitch, board: +$('board').value,
      onProgress: (i, n) => { btn.textContent = `生成中 ${i}/${n}…`; },
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `pindou-print-${p.width}x${p.height}.pdf`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  } catch (e) {
    showError(`PDF 生成失败：${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function downloadCsv() {
  const p = state.pattern;
  const rows = [['色号', 'HEX', '数量'], ...p.legend.map((l) => [l.code, l.hex, l.n]), ['合计', '', p.total]];
  const blob = new Blob(['﻿' + rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'pindou-colors.csv'; a.click();
}

// 同一个位置换图时回收上一个 blob URL，避免翻看作品时内存一直涨
const objectUrls = {};
function setObjectUrl(key, blob) {
  if (objectUrls[key]) URL.revokeObjectURL(objectUrls[key]);
  objectUrls[key] = URL.createObjectURL(blob);
  if (key === 'srcPreview') $('srcPreview').src = objectUrls[key];
  return objectUrls[key];
}

const dlProps = (kind) => ({ kind, palette: $('palette').value, w: state.pattern?.width, h: state.pattern?.height, colors: state.pattern?.legend.length, mode: state.lastMode || '' });

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

init();
