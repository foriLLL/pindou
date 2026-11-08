// 拼豆图纸站后端：零依赖 Node 24。
// 负责静态文件、用户 ID、生图任务（持久化）、防滥用；拼豆转换在浏览器完成。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { PRESETS, MAX_STYLE, MAX_SUBJECT, buildPrompt } from './lib/prompts.mjs';
import { openStore } from './lib/store.mjs';
import { clientIp, makeLimiter, makeDailyCounter, makePow, dayStart } from './lib/guard.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const env = (k, d) => process.env[k] ?? d;

const PORT = +env('PORT', 8645);
const HOST = env('HOST', '127.0.0.1');
const BASE_URL = env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, '');
// 可选：要记录到日志的上游响应头（逗号分隔），用于观察额度/限流，例如 x-ratelimit-remaining-requests
const LOG_HEADERS = env('LOG_HEADERS', '').split(',').map((s) => s.trim()).filter(Boolean);
const API_KEY = env('OPENAI_API_KEY');
const MODELS = env('IMAGE_MODELS', 'gpt-image-2.5-flare,gpt-image-2.5-sunburst').split(',');
const DATA_DIR = env('DATA_DIR', path.join(ROOT, 'data'));
const MAX_UPLOAD = 12 * 1024 * 1024;
// 额度与限流（都可用环境变量调整）
const LIMIT = {
  running: +env('MAX_RUNNING', 3),        // 同时在生成的任务数（全站）
  queue: +env('MAX_QUEUE', 20),           // 排队上限（全站）
  userActive: +env('USER_ACTIVE', 2),     // 每个 ID 同时进行中的任务
  userDaily: +env('USER_DAILY', 20),      // 每个 ID 每天生成次数
  ipDaily: +env('IP_DAILY', 40),          // 每个 IP 每天生成次数（防止换 ID 刷）
  globalDaily: +env('GLOBAL_DAILY', 200), // 全站每天生成次数（成本兜底）
  newUsersPerIp: +env('NEW_USERS_PER_IP', 10),
  convertPerIp: +env('CONVERT_PER_IP', 30),
  switchFailPerIp: +env('SWITCH_FAIL_PER_IP', 20),
  powBits: +env('POW_BITS', 18),
  srcKeepDays: +env('SRC_KEEP_DAYS', 30),
};
if (!API_KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const store = openStore(DATA_DIR);
const pow = makePow(env('POW_SECRET', crypto.randomBytes(32).toString('hex')), LIMIT.powBits);
const apiLimit = makeLimiter({ rate: 5, burst: 40 });   // 每 IP 每秒 5 个 API 请求，可突发 40
const daily = makeDailyCounter();

// ---------- 生图 ----------
function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function callModel(job, src) {
  const isText = job.mode === 'text';
  const body = {
    model: job.model,
    prompt: buildPrompt(job),
    ...(isText ? {} : { images: [{ image_url: `data:${job.src_mime};base64,${src.toString('base64')}` }] }),
    size: '1024x1024',
    quality: 'medium', // 实测像素图 low 与 medium 差别不大；部分中转服务会忽略该参数
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/images/${isText ? 'generations' : 'edits'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`上游返回非 JSON（HTTP ${res.status}）`); }
      if (!res.ok || !data.data?.[0]) {
        const err = new Error(`生图失败：${data.error?.message || `HTTP ${res.status}`}`);
        err.retry = res.status >= 500 || res.status === 429;
        throw err;
      }
      const meta = {
        inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens, size: data.size,
        headers: LOG_HEADERS.map((k) => `${k}=${res.headers.get(k)}`).join(' '),
      };
      const item = data.data[0];
      if (item.b64_json) return { image: Buffer.from(item.b64_json, 'base64'), meta };
      if (item.url) return { image: Buffer.from(await (await fetch(item.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer()), meta };
      throw new Error('上游没有返回图片');
    } catch (e) {
      lastErr = e;
      if (e.retry === false || e.name === 'TimeoutError') break; // 只对网络错误 / 5xx / 429 重试一次
    }
  }
  throw lastErr;
}

const queue = []; // 等待中的任务 id
let running = 0;

function pump() {
  while (running < LIMIT.running && queue.length) {
    const id = queue.shift();
    const job = store.getJob(id);
    if (!job || job.status !== 'queued') continue;
    const src = job.mode === 'photo' ? store.readSrc(job) : null;
    if (job.mode === 'photo' && !src) { store.setError(id, '原图已丢失'); continue; }
    running++;
    store.setRunning(id);
    const t0 = Date.now();
    callModel(job, src)
      .then(({ image, meta }) => {
        store.setDone(id, image, meta);
        console.log(`[job] done ${job.model} ${Math.round((Date.now() - t0) / 1000)}s in=${meta.inTok} out=${meta.outTok} ${meta.size} ${meta.headers}`.trimEnd());
      })
      .catch((e) => {
        store.setError(id, e.name === 'TimeoutError' ? '生图超时，请重试' : e.message);
        console.error(`[job ${id}]`, e.message);
      })
      .finally(() => { running--; pump(); });
  }
}

// 服务重启后，把未完成的任务重新排队
for (const j of store.pending()) queue.push(j.id);
for (const j of store.pending()) if (j.status === 'running') store.db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(j.id);
pump();

// 维护：每小时清理过期原图，每天备份数据库
const maintain = () => {
  try {
    const n = store.purgeOldSources(LIMIT.srcKeepDays);
    if (n) console.log(`[maintain] purged ${n} old source images`);
    store.backup();
  } catch (e) { console.error('[maintain]', e.message); }
};
setTimeout(maintain, 10_000).unref();
setInterval(maintain, 3600_000).unref();

// ---------- HEIC 转换 ----------
function isHeif(buf) {
  if (buf.length < 12 || buf.slice(4, 8).toString() !== 'ftyp') return false;
  return ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'heif', 'avif'].includes(buf.slice(8, 12).toString());
}
let converting = 0;
async function convertHeif(buf) {
  const base = path.join(os.tmpdir(), `pindou-${crypto.randomUUID()}`);
  const inp = `${base}.heic`, out = `${base}.jpg`;
  await fs.promises.writeFile(inp, buf);
  try {
    await new Promise((resolve, reject) => execFile('heif-dec', ['-q', '92', inp, out], { timeout: 30_000 }, (err) => err ? reject(err) : resolve()));
    return await fs.promises.readFile(out);
  } finally {
    fs.promises.rm(inp, { force: true }); fs.promises.rm(out, { force: true });
  }
}

// ---------- 用户 ID ----------
const COOKIE = 'pd_uid';
const normId = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
function cookieUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pd_uid=([0-9A-Z]{10})/);
  return m && store.getUser(m[1]) ? m[1] : null;
}
function setUserCookie(req, res, id) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  // 服务端下发的第一方 Cookie（不是 JS 写的），Safari 不会 7 天清除；400 天为浏览器允许的上限
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; Max-Age=34560000; SameSite=Lax; HttpOnly${secure}`);
}
function usage(userId, ip) {
  const t = dayStart();
  return {
    today: store.countUserSince(userId, t), userDaily: LIMIT.userDaily,
    ipToday: store.countIpSince(ip, t), ipDaily: LIMIT.ipDaily,
  };
}

// 生成前的额度检查，返回错误信息或 null
function checkQuota(userId, ip) {
  const t = dayStart();
  if (store.activeOfUser(userId) >= LIMIT.userActive) return [429, `你已有 ${LIMIT.userActive} 张图在生成，请等它们完成`];
  if (store.countUserSince(userId, t) >= LIMIT.userDaily) return [429, `今天的 ${LIMIT.userDaily} 次生成已用完，明天再来吧`];
  if (store.countIpSince(ip, t) >= LIMIT.ipDaily) return [429, '当前网络今天的生成次数已用完，明天再来吧'];
  if (store.countAllSince(t) >= LIMIT.globalDaily) return [503, '今天全站的生成额度已用完，明天再来吧'];
  if (queue.length >= LIMIT.queue) return [429, '排队人数过多，请稍后再试'];
  return null;
}

// ---------- HTTP ----------
const STATIC = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 16 * 1024) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8')); } catch { return null; }
}

function sendFile(res, file, type, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: '文件不存在' });
    send(res, 200, data, type, { 'Cache-Control': cache });
  });
}

function jobView(j) {
  return {
    id: j.id, mode: j.mode, model: j.model, status: j.status, error: j.error,
    ahead: j.status === 'queued' ? queue.indexOf(j.id) : -1,
    elapsed: Math.round(((j.finished_at || Date.now()) - (j.started_at || j.created_at)) / 1000),
    style: j.style, subject: j.subject, hasSrc: !!j.src_mime, hasThumb: !!j.has_thumb, params: j.params ? JSON.parse(j.params) : null,
    createdAt: j.created_at,
  };
}

async function createJob(req, res, url, userId, ip, from) {
  const bad = pow.verify(req.headers['x-pow'], userId);
  if (bad) return send(res, 403, { error: bad });
  const q = checkQuota(userId, ip);
  if (q) return send(res, q[0], { error: q[1] });
  const model = MODELS[0]; // 模型固定，不接受用户指定
  const style = (url.searchParams.get('style') || '').trim().slice(0, MAX_STYLE) || PRESETS[0].prompt;
  let job;
  if (from) {
    // 基于历史任务重新生成：照片模式复用保存的原图，文字模式可以带新描述
    const body = (await readJson(req)) || {};
    if (from.mode === 'photo') {
      const src = store.readSrc(from);
      if (!src) return send(res, 410, { error: `原图已过期（只保留 ${LIMIT.srcKeepDays} 天），请重新上传` });
      job = { mode: 'photo', src, srcMime: from.src_mime };
    } else {
      const subject = String(body.subject ?? from.subject ?? '').trim().slice(0, MAX_SUBJECT);
      if (!subject) return send(res, 400, { error: '请先写下想画的内容' });
      job = { mode: 'text', subject };
    }
  } else {
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD); } catch { return send(res, 413, { error: '图片太大（上限 12MB）' }); }
    if ((req.headers['content-type'] || '').startsWith('application/json')) {
      let subject = '';
      try { subject = String(JSON.parse(buf.toString('utf8')).subject || '').trim().slice(0, MAX_SUBJECT); } catch {}
      if (!subject) return send(res, 400, { error: '请先写下想画的内容' });
      job = { mode: 'text', subject };
    } else {
      const mime = sniffMime(buf);
      if (!mime) return send(res, 400, { error: '只支持 PNG / JPEG / WebP 图片' });
      job = { mode: 'photo', src: buf, srcMime: mime };
    }
  }
  const id = crypto.randomUUID();
  store.addJob({ id, userId, ip, model, style, ...job });
  queue.push(id);
  pump();
  return send(res, 202, jobView(store.getJob(id)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);
  try {
    if (p.startsWith('/api/')) {
      if (!apiLimit(ip)) return send(res, 429, { error: '请求太频繁，请稍后再试' }, undefined, { 'Retry-After': '5' });
    }

    if (p === '/api/config' && req.method === 'GET') {
      // 模型和固定技术提示词不对用户开放
      return send(res, 200, { presets: PRESETS.map(({ id, name, demo, prompt }) => ({ id, name, demo, prompt })), maxStyle: MAX_STYLE, maxSubject: MAX_SUBJECT, srcKeepDays: LIMIT.srcKeepDays });
    }

    // 当前用户：有 Cookie 用 Cookie；没有则尝试用浏览器本地记住的 ID 恢复；都没有就新建
    if (p === '/api/me' && req.method === 'GET') {
      let uid = cookieUser(req);
      if (!uid) {
        const restore = normId(url.searchParams.get('restore'));
        if (restore.length === 10 && store.getUser(restore)) uid = restore;
      }
      if (!uid) {
        if (store.usersByIpSince(ip, dayStart()) >= LIMIT.newUsersPerIp) return send(res, 429, { error: '当前网络今天新建的 ID 太多了，请用已有 ID' });
        uid = store.newUserId();
        store.addUser(uid, ip);
      }
      store.touchUser(uid);
      setUserCookie(req, res, uid);
      return send(res, 200, { id: uid, usage: usage(uid, ip) });
    }

    if (p === '/api/me/switch' && req.method === 'POST') {
      if (daily.get(`sw:${ip}`) >= LIMIT.switchFailPerIp) return send(res, 429, { error: '尝试次数太多，明天再试' });
      const id = normId((await readJson(req))?.id);
      if (id.length !== 10 || !store.getUser(id)) { daily.hit(`sw:${ip}`); return send(res, 404, { error: '这个 ID 不存在，请检查是否输错' }); }
      store.touchUser(id);
      setUserCookie(req, res, id);
      return send(res, 200, { id, usage: usage(id, ip) });
    }

    // 以下接口都需要用户 ID
    const uid = p.startsWith('/api/') && p !== '/api/convert' ? cookieUser(req) : null;
    const needUser = () => { if (!uid) { send(res, 401, { error: '请刷新页面后重试' }); return false; } return true; };

    if (p === '/api/pow' && req.method === 'GET') {
      if (!needUser()) return;
      return send(res, 200, pow.issue(uid));
    }

    if (p === '/api/history' && req.method === 'GET') {
      if (!needUser()) return;
      return send(res, 200, { items: store.history(uid).map((j) => ({ ...j, has_src: !!j.has_src })), usage: usage(uid, ip) });
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      if (!needUser()) return;
      return createJob(req, res, url, uid, ip, null);
    }

    const m = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(image|thumb|params|rerun))?$/);
    if (m) {
      if (!needUser()) return;
      const job = store.getJob(m[1]);
      if (!job || job.user_id !== uid) return send(res, 404, { error: '作品不存在或已删除' });
      const sub = m[2];
      if (!sub && req.method === 'GET') return send(res, 200, jobView(job));
      if (!sub && req.method === 'DELETE') { store.deleteJob(job); return send(res, 200, { ok: true }); }
      if (sub === 'image' && req.method === 'GET') {
        if (job.status !== 'done') return send(res, 409, { error: '图片尚未生成' });
        return sendFile(res, store.imagePath(job.id), 'image/png', 'private, max-age=86400, immutable');
      }
      if (sub === 'thumb' && req.method === 'GET') {
        if (!job.has_thumb) return send(res, 404, { error: 'no thumb' });
        return sendFile(res, store.thumbPath(job.id), 'image/webp', 'private, max-age=86400');
      }
      if (sub === 'thumb' && req.method === 'PUT') {
        let buf;
        try { buf = await readBody(req, 200 * 1024); } catch { return send(res, 413, { error: 'too large' }); }
        if (sniffMime(buf) !== 'image/webp') return send(res, 400, { error: 'webp only' });
        store.saveThumb(job.id, buf);
        return send(res, 200, { ok: true });
      }
      if (sub === 'params' && req.method === 'PUT') {
        const body = await readJson(req, 2048);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'bad params' });
        store.setParams(job.id, JSON.stringify(body));
        return send(res, 200, { ok: true });
      }
      if (sub === 'rerun' && req.method === 'POST') return createJob(req, res, url, uid, ip, job);
      return send(res, 405, { error: 'method not allowed' });
    }

    if (p === '/api/convert' && req.method === 'POST') {
      if (converting >= 2) return send(res, 429, { error: '转换繁忙，请稍后再试' });
      if (daily.hit(`cv:${ip}`) > LIMIT.convertPerIp) return send(res, 429, { error: '今天的 HEIC 转换次数已用完' });
      let buf;
      try { buf = await readBody(req, 30 * 1024 * 1024); } catch { return send(res, 413, { error: '图片太大（上限 30MB）' }); }
      if (!isHeif(buf)) return send(res, 400, { error: '无法识别的图片格式，请换成 JPG / PNG' });
      converting++;
      try { return send(res, 200, await convertHeif(buf), 'image/jpeg'); }
      catch (e) { console.error('[convert]', e.message); return send(res, 422, { error: 'HEIC 转换失败，请在手机上导出为 JPG 后再上传' }); }
      finally { converting--; }
    }

    if (p === '/healthz') return send(res, 200, { ok: true, running, queued: queue.length });
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.join(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
    // 静态文件每次都向服务器确认（没变就回 304），更新后用户刷新立即生效
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      fs.readFile(file, (err2, data) => {
        if (err2) return send(res, 404, 'not found', 'text/plain');
        send(res, 200, data, STATIC[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache', ETag: etag });
      });
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 20_000;
server.listen(PORT, HOST, () => console.log(`pindou listening on http://${HOST}:${PORT} data=${DATA_DIR} limits=${JSON.stringify(LIMIT)}`));
