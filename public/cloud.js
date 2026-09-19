/* ============================================================================
 * cloud.js — ZeroTodo online sync layer (multi-user)
 * ----------------------------------------------------------------------------
 * Wraps the local storage engine (storage.js) WITHOUT touching its safety
 * logic. IndexedDB + localStorage stay the fast, crash-proof primary store;
 * this file mirrors every committed change to the server and reconciles with
 * it, so data also survives cleared browser data and follows you to other
 * devices — now behind YOUR OWN account (username + password), no passkeys
 * to paste: the Supabase key and the session-signing secret live only in the
 * server's environment.
 *
 * Auth flow:
 *   /api/config says authRequired → GET /api/me with the stored session token
 *     valid    → signed in, sync normally
 *     401      → guest mode: app works fully on this browser's storage, a
 *               sign-in card invites you; nothing syncs until you sign in.
 *   Sign in / Create account → server returns a 30-day signed session token,
 *   stored in localStorage and sent as Authorization: Bearer on every call
 *   (SSE gets it as a query param since EventSource can't set headers).
 *
 * Protocol (see server.js):
 *   startup  → GET /api/state  → per-record last-write-wins merge with local
 *             → adopt if anything changed → (re)push local-only changes
 *   commits  → debounce ~700 ms → POST /api/sync { baseRev, state, tombstones }
 *             → server returns the authoritative merged view → adopt
 *   live     → EventSource /api/events → pull + merge (your other devices)
 *
 * Deletes are store-scoped tombstones (localStorage `zt_tombstones_v1`,
 * 30-day TTL: "tasks:<id>" / "trash:<id>") so a deleted task can never
 * resurface from a stale copy on another device, while moves (soft delete,
 * restore) propagate correctly. Task ids are UUIDs, so a shared tombstone
 * map across accounts on one browser is inert for other users' ids.
 *
 * Offline: the app keeps working fully (local-first design); pushes are
 * retried with backoff and a full re-push happens when the connection
 * returns. A failed push can never lose data — it only delays visibility.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const CFG_KEY = 'zt_cloud_v1';        // { enabled, endpoint, token(session) }
  const TOMBS_KEY = 'zt_tombstones_v1'; // { "tasks:<id>": deletedAt, "trash:<id>": deletedAt }
  const TOMB_TTL = 30 * 24 * 60 * 60 * 1000;
  const PUSH_DEBOUNCE = 700;
  const CLIENT_ID = (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2);

  const cfg = loadJSON(CFG_KEY, { enabled: true, endpoint: '', token: '' });
  let tombstones = loadJSON(TOMBS_KEY, {});

  let store = null;
  let getState = null;
  let onChange = null;
  let serverRev = null;       // last rev we know the server holds
  let lastSyncedJson = null;  // serialized snapshot matching the server (loop breaker)
  let pushTimer = null;
  let retryTimer = null;
  let retryDelay = 5000;
  let online = false;         // server reachable AND signed in
  let attached = false;
  let replaceNext = false;    // set after Import: next push uses mode:'replace'
  let es = null;
  let me = null;              // username once validated

  /* ------------------------------- utilities ------------------------------ */

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : fallback;
    } catch (_) { return fallback; }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* best effort */ }
  }

  function endpoint() {
    const e = (cfg.endpoint || '').trim().replace(/\/+$/, '');
    if (e) return e;
    return (global.location && /^https?:$/.test(location.protocol)) ? location.origin : '';
  }

  function headers(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (cfg.token) h.Authorization = 'Bearer ' + cfg.token;
    return h;
  }

  function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 15000);
    return fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
  }

  function snapshotJson() {
    const st = getState();
    return JSON.stringify({
      tasks: st.tasks,
      trash: st.trash,
      projects: st.projects,
      settings: { theme: st.settings.theme, exportReminderDays: st.settings.exportReminderDays },
    });
  }

  /* ---------------------------- status indicator ---------------------------- */

  function setPill(kind, text) {
    const pill = document.getElementById('cloudPill');
    const label = document.getElementById('cloudPillText');
    if (!pill) return;
    pill.classList.remove('saving', 'error', 'saved', 'off');
    pill.classList.add(kind);
    if (label) label.textContent = text;
    pill.style.cursor = me ? '' : 'pointer';
  }

  function syncLabel() {
    return '☁ Synced as ' + me;
  }

  function fmtTime(ms) {
    return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }

  /* ------------------------------ auth overlay ------------------------------ */

  function ensureOverlayCss() {
    if (document.getElementById('zt-auth-css')) return;
    const s = document.createElement('style');
    s.id = 'zt-auth-css';
    s.textContent =
      '.zt-auth-overlay{position:fixed;inset:0;background:rgba(10,14,25,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;backdrop-filter:blur(2px)}' +
      '.zt-auth-card{background:var(--panel,#fff);color:var(--text,#1d2433);border:1px solid var(--border,#e2e6ec);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);max-width:360px;width:100%;padding:22px}' +
      '.zt-auth-card h3{margin:0 0 4px;font-size:17px}' +
      '.zt-auth-card p{margin:0 0 14px;font-size:12.5px;color:var(--muted,#66707f)}' +
      '.zt-auth-card input{font:inherit;font-size:14px;width:100%;box-sizing:border-box;padding:9px 11px;margin:0 0 10px;border:1px solid var(--border,#d7dbe3);border-radius:9px;background:var(--bg,#f5f6f8);color:var(--text,#1d2433)}' +
      '.zt-auth-actions{display:flex;gap:8px;margin-top:2px}' +
      '.zt-auth-actions .btn{flex:1}' +
      '.zt-auth-err{font-size:12.5px;color:var(--danger,#b91c1c);min-height:16px;margin-top:10px}' +
      '.zt-auth-note{font-size:11.5px;color:var(--muted,#66707f);margin-top:12px;text-align:center}';
    document.head.appendChild(s);
  }

  /** Open the sign-in / create-account card. Callback keeps the app honest:
   *  everything the guest typed stays local until login, then merges up. */
  function openOverlay(mode) {
    if (document.getElementById('zt-auth-overlay')) return;
    ensureOverlayCss();
    const ov = document.createElement('div');
    ov.id = 'zt-auth-overlay';
    ov.className = 'zt-auth-overlay';
    ov.innerHTML =
      '<div class="zt-auth-card" role="dialog" aria-modal="true">' +
        '<h3 id="zt-auth-title">Sign in to sync ☁</h3>' +
        '<p id="zt-auth-sub">Your tasks are safe on this device; sign in (or create an account) to also keep them on the server and on your other devices.</p>' +
        '<input id="zt-auth-user" placeholder="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32">' +
        '<input id="zt-auth-pass" type="password" placeholder="password (8+ characters)" autocomplete="current-password" maxlength="128">' +
        '<div class="zt-auth-actions">' +
          '<button class="btn btn-primary" id="zt-auth-login" type="button">Sign in</button>' +
          '<button class="btn btn-ghost" id="zt-auth-signup" type="button">Create account</button>' +
        '</div>' +
        '<div class="zt-auth-err" id="zt-auth-err"></div>' +
        '<div class="zt-auth-note">No account yet? Pick a username + password once per device — that replaces the old passkey.</div>' +
      '</div>';
    document.body.appendChild(ov);
    const userInput = ov.querySelector('#zt-auth-user');
    const passInput = ov.querySelector('#zt-auth-pass');
    const errEl = ov.querySelector('#zt-auth-err');
    if (mode === 'signup') {
      ov.querySelector('#zt-auth-title').textContent = 'Create your account';
      userInput.autocomplete = 'new-username';
      passInput.autocomplete = 'new-password';
    }
    userInput.focus();

    const close = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

    async function submit(asSignup) {
      errEl.textContent = '';
      const username = userInput.value.toLowerCase().trim();
      const password = passInput.value;
      if (!username || !password) { errEl.textContent = 'Fill in both fields.'; return; }
      const btn = ov.querySelector(asSignup ? '#zt-auth-signup' : '#zt-auth-login');
      const other = ov.querySelector(asSignup ? '#zt-auth-login' : '#zt-auth-signup');
      btn.disabled = other.disabled = true;
      btn.textContent = asSignup ? 'Creating…' : 'Signing in…';
      try {
        const res = await fetchT(endpoint() + (asSignup ? '/api/signup' : '/api/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          errEl.textContent = (d && d.error) || ('server returned ' + res.status);
          btn.textContent = asSignup ? 'Create account' : 'Sign in';
          btn.disabled = other.disabled = false;
          return;
        }
        cfg.token = d.token;
        saveJSON(CFG_KEY, cfg);
        close();
        await reconnect(); // pull + push as the new identity
      } catch (e) {
        errEl.textContent = 'Could not reach the server: ' + (e && e.message || e);
        btn.textContent = asSignup ? 'Create account' : 'Sign in';
        btn.disabled = other.disabled = false;
      }
    }
    ov.querySelector('#zt-auth-login').onclick = () => submit(false);
    ov.querySelector('#zt-auth-signup').onclick = () => submit(true);
    passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(false); });
  }

  async function signOut() {
    try { await fetchT(endpoint() + '/api/logout', { method: 'POST', headers: headers() }, 5000); } catch (_) {}
    cfg.token = '';
    saveJSON(CFG_KEY, cfg);
    location.reload(); // clean detach: local storage keeps data, sync stops
  }

  function updateAcctUI() {
    const name = document.getElementById('cloudAcctName');
    const out = document.getElementById('cloudSignOutBtn');
    const inb = document.getElementById('cloudSignInBtn');
    if (name) name.textContent = me || 'Not signed in';
    if (out) out.hidden = !me;
    if (inb) inb.hidden = !!me;
  }

  /* --------------------------- merge / adopt logic -------------------------- */

  function pruneTombstones() {
    const now = Date.now();
    let changed = false;
    for (const [id, at] of Object.entries(tombstones)) {
      if (now - at > TOMB_TTL) { delete tombstones[id]; changed = true; }
    }
    if (changed) saveJSON(TOMBS_KEY, tombstones);
  }

  /** LWW-merge server records into the LIVE memory state. Returns changed? */
  function adoptRemote(remote, { authoritative }) {
    const st = getState();
    const nowTomb = { ...tombstones, ...(remote.tombstones || {}) };
    saveJSON(TOMBS_KEY, nowTomb);
    tombstones = nowTomb;
    pruneTombstones();

    const mergeList = (localArr, remoteArr) => {
      const byId = new Map();
      for (const t of localArr || []) byId.set(t.id, t);
      for (const t of remoteArr || []) {
        const cur = byId.get(t.id);
        if (authoritative || !cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) byId.set(t.id, t);
      }
      return [...byId.values()];
    };

    let tasks = mergeList(st.tasks, remote.tasks);
    let trash = mergeList(st.trash, remote.trash);
    let projects = mergeList(st.projects || [], remote.projects || []);
    // Store-scoped tombstones: a `tasks:id` delete must not remove the
    // trash copy of the same id (soft delete), and vice versa.
    tasks = tasks.filter((t) => !(tombstones['tasks:' + t.id] >= (t.updatedAt || 0)));
    trash = trash.filter((t) => !(tombstones['trash:' + t.id] >= (t.updatedAt || 0)));
    projects = projects.filter((p) => !(tombstones['projects:' + p.id] >= (p.updatedAt || 0)));
    // App invariant (storage.js cleanPayload): a record lives in one store; live wins.
    { const live = new Set(tasks.map((t) => t.id)); trash = trash.filter((t) => !live.has(t.id)); }
    // Prune redundant tombstones (a live record newer than the deletion has
    // won; any future delete writes a fresh tombstone) — mirrors server.js.
    let tombChanged = false;
    for (const t of tasks) {
      const k = 'tasks:' + t.id;
      if (tombstones[k] && (t.updatedAt || 0) > tombstones[k]) { delete tombstones[k]; tombChanged = true; }
    }
    for (const t of trash) {
      const k = 'trash:' + t.id;
      if (tombstones[k] && (t.updatedAt || 0) > tombstones[k]) { delete tombstones[k]; tombChanged = true; }
    }
    for (const p of projects) {
      const k = 'projects:' + p.id;
      if (tombstones[k] && (p.updatedAt || 0) > tombstones[k]) { delete tombstones[k]; tombChanged = true; }
    }
    if (tombChanged) saveJSON(TOMBS_KEY, tombstones);

    const before = JSON.stringify({ t: st.tasks, r: st.trash, p: st.projects });
    const after = JSON.stringify({ t: tasks, r: trash, p: projects });
    const changed = before !== after;

    if (changed) {
      st.tasks = tasks;
      st.trash = trash;
      st.projects = projects;
    }
    if (remote.savedAt && (!st.lastSavedAt || remote.savedAt > st.lastSavedAt) && remote.settings) {
      Object.assign(st.settings, remote.settings);
    }
    if (Number.isFinite(remote.rev)) serverRev = remote.rev;
    return changed;
  }

  async function persistAndRender(changed) {
    if (changed) {
      try { await store.resync(); } catch (_) { /* engine handles its own errors */ }
      if (onChange) onChange();
    }
  }

  function handleUnauthorized() {
    // Expired/invalid session: drop to guest mode, invite sign-in. Local data
    // and pending commits are untouched — after sign-in they upload.
    me = null;
    online = false;
    if (cfg.token) { cfg.token = ''; saveJSON(CFG_KEY, cfg); }
    setPill('off', '☁ Tap to sign in for sync');
    updateAcctUI();
    openOverlay();
  }

  /* --------------------------------- pull ---------------------------------- */

  async function pull({ authoritative } = {}) {
    const ep = endpoint();
    if (!ep || !cfg.enabled) return false;
    const res = await fetchT(ep + '/api/state', { headers: headers() });
    if (res.status === 401) { handleUnauthorized(); return false; }
    if (!res.ok) throw new Error('GET /api/state → ' + res.status);
    const remote = await res.json();
    const changed = adoptRemote(remote, { authoritative });
    await persistAndRender(changed);
    return remote;
  }

  /* --------------------------------- push ---------------------------------- */

  async function push(force) {
    if (!attached || !cfg.enabled || !me) return false;
    const ep = endpoint();
    if (!ep) return false;
    const st = getState();
    const snap = snapshotJson();
    if (!force && snap === lastSyncedJson) return false; // nothing new for the server

    setPill('saving', '☁ Syncing…');
    let remote;
    try {
      const mode = replaceNext ? 'replace' : 'merge';
      replaceNext = false;
      const res = await fetchT(ep + '/api/sync', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          clientId: CLIENT_ID,
          baseRev: serverRev,
          mode,
          state: { savedAt: Date.now(), settings: st.settings, tasks: st.tasks, trash: st.trash, projects: st.projects },
          tombstones,
        }),
      });
      if (res.status === 401) { handleUnauthorized(); return false; }
      if (!res.ok) throw new Error('POST /api/sync → ' + res.status);
      remote = await res.json();
    } catch (e) {
      online = false;
      setPill('off', '☁ Offline — saved locally');
      scheduleRetry();
      return false;
    }

    // The server response is the authoritative merged view for THIS user.
    const changed = adoptRemote(remote, { authoritative: true });
    if (changed) {
      try { await store.resync(); } catch (_) {}
      if (onChange) onChange();
    }
    lastSyncedJson = snapshotJson();
    online = true;
    retryDelay = 5000;
    clearTimeout(retryTimer); retryTimer = null;
    st.lastSyncedAt = Date.now();
    setPill('saved', syncLabel() + ' · ' + fmtTime(st.lastSyncedAt));
    return true;
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(false), PUSH_DEBOUNCE);
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 2, 5 * 60000);
      push(false).catch(() => {});
    }, retryDelay);
  }

  /* ------------------------------- SSE stream ------------------------------- */

  function connectStream() {
    disconnectStream();
    const ep = endpoint();
    if (!ep || typeof EventSource === 'undefined' || !cfg.enabled || !me) return;
    const q = 'id=' + encodeURIComponent(CLIENT_ID) + (cfg.token ? '&token=' + encodeURIComponent(cfg.token) : '');
    try {
      es = new EventSource(ep + '/api/events?' + q);
    } catch (_) { return; }
    es.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.type === 'sync' && d.rev && d.rev === serverRev) return; // our own echo
      pull({ authoritative: false })
        .then((remote) => {
          if (!remote) return;
          if (snapshotJson() !== lastSyncedJson) schedulePush();
        })
        .catch(() => { online = false; setPill('off', '☁ Offline — saved locally'); scheduleRetry(); });
    };
    es.onerror = () => { /* EventSource auto-reconnects (retry: 3000) */ };
  }

  function disconnectStream() {
    if (es) { try { es.close(); } catch (_) {} es = null; }
  }

  /* ------------------------------ settings UI ------------------------------ */

  function wireSettingsUI() {
    const epIn = document.getElementById('cloudEndpoint');
    const enIn = document.getElementById('cloudEnabled');
    const saveBtn = document.getElementById('cloudSaveBtn');
    const info = document.getElementById('cloudInfo');
    if (epIn) epIn.value = cfg.endpoint || '';
    if (enIn) enIn.checked = cfg.enabled !== false;
    if (info) info.textContent = 'Endpoint: ' + (endpoint() || 'not available (open the app via http)');

    if (saveBtn) saveBtn.onclick = async () => {
      if (epIn) cfg.endpoint = epIn.value.trim().replace(/\/+$/, '');
      if (enIn) cfg.enabled = !!enIn.checked;
      saveJSON(CFG_KEY, cfg);
      saveBtn.disabled = true;
      try { serverRev = null; lastSyncedJson = null; await reconnect(); } finally { saveBtn.disabled = false; }
      if (info) info.textContent = 'Endpoint: ' + (endpoint() || 'not available');
    };

    const signInBtn = document.getElementById('cloudSignInBtn');
    const signOutBtn = document.getElementById('cloudSignOutBtn');
    if (signInBtn) signInBtn.onclick = () => openOverlay();
    if (signOutBtn) signOutBtn.onclick = signOut;
    const pill = document.getElementById('cloudPill');
    if (pill) pill.addEventListener('click', () => { if (!me) openOverlay(); });
    updateAcctUI();
  }

  /* ------------------------------ main entry ------------------------------- */

  /**
   * Attach after the local engine has recovered. Never throws: on any problem
   * the app continues local-only/guest — nothing user-visible breaks.
   */
  async function attach(deps) {
    if (attached) return;
    store = deps.store;
    getState = deps.getState;
    onChange = deps.onChange;

    // --- capture deletes as store-scoped tombstones + schedule pushes -----
    // Tombstone keys are "tasks:<id>" / "trash:<id>": a delete only kills
    // records in the store it happened in. Moves (soft delete tasks→trash,
    // restore trash→tasks) propagate correctly; hard deletes (destroy, empty
    // trash) fully remove the record everywhere.
    const origCommit = store.commit.bind(store);
    store.commit = async function (ops, opts) {
      const ok = await origCommit(ops, opts);
      if (ok && attached) {
        let touched = false;
        for (const op of ops || []) {
          if (op && op.op === 'delete' && op.key && op.store) {
            tombstones[op.store + ':' + op.key] = Date.now();
            touched = true;
          }
        }
        if (touched) { saveJSON(TOMBS_KEY, tombstones); pruneTombstones(); }
        if ((ops || []).length) schedulePush();
      }
      return ok;
    };

    // Import replaces the whole dataset: the next push must be a replace.
    const origReplace = store.replaceMemory.bind(store);
    store.replaceMemory = function (...args) {
      replaceNext = true;
      return origReplace(...args);
    };

    attached = true;
    wireSettingsUI();
    await reconnect();

    global.addEventListener('online', () => { push(false).catch(() => {}); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && attached && me && endpoint()) {
        pull({ authoritative: false }).then((remote) => {
          if (remote && snapshotJson() !== lastSyncedJson) schedulePush();
        }).catch(() => {});
      }
    });
  }

  async function reconnect() {
    const ep = endpoint();
    if (!cfg.enabled || !ep) {
      online = false; me = null;
      setPill('off', '☁ Local only');
      updateAcctUI();
      return;
    }
    try {
      // 1. server up? do we have a valid session?
      const probe = await fetchT(ep + '/api/config', {}, 8000);
      if (!probe.ok) throw new Error('config http ' + probe.status);
      const conf = await probe.json();

      if (conf.authRequired) {
        if (!cfg.token) {
          online = false; me = null;
          setPill('off', '☁ Tap to sign in for sync');
          updateAcctUI();
          openOverlay();
          return;
        }
        const meRes = await fetchT(ep + '/api/me', { headers: headers() });
        if (meRes.status === 401) { handleUnauthorized(); return; }
        if (!meRes.ok) throw new Error('me http ' + meRes.status);
        me = (await meRes.json()).username || 'user';
      } else {
        me = me || 'shared'; // open mode (LAN box): no accounts needed
      }
      updateAcctUI();

      // 2. pull → merge → push. Same order as before; now scoped to this user.
      await pull({ authoritative: false });
      const pushed = await push(true);
      if (pushed) {
        online = true;
        retryDelay = 5000;
        setPill('saved', syncLabel() + ' · ' + fmtTime(Date.now()));
      }
      connectStream();
    } catch (e) {
      online = false;
      setPill('off', '☁ Offline — saved locally');
      scheduleRetry();
      connectStream();
    }
  }

  /* -------------------------------- exports -------------------------------- */

  global.ZTCloud = {
    attach,
    status: () => ({ online, user: me, serverRev, endpoint: endpoint() }),
    syncNow: () => push(true),
    signIn: () => openOverlay(),
    signOut,
  };
})(typeof window !== 'undefined' ? window : globalThis);
