// 拼豆图纸站后端：零依赖 Node 24。
// 负责静态文件、用户 ID、生图任务（持久化）、防滥用；拼豆转换在浏览器完成。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRESETS, MAX_STYLE, MAX_SUBJECT, buildPrompt } from './lib/prompts.mjs';
import { openStore } from './lib/store.mjs';
import { clientIp, makeLimiter, makeDailyCounter, makePow, dayStart } from './lib/guard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
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
const MB = 1024 * 1024;
const MAX_UPLOAD = 5 * MB;        // 前端会先把照片缩到长边 1536 的 JPEG，通常 < 1MB
const MAX_JSON = 16 * 1024;
const MAX_HEIC = 15 * MB;
const MAX_RESULT = 20 * MB;       // 上游返回图片的大小上限
// 额度与限流（都可用环境变量调整）
const LIMIT = {
  running: +env('MAX_RUNNING', 3),        // 同时在生成的任务数（全站）
  queue: +env('MAX_QUEUE', 20),           // 排队上限（全站）
  userActive: +env('USER_ACTIVE', 2),     // 每个 ID 同时进行中的任务
  userDaily: +env('USER_DAILY', 20),      // 每个 ID 每天生成次数
  ipDaily: +env('IP_DAILY', 40),          // 每个 IP 每天生成次数（防止换 ID 刷）
  globalDaily: +env('GLOBAL_DAILY', 200), // 全站每天生成次数（成本兜底）
  userFailDaily: +env('USER_FAIL_DAILY', 10), // 失败不计入生成次数，但单独限制，防止拿失败任务反复刷
  ipFailDaily: +env('IP_FAIL_DAILY', 20),
  newUsersPerIp: +env('NEW_USERS_PER_IP', 10),
  convertPerIp: +env('CONVERT_PER_IP', 30),
  convertConcurrent: 2,
  switchFailPerIp: +env('SWITCH_FAIL_PER_IP', 20),
  powBits: +env('POW_BITS', 18),
  srcKeepDays: +env('SRC_KEEP_DAYS', 30),
  minFreeMB: +env('MIN_FREE_MB', 500),    // 磁盘剩余低于此值时拒绝新的照片任务
};
if (!API_KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const store = openStore(DATA_DIR);
const pow = makePow(env('POW_SECRET', crypto.randomBytes(32).toString('hex')), LIMIT.powBits);
const apiLimit = makeLimiter({ rate: 5, burst: 40 });   // 每 IP 每秒 5 个 API 请求，可突发 40
const daily = makeDailyCounter();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// ---------- 生图 ----------
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

class UpstreamError extends Error {
  constructor(kind, detail, retry = false, wait = 0) { super(detail); this.kind = kind; this.retry = retry; this.wait = wait; }
}
// 给用户看的固定文案；上游原始报错只写服务端日志（可能含账号、额度、中转信息）
const USER_MESSAGE = {
  timeout: '生图超时，请重试',
  busy: 'AI 服务繁忙，请稍后重试',
  rejected: '这张图或描述没有通过 AI 服务的内容审核，换一张试试',
  bad: 'AI 服务返回的结果有问题，请重试',
  other: '生成失败，请稍后重试',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadResult(url) {
  let u;
  try { u = new URL(url); } catch { throw new UpstreamError('bad', 'invalid image url'); }
  if (u.protocol !== 'https:') throw new UpstreamError('bad', `refuse non-https image url ${u.protocol}`);
  const r = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  if (!r.ok) throw new UpstreamError('bad', `image url HTTP ${r.status}`);
  if (+r.headers.get('content-length') > MAX_RESULT) throw new UpstreamError('bad', 'image too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_RESULT) throw new UpstreamError('bad', 'image too large');
  return buf;
}

// 一次调用：成功返回图片；失败抛 UpstreamError（retry 表示可以重试，wait 为建议等待毫秒数）
async function callOnce(job, body) {
  const isText = job.mode === 'text';
  let res;
  try {
    res = await fetch(`${BASE_URL}/images/${isText ? 'generations' : 'edits'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new UpstreamError('timeout', 'upstream timeout');
    throw new UpstreamError('busy', `network: ${e.message}`, true); // 网络错误：可以重试
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data?.data?.[0]) {
    const msg = data?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    if (res.status === 429) {
      const wait = Math.min(15_000, (+res.headers.get('retry-after') || 5) * 1000);
      throw new UpstreamError('busy', `429 ${msg}`, true, wait);
    }
    if (res.status >= 500) throw new UpstreamError('busy', `${res.status} ${msg}`, true, 2000);
    const rejected = /safety|moderation|content[_ ]?policy|rejected|not allowed|violat/i.test(msg);
    throw new UpstreamError(rejected ? 'rejected' : 'other', `${res.status} ${msg}`);
  }
  const meta = {
    inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens, size: data.size,
    headers: LOG_HEADERS.map((k) => `${k}=${res.headers.get(k)}`).join(' '),
  };
  const item = data.data[0];
  // 生成已经完成并计费：后面的下载/校验失败不再重新生成
  let image;
  if (item.b64_json) image = Buffer.from(item.b64_json, 'base64');
  else if (item.url) {
    try { image = await downloadResult(item.url); } catch (e) { throw e instanceof UpstreamError ? e : new UpstreamError('bad', `download: ${e.message}`); }
  } else throw new UpstreamError('bad', 'no image in response');
  if (!sniffMime(image)) throw new UpstreamError('bad', 'result is not an image');
  return { image, meta };
}

async function callModel(job, src) {
  const body = {
    model: job.model,
    prompt: buildPrompt(job),
    ...(job.mode === 'text' ? {} : { images: [{ image_url: `data:${job.src_mime};base64,${src.toString('base64')}` }] }),
    size: '1024x1024',
    quality: 'medium', // 实测像素图 low 与 medium 差别不大；部分中转服务会忽略该参数
  };
  try {
    return await callOnce(job, body);
  } catch (e) {
    if (!(e instanceof UpstreamError) || !e.retry) throw e;
    await sleep(e.wait || 1000); // 只对网络错误 / 5xx / 429 重试一次
    return callOnce(job, body);
  }
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
        const kept = store.setDone(id, image, meta);
        console.log(`[job] done ${job.model} ${Math.round((Date.now() - t0) / 1000)}s in=${meta.inTok} out=${meta.outTok} ${meta.size}${kept ? '' : ' (deleted, discarded)'} ${meta.headers}`.trimEnd());
      })
      .catch((e) => {
        const kind = e instanceof UpstreamError ? e.kind : 'other';
        try { store.setError(id, USER_MESSAGE[kind]); } catch (e2) { console.error('[job] setError', e2.message); }
        console.error(`[job ${id}] ${kind}: ${e.message}`);
      })
      .finally(() => { running--; pump(); });
  }
}

// 服务重启后，把未完成的任务重新排队
for (const j of store.pending()) {
  if (j.status === 'running') store.db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(j.id);
  queue.push(j.id);
}
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
  if (buf.length < 12 || buf.subarray(4, 8).toString() !== 'ftyp') return false;
  return ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'heif', 'avif'].includes(buf.subarray(8, 12).toString());
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
    fs.promises.rm(inp, { force: true }).catch(() => {});
    fs.promises.rm(out, { force: true }).catch(() => {});
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

// 生成前的额度检查（必须和入库处在同一个同步段里，中间不能有 await，否则并发请求会一起通过）
function checkQuota(userId, ip, isPhoto) {
  const t = dayStart();
  if (store.activeOfUser(userId) >= LIMIT.userActive) return [429, `你已有 ${LIMIT.userActive} 张图在生成，请等它们完成`];
  if (store.countUserSince(userId, t) >= LIMIT.userDaily) return [429, `今天的 ${LIMIT.userDaily} 次生成已用完，明天再来吧`];
  if (store.countIpSince(ip, t) >= LIMIT.ipDaily) return [429, '当前网络今天的生成次数已用完，明天再来吧'];
  if (store.errorsUserSince(userId, t) >= LIMIT.userFailDaily || store.errorsIpSince(ip, t) >= LIMIT.ipFailDaily) return [429, '今天失败的次数太多了，明天再试吧'];
  if (store.countAllSince(t) >= LIMIT.globalDaily) return [503, '今天全站的生成额度已用完，明天再来吧'];
  if (queue.length >= LIMIT.queue) return [429, '排队人数过多，请稍后再试'];
  if (isPhoto && store.freeBytes() < LIMIT.minFreeMB * MB) return [507, '服务器存储空间不足，请稍后再试'];
  return null;
}

// ---------- HTTP ----------
const STATIC = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

class TooLarge extends Error {}
// 读请求体；超限时不再收集、把剩余数据丢掉，读完再报错，这样 413 能正常送到客户端
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new TooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
function tooLarge(res, what) { send(res, 413, { error: `${what}太大了` }, undefined, { Connection: 'close' }); }
const isJsonReq = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '');
const parseJson = (buf) => { try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

// 写操作只接受本站页面发起的请求（防止别的网站用表单替用户切换 ID 等）
function sameSite(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

function sendImageFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: '文件不存在' });
    send(res, 200, data, sniffMime(data) || 'application/octet-stream', { 'Cache-Control': cache });
  });
}

function jobView(j) {
  return {
    id: j.id, mode: j.mode, status: j.status, error: j.error,
    ahead: j.status === 'queued' ? queue.indexOf(j.id) : -1,
    elapsed: Math.round(((j.finished_at || Date.now()) - (j.started_at || j.created_at)) / 1000),
    style: j.style, subject: j.subject, hasSrc: !!j.src_mime, hasThumb: !!j.has_thumb, params: j.params ? JSON.parse(j.params) : null,
    createdAt: j.created_at,
  };
}

async function createJob(req, res, url, userId, ip, from) {
  const proof = req.headers['x-pow'];
  const bad = pow.check(proof, userId);
  if (bad) return send(res, 403, { error: bad });
  const json = isJsonReq(req);
  if (!from && !json && !/^image\//i.test(req.headers['content-type'] || '')) return send(res, 415, { error: '请求格式不对，请刷新页面后重试' });
  if (from && !json) return send(res, 415, { error: '请求格式不对，请刷新页面后重试' });
  let buf;
  try { buf = await readBody(req, json ? MAX_JSON : MAX_UPLOAD); } catch (e) { return e instanceof TooLarge ? tooLarge(res, json ? '内容' : '图片') : undefined; }

  // ---- 以下必须同步执行：校验 → 额度检查 → 入库，中间不能出现 await ----
  const model = MODELS[0]; // 模型固定，不接受用户指定
  const style = (url.searchParams.get('style') || '').trim().slice(0, MAX_STYLE) || PRESETS[0].prompt;
  let job;
  if (from) {
    // 基于历史任务重新生成：照片模式复用保存的原图，文字模式可以带新描述
    const body = parseJson(buf) || {};
    if (from.mode === 'photo') {
      const src = store.readSrc(from);
      if (!src) return send(res, 410, { error: `原图已过期（只保留 ${LIMIT.srcKeepDays} 天），请重新上传` });
      job = { mode: 'photo', src, srcMime: from.src_mime };
    } else {
      const subject = String(body.subject ?? from.subject ?? '').trim().slice(0, MAX_SUBJECT);
      if (!subject) return send(res, 400, { error: '请先写下想画的内容' });
      job = { mode: 'text', subject };
    }
  } else if (json) {
    const subject = String(parseJson(buf)?.subject || '').trim().slice(0, MAX_SUBJECT);
    if (!subject) return send(res, 400, { error: '请先写下想画的内容' });
    job = { mode: 'text', subject };
  } else {
    const mime = sniffMime(buf);
    if (!mime) return send(res, 400, { error: '只支持 PNG / JPEG / WebP 图片' });
    job = { mode: 'photo', src: buf, srcMime: mime };
  }
  const used = pow.consume(proof, userId);
  if (used) return send(res, 403, { error: used });
  const q = checkQuota(userId, ip, job.mode === 'photo');
  if (q) return send(res, q[0], { error: q[1] });
  const id = crypto.randomUUID();
  try {
    store.addJob({ id, userId, ip, model, style, ...job });
  } catch (e) {
    console.error('[addJob]', e.message);
    return send(res, 507, { error: '服务器暂时无法保存图片，请稍后再试' });
  }
  queue.push(id);
  pump();
  return send(res, 202, jobView(store.getJob(id)));
}

function deleteJob(job) {
  if (job.status === 'queued') {
    // 还没开始：直接取消（仍计入当天次数，防止“提交-删除”反复刷）
    const i = queue.indexOf(job.id);
    if (i >= 0) queue.splice(i, 1);
    store.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), job.id);
  }
  // 正在生成的任务不能中途撤回上游请求：标记删除，完成时丢弃结果，并照常占用并发名额直到结束
  store.deleteJob(job);
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request', 'text/plain'); }
  const p = url.pathname;
  const ip = clientIp(req);

  if (p.startsWith('/api/')) {
    if (!apiLimit(ip)) return send(res, 429, { error: '请求太频繁，请稍后再试' }, undefined, { 'Retry-After': '5' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameSite(req)) return send(res, 403, { error: '请从本站页面操作' });
  }

  if (p === '/api/config' && req.method === 'GET') {
    // 模型和固定技术提示词不对用户开放
    return send(res, 200, { presets: PRESETS.map(({ id, name, demo, prompt }) => ({ id, name, demo, prompt })), maxStyle: MAX_STYLE, maxSubject: MAX_SUBJECT, srcKeepDays: LIMIT.srcKeepDays });
  }

  // 当前用户：有 Cookie 用 Cookie；没有则尝试用浏览器本地记住的 ID 恢复；都没有就新建
  if (p === '/api/me' && req.method === 'GET') {
    let uid = cookieUser(req);
    const restore = url.searchParams.get('restore');
    if (!uid && restore && daily.get(`sw:${ip}`) < LIMIT.switchFailPerIp) {
      const id = normId(restore);
      if (id.length === 10 && store.getUser(id)) uid = id;
      else daily.hit(`sw:${ip}`); // 恢复失败和切换失败共用一个计数
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
    if (!isJsonReq(req)) return send(res, 415, { error: '请求格式不对' });
    if (daily.get(`sw:${ip}`) >= LIMIT.switchFailPerIp) return send(res, 429, { error: '尝试次数太多，明天再试' });
    let buf;
    try { buf = await readBody(req, MAX_JSON); } catch (e) { return e instanceof TooLarge ? tooLarge(res, '内容') : undefined; }
    const id = normId(parseJson(buf)?.id);
    if (id.length !== 10 || !store.getUser(id)) { daily.hit(`sw:${ip}`); return send(res, 404, { error: '这个 ID 不存在，请检查是否输错' }); }
    store.touchUser(id);
    setUserCookie(req, res, id);
    return send(res, 200, { id, usage: usage(id, ip) });
  }

  // 以下接口都需要用户 ID
  const uid = p.startsWith('/api/') ? cookieUser(req) : null;
  const needUser = () => { if (!uid) { send(res, 401, { error: '请刷新页面后重试' }); return false; } return true; };

  if (p === '/api/pow' && req.method === 'GET') {
    if (!needUser()) return;
    return send(res, 200, pow.issue(uid));
  }

  if (p === '/api/history' && req.method === 'GET') {
    if (!needUser()) return;
    const items = store.history(uid).map(({ model, ...j }) => ({ ...j, has_src: !!j.has_src }));
    return send(res, 200, { items, usage: usage(uid, ip) });
  }

  if (p === '/api/jobs' && req.method === 'POST') {
    if (!needUser()) return;
    return await createJob(req, res, url, uid, ip, null);
  }

  const m = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(image|thumb|params|rerun))?$/);
  if (m) {
    if (!needUser()) return;
    const job = store.getJob(m[1]);
    if (!job || job.user_id !== uid) return send(res, 404, { error: '作品不存在或已删除' });
    const sub = m[2];
    if (!sub && req.method === 'GET') return send(res, 200, jobView(job));
    if (!sub && req.method === 'DELETE') { deleteJob(job); return send(res, 200, { ok: true }); }
    if (sub === 'image' && req.method === 'GET') {
      if (job.status !== 'done') return send(res, 409, { error: '图片尚未生成' });
      return sendImageFile(res, store.imagePath(job.id), 'private, max-age=86400, immutable');
    }
    if (sub === 'thumb' && req.method === 'GET') {
      if (!job.has_thumb) return send(res, 404, { error: 'no thumb' });
      return sendImageFile(res, store.thumbPath(job.id), 'private, max-age=86400');
    }
    if (sub === 'thumb' && req.method === 'PUT') {
      let buf;
      try { buf = await readBody(req, 200 * 1024); } catch (e) { return e instanceof TooLarge ? tooLarge(res, '缩略图') : undefined; }
      if (sniffMime(buf) !== 'image/webp') return send(res, 400, { error: 'webp only' });
      store.saveThumb(job.id, buf);
      return send(res, 200, { ok: true });
    }
    if (sub === 'params' && req.method === 'PUT') {
      if (!isJsonReq(req)) return send(res, 415, { error: 'json only' });
      let buf;
      try { buf = await readBody(req, 2048); } catch (e) { return e instanceof TooLarge ? tooLarge(res, '参数') : undefined; }
      const body = parseJson(buf);
      if (!body) return send(res, 400, { error: 'bad params' });
      store.setParams(job.id, JSON.stringify(body));
      return send(res, 200, { ok: true });
    }
    if (sub === 'rerun' && req.method === 'POST') return await createJob(req, res, url, uid, ip, job);
    return send(res, 405, { error: 'method not allowed' });
  }

  if (p === '/api/convert' && req.method === 'POST') {
    if (!needUser()) return;
    if (converting >= LIMIT.convertConcurrent) return send(res, 429, { error: '转换繁忙，请稍后再试' });
    if (daily.hit(`cv:${ip}`) > LIMIT.convertPerIp) return send(res, 429, { error: '今天的 HEIC 转换次数已用完' });
    converting++; // 先占名额再读请求体，慢速上传也算在并发里
    try {
      let buf;
      try { buf = await readBody(req, MAX_HEIC); } catch (e) { return e instanceof TooLarge ? tooLarge(res, '图片') : undefined; }
      if (!isHeif(buf)) return send(res, 400, { error: '无法识别的图片格式，请换成 JPG / PNG' });
      try { return send(res, 200, await convertHeif(buf), 'image/jpeg'); }
      catch (e) { console.error('[convert]', e.message); return send(res, 422, { error: 'HEIC 转换失败，请在手机上导出为 JPG 后再上传' }); }
    } finally { converting--; }
  }

  if (p === '/healthz') return send(res, 200, { ok: true, running, queued: queue.length });
  if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  let rel;
  try { rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''); } catch { return send(res, 400, 'bad request', 'text/plain'); }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  // 静态文件每次都向服务器确认（没变就回 304），更新后用户刷新立即生效
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const extra = { 'Cache-Control': 'no-cache', ETag: etag, ...(file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {}) };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...SECURITY_HEADERS, ...extra }); return res.end(); }
  const data = await fs.promises.readFile(file).catch(() => null);
  if (!data) return send(res, 404, 'not found', 'text/plain');
  return send(res, 200, data, STATIC[path.extname(file)] || 'application/octet-stream', extra);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[request]', e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.destroy();
  });
});
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.requestTimeout = 120_000;
server.headersTimeout = 20_000;
server.listen(PORT, HOST, () => console.log(`pindou listening on http://${HOST}:${PORT} data=${DATA_DIR} limits=${JSON.stringify(LIMIT)}`));
