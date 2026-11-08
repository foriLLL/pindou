// 防滥用：真实 IP、请求频率限制、工作量证明（PoW）、每日额度。
import crypto from 'node:crypto';

// 服务应只监听 127.0.0.1，前面放一个反向代理（如 Caddy / Nginx），由它把真实客户端 IP 写入 X-Forwarded-For。
// 取最后一段：反向代理追加的那一段，客户端伪造不了。
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',').pop().trim();
  return req.socket.remoteAddress || 'unknown';
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
export function makePow(secret, bits) {
  const used = new Map(); // salt -> 过期时间，防重放
  setInterval(() => { const now = Date.now(); for (const [s, e] of used) if (e < now) used.delete(s); }, 60_000).unref();
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22);
  return {
    issue(userId) {
      const salt = crypto.randomBytes(12).toString('base64url');
      const exp = Date.now() + 10 * 60_000;
      const body = `${salt}.${bits}.${exp}.${userId}`;
      return { salt, bits, exp, token: `${salt}.${bits}.${exp}.${sign(body)}` };
    },
    verify(header, userId) {
      if (!header) return '缺少验证信息，请刷新页面后重试';
      const [salt, b, exp, sig, nonce] = String(header).split('.');
      if (!nonce || sign(`${salt}.${b}.${exp}.${userId}`) !== sig) return '验证信息无效，请刷新页面后重试';
      if (+exp < Date.now()) return '验证已过期，请重试';
      if (used.has(salt)) return '验证信息已使用，请重试';
      const h = crypto.createHash('sha256').update(salt + nonce).digest();
      if (leadingZeroBits(h) < +b || +b < bits) return '验证未通过，请重试';
      used.set(salt, +exp);
      return null;
    },
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
