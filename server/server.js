/* ============================================================================
 * server.js — ZeroTodo cloud backend (zero dependencies, Node >= 18)
 * ----------------------------------------------------------------------------
 * What it does:
 *   1. Serves the static app files from ./public (so the app + API share one
 *      origin — no CORS headaches when deployed).
 *   2. Persists the full app state (tasks, trash, settings, deletion
 *      tombstones) to ./data/state.json with atomic writes (tmp + rename),
 *      so the data survives restarts, crashes and browser-data clearing.
 *      With ZT_SUPABASE_URL + ZT_SUPABASE_KEY set, every change is also
 *      mirrored to a single Postgres row over plain HTTPS (PostgREST) and
 *      restored from there on boot — this is what makes the free Render plan
 *      (ephemeral filesystem) safe. Retries with backoff; a dead remote never
 *      blocks the API.
 *   3. Merges concurrent changes from multiple devices with a per-record
 *      last-write-wins rule (freshest `updatedAt` wins; a delete only wins
 *      if nothing edited the record afterwards — enforced via tombstones).
 *   4. Pushes live updates to every open client through Server-Sent Events,
 *      so two devices on the same list converge in ~instant time.
 *
 * API (all JSON):
 *   GET  /api/config  → { app, authRequired, version }           (no auth)
 *   GET  /api/state   → { rev, savedAt, settings, tasks, trash, tombstones }
 *   POST /api/sync    ← { clientId, baseRev, mode:'merge'|'replace',
 *                         state:{ settings, tasks, trash }, tombstones }
 *                     → same shape as /api/state (the authoritative merged view)
 *   GET  /api/events  → SSE stream: data: {type:'sync', rev, origin}
 *
 * Auth (optional but recommended when online):
 *   - env ZT_TOKEN=...           → clients must send `Authorization: Bearer <token>`
 *     (or ?token=... on the SSE endpoint, which cannot set headers)
 *   - or ./data/token.txt        → used if ZT_TOKEN is unset; auto-generated +
 *     printed to the log on first boot so the owner can copy it into Settings
 *   - env ZT_OPEN=1              → explicitly disable auth (bad on the public
 *     internet, handy for a quick LAN test)
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
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');

const MAX_BODY = 8 * 1024 * 1024;                 // 8 MB is generous for a todo app
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // keep in sync with storage.js
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // deletions remembered 30 days

/* Remote persistence (optional, zero-dep): a single JSON row in Postgres,
 * reached over plain HTTPS via PostgREST (e.g. a free Supabase project).
 * Render's free plan has no persistent disk, so state.json alone would be lost
 * on restart — the remote row is the durable copy; the file is a local cache.
 * Unset the env vars and the server runs file-only (fine for a real VPS or
 * Docker with a volume). */
const SB_URL = (process.env.ZT_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.ZT_SUPABASE_KEY || '').trim();
const SB_TABLE = (process.env.ZT_SUPABASE_TABLE || 'zerotodo_state').trim();
const sbEnabled = () => Boolean(SB_URL && SB_KEY);

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

/* ------------------------------- Auth token ------------------------------- */

let TOKEN = null;

function initAuth() {
  if (process.env.ZT_OPEN === '1') { TOKEN = null; return; }
  if (process.env.ZT_TOKEN) { TOKEN = String(process.env.ZT_TOKEN); return; }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
    }
  } catch (_) { /* fall through to generate */ }
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(12).toString('base64url');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, TOKEN + '\n');
    } catch (e) {
      console.error('[zerotodo] Could not persist token to', TOKEN_FILE, '— using in-memory token only.', e.message);
    }
    console.log('────────────────────────────────────────────────────────');
    console.log('[zerotodo] Access passkey (paste into the app → ⚙ Settings → Cloud sync):');
    console.log('[zerotodo]   ' + TOKEN);
    console.log('[zerotodo] Set env ZT_TOKEN to choose your own, or ZT_OPEN=1 to disable auth.');
    console.log('────────────────────────────────────────────────────────');
  }
}

const authRequired = () => TOKEN !== null;

function checkAuth(req, url) {
  if (!authRequired()) return true;
  const hdr = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  const candidate = (m && m[1]) || url.searchParams.get('token') || '';
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
  } catch (_) {
    return false;
  }
}

/* ------------------------------ State & storage ---------------------------- */

/**
 * Server-side truth. Kept in memory; durably mirrored to STATE_FILE after
 * every change (debounced atomic write) and on shutdown.
 */
let state = {
  rev: 0,
  savedAt: 0,
  settings: {},
  tasks: [],
  trash: [],
  tombstones: {}, // id → deletion timestamp (last-write-wins guard)
};
let saveTimer = null;
let lastLoadedMtime = 0;

function loadState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.tasks)) {
        state = normalizeState(raw);
        lastLoadedMtime = fs.statSync(STATE_FILE).mtimeMs;
        console.log(`[zerotodo] Loaded state: ${state.tasks.length} task(s), ${state.trash.length} trashed, rev ${state.rev}`);
      }
    }
  } catch (e) {
    console.error('[zerotodo] Could not read state file, starting fresh:', e.message);
  }
  pruneExpired();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE); // atomic: readers never see a partial file
    lastLoadedMtime = fs.statSync(STATE_FILE).mtimeMs;
  } catch (e) {
    console.error('[zerotodo] Failed to persist state:', e.message);
  }
}

/* ------------------------ Remote persistence (Supabase/PostgREST) --------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 15000);
  return fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
}

function sbHeaders() {
  return { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
}

let sbDirty = false;
let sbRunning = false;
let sbDelay = 4000;
let sbLastOk = 0;
let sbLastError = '';

/** durable-write funnel: local file cache + (if configured) the remote row */
function persist() {
  scheduleSave();
  scheduleRemoteSave();
}

function scheduleRemoteSave() {
  sbDirty = true;
  if (!sbEnabled() || sbRunning) return;
  runRemoteSaveLoop().catch(() => { sbRunning = false; });
}

async function runRemoteSaveLoop() {
  sbRunning = true;
  while (sbDirty) {
    sbDirty = false;
    try {
      const res = await fetchT(`${SB_URL}/rest/v1/${SB_TABLE}`, {
        method: 'POST',
        headers: { ...sbHeaders(), Prefer: 'return=minimal, resolution=merge-duplicates' },
        body: JSON.stringify({ id: 1, doc: state }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text().catch(() => '')).slice(0, 160));
      sbLastOk = Date.now();
      sbLastError = '';
      sbDelay = 4000;
    } catch (e) {
      sbLastError = String((e && e.message) || e);
      console.warn('[zerotodo] Supabase save failed (' + sbLastError + ') — retry in ' + (sbDelay / 1000) + 's. File cache still holds the data.');
      await sleep(sbDelay);
      sbDelay = Math.min(sbDelay * 2, 300000); // backoff up to 5 min
      sbDirty = true;
    }
  }
  sbRunning = false;
}

/** One-shot attempt used on shutdown (bounded by a timeout so exit never hangs). */
async function remoteFlushOnce(timeoutMs) {
  if (!sbEnabled() || !sbDirty) return true;
  try {
    await Promise.race([
      (async () => {
        const res = await fetchT(`${SB_URL}/rest/v1/${SB_TABLE}`, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'return=minimal, resolution=merge-duplicates' },
          body: JSON.stringify({ id: 1, doc: state }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      })(),
      sleep(timeoutMs),
    ]);
    sbDirty = false;
    return true;
  } catch (_) { return false; }
}

/**
 * Boot restore: remote row wins when it is at least as fresh as the local
 * cache (fresh instance → empty file, remote has everything). Both agree
 * afterwards: whichever wins is pushed to the other copy.
 */
async function loadRemote() {
  if (!sbEnabled()) return;
  try {
    const res = await fetchT(`${SB_URL}/rest/v1/${SB_TABLE}?select=doc&id=eq.1`, { headers: sbHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text().catch(() => '')).slice(0, 160));
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length && rows[0] && rows[0].doc) {
      const remote = normalizeState(rows[0].doc);
      if (remote.rev >= state.rev) {
        state = remote;
        saveNow();
        console.log(`[zerotodo] restored from Supabase: rev ${state.rev}, ${state.tasks.length} task(s)`);
      } else {
        console.log('[zerotodo] local file cache is newer than the Supabase row — keeping it and re-uploading');
        sbDirty = true;
      }
    } else {
      console.log('[zerotodo] Supabase table empty — uploading current state');
      sbDirty = true;
    }
    if (sbDirty) scheduleRemoteSave();
  } catch (e) {
    console.error('[zerotodo] Supabase unreachable at boot (' + ((e && e.message) || e) + ') — continuing with file cache; background retry scheduled.');
    scheduleRemoteSave(); // the loop will keep trying with backoff until it connects
  }
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
  return {
    rev: Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : 0,
    savedAt: Number(raw.savedAt) || 0,
    settings,
    tasks: pick(raw.tasks, false),
    trash: pick(raw.trash, true),
    tombstones,
  };
}

/** Trash retention + tombstone TTL — mirrors the client's rules server-side. */
function pruneExpired() {
  const now = Date.now();
  let changed = false;
  const keepTrash = [];
  for (const t of state.trash) {
    if (now - (t.trashedAt || 0) > TRASH_RETENTION_MS) {
      state.tombstones['trash:' + t.id] = Math.max(state.tombstones['trash:' + t.id] || 0, now); // expired trash becomes a deletion
      changed = true;
    } else keepTrash.push(t);
  }
  if (changed) state.trash = keepTrash;
  for (const [id, at] of Object.entries(state.tombstones)) {
    if (now - at > TOMBSTONE_TTL_MS) { delete state.tombstones[id]; changed = true; }
  }
  return changed;
}

/* --------------------------------- Merging -------------------------------- */

/**
 * Per-record last-write-wins merge of two record lists. Unknown ids from
 * either side are kept (union) — this is what makes multi-device usage safe:
 * neither device can accidentally wipe records it has never seen.
 */
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
 * Tombstones are store-scoped (`"tasks:<id>"`, `"trash:<id>"`) so a move
 * (soft delete = remove from tasks + add to trash) removes stale copies from
 * the store they left, while the fresh copy in the other store survives.
 * A tombstone only kills records that are NOT newer than it (a later edit or
 * restore legitimately revives a record).
 */
function applyTombstones(tasks, trash, tombstones) {
  return {
    tasks: tasks.filter((t) => !(tombstones['tasks:' + t.id] >= (t.updatedAt || 0))),
    trash: trash.filter((t) => !(tombstones['trash:' + t.id] >= (t.updatedAt || 0))),
  };
}

/** App invariant (storage.js cleanPayload): a live task wins over its trash copy. */
function enforceLiveWins(tasks, trash) {
  const live = new Set(tasks.map((t) => t.id));
  return trash.filter((t) => !live.has(t.id));
}

/**
 * Merge an incoming client sync into server state.
 *  - mode 'replace' (used after an explicit Import): the client's dataset IS
 *    the truth for tasks/trash/settings; tombstones are unioned.
 *  - mode 'merge' (the normal path): union + per-record last-write-wins;
 *    tombstones unioned then applied to both sides' records.
 * Returns { changed }.
 */
function ingest(body) {
  const incoming = normalizeState({
    rev: 0,
    savedAt: (body.state && body.state.savedAt) || 0,
    settings: (body.state && body.state.settings) || {},
    tasks: (body.state && body.state.tasks) || [],
    trash: (body.state && body.state.trash) || [],
    tombstones: body.tombstones || {},
  });

  const newTombstones = { ...state.tombstones };
  for (const [id, at] of Object.entries(incoming.tombstones)) {
    newTombstones[id] = Math.max(newTombstones[id] || 0, at);
  }

  let merged;
  if (body.mode === 'replace') {
    // An explicit Import/replace overwrites the dataset: tombstones for the
    // ids being (re)installed are cleared, so the imported records stand.
    for (const t of incoming.tasks) delete newTombstones['tasks:' + t.id];
    for (const t of incoming.trash) delete newTombstones['trash:' + t.id];
    merged = {
      settings: incoming.settings,
      tasks: incoming.tasks,
      trash: enforceLiveWins(incoming.tasks, incoming.trash),
      savedAt: Math.max(state.savedAt, incoming.savedAt || Date.now()),
    };
  } else {
    const tasks = mergeRecords(state.tasks, incoming.tasks);
    const trash = mergeRecords(state.trash, incoming.trash);
    const alive = applyTombstones(tasks, trash, newTombstones);
    merged = {
      settings: (incoming.savedAt || 0) >= state.savedAt ? incoming.settings : state.settings,
      tasks: alive.tasks,
      trash: enforceLiveWins(alive.tasks, alive.trash),
      savedAt: Math.max(state.savedAt, incoming.savedAt || 0) || Date.now(),
    };
    // Prune redundant tombstones: a live record newer than the deletion has
    // already won, so the tombstone only exists to kill stale re-pushes —
    // which the fresher record does by itself under LWW.
    for (const t of merged.tasks) {
      const k = 'tasks:' + t.id;
      if (newTombstones[k] && (t.updatedAt || 0) > newTombstones[k]) delete newTombstones[k];
    }
    for (const t of merged.trash) {
      const k = 'trash:' + t.id;
      if (newTombstones[k] && (t.updatedAt || 0) > newTombstones[k]) delete newTombstones[k];
    }
  }

  const before = JSON.stringify([state.tasks, state.trash, state.settings]);
  const after = JSON.stringify([merged.tasks, merged.trash, merged.settings]);
  const changed = before !== after;

  state = {
    ...state,
    ...merged,
    tombstones: newTombstones,
    rev: state.rev + 1,
  };
  pruneExpired();
  persist();
  return changed;
}

/* ------------------------------- SSE clients ------------------------------- */

const sseClients = new Set();

function broadcast(eventObj, exceptId) {
  const data = 'data: ' + JSON.stringify(eventObj) + '\n\n';
  for (const res of sseClients) {
    if (exceptId && res.__ztId === exceptId) continue;
    try { res.write(data); } catch (_) { /* dropped below on next error */ }
  }
}

// keepalive so proxies don't idle-kill the stream
setInterval(() => {
  for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (_) {} }
}, 25000).unref();

/* -------------------------------- HTTP core -------------------------------- */

function sendJSON(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
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
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback: unknown non-file path → index.html (404s only for missing assets with an extension)
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, index) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
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

  // CORS preflight (only matters if someone hosts the frontend elsewhere)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  try {
    if (p === '/api/config') {
      return sendJSON(res, 200, {
        app: 'zerotodo-server', version: 2, authRequired: authRequired(),
        storage: sbEnabled() ? 'supabase (Postgres) + local cache' : 'local file only',
        remote: sbEnabled() ? { lastSavedAt: sbLastOk || null, lastError: sbLastError || null } : null,
      });
    }

    // Static files are NOT gated: the app shell contains no user data — the
    // data only comes from the authenticated /api/* endpoints below.
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      return serveStatic(res, p);
    }

    if (!checkAuth(req, url)) {
      return sendJSON(res, 401, { error: 'unauthorized', hint: 'Set the passkey in ⚙ Settings → Cloud sync' });
    }

    if (p === '/api/state' && req.method === 'GET') {
      await readyPromise; // boot-restore (remote) must settle before serving
      if (pruneExpired()) persist();
      return sendJSON(res, 200, state);
    }

    if (p === '/api/sync' && req.method === 'POST') {
      await readyPromise; // never merge against pre-restore state
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return sendJSON(res, 400, { error: 'bad json: ' + e.message }); }
      if (!body || typeof body !== 'object' || !body.state || !Array.isArray(body.state.tasks)) {
        return sendJSON(res, 400, { error: 'expected { clientId, baseRev, mode, state:{ tasks, trash, settings }, tombstones }' });
      }
      const baseRev = Number(body.baseRev);
      let conflicted = false;
      if (Number.isFinite(baseRev) && baseRev !== state.rev && body.mode !== 'replace') {
        conflicted = true; // another device moved ahead → merge instead of trusting base
      }
      if (!Number.isFinite(baseRev) && body.mode !== 'replace') conflicted = true;

      // 'replace' skips conflict detection by design (explicit Import).
      const changed = ingest({ ...body, mode: conflicted ? 'merge' : (body.mode === 'replace' ? 'replace' : 'merge') });
      if (changed) broadcast({ type: 'sync', rev: state.rev, origin: String(body.clientId || '') }, String(body.clientId || ''));
      return sendJSON(res, 200, { ...state, conflicted });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', rev: state.rev }) + '\n\n');
      res.__ztId = url.searchParams.get('id') || '';
      sseClients.add(res);
      const cleanup = () => sseClients.delete(res);
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
loadState();
const readyPromise = loadRemote().then(() => {
  if (sbEnabled()) console.log('[zerotodo] remote persistence active: ' + SB_URL + ' (table ' + SB_TABLE + ')');
});

server.listen(PORT, HOST, () => {
  console.log(`[zerotodo] server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[zerotodo] data file: ${STATE_FILE}`);
  console.log(`[zerotodo] auth: ${authRequired() ? 'passkey required' : 'OPEN (set ZT_TOKEN for internet deployment)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    saveNow();
    await remoteFlushOnce(3000); // give a healthy render redeploy the durable copy
    console.log('[zerotodo] state saved, bye.');
    process.exit(0);
  });
}
process.on('exit', saveNow);
