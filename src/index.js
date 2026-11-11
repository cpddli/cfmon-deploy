/**
 * cfmon —— Cloudflare Workers 上的服务器监控面板（不使用 Durable Objects）
 *
 * 数据流：
 *   agent --HTTP POST /api/report--> Worker --UPDATE 一行--> D1
 *   浏览器 --GET /api/servers 每 3~5 秒轮询--> Worker --> D1
 *
 * 为什么这样最省钱：
 *   1. 不用 DO，就没有 DO 的「存活时长」计费（参考项目用 DO 持有 WebSocket 广播，
 *      面板一开着 DO 就一直活着，时长按墙钟时间烧）。
 *   2. agent 每次上报只写 1 行（servers 表 UPSERT 成 UPDATE），
 *      历史曲线另外按 60s 采样写 1 行，所以写入量完全可控。
 *   3. Worker 本身无状态，请求结束就回收，CPU 时间几乎为 0。
 */

const SESSION_COOKIE = 'cfmon_session';
const SESSION_TTL = 7 * 86400; // 7 天
const MAX_BODY = 64 * 1024;
const SERVER_PATH = /^\/api\/servers\/([0-9a-zA-Z-]{8,40})(\/token)?$/;
const SCHEMA_VERSION = '4';

/* ---------------------------------------------------------------- 自动建表 */

/**
 * 首次请求时自动建表 / 补字段，这样「一键部署」之后不需要再手动跑 SQL。
 * 用一个 schema_version 标记做缓存，正常情况下每次冷启动只多一次读。
 */
const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS servers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
     token_hash TEXT NOT NULL UNIQUE, token_hint TEXT NOT NULL DEFAULT '',
     hostname TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '',
     cpu_model TEXT NOT NULL DEFAULT '', cpu_cores INTEGER NOT NULL DEFAULT 0,
     kernel TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '',
     stats TEXT NOT NULL DEFAULT '{}', last_seen INTEGER NOT NULL DEFAULT 0,
     last_sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
     expires_at INTEGER NOT NULL DEFAULT 0, renew_cycle INTEGER NOT NULL DEFAULT 30,
     auto_renew INTEGER NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
     alert_state TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE TABLE IF NOT EXISTS samples (
     server_id TEXT NOT NULL, ts INTEGER NOT NULL,
     cpu REAL NOT NULL DEFAULT 0, mem REAL NOT NULL DEFAULT 0, swap REAL NOT NULL DEFAULT 0,
     disk REAL NOT NULL DEFAULT 0, load1 REAL NOT NULL DEFAULT 0,
     rx REAL NOT NULL DEFAULT 0, tx REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (server_id, ts)
   ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts)',
  `CREATE TABLE IF NOT EXISTS login_fail (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_login_fail_ip_ts ON login_fail (ip, ts)',
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

// 老库升级需要补的列（新库建表时已经包含）
const SCHEMA_COLUMNS = [
  ['region', "TEXT NOT NULL DEFAULT ''"],
  ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['renew_cycle', 'INTEGER NOT NULL DEFAULT 30'],
  ['auto_renew', 'INTEGER NOT NULL DEFAULT 0'],
  ['price', 'REAL NOT NULL DEFAULT 0'],
  ['alert_state', "TEXT NOT NULL DEFAULT '{}'"],
];

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first();
    if (row && row.value === SCHEMA_VERSION) {
      schemaReady = true;
      return;
    }
  } catch {
    /* settings 表还不存在，继续建 */
  }

  await env.DB.batch(SCHEMA_DDL.map((sql) => env.DB.prepare(sql)));

  // 补列：先看现有列，缺哪个补哪个
  const info = await env.DB.prepare('PRAGMA table_info(servers)').all();
  const have = new Set((info.results || []).map((r) => r.name));
  for (const [name, type] of SCHEMA_COLUMNS) {
    if (!have.has(name)) {
      await env.DB.prepare(`ALTER TABLE servers ADD COLUMN ${name} ${type}`).run();
    }
  }

  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(SCHEMA_VERSION)
    .run();

  schemaReady = true;
}

/* ------------------------------------------------------------ 管理密码 */

let cachedPasswordHash; // undefined = 还没读过

/** secret 优先；没配 secret 就用初始化时存进 D1 的哈希 */
async function adminSecret(env) {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (cachedPasswordHash === undefined) {
    try {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'password_hash'").first();
      cachedPasswordHash = row ? row.value : null;
    } catch {
      cachedPasswordHash = null;
    }
  }
  return cachedPasswordHash;
}

const enc = new TextEncoder();

/* ------------------------------------------------------------------ 小工具 */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

const bad = (message, status = 400) => json({ error: message }, status);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function pctOf(used, total) {
  const t = num(total);
  return t > 0 ? clamp((num(used) / t) * 100, 0, 100) : 0;
}

const round1 = (v) => Math.round(num(v) * 10) / 10;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 24) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** 定长比较，避免按字符提前返回泄露信息 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------ 会话（Cookie） */

async function issueSession(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const sig = await hmacHex(secret, `sess:${exp}`);
  return { value: `${exp}.${sig}`, maxAge: SESSION_TTL };
}

async function isAuthed(request, env) {
  const secret = await adminSecret(env);
  if (!secret) return false;
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(raw.slice(dot + 1), await hmacHex(secret, `sess:${exp}`));
}

function cookieHeader(url, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/* ---------------------------------------------------------------- 登录 / 登出 */

async function handleLogin(request, env, url) {
  const secret = await adminSecret(env);
  if (!secret) {
    return json({ error: '面板还没设置密码，请刷新页面完成初始化' }, 409);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Math.floor(Date.now() / 1000);

  const fails = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM login_fail WHERE ip = ? AND ts > ?',
  )
    .bind(ip, now - 900)
    .first();
  if (num(fails && fails.n) >= 10) {
    return json({ error: '密码错误次数过多，请 15 分钟后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const password = String((body && body.password) || '');
  // secret 场景两边都先哈希；D1 里存的本就是哈希，直接比
  const expected = env.ADMIN_PASSWORD ? await sha256Hex(env.ADMIN_PASSWORD) : secret;
  const ok = safeEqual(await sha256Hex(password), expected);
  if (!ok) {
    await env.DB.prepare('INSERT INTO login_fail (ip, ts) VALUES (?, ?)').bind(ip, now).run();
    return json({ error: '密码错误' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_fail WHERE ip = ?').bind(ip).run();
  const session = await issueSession(secret);
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, session.value, session.maxAge) });
}

/** 首次部署后设置管理密码（只在还没有任何密码时可用） */
async function handleSetup(request, env, url) {
  if (env.ADMIN_PASSWORD) return bad('已经通过环境变量设置了密码', 409);
  if (await adminSecret(env)) return bad('密码已经设置过了，直接登录即可', 409);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const password = String((body && body.password) || '');
  if (password.length < 6) return bad('密码至少 6 位');
  if (password.length > 128) return bad('密码太长');

  const hash = await sha256Hex(password);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(hash)
    .run();
  cachedPasswordHash = hash;

  const session = await issueSession(hash);
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, session.value, session.maxAge) });
}

function handleLogout(url) {
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, '', 0) });
}

/* ------------------------------------------------------------------ 数据上报 */

function normalizeStats(body) {
  const mem = body.mem || {};
  const swap = body.swap || {};
  const disk = body.disk || {};
  const net = body.net || {};
  const load = Array.isArray(body.load) ? body.load : [];

  return {
    ts: num(body.ts, Math.floor(Date.now() / 1000)),
    uptime: Math.max(0, num(body.uptime)),
    cpu: clamp(num(body.cpu), 0, 100),
    load: [num(load[0]), num(load[1]), num(load[2])],
    mem: { total: num(mem.total), used: num(mem.used), pct: pctOf(mem.used, mem.total) },
    swap: { total: num(swap.total), used: num(swap.used), pct: pctOf(swap.used, swap.total) },
    disk: { total: num(disk.total), used: num(disk.used), pct: pctOf(disk.used, disk.total) },
    net: {
      rx_rate: Math.max(0, num(net.rx_rate)),
      tx_rate: Math.max(0, num(net.tx_rate)),
      rx_total: Math.max(0, num(net.rx_total)),
      tx_total: Math.max(0, num(net.tx_total)),
    },
    procs: Math.max(0, num(body.procs)),
    tcp: Math.max(0, num(body.tcp)),
  };
}

async function handleReport(request, env, ctx) {
  const auth = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(request.headers.get('authorization') || '');
  if (!auth) return bad('缺少或非法的 Authorization: Bearer <token>', 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return bad('上报数据过大', 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad('请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object') return bad('请求体不是合法 JSON');

  const tokenHash = await sha256Hex(auth[1]);
  const row = await env.DB.prepare('SELECT id, last_sample FROM servers WHERE token_hash = ?')
    .bind(tokenHash)
    .first();
  if (!row) return bad('服务器密钥无效（可能已在面板里重置或删除）', 401);

  const now = Math.floor(Date.now() / 1000);
  const stats = normalizeStats(body);
  const sampleEvery = clamp(num(env.SAMPLE_INTERVAL, 60), 0, 86400);
  const dueSample = sampleEvery > 0 && now - num(row.last_sample) >= sampleEvery;

  const statements = [
    env.DB.prepare(
      `UPDATE servers
          SET hostname = ?, os = ?, arch = ?, cpu_model = ?, cpu_cores = ?,
              kernel = ?, agent = ?, stats = ?, last_seen = ?, last_sample = ?
        WHERE id = ?`,
    ).bind(
      String(body.hostname || '').slice(0, 128),
      String(body.os || '').slice(0, 128),
      String(body.arch || '').slice(0, 32),
      String(body.cpu_model || '').slice(0, 160),
      Math.max(0, num(body.cpu_cores)),
      String(body.kernel || '').slice(0, 96),
      String(body.agent || '').slice(0, 32),
      JSON.stringify(stats),
      now,
      dueSample ? now : num(row.last_sample),
      row.id,
    ),
  ];

  if (dueSample) {
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO samples (server_id, ts, cpu, mem, swap, disk, load1, rx, tx)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        now,
        stats.cpu,
        stats.mem.pct,
        stats.swap.pct,
        stats.disk.pct,
        stats.load[0],
        stats.net.rx_rate,
        stats.net.tx_rate,
      ),
    );
  }

  await env.DB.batch(statements);

  // 顺手做一次过期清理（约每 50 次上报触发一次），cron 没配也不会无限膨胀
  if (ctx && Math.random() < 0.02) {
    ctx.waitUntil(prune(env).catch((error) => console.error('prune failed', error)));
  }

  return json({ ok: true, ts: now, sampled: dueSample });
}

/* -------------------------------------------------------------- 查询 / 增删改 */

async function handleList(env, authed) {
  const now = Math.floor(Date.now() / 1000);
  const offlineAfter = clamp(num(env.OFFLINE_AFTER, 90), 10, 86400);

  const { results } = await env.DB.prepare(
    `SELECT id, name, region, note, sort_order, hostname, os, arch, cpu_model, cpu_cores,
            kernel, agent, stats, last_seen, created_at,
            expires_at, renew_cycle, auto_renew, price
       FROM servers
      ORDER BY sort_order ASC, name ASC`,
  ).all();

  const servers = (results || []).map((row) => {
    let stats = {};
    try {
      stats = JSON.parse(row.stats || '{}');
    } catch {
      stats = {};
    }
    const lastSeen = num(row.last_seen);
    return {
      id: row.id,
      name: row.name,
      region: row.region,
      // 备注常写机房、到期日、价格；主机名偏内部信息 —— 都不对游客展示
      note: authed ? row.note : '',
      sort_order: row.sort_order,
      hostname: authed ? row.hostname : '',
      os: row.os,
      arch: row.arch,
      cpu_model: row.cpu_model,
      cpu_cores: row.cpu_cores,
      kernel: row.kernel,
      agent: row.agent,
      stats,
      last_seen: lastSeen,
      online: lastSeen > 0 && now - lastSeen <= offlineAfter,
      created_at: row.created_at,
      // 计费信息只给管理员看
      expires_at: authed ? num(row.expires_at) : 0,
      renew_cycle: authed ? num(row.renew_cycle, 30) : 0,
      auto_renew: authed ? num(row.auto_renew) : 0,
      price: authed ? num(row.price) : 0,
    };
  });

  return json({ now, offline_after: offlineAfter, servers });
}

async function handleHistory(env, url) {
  const seconds = clamp(num(url.searchParams.get('seconds'), 3600), 60, 86400);
  const now = Math.floor(Date.now() / 1000);
  const since = now - seconds;
  // 服务端分桶降采样：每台最多 ~240 个点，长区间也不会吐出几 MB 的 JSON
  const bucket = Math.max(30, Math.round(seconds / 240));

  const { results } = await env.DB.prepare(
    `SELECT server_id,
            MIN(ts) AS ts,
            AVG(cpu) AS cpu,
            AVG(mem) AS mem,
            AVG(swap) AS swap,
            AVG(disk) AS disk,
            AVG(rx) AS rx,
            AVG(tx) AS tx
       FROM samples
       WHERE ts >= ?
      GROUP BY server_id, CAST((ts - ?) / ? AS INTEGER)
      ORDER BY server_id ASC, ts ASC
      LIMIT 50000`,
  )
    .bind(since, since, bucket)
    .all();

  // 用数组而不是对象，省一半体积：[ts, cpu, mem, swap, disk, rx, tx]
  const series = {};
  for (const row of results || []) {
    if (!series[row.server_id]) series[row.server_id] = [];
    series[row.server_id].push([
      row.ts,
      round1(row.cpu),
      round1(row.mem),
      round1(row.swap),
      round1(row.disk),
      Math.round(num(row.rx)),
      Math.round(num(row.tx)),
    ]);
  }

  return json({ now, seconds, bucket, series });
}

/* ------------------------------------------------------------ 通知 / 告警 */

const DEFAULT_CONFIG = {
  tg_token: '',
  tg_chat: '',
  cpu_enabled: 1,
  cpu_pct: 85,
  cpu_minutes: 10,
  mem_enabled: 1,
  mem_pct: 90,
  mem_minutes: 10,
  net_enabled: 0,
  net_mbps: 20,
  net_minutes: 10,
  offline_enabled: 1,
  offline_minutes: 5,
  cooldown_minutes: 60,
  billing_days: '7,3,1,0',
};

const BOOL_KEYS = ['cpu_enabled', 'mem_enabled', 'net_enabled', 'offline_enabled'];
const NUM_KEYS = {
  cpu_pct: [1, 100],
  cpu_minutes: [3, 1440],
  mem_pct: [1, 100],
  mem_minutes: [3, 1440],
  net_mbps: [1, 100000],
  net_minutes: [3, 1440],
  offline_minutes: [1, 1440],
  cooldown_minutes: [5, 10080],
};

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function fmtDate(ts) {
  const d = new Date(num(ts) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

async function loadConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'config'").first();
  const stored = row ? parseJson(row.value, {}) || {} : {};
  const cfg = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (stored[key] !== undefined && stored[key] !== null) cfg[key] = stored[key];
  }
  return cfg;
}

async function saveConfig(env, cfg) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('config', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(cfg))
    .run();
}

const maskToken = (token) => (token ? `${token.slice(0, 8)}…${token.slice(-4)}` : '');

async function tgSend(cfg, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.tg_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.tg_chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

async function handleGetSettings(env) {
  const cfg = await loadConfig(env);
  return json({ ...cfg, tg_token: maskToken(cfg.tg_token), tg_token_set: Boolean(cfg.tg_token) });
}

async function handlePutSettings(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const next = { ...(await loadConfig(env)) };

  // token 只有传入新值时才覆盖；传空字符串表示清除；回显的掩码值不会覆盖
  if (typeof body.tg_token === 'string') {
    const t = body.tg_token.trim();
    if (t === '') next.tg_token = '';
    else if (!t.includes('…')) next.tg_token = t.slice(0, 128);
  }
  if (typeof body.tg_chat === 'string') next.tg_chat = body.tg_chat.trim().slice(0, 64);

  if (typeof body.billing_days === 'string') {
    const days = body.billing_days
      .split(',')
      .map((x) => num(x, -1))
      .filter((x) => x >= 0 && x <= 365)
      .slice(0, 8);
    next.billing_days = (days.length ? days : [7, 3, 1, 0]).join(',');
  }

  for (const key of BOOL_KEYS) {
    if (body[key] !== undefined) next[key] = body[key] ? 1 : 0;
  }
  for (const [key, [lo, hi]] of Object.entries(NUM_KEYS)) {
    if (body[key] !== undefined) next[key] = clamp(num(body[key], next[key]), lo, hi);
  }

  await saveConfig(env, next);
  return json({ ok: true, ...next, tg_token: maskToken(next.tg_token), tg_token_set: Boolean(next.tg_token) });
}

async function handleTestTelegram(env) {
  const cfg = await loadConfig(env);
  if (!cfg.tg_token || !cfg.tg_chat) return bad('还没填 Bot Token 或 Chat ID');
  const res = await tgSend(
    cfg,
    '✅ <b>cfmon</b> 测试消息\n通知已打通，之后告警会发到这个会话。',
  );
  if (!res.ok) return json({ error: res.error || '发送失败' }, 400);
  return json({ ok: true });
}

const coolingDown = (last, nowTs, minutes) => !last || nowTs - num(last) >= minutes * 60;

/**
 * 判断某个指标是否「持续」超过阈值：取最近 N 个采样点，全部超阈值才算命中。
 * 不额外写库，纯读历史，所以每 2 分钟跑一次也很便宜。
 */
async function sustainedHit(env, serverId, field, threshold, minutes, nowTs, sampleEvery) {
  const need = clamp(Math.ceil((minutes * 60) / sampleEvery), 3, 240);
  const { results } = await env.DB.prepare(
    'SELECT ts, cpu, mem, rx, tx FROM samples WHERE server_id = ? ORDER BY ts DESC LIMIT ?',
  )
    .bind(serverId, need)
    .all();

  const rows = results || [];
  if (rows.length < need) return null; // 采样不够，说明刚上线或数据被清过
  if (nowTs - num(rows[0].ts) > Math.max(180, sampleEvery * 3)) return null; // 最新数据太旧

  const valueOf = (r) => (field === 'net' ? (num(r.rx) + num(r.tx)) / 1048576 : num(r[field]));
  for (const r of rows) {
    if (valueOf(r) < threshold) return null;
  }
  return { value: valueOf(rows[0]), samples: rows.length };
}

/**
 * 通知引擎：由 cron 定时调用。
 * 只读历史 + 必要时写一次 alert_state，没有常驻进程。
 */
async function runAlerts(env, nowTs = Math.floor(Date.now() / 1000)) {
  const cfg = await loadConfig(env);
  if (!cfg.tg_token || !cfg.tg_chat) return { skipped: 'telegram 未配置' };

  const sampleEvery = Math.max(30, num(env.SAMPLE_INTERVAL, 60));
  const offlineAfter = clamp(num(env.OFFLINE_AFTER, 90), 10, 86400);

  const { results } = await env.DB.prepare(
    `SELECT id, name, last_seen, expires_at, renew_cycle, auto_renew, alert_state FROM servers`,
  ).all();

  let sent = 0;
  const errors = [];

  for (const row of results || []) {
    const state = parseJson(row.alert_state, {}) || {};
    const name = escapeHtml(row.name || '未命名');
    const lastSeen = num(row.last_seen);
    const online = lastSeen > 0 && nowTs - lastSeen <= offlineAfter;
    let dirty = false;

    const send = async (text) => {
      const res = await tgSend(cfg, text);
      if (res.ok) sent += 1;
      else errors.push(res.error);
      return res.ok;
    };

    /* 离线 */
    if (cfg.offline_enabled && lastSeen > 0 && !online && coolingDown(state.offline, nowTs, cfg.cooldown_minutes)) {
      const mins = Math.round((nowTs - lastSeen) / 60);
      if (await send(`🔴 <b>${name}</b> 离线\n已经 ${mins} 分钟没有上报了。`)) {
        state.offline = nowTs;
        dirty = true;
      }
    }

    /* 持续负载（只在在线时判断，避免拿旧数据误报） */
    if (online) {
      if (cfg.cpu_enabled) {
        const hit = await sustainedHit(env, row.id, 'cpu', cfg.cpu_pct, cfg.cpu_minutes, nowTs, sampleEvery);
        if (hit && coolingDown(state.cpu, nowTs, cfg.cooldown_minutes)) {
          const text = `🔥 <b>${name}</b> CPU 持续偏高\n最近 ${hit.samples} 个采样都在 ${cfg.cpu_pct}% 以上，当前 <b>${hit.value.toFixed(0)}%</b>。`;
          if (await send(text)) {
            state.cpu = nowTs;
            dirty = true;
          }
        }
      }
      if (cfg.mem_enabled) {
        const hit = await sustainedHit(env, row.id, 'mem', cfg.mem_pct, cfg.mem_minutes, nowTs, sampleEvery);
        if (hit && coolingDown(state.mem, nowTs, cfg.cooldown_minutes)) {
          const text = `🧠 <b>${name}</b> 内存持续偏高\n最近 ${hit.samples} 个采样都在 ${cfg.mem_pct}% 以上，当前 <b>${hit.value.toFixed(0)}%</b>。`;
          if (await send(text)) {
            state.mem = nowTs;
            dirty = true;
          }
        }
      }
      if (cfg.net_enabled) {
        const hit = await sustainedHit(env, row.id, 'net', cfg.net_mbps, cfg.net_minutes, nowTs, sampleEvery);
        if (hit && coolingDown(state.net, nowTs, cfg.cooldown_minutes)) {
          const text = `🌐 <b>${name}</b> 网络持续跑满\n最近 ${hit.samples} 个采样上下行合计都超过 ${cfg.net_mbps} MB/s，当前 <b>${hit.value.toFixed(1)} MB/s</b>。`;
          if (await send(text)) {
            state.net = nowTs;
            dirty = true;
          }
        }
      }
    }

    /* 计费 */
    const expiresAt = num(row.expires_at);
    if (expiresAt > 0) {
      let exp = expiresAt;

      // 循环计费：到期自动顺延到未来
      if (num(row.auto_renew) && exp <= nowTs) {
        const cycle = Math.max(1, num(row.renew_cycle, 30));
        const steps = Math.min(240, Math.floor((nowTs - exp) / (cycle * 86400)) + 1);
        exp = exp + steps * cycle * 86400;
        await env.DB.prepare('UPDATE servers SET expires_at = ? WHERE id = ?').bind(exp, row.id).run();
        state.bill = { exp, sent: [] };
        dirty = true;
        await send(`🔄 <b>${name}</b> 已自动续费\n新到期日 ${fmtDate(exp)}（每 ${cycle} 天循环计费）。`);
      }

      const daysLeft = Math.ceil((exp - nowTs) / 86400);
      if (!state.bill || num(state.bill.exp) !== exp) state.bill = { exp, sent: [] };
      if (!Array.isArray(state.bill.sent)) state.bill.sent = [];

      const marks = String(cfg.billing_days || '7,3,1,0')
        .split(',')
        .map((x) => num(x, -1))
        .filter((x) => x >= 0);

      if (marks.includes(daysLeft) && !state.bill.sent.includes(daysLeft)) {
        const when = daysLeft === 0 ? '今天到期' : `${daysLeft} 天后到期`;
        const tail = num(row.auto_renew) ? '已开启循环计费，会自动扣费续期。' : '未开启自动续费，记得手动续费。';
        const text = `💳 <b>${name}</b> ${when}\n到期日 ${fmtDate(exp)}，${tail}`;
        if (await send(text)) {
          state.bill.sent.push(daysLeft);
          dirty = true;
        }
      }
      if (daysLeft < 0 && !state.bill.sent.includes(-1)) {
        const text = `⚠️ <b>${name}</b> 已过期\n到期日 ${fmtDate(exp)}，已经过期 ${-daysLeft} 天。`;
        if (await send(text)) {
          state.bill.sent.push(-1);
          dirty = true;
        }
      }
    }

    if (dirty) {
      await env.DB.prepare('UPDATE servers SET alert_state = ? WHERE id = ?')
        .bind(JSON.stringify(state), row.id)
        .run();
    }
  }

  return { sent, errors };
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const name = String((body && body.name) || '').trim();
  if (!name) return bad('名称不能为空');
  if (name.length > 64) return bad('名称最长 64 个字符');
  const note = String((body && body.note) || '').trim().slice(0, 200);
  const region = String((body && body.region) || '').trim().slice(0, 16);

  const id = crypto.randomUUID();
  const token = randomToken(24);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO servers (id, name, region, note, token_hash, token_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, region, note, await sha256Hex(token), token.slice(0, 6), now)
    .run();

  return json({ ok: true, id, name, region, note, token }, 201);
}

async function handlePatch(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const sets = [];
  const values = [];

  if (body && typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return bad('名称不能为空');
    if (name.length > 64) return bad('名称最长 64 个字符');
    sets.push('name = ?');
    values.push(name);
  }
  if (body && typeof body.note === 'string') {
    sets.push('note = ?');
    values.push(body.note.trim().slice(0, 200));
  }
  if (body && typeof body.region === 'string') {
    sets.push('region = ?');
    values.push(body.region.trim().slice(0, 16));
  }
  if (body && body.sort_order !== undefined) {
    sets.push('sort_order = ?');
    values.push(num(body.sort_order));
  }
  // 计费字段
  if (body && body.expires_at !== undefined) {
    let ts = 0;
    if (typeof body.expires_at === 'number') {
      ts = Math.max(0, Math.floor(body.expires_at));
    } else if (typeof body.expires_at === 'string' && body.expires_at.trim()) {
      const parsed = Date.parse(`${body.expires_at.trim().slice(0, 10)}T00:00:00Z`);
      ts = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    }
    sets.push('expires_at = ?');
    values.push(ts);
  }
  if (body && body.renew_cycle !== undefined) {
    sets.push('renew_cycle = ?');
    values.push(clamp(num(body.renew_cycle, 30), 1, 3650));
  }
  if (body && body.auto_renew !== undefined) {
    sets.push('auto_renew = ?');
    values.push(body.auto_renew ? 1 : 0);
  }
  if (body && body.price !== undefined) {
    sets.push('price = ?');
    values.push(Math.max(0, num(body.price, 0)));
  }
  if (!sets.length) return bad('没有可更新的字段');

  values.push(id);
  const result = await env.DB.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  if (result.meta && result.meta.changes === 0) return bad('服务器不存在', 404);
  return json({ ok: true });
}

async function handleRotate(env, id) {
  const token = randomToken(24);
  const result = await env.DB.prepare('UPDATE servers SET token_hash = ?, token_hint = ? WHERE id = ?')
    .bind(await sha256Hex(token), token.slice(0, 6), id)
    .run();

  if (result.meta && result.meta.changes === 0) return bad('服务器不存在', 404);
  return json({ ok: true, token });
}

/** 批量重排：按传入的 id 顺序写 sort_order（一次 batch，一次往返） */
async function handleReorder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }
  const ids = Array.isArray(body && body.ids)
    ? body.ids.filter((x) => typeof x === 'string' && x.length >= 8).slice(0, 500)
    : [];
  if (!ids.length) return bad('缺少 ids');

  await env.DB.batch(
    ids.map((id, index) => env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, id)),
  );
  return json({ ok: true, count: ids.length });
}

async function handleDelete(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM samples WHERE server_id = ?').bind(id),
    env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ 清理任务 */

async function prune(env) {
  const now = Math.floor(Date.now() / 1000);
  const days = clamp(num(env.RETENTION_DAYS, 1), 1, 365);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM samples WHERE ts < ?').bind(now - days * 86400),
    env.DB.prepare('DELETE FROM login_fail WHERE ts < ?').bind(now - 86400),
  ]);
}

/* -------------------------------------------------------------------- 路由 */

/**
 * 游客模式：默认开启，未登录也能看状态。
 * 想关掉（全部内容都要登录）就在 Cloudflare 后台加一个变量 PUBLIC_VIEW=0。
 */
const publicViewEnabled = (env) => String(env.PUBLIC_VIEW ?? '1') !== '0';

async function route(request, env, url, path, ctx) {
  if (!env.DB) return json({ error: '缺少 D1 绑定 DB，请检查 wrangler.toml' }, 500);
  const method = request.method;

  if (path === '/api/login' && method === 'POST') return handleLogin(request, env, url);
  if (path === '/api/setup' && method === 'POST') return handleSetup(request, env, url);
  if (path === '/api/logout' && method === 'POST') return handleLogout(url);
  if (path === '/api/health') return json({ ok: true });
  // agent 用独立密钥鉴权，不走会话
  if (path === '/api/report' && method === 'POST') return handleReport(request, env, ctx);

  const authed = await isAuthed(request, env);
  const isPublic = publicViewEnabled(env);

  // 前端靠这个判断该进游客模式还是登录页
  if (path === '/api/me') {
    const secret = await adminSecret(env);
    return json({ ok: true, authed, public: isPublic, needsSetup: !secret });
  }

  const guestAllowed = authed || isPublic;

  if (path === '/api/servers') {
    if (method === 'GET') {
      if (!guestAllowed) return json({ error: '未登录' }, 401);
      return handleList(env, authed);
    }
    if (method === 'POST') {
      if (!authed) return json({ error: '未登录' }, 401);
      return handleCreate(request, env);
    }
    return json({ error: '方法不允许' }, 405);
  }

  if (path === '/api/history' && method === 'GET') {
    if (!guestAllowed) return json({ error: '未登录' }, 401);
    return handleHistory(env, url);
  }

  if (!authed) return json({ error: '未登录' }, 401);

  if (path === '/api/settings') {
    if (method === 'GET') return handleGetSettings(env);
    if (method === 'PUT') return handlePutSettings(request, env);
    return json({ error: '方法不允许' }, 405);
  }
  if (path === '/api/settings/test' && method === 'POST') return handleTestTelegram(env);

  // 注意要放在 SERVER_PATH 之前，否则会被当成 :id
  if (path === '/api/servers/reorder' && method === 'POST') return handleReorder(request, env);

  const match = SERVER_PATH.exec(path);
  if (match) {
    const id = match[1];
    if (match[2] === '/token' && method === 'POST') return handleRotate(env, id);
    if (!match[2]) {
      if (method === 'PATCH') return handlePatch(request, env, id);
      if (method === 'DELETE') return handleDelete(env, id);
    }
  }

  return json({ error: '接口不存在' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!path.startsWith('/api/')) {
      // 静态资源（面板前端 / agent 脚本）由 assets 直接返回
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    try {
      // 首次请求自动建表，部署完不用再手动跑 SQL
      if (env.DB) {
        await ensureSchema(env).catch((error) => console.error('ensureSchema failed', error));
      }
      return await route(request, env, url, path, ctx);
    } catch (error) {
      console.error('cfmon api error:', path, error && error.stack ? error.stack : error);
      return json({ error: '服务器内部错误' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (env.DB) {
      await ensureSchema(env).catch((error) => console.error('ensureSchema failed', error));
    }
    const cron = event && event.cron;
    // 每天 03:17 那次只做清理；其余（每 2 分钟）跑告警评估
    if (cron === '17 3 * * *') {
      ctx.waitUntil(prune(env).catch((error) => console.error('prune failed', error)));
      return;
    }
    ctx.waitUntil(runAlerts(env).catch((error) => console.error('alerts failed', error)));
  },
};
