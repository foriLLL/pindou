// 持久化：SQLite（Node 内置 node:sqlite）存用户和任务记录，图片存在 DATA_DIR 下的文件里。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function openStore(dataDir) {
  for (const d of ['images', 'src', 'thumbs', 'backup']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'pindou.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      created_ip TEXT,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip TEXT,
      mode TEXT NOT NULL,            -- photo | text
      model TEXT NOT NULL,
      style TEXT NOT NULL,
      subject TEXT,
      src_mime TEXT,                 -- 原图类型；原图过期删除后置空
      status TEXT NOT NULL,          -- queued | running | done | error
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      in_tok INTEGER, out_tok INTEGER,
      params TEXT,                   -- 用户最后一次的图纸参数（JSON）
      has_thumb INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS jobs_ip ON jobs(ip, created_at);
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
    -- 埋点：会话（一次打开页面）与事件。只记匿名 ID，不记 IP
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      active_sec INTEGER DEFAULT 0,  -- 页面在前台的累计秒数
      device TEXT,                   -- mobile | desktop
      source TEXT                    -- 来源：utm/from 参数或来源网站域名
    );
    CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      session_id TEXT,
      user_id TEXT,
      name TEXT NOT NULL,
      props TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS events_name ON events(name, ts);
  `);

  const q = (sql) => db.prepare(sql);
  const st = {
    getUser: q('SELECT * FROM users WHERE id = ?'),
    addUser: q('INSERT INTO users (id, created_at, created_ip, last_seen) VALUES (?, ?, ?, ?)'),
    touchUser: q('UPDATE users SET last_seen = ? WHERE id = ?'),
    usersByIpSince: q('SELECT COUNT(*) n FROM users WHERE created_ip = ? AND created_at >= ?'),
    addJob: q(`INSERT INTO jobs (id, user_id, ip, mode, model, style, subject, src_mime, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`),
    getJob: q('SELECT * FROM jobs WHERE id = ? AND deleted = 0'),
    setRunning: q("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?"),
    setDone: q("UPDATE jobs SET status = 'done', finished_at = ?, in_tok = ?, out_tok = ? WHERE id = ?"),
    setError: q("UPDATE jobs SET status = 'error', finished_at = ?, error = ?, src_mime = NULL WHERE id = ?"),
    getAny: q('SELECT * FROM jobs WHERE id = ?'),
    setParams: q('UPDATE jobs SET params = ? WHERE id = ?'),
    setThumb: q('UPDATE jobs SET has_thumb = 1 WHERE id = ?'),
    del: q('UPDATE jobs SET deleted = 1 WHERE id = ?'),
    history: q(`SELECT id, mode, model, style, subject, status, error, created_at, has_thumb, src_mime IS NOT NULL AS has_src
                FROM jobs WHERE user_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT ?`),
    pending: q("SELECT * FROM jobs WHERE status IN ('queued', 'running') AND deleted = 0 ORDER BY created_at"),
    // 计数：失败的任务不算
    countUserSince: q("SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND created_at >= ? AND status != 'error'"),
    countIpSince: q("SELECT COUNT(*) n FROM jobs WHERE ip = ? AND created_at >= ? AND status != 'error'"),
    countAllSince: q("SELECT COUNT(*) n FROM jobs WHERE created_at >= ? AND status != 'error'"),
    // 进行中的任务即使被删除也照样占名额，直到真正结束（上游调用不会因为删除而停止）
    activeOfUser: q("SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')"),
    errorsUserSince: q("SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND created_at >= ? AND status = 'error'"),
    errorsIpSince: q("SELECT COUNT(*) n FROM jobs WHERE ip = ? AND created_at >= ? AND status = 'error'"),
    oldSrc: q('SELECT id, src_mime FROM jobs WHERE src_mime IS NOT NULL AND created_at < ?'),
    getSession: q('SELECT * FROM sessions WHERE id = ?'),
    addSession: q('INSERT INTO sessions (id, user_id, started_at, last_at, active_sec, device, source) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    touchSession: q('UPDATE sessions SET last_at = ?, active_sec = MIN(active_sec + ?, 86400), user_id = ? WHERE id = ?'),
    addEvent: q('INSERT INTO events (ts, session_id, user_id, name, props) VALUES (?, ?, ?, ?, ?)'),
    purgeEvents: q('DELETE FROM events WHERE ts < ?'),
    clearSrc: q('UPDATE jobs SET src_mime = NULL WHERE id = ?'),
  };

  const file = (kind, id, ext) => path.join(dataDir, kind, `${id}.${ext}`);
  const extOf = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime] || 'bin';

  return {
    db,
    // 用户 ID：10 位 Crockford Base32（去掉易混的 I L O U），约 50 bit，猜不到
    newUserId() {
      const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let s = '';
      for (const b of crypto.randomBytes(10)) s += A[b & 31];
      return s;
    },
    getUser: (id) => st.getUser.get(id),
    addUser: (id, ip) => st.addUser.run(id, Date.now(), ip, Date.now()),
    touchUser: (id) => st.touchUser.run(Date.now(), id),
    usersByIpSince: (ip, t) => st.usersByIpSince.get(ip, t).n,

    // 先写原图再入库：写盘失败（磁盘满等）时不会留下没有原图的任务记录
    addJob(j) {
      const srcFile = j.src ? file('src', j.id, extOf(j.srcMime)) : null;
      if (srcFile) fs.writeFileSync(srcFile, j.src);
      try {
        st.addJob.run(j.id, j.userId, j.ip, j.mode, j.model, j.style, j.subject ?? null, j.srcMime ?? null, Date.now());
      } catch (e) {
        if (srcFile) fs.rmSync(srcFile, { force: true });
        throw e;
      }
    },
    freeBytes() {
      try { const s = fs.statfsSync(dataDir); return s.bavail * s.bsize; } catch { return Infinity; }
    },
    getJob: (id) => st.getJob.get(id),
    readSrc(job) {
      if (!job.src_mime) return null;
      try { return fs.readFileSync(file('src', job.id, extOf(job.src_mime))); } catch { return null; }
    },
    setRunning: (id) => st.setRunning.run(Date.now(), id),
    setDone(id, image, meta = {}) {
      const j = st.getAny.get(id);
      if (j?.deleted) { st.setDone.run(Date.now(), meta.inTok ?? null, meta.outTok ?? null, id); return false; } // 已被删除：不落盘
      fs.writeFileSync(file('images', id, 'png'), image);
      st.setDone.run(Date.now(), meta.inTok ?? null, meta.outTok ?? null, id);
      return true;
    },
    // 失败时顺带删除原图：失败的作品不能重新生成，留着只占磁盘
    setError(id, msg) {
      const j = st.getAny.get(id);
      st.setError.run(Date.now(), String(msg).slice(0, 300), id);
      if (j?.src_mime) fs.rm(file('src', id, extOf(j.src_mime)), { force: true }, () => {});
    },
    imagePath: (id) => file('images', id, 'png'),
    thumbPath: (id) => file('thumbs', id, 'webp'),
    saveThumb(id, buf) { fs.writeFileSync(file('thumbs', id, 'webp'), buf); st.setThumb.run(id); },
    setParams: (id, json) => st.setParams.run(json, id),
    deleteJob(job) {
      st.del.run(job.id);
      for (const f of [file('images', job.id, 'png'), file('thumbs', job.id, 'webp'), job.src_mime && file('src', job.id, extOf(job.src_mime))]) {
        if (f) fs.rm(f, { force: true }, () => {});
      }
    },
    history: (userId, limit = 200) => st.history.all(userId, limit),
    pending: () => st.pending.all(),
    countUserSince: (u, t) => st.countUserSince.get(u, t).n,
    countIpSince: (ip, t) => st.countIpSince.get(ip, t).n,
    countAllSince: (t) => st.countAllSince.get(t).n,
    activeOfUser: (u) => st.activeOfUser.get(u).n,
    errorsUserSince: (u, t) => st.errorsUserSince.get(u, t).n,
    errorsIpSince: (ip, t) => st.errorsIpSince.get(ip, t).n,

    // 原图只保留 keepDays 天（够“换个风格重新生成”用），过期删除
    purgeOldSources(keepDays) {
      let n = 0;
      for (const r of st.oldSrc.all(Date.now() - keepDays * 86400_000)) {
        fs.rm(file('src', r.id, extOf(r.src_mime)), { force: true }, () => {});
        st.clearSrc.run(r.id); n++;
      }
      return n;
    },
    // ---------- 埋点 ----------
    track(sid, userId, meta, events, activeDelta) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const cur = st.getSession.get(sid);
        if (!cur) st.addSession.run(sid, userId, now, now, Math.max(0, activeDelta), meta.device || null, meta.source || null);
        else st.touchSession.run(now, Math.max(0, activeDelta), userId || cur.user_id, sid);
        for (const e of events) st.addEvent.run(Math.min(now, e.t || now), sid, userId, e.n, e.p ? JSON.stringify(e.p) : null);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    // 看板统计：since 起，按北京时间分天
    stats(since, presets) {
      const all = (sql, ...a) => db.prepare(sql).all(...a);
      const one = (sql, ...a) => db.prepare(sql).get(...a);
      const DAY = "strftime('%Y-%m-%d', (%COL% / 1000) + 8 * 3600, 'unixepoch')";
      const day = (col) => DAY.replace('%COL%', col);
      const presetName = (style) => presets.find((p) => p.prompt === style)?.name || '自定义';
      const styles = {};
      for (const r of all('SELECT style, COUNT(*) n FROM jobs WHERE created_at >= ? GROUP BY style', since)) styles[presetName(r.style)] = (styles[presetName(r.style)] || 0) + r.n;
      return {
        totals: {
          pv: one("SELECT COUNT(*) n FROM events WHERE ts >= ? AND name = 'page_view'", since).n,
          visitors: one('SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE started_at >= ?', since).n,
          sessions: one('SELECT COUNT(*) n FROM sessions WHERE started_at >= ?', since).n,
          newUsers: one('SELECT COUNT(*) n FROM users WHERE created_at >= ?', since).n,
          totalUsers: one('SELECT COUNT(*) n FROM users').n,
          activeUsers: one('SELECT COUNT(*) n FROM users WHERE last_seen >= ?', since).n,
          avgActiveSec: one('SELECT AVG(active_sec) v FROM sessions WHERE started_at >= ?', since).v || 0,
          activeSecs: all('SELECT active_sec v FROM sessions WHERE started_at >= ? ORDER BY active_sec', since).map((r) => r.v),
          jobs: one('SELECT COUNT(*) n FROM jobs WHERE created_at >= ?', since).n,
          jobsDone: one("SELECT COUNT(*) n FROM jobs WHERE created_at >= ? AND status = 'done'", since).n,
          jobsError: one("SELECT COUNT(*) n FROM jobs WHERE created_at >= ? AND status = 'error'", since).n,
          jobUsers: one('SELECT COUNT(DISTINCT user_id) n FROM jobs WHERE created_at >= ?', since).n,
          avgGenSec: one("SELECT AVG((finished_at - started_at) / 1000.0) v FROM jobs WHERE created_at >= ? AND status = 'done' AND started_at IS NOT NULL", since).v || 0,
          tokensOut: one('SELECT SUM(out_tok) v FROM jobs WHERE created_at >= ?', since).v || 0,
        },
        byMode: all('SELECT mode, COUNT(*) n FROM jobs WHERE created_at >= ? GROUP BY mode', since),
        styles,
        daily: {
          visitors: all(`SELECT ${day('started_at')} d, COUNT(DISTINCT user_id) n FROM sessions WHERE started_at >= ? GROUP BY d ORDER BY d`, since),
          pv: all(`SELECT ${day('ts')} d, COUNT(*) n FROM events WHERE ts >= ? AND name = 'page_view' GROUP BY d ORDER BY d`, since),
          jobs: all(`SELECT ${day('created_at')} d, COUNT(*) n FROM jobs WHERE created_at >= ? GROUP BY d ORDER BY d`, since),
          newUsers: all(`SELECT ${day('created_at')} d, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY d ORDER BY d`, since),
        },
        // 每个事件：次数与触发的会话数（用于漏斗和点击排行）
        events: all('SELECT name, COUNT(*) n, COUNT(DISTINCT session_id) s FROM events WHERE ts >= ? GROUP BY name ORDER BY n DESC', since),
        // 事件属性分布（例如下载的格式、选的色卡）
        props: all(`SELECT name, props, COUNT(*) n FROM events WHERE ts >= ? AND props IS NOT NULL AND name IN ('download','mode_select','style_select','palette_change','size_change','example_click','id_switch','generate_click') GROUP BY name, props ORDER BY n DESC LIMIT 200`, since),
        devices: all('SELECT device, COUNT(*) n FROM sessions WHERE started_at >= ? GROUP BY device', since),
        sources: all('SELECT COALESCE(source, \'直接打开\') source, COUNT(*) n FROM sessions WHERE started_at >= ? GROUP BY source ORDER BY n DESC LIMIT 20', since),
      };
    },
    purgeOldEvents(keepDays) { st.purgeEvents.run(Date.now() - keepDays * 86400_000); },

    // 每天一份数据库快照，保留最近 7 份
    backup() {
      const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const target = path.join(dataDir, 'backup', `pindou-${day}.db`);
      if (!fs.existsSync(target)) db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      const all = fs.readdirSync(path.join(dataDir, 'backup')).filter((f) => f.startsWith('pindou-')).sort();
      for (const f of all.slice(0, -7)) fs.rmSync(path.join(dataDir, 'backup', f), { force: true });
    },
  };
}
