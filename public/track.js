// 自建埋点：事件批量上报到 /api/t，同时累计页面在前台的停留秒数。
// 只记匿名 ID（服务端从 Cookie 取）和操作，不采集照片、描述内容等个人信息。

const sid = (() => {
  try {
    let v = sessionStorage.getItem('pd_sid');
    if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join(''); sessionStorage.setItem('pd_sid', v); }
    return v;
  } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();

const device = matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';

// 来源：链接上的 from / utm_source 参数优先，其次是来源网站域名
const source = (() => {
  const q = new URLSearchParams(location.search);
  const tag = q.get('from') || q.get('utm_source');
  if (tag) return tag.slice(0, 40);
  try {
    const h = document.referrer && new URL(document.referrer).hostname;
    if (h && h !== location.hostname) return h.replace(/^www\./, '');
  } catch {}
  return null;
})();

const queue = [];
let active = 0;       // 自上次上报以来在前台的秒数
let lastTick = Date.now();
const once = new Set();

// 每秒累计前台时间（页面在后台时不计）
setInterval(() => {
  const now = Date.now();
  if (document.visibilityState === 'visible') active += Math.min(2, (now - lastTick) / 1000);
  lastTick = now;
}, 1000);

export function track(name, props) {
  queue.push({ n: name, p: props || undefined, t: Date.now() });
  if (queue.length >= 20) flush();
}

// 每个会话只记一次的事件（例如第一次修改提示词）
export function trackOnce(name, props) {
  if (once.has(name)) return;
  once.add(name);
  track(name, props);
}

function payload() {
  const body = JSON.stringify({ sid, device, source, active: Math.round(active), events: queue.splice(0, 50) });
  active = 0;
  return body;
}

function flush(useBeacon = false) {
  if (!queue.length && active < 1) return;
  const body = payload();
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon('api/t', new Blob([body], { type: 'text/plain' }));
    return;
  }
  fetch('api/t', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
}

setInterval(() => flush(), 15_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
addEventListener('pagehide', () => flush(true));

track('page_view', { device, source: source || '' });
