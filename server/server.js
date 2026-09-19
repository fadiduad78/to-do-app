/* ============================================================================
 * server.js — ZeroTodo cloud backend (zero dependencies, Node >= 18)
 * ----------------------------------------------------------------------------
 * Multi-user edition. What it does:
 *   1. Serves the static app files from ./public (app + API share one origin).
 *   2. User accounts: username + password (scrypt-hashed, salted). Sessions are
 *      stateless signed tokens (30 days) — no server-side session store, so a
 *      restart never logs anyone out. The passkey that used to be pasted into
 *      the app is gone: ZT_TOKEN now only signs session tokens internally,
 *      and the Supabase key lives exclusively in server env vars.
 *   3. One private data bucket per user:
 *        file mode   → data/users/<username>.json   (admin → legacy data/state.json)
 *        supabase    → table zerotodo_state_by_user, one row per owner
 *      Atomic writes + per-user background upload loop with backoff.
 *   4. Per-record last-write-wins merge (see ingest) + store-scoped tombstones.
 *   5. Per-user Server-Sent Events: only YOUR devices see YOUR updates.
 *
 * API (JSON; state endpoints require a session):
 *   GET  /api/config  → { app, authRequired, storage, version }        (public)
 *   POST /api/signup  { username, password } → { token, username }
 *   POST /api/login   { username, password } → { token, username }
 *   POST /api/logout  → { ok }               (client drops the token)
 *   GET  /api/me      → { username }         (validates a session)
 *   GET  /api/state   → { rev, savedAt, settings, tasks, trash, tombstones }
 *   POST /api/sync    ← { clientId, baseRev, mode:'merge'|'replace',
 *                         state:{ settings, tasks, trash }, tombstones }
 *                     → the authoritative merged view for THIS user
 *   GET  /api/events  → SSE: data: {type:'sync', rev, origin}
 *
 * Back-compat: an Authorization Bearer equal to ZT_TOKEN maps to the legacy
 * "admin" bucket (the pre-accounts dataset, incl. the old Supabase id=1 row).
 * The FIRST account ever created also adopts that legacy data once, so an
 * existing single-user deployment migrates with zero ceremony.
 *
 * Modes / env:
 *   ZT_TOKEN=...      signing secret for sessions (auto-generated + persisted
 *                     to data/token.txt when unset) — the client never needs it
 *   ZT_OPEN=1         auth off: single shared bucket, no login (LAN / testing)
 *   ZT_SUPABASE_URL / ZT_SUPABASE_KEY   PostgREST persistence (Supabase free)
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------ Configuration ----------------------------- */

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.ZT_HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.ZT_DATA_DIR || path.join(ROOT, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');        // legacy admin bucket
const USERS_DIR = path.join(DATA_DIR, 'users');              // per-user buckets
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');  // file-mode accounts
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');

const MAX_BODY = 8 * 1024 * 1024;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SB_URL = (process.env.ZT_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.ZT_SUPABASE_KEY || '').trim();
const SB_TABLE = (process.env.ZT_SUPABASE_STATE_TABLE || 'zerotodo_state_by_user').trim();
const SB_USERS_TABLE = (process.env.ZT_SUPABASE_USERS_TABLE || 'zerotodo_users').trim();
const SB_LEGACY_TABLE = (process.env.ZT_SUPABASE_LEGACY_TABLE || 'zerotodo_state').trim();
const sbEnabled = () => Boolean(SB_URL && SB_KEY);

const RESERVED = new Set(['admin', 'shared', 'signup', 'login', 'logout', 'me', 'config', 'state', 'sync', 'events']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* --------------------------------- Auth core ------------------------------- */

let TOKEN = null; // signing secret (also legacy admin bearer)

function initAuth() {
  if (process.env.ZT_OPEN === '1') { TOKEN = null; return; }
  if (process.env.ZT_TOKEN) { TOKEN = String(process.env.ZT_TOKEN); return; }
  try {
    if (fs.existsSync(TOKEN_FILE)) TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch (_) { /* fall through */ }
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(24).toString('base64url');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, TOKEN + '\n');
    } catch (e) {
      console.error('[zerotodo] Could not persist signing secret:', e.message, '— sessions will reset on restart.');
    }
  }
}

const authRequired = () => TOKEN !== null;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', TOKEN).update(payload).digest('base64url');

function makeSession(username) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${username}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifySession(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return null;
  const [username, exp, mac] = parts;
  if (!USERNAME_RE.test(username)) return null;
  if (Number(exp) < Date.now()) return null;
  const expect = sign(`${username}.${exp}`);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch (_) { return null; }
  return username;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function passwordFromUser(u, password) { // scrypt with per-user salt
  return crypto.scryptSync(String(password), String(u.salt), 64).toString('hex');
}

/** Identify the caller: 'shared' (open mode) | legacy admin | session user | null */
function userFromReq(req, url) {
  if (!authRequired()) return 'shared';
  const hdr = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  const candidate = (m && m[1]) || url.searchParams.get('token') || '';
  if (!candidate) return null;
  if (candidate === TOKEN) return 'admin';
  return verifySession(candidate);
}

/* -------------------------- Rate limiting (login/signup) ------------------- */

const attempts = new Map(); // ip → { n, t0 }
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.t0 > 5 * 60000) { attempts.set(ip, { n: 1, t0: now }); return false; }
  a.n++;
  return a.n > 20; // 20 auth attempts per 5 min per IP
}

/* ----------------------- Per-user state buckets ---------------------------- */

/**
 * A bucket = one user's private universe. state is the authoritative in-memory
 * copy; every change goes through persist(bucket) which mirrors it to the
 * local file and (when configured) the Supabase row, with background retry.
 */
const BUCKETS = new Map(); // username → bucket

function bucketFor(username) {
  let b = BUCKETS.get(username);
  if (!b) {
    b = {
      username,
      state: { rev: 0, savedAt: 0, settings: {}, tasks: [], trash: [], projects: [], tombstones: {} },
      saveTimer: null, loaded: false, ready: null,
      sse: new Set(),
      sbDirty: false, sbRunning: false, sbDelay: 4000, sbLastOk: 0, sbLastError: '',
    };
    BUCKETS.set(username, b);
    b.ready = bootBucket(b);
  }
  return b;
}

function bucketFile(b) {
  return b.username === 'admin' || b.username === 'shared'
    ? STATE_FILE
    : path.join(USERS_DIR, b.username + '.json');
}

/** Supabase upsert target for this bucket: admin keeps using the legacy row. */
function sbUpsert(b) {
  return b.username === 'admin' || b.username === 'shared'
    ? { table: SB_LEGACY_TABLE, rowKey: { id: 1 } }
    : { table: SB_TABLE, rowKey: { owner: b.username } };
}

function fileSave(b) {
  try {
    const target = bucketFile(b);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(b.state));
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error('[zerotodo] file save failed (' + b.username + '):', e.message);
  }
}

function fileLoad(b) {
  try {
    const target = bucketFile(b);
    if (fs.existsSync(target)) {
      const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (raw && Array.isArray(raw.tasks)) b.state = normalizeState(raw);
    }
  } catch (e) {
    console.error('[zerotodo] Could not read state for ' + b.username + ', starting empty:', e.message);
  }
}

function persist(b) {
  clearTimeout(b.saveTimer);
  b.saveTimer = setTimeout(() => { fileSave(b); }, 200);
  scheduleRemoteSave(b);
}

/* ------------------------- Validation & normalization -------------------- */

/** Same spirit as storage.js coerceTask: normalize known fields, keep the rest. */
function coerceTask(raw, isTrash) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const now = Date.now();
  const t = { ...raw };
  t.id = raw.id;
  t.title = raw.title;
  t.description = typeof raw.description === 'string' ? raw.description : '';
  t.dueDate = typeof raw.dueDate === 'string' && raw.dueDate ? raw.dueDate : null;
  t.priority = raw.priority === 'low' || raw.priority === 'high' ? raw.priority : 'med';
  t.status = raw.status === 'completed' ? 'completed' : 'active';
  t.tags = Array.isArray(raw.tags)
    ? raw.tags.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
    : [];
  t.createdAt = Number(raw.createdAt) || now;
  t.updatedAt = Number(raw.updatedAt) || now;
  t.sortOrder = Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : now;
  if (isTrash) t.trashedAt = Number(raw.trashedAt) || now;
  return t;
}

function normalizeState(raw) {
  const pick = (arr, isTrash) => {
    const out = [];
    const seen = new Set();
    for (const r of (Array.isArray(arr) ? arr : [])) {
      const t = coerceTask(r, isTrash);
      if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    return out;
  };
  const tombstones = {};
  if (raw.tombstones && typeof raw.tombstones === 'object' && !Array.isArray(raw.tombstones)) {
    for (const [k, v] of Object.entries(raw.tombstones)) {
      if (typeof k === 'string' && k && Number.isFinite(Number(v))) tombstones[k] = Number(v);
    }
  }
  const settings = (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) ? raw.settings : {};
  const projects = [];
  {
    const seenP = new Set();
    for (const r of (Array.isArray(raw.projects) ? raw.projects : [])) {
      const p = coerceProject(r);
      if (p && !seenP.has(p.id)) { seenP.add(p.id); projects.push(p); }
    }
  }
  return {
    rev: Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : 0,
    savedAt: Number(raw.savedAt) || 0,
    settings,
    tasks: pick(raw.tasks, false),
    trash: pick(raw.trash, true),
    projects,
    tombstones,
  };
}

/** Lenient project coercion — mirrors storage.js coerceProject (unknown fields preserved). */
function coerceProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const now = Date.now();
  const p = { ...raw };
  p.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'Untitled project';
  p.description = typeof raw.description === 'string' ? raw.description.slice(0, 2000) : '';
  p.color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color) ? raw.color : 'var(--accent)';
  p.icon = typeof raw.icon === 'string' && raw.icon ? raw.icon.slice(0, 8) : '📁';
  p.status = raw.status === 'completed' ? 'completed' : 'active';
  p.archived = !!raw.archived;
  p.dueDate = typeof raw.dueDate === 'string' && raw.dueDate ? raw.dueDate : null;
  p.createdAt = Number(raw.createdAt) || now;
  p.updatedAt = Number(raw.updatedAt) || p.createdAt;
  p.sortOrder = Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : p.createdAt;
  p.deletedAt = Number.isFinite(Number(raw.deletedAt)) && Number(raw.deletedAt) > 0 ? Number(raw.deletedAt) : null;
  return p;
}

/** Trash retention + tombstone TTL — mirrors the client's rules server-side. */
function pruneExpired(b) {
  const now = Date.now();
  let changed = false;
  const keepTrash = [];
  for (const t of b.state.trash) {
    if (now - (t.trashedAt || 0) > TRASH_RETENTION_MS) {
      b.state.tombstones['trash:' + t.id] = Math.max(b.state.tombstones['trash:' + t.id] || 0, now);
      changed = true;
    } else keepTrash.push(t);
  }
  if (changed) b.state.trash = keepTrash;
  const keepProj = [];
  let projChanged = false;
  for (const p of b.state.projects) {
    if (p.deletedAt && now - p.deletedAt > TRASH_RETENTION_MS) {
      b.state.tombstones['projects:' + p.id] = Math.max(b.state.tombstones['projects:' + p.id] || 0, now);
      projChanged = true;
    } else keepProj.push(p);
  }
  if (projChanged) { b.state.projects = keepProj; changed = true; }
  for (const [id, at] of Object.entries(b.state.tombstones)) {
    if (now - at > TOMBSTONE_TTL_MS) { delete b.state.tombstones[id]; changed = true; }
  }
  return changed;
}

/* --------------------------------- Merging -------------------------------- */

function mergeRecords(localArr, remoteArr) {
  const byId = new Map();
  for (const t of localArr) byId.set(t.id, t);
  for (const t of remoteArr) {
    const cur = byId.get(t.id);
    if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * Store-scoped tombstones ("tasks:<id>" / "trash:<id>"): a move (soft delete,
 * restore) only removes copies in the store it left. A tombstone kills records
 * not newer than it — a later edit/restore legitimately revives a record.
 */
function applyTombstones(tasks, trash, projects, tombstones) {
  const kill = (arr, scope) => arr.filter((r) => !(tombstones[scope + ':' + r.id] >= (r.updatedAt || 0)));
  return {
    tasks: kill(tasks, 'tasks'),
    trash: kill(trash, 'trash'),
    projects: kill(projects || [], 'projects'),
  };
}

/** App invariant (storage.js cleanPayload): a live task wins over its trash copy. */
function enforceLiveWins(tasks, trash) {
  const live = new Set(tasks.map((t) => t.id));
  return trash.filter((t) => !live.has(t.id));
}

/** Merge an incoming client sync into the bucket's state. Returns changed? */
function ingest(b, body) {
  const incoming = normalizeState({
    rev: 0,
    savedAt: (body.state && body.state.savedAt) || 0,
    settings: (body.state && body.state.settings) || {},
    tasks: (body.state && body.state.tasks) || [],
    trash: (body.state && body.state.trash) || [],
    projects: (body.state && body.state.projects) || [],
    tombstones: body.tombstones || {},
  });

  const newTombstones = { ...b.state.tombstones };
  for (const [id, at] of Object.entries(incoming.tombstones)) {
    newTombstones[id] = Math.max(newTombstones[id] || 0, at);
  }

  let merged;
  if (body.mode === 'replace') {
    for (const t of incoming.tasks) delete newTombstones['tasks:' + t.id];
    for (const t of incoming.trash) delete newTombstones['trash:' + t.id];
    for (const p of incoming.projects) delete newTombstones['projects:' + p.id];
    merged = {
      settings: incoming.settings,
      tasks: incoming.tasks,
      trash: enforceLiveWins(incoming.tasks, incoming.trash),
      projects: incoming.projects,
      savedAt: Math.max(b.state.savedAt, incoming.savedAt || Date.now()),
    };
  } else {
    const tasks = mergeRecords(b.state.tasks, incoming.tasks);
    const trash = mergeRecords(b.state.trash, incoming.trash);
    const projects = mergeRecords(b.state.projects, incoming.projects);
    const alive = applyTombstones(tasks, trash, projects, newTombstones);
    merged = {
      settings: (incoming.savedAt || 0) >= b.state.savedAt ? incoming.settings : b.state.settings,
      tasks: alive.tasks,
      trash: enforceLiveWins(alive.tasks, alive.trash),
      projects: alive.projects,
      savedAt: Math.max(b.state.savedAt, incoming.savedAt || 0) || Date.now(),
    };
    for (const t of merged.tasks) {
      const k = 'tasks:' + t.id;
      if (newTombstones[k] && (t.updatedAt || 0) > newTombstones[k]) delete newTombstones[k];
    }
    for (const t of merged.trash) {
      const k = 'trash:' + t.id;
      if (newTombstones[k] && (t.updatedAt || 0) > newTombstones[k]) delete newTombstones[k];
    }
    for (const p of merged.projects) {
      const k = 'projects:' + p.id;
      if (newTombstones[k] && (p.updatedAt || 0) > newTombstones[k]) delete newTombstones[k];
    }
  }

  const before = JSON.stringify([b.state.tasks, b.state.trash, b.state.projects, b.state.settings]);
  const after = JSON.stringify([merged.tasks, merged.trash, merged.projects, merged.settings]);
  const changed = before !== after;

  b.state = { ...b.state, ...merged, tombstones: newTombstones, rev: b.state.rev + 1 };
  pruneExpired(b);
  persist(b);
  return changed;
}

/* ------------------------------ HTTP helpers ------------------------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 15000);
  return fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
}

function sbHeaders() {
  return { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
}

/* --------------------- Remote persistence (per bucket) ---------------------- */

function scheduleRemoteSave(b) {
  b.sbDirty = true;
  if (!sbEnabled() || b.sbRunning) return;
  runRemoteSaveLoop(b).catch(() => { b.sbRunning = false; });
}

async function remotePut(b) {
  const tgt = sbUpsert(b);
  const res = await fetchT(`${SB_URL}/rest/v1/${tgt.table}`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=minimal, resolution=merge-duplicates' },
    body: JSON.stringify({ ...tgt.rowKey, doc: b.state }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text().catch(() => '')).slice(0, 160));
}

async function runRemoteSaveLoop(b) {
  b.sbRunning = true;
  while (b.sbDirty) {
    b.sbDirty = false;
    try {
      await remotePut(b);
      b.sbLastOk = Date.now();
      b.sbLastError = '';
      b.sbDelay = 4000;
    } catch (e) {
      b.sbLastError = String((e && e.message) || e);
      console.warn(`[zerotodo] supabase save failed (${b.username}): ${b.sbLastError} — retry in ${b.sbDelay / 1000}s (file cache holds the data)`);
      await sleep(b.sbDelay);
      b.sbDelay = Math.min(b.sbDelay * 2, 300000);
      b.sbDirty = true;
    }
  }
  b.sbRunning = false;
}

async function sbRowGet(table, filters) {
  const res = await fetchT(`${SB_URL}/rest/v1/${table}?select=doc&${filters}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text().catch(() => '')).slice(0, 160));
  const rows = await res.json();
  return Array.isArray(rows) && rows.length && rows[0] && rows[0].doc ? rows[0].doc : null;
}

/** Boot restore: file cache first, then remote (remote wins when fresher). */
async function loadBucket(b) {
  fileLoad(b);
  if (!sbEnabled()) { b.loaded = true; return; }
  try {
    const tgt = sbUpsert(b);
    const filt = tgt.rowKey.id ? 'id=eq.1' : 'owner=eq.' + encodeURIComponent(b.username);
    const doc = await sbRowGet(tgt.table, filt);
    if (doc) {
      const remote = normalizeState(doc);
      if (remote.rev >= b.state.rev) {
        b.state = remote;
        fileSave(b);
        console.log(`[zerotodo] ${b.username}: restored from Supabase (rev ${remote.rev}, ${remote.tasks.length} tasks)`);
      } else {
        b.sbDirty = true;
      }
    } else if (b.state.rev > 0 || b.state.tasks.length) {
      b.sbDirty = true; // cache has data the table doesn't → seed
    }
    if (b.sbDirty) scheduleRemoteSave(b);
    else b.loaded = true;
    b.loaded = true;
  } catch (e) {
    console.error(`[zerotodo] ${b.username}: supabase unreachable at boot (${(e && e.message) || e}) — file cache in use, retrying in background`);
    scheduleRemoteSave(b);
    b.loaded = true;
  }
}

function bootBucket(b) { return loadBucket(b); }

/* ------------------------------ Accounts store ------------------------------ */

function accountsFromFile() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      if (d && d.users && typeof d.users === 'object') return d;
    }
  } catch (e) { console.error('[zerotodo] accounts file unreadable:', e.message); }
  return { users: {} };
}

function accountsToFile(d) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ACCOUNTS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (e) { console.error('[zerotodo] accounts file write failed:', e.message); }
}

async function listAccounts() {
  if (!sbEnabled()) {
    // file mode stores {salt, hash}; expose the same shape as the Postgres rows
    return Object.entries(accountsFromFile().users).map(([username, u]) => ({
      username, salt: u.salt, pass_hash: u.hash, created: u.created,
    }));
  }
  const res = await fetchT(`${SB_URL}/rest/v1/${SB_USERS_TABLE}?select=username,pass_hash,salt`, { headers: sbHeaders() });
  if (!res.ok) throw new Error('users table HTTP ' + res.status + ' — has the SQL from README-ONLINE.md been run?');
  return await res.json();
}

async function signup(username, password) {
  if (!USERNAME_RE.test(username)) throw err(400, 'username: 3–32 chars, lowercase letters, numbers, dots, dashes, underscores; must start with a letter/number');
  if (RESERVED.has(username)) throw err(400, 'that username is reserved — pick another');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw err(400, 'password must be 8–128 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');

  if (!sbEnabled()) {
    const d = accountsFromFile();
    if (d.users[username]) throw err(409, 'that username is taken');
    const firstUser = Object.keys(d.users).length === 0;
    d.users[username] = { salt, hash, created: Date.now() };
    accountsToFile(d);
    if (firstUser) await adoptLegacyInto(username);
  } else {
    const existing = await listAccounts();
    if (existing.some((u) => u.username === username)) throw err(409, 'that username is taken');
    const firstUser = existing.length === 0;
    const res = await fetchT(`${SB_URL}/rest/v1/${SB_USERS_TABLE}`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal, resolution=merge-duplicates' },
      body: JSON.stringify({ username, pass_hash: hash, salt }),
    });
    if (!res.ok) throw err(502, 'could not save account: ' + (await res.text().catch(() => '')).slice(0, 120));
    if (firstUser) await adoptLegacyInto(username);
  }
  return makeSession(username);
}

async function login(username, password) {
  if (!USERNAME_RE.test(username)) return null;
  const accounts = await listAccounts().catch((e) => { throw err(502, e.message); });
  const u = accounts.find((a) => a.username === username);
  if (!u) return null;
  const hash = passwordFromUser(u, password);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(String(u.pass_hash), 'hex'))) return null;
  } catch (_) { return null; }
  return makeSession(username);
}

/** First account ever created inherits the pre-accounts single-user dataset. */
async function adoptLegacyInto(username) {
  try {
    let legacy = null;
    if (!sbEnabled()) {
      if (fs.existsSync(STATE_FILE)) legacy = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      legacy = await sbRowGet(SB_LEGACY_TABLE, 'id=eq.1');
    }
    if (legacy && (legacy.rev > 0 || (Array.isArray(legacy.tasks) && legacy.tasks.length))) {
      const nb = bucketFor(username);
      await nb.ready;
      nb.state = normalizeState({ ...legacy });
      persist(nb);
      console.log(`[zerotodo] first account '${username}' adopted legacy data (${nb.state.tasks.length} task(s))`);
    }
  } catch (e) {
    console.warn('[zerotodo] legacy adoption skipped:', e.message);
  }
}

function err(status, message) { const e = new Error(message); e.status = status; return e; }

/* -------------------------------- SSE clients ------------------------------- */

function broadcast(b, eventObj, exceptId) {
  const data = 'data: ' + JSON.stringify(eventObj) + '\n\n';
  for (const res of b.sse) {
    if (exceptId && res.__ztId === exceptId) continue;
    try { res.write(data); } catch (_) { b.sse.delete(res); }
  }
}

setInterval(() => {
  for (const b of BUCKETS.values()) {
    for (const res of b.sse) { try { res.write(': ping\n\n'); } catch (_) { b.sse.delete(res); } }
  }
}, 25000).unref();

/* -------------------------------- HTTP core -------------------------------- */

function sendJSON(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden');
  }
  fs.readFile(filePath, (err2, buf) => {
    if (err2) {
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e3, index) => {
          if (e3) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(index);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/api/config') {
      return sendJSON(res, 200, {
        app: 'zerotodo-server', version: 4, authRequired: authRequired(),
        storage: sbEnabled() ? 'supabase (Postgres) + local cache' : 'local file only',
      });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    // Static files are not gated: the app shell carries no user data.
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      return serveStatic(res, p);
    }

    /* -------- auth endpoints (no session needed; rate-limited) -------- */

    if (p === '/api/signup' && req.method === 'POST') {
      if (!authRequired()) return sendJSON(res, 400, { error: 'accounts are off while the server runs in open mode (ZT_OPEN=1)' });
      if (tooManyAttempts(req.socket.remoteAddress || '?')) return sendJSON(res, 429, { error: 'too many attempts, try again in a few minutes' });
      let body; try { body = JSON.parse(await readBody(req)); } catch (_) { body = {}; }
      try {
        const uname = String(body.username || '').toLowerCase().trim();
        const token = await signup(uname, body.password);
        return sendJSON(res, 200, { ok: true, username: uname, token });
      } catch (e) {
        return sendJSON(res, e.status || 500, { error: e.message });
      }
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (!authRequired()) return sendJSON(res, 200, { ok: true, username: 'shared', token: TOKEN || 'open' });
      if (tooManyAttempts(req.socket.remoteAddress || '?')) return sendJSON(res, 429, { error: 'too many attempts, wait a few minutes' });
      let body; try { body = JSON.parse(await readBody(req)); } catch (_) { body = {}; }
      try {
        const uname = String(body.username || '').toLowerCase().trim();
        const token = await login(uname, body.password);
        if (!token) return sendJSON(res, 401, { error: 'wrong username or password' });
        return sendJSON(res, 200, { ok: true, username: uname, token });
      } catch (e) {
        return sendJSON(res, e.status || 500, { error: e.message });
      }
    }

    if (p === '/api/logout' && req.method === 'POST') return sendJSON(res, 200, { ok: true });

    /* -------- session identity for everything below -------- */

    const user = userFromReq(req, url);
    if (!user) return sendJSON(res, 401, { error: 'login required' });

    if (p === '/api/me') return sendJSON(res, 200, { ok: true, username: user });

    const b = bucketFor(user);
    await b.ready; // bucket boot (file + remote) must settle first

    if (p === '/api/state' && req.method === 'GET') {
      if (pruneExpired(b)) persist(b);
      return sendJSON(res, 200, b.state);
    }

    if (p === '/api/sync' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return sendJSON(res, 400, { error: 'bad json: ' + e.message }); }
      if (!body || typeof body !== 'object' || !body.state || !Array.isArray(body.state.tasks)) {
        return sendJSON(res, 400, { error: 'expected { clientId, baseRev, mode, state:{ tasks, trash, settings }, tombstones }' });
      }
      const baseRev = Number(body.baseRev);
      let conflicted = false;
      if (Number.isFinite(baseRev) && baseRev !== b.state.rev && body.mode !== 'replace') conflicted = true;
      if (!Number.isFinite(baseRev) && body.mode !== 'replace') conflicted = true;
      const changed = ingest(b, { ...body, mode: conflicted ? 'merge' : (body.mode === 'replace' ? 'replace' : 'merge') });
      if (changed) broadcast(b, { type: 'sync', rev: b.state.rev, origin: String(body.clientId || '') }, String(body.clientId || ''));
      return sendJSON(res, 200, { ...b.state, conflicted });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', rev: b.state.rev }) + '\n\n');
      res.__ztId = url.searchParams.get('id') || '';
      b.sse.add(res);
      const cleanup = () => b.sse.delete(res);
      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    return sendJSON(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    console.error('[zerotodo] request error:', e);
    try { sendJSON(res, 500, { error: 'internal' }); } catch (_) {}
  }
});

/* ------------------------------ Startup / shutdown ------------------------- */

initAuth();

server.listen(PORT, HOST, () => {
  console.log(`[zerotodo] server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[zerotodo] data dir: ${DATA_DIR}`);
  console.log(`[zerotodo] auth: ${authRequired() ? 'user accounts (signup/login)' : 'OPEN (single shared list — set ZT_TOKEN for accounts)'} | storage: ${sbEnabled() ? 'supabase + file cache' : 'file only'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const b of BUCKETS.values()) { clearTimeout(b.saveTimer); fileSave(b); }
    await Promise.race([
      Promise.all([...BUCKETS.values()].map(async (b) => { if (b.sbDirty) { try { await remotePut(b); b.sbDirty = false; } catch (_) {} } })),
      sleep(3000),
    ]);
    console.log('[zerotodo] state saved, bye.');
    process.exit(0);
  });
}
process.on('exit', () => { for (const b of BUCKETS.values()) { try { fileSave(b); } catch (_) {} } });
