// 防滥用：真实 IP、请求频率限制、工作量证明（PoW）、每日额度。
import crypto from 'node:crypto';

// 服务应只监听 127.0.0.1，前面放一个反向代理（如 Caddy / Nginx），由它把真实客户端 IP 写入 X-Forwarded-For。
// 只在连接来自本机（反向代理）时才信任 XFF，并取最后一段（代理追加的那一段，客户端伪造不了）。
// IPv6 按 /64 网段计数（一个家庭宽带通常分到整个 /64），IPv4 映射地址还原成 IPv4。
const TRUSTED = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', ...(process.env.TRUST_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean)]);
export function clientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  const raw = TRUSTED.has(peer) && xff ? String(xff).split(',').pop().trim() : peer;
  return normalizeIp(raw);
}
export function normalizeIp(ip) {
  let a = String(ip).replace(/^\[|\]$/g, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a)) a = a.slice(7);
  if (!a.includes(':')) return a;
  // 展开 IPv6，取前 4 组
  const [head, tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// 令牌桶：每个 key 容量 burst，每秒补充 rate 个
export function makeLimiter({ rate, burst }) {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.t > 10 * 60_000) buckets.delete(k);
  }, 60_000).unref();
  return (key, cost = 1) => {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, t: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 1000) * rate);
    b.t = now;
    buckets.set(key, b);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  };
}

// 计数器（按天，Asia/Shanghai）：用于 HEIC 转换次数、切换 ID 失败次数等不入库的计数
export function makeDailyCounter() {
  const m = new Map();
  let day = dayStart();
  return {
    hit(key, n = 1) {
      if (dayStart() !== day) { m.clear(); day = dayStart(); }
      const v = (m.get(key) || 0) + n; m.set(key, v); return v;
    },
    get(key) { return dayStart() === day ? m.get(key) || 0 : 0; },
  };
}

export function dayStart(t = Date.now()) {
  const off = 8 * 3600_000; // 北京时间零点
  return Math.floor((t + off) / 86400_000) * 86400_000 - off;
}

// 工作量证明：生成前浏览器要算出一个 nonce，使 sha256(salt + nonce) 前 bits 位为 0。
// 正常用户无感（约 0.1–1 秒），脚本批量刷接口的成本线性上升；不依赖任何第三方服务，国内可用。
export function makePow(secret, bitsIn) {
  const bits = Math.max(0, Math.min(30, bitsIn | 0)); // 超过 30 位前端几乎解不出来
  const used = new Map(); // salt -> 过期时间，防重放
  setInterval(() => { const now = Date.now(); for (const [s, e] of used) if (e < now) used.delete(s); }, 60_000).unref();
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22);
  const parse = (header, userId) => {
    if (!header) return { err: '缺少验证信息，请刷新页面后重试' };
    const [salt, b, exp, sig, nonce] = String(header).split('.');
    const expect = sign(`${salt}.${b}.${exp}.${userId}`);
    if (!nonce || !sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { err: '验证信息无效，请刷新页面后重试' };
    if (+exp < Date.now()) return { err: '验证已过期，请重试' };
    if (used.has(salt)) return { err: '验证信息已使用，请重试' };
    const h = crypto.createHash('sha256').update(salt + nonce).digest();
    if (leadingZeroBits(h) < +b || +b < bits) return { err: '验证未通过，请重试' };
    return { salt, exp: +exp };
  };
  return {
    bits,
    issue(userId) {
      const salt = crypto.randomBytes(12).toString('base64url');
      const exp = Date.now() + 10 * 60_000;
      const body = `${salt}.${bits}.${exp}.${userId}`;
      return { salt, bits, exp, token: `${salt}.${bits}.${exp}.${sign(body)}` };
    },
    // 只校验，不标记已用（读请求体之前调用）
    check(header, userId) { return parse(header, userId).err || null; },
    // 校验并标记已用（和入库在同一个同步段里调用，防止并发重复使用）
    consume(header, userId) {
      const r = parse(header, userId);
      if (r.err) return r.err;
      used.set(r.salt, r.exp);
      return null;
    },
    verify(header, userId) { return this.consume(header, userId); },
  };
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    n += Math.clz32(byte) - 24;
    break;
  }
  return n;
}
