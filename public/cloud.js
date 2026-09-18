/* ============================================================================
 * cloud.js — ZeroTodo online sync layer
 * ----------------------------------------------------------------------------
 * Wraps the local storage engine (storage.js) WITHOUT touching its safety
 * logic. IndexedDB + localStorage stay the fast, crash-proof primary store;
 * this file mirrors every committed change to the server and reconciles with
 * it, so the data also survives:
 *
 *   - "Clear site data", private browsing, browser reinstalls
 *   - switching devices / browsers / computers
 *
 * Protocol (see server.js):
 *   startup  → GET /api/state  → per-record last-write-wins merge with local
 *             → adopt if anything changed → (re)push local-only changes
 *   commits  → debounce ~700 ms → POST /api/sync { baseRev, state, tombstones }
 *             → server returns the authoritative merged state → adopt
 *   live     → EventSource /api/events → pull + merge (other devices/tabs)
 *
 * Deletes are remembered as store-scoped tombstones (localStorage
 * `zt_tombstones_v1`, 30-day TTL: "tasks:<id>" / "trash:<id>") so a deleted
 * task can never resurface from a stale copy on another device — while a
 * move (soft delete into trash, or restore out of it) propagates correctly.
 *
 * Offline: the app keeps working fully (local-first design); pushes are
 * retried with backoff and a full re-push happens when the connection
 * returns. A failed push can never lose data — it only delays visibility.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const CFG_KEY = 'zt_cloud_v1';        // { enabled, endpoint, token }
  const TOMBS_KEY = "zt_tombstones_v1"; // { "tasks:003cid>": deletedAt, "trash:003cid>": deletedAt }
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
  let online = false;         // server reachable + (auth ok)
  let attached = false;
  let replaceNext = false;    // set after Import: next push uses mode:'replace'
  let es = null;

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
      settings: { theme: st.settings.theme, exportReminderDays: st.settings.exportReminderDays }, // device-local bits excluded
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
  }

  function fmtTime(ms) {
    return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
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
    // Store-scoped tombstones: a `tasks:id` delete must not remove the
    // trash copy of the same id (soft delete), and vice versa.
    tasks = tasks.filter((t) => !(tombstones['tasks:' + t.id] >= (t.updatedAt || 0)));
    trash = trash.filter((t) => !(tombstones['trash:' + t.id] >= (t.updatedAt || 0)));
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
    if (tombChanged) saveJSON(TOMBS_KEY, tombstones);

    const before = JSON.stringify({ t: st.tasks, r: st.trash });
    const after = JSON.stringify({ t: tasks, r: trash });
    const changed = before !== after;

    if (changed) {
      st.tasks = tasks;
      st.trash = trash;
    }
    // Settings: server copy wins only when it is strictly fresher than ours
    // (device prefs like theme ride along; this tab's pending settings commit
    // will re-push them anyway).
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

  /* --------------------------------- pull ---------------------------------- */

  async function pull({ authoritative } = {}) {
    const ep = endpoint();
    if (!ep || !cfg.enabled) return false;
    const res = await fetchT(ep + '/api/state', { headers: headers() });
    if (res.status === 401) { online = false; setPill('error', '☁ Passkey needed'); return false; }
    if (!res.ok) throw new Error('GET /api/state → ' + res.status);
    const remote = await res.json();
    const changed = adoptRemote(remote, { authoritative });
    await persistAndRender(changed);
    return remote;
  }

  /* --------------------------------- push ---------------------------------- */

  async function push(force) {
    if (!attached || !cfg.enabled) return false;
    const ep = endpoint();
    if (!ep) return false;
    const st = getState();
    const snap = snapshotJson();
    if (!force && snap === lastSyncedJson) return; // nothing new for the server

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
          state: { savedAt: Date.now(), settings: st.settings, tasks: st.tasks, trash: st.trash },
          tombstones,
        }),
      });
      if (res.status === 401) {
        online = false;
        setPill('error', '☁ Passkey needed');
        showTokenBanner();
        return false;
      }
      if (!res.ok) throw new Error('POST /api/sync → ' + res.status);
      remote = await res.json();
    } catch (e) {
      online = false;
      setPill('off', '☁ Offline — saved locally');
      scheduleRetry();
      return false;
    }

    // The server response is the authoritative merged view (it includes our
    // own change + anything other devices pushed in the meantime).
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
    setPill('saved', '☁ Synced · ' + fmtTime(st.lastSyncedAt));
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
    const ep = endpoint();
    if (!ep || typeof EventSource === 'undefined' || !cfg.enabled) return;
    if (es) { try { es.close(); } catch (_) {} es = null; }
    const q = 'id=' + encodeURIComponent(CLIENT_ID) + (cfg.token ? '&token=' + encodeURIComponent(cfg.token) : '');
    try {
      es = new EventSource(ep + '/api/events?' + q);
    } catch (_) { return; }
    es.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.type === 'sync' && d.rev && d.rev === serverRev) return; // our own echo
      // Another device committed: pull + LWW-merge.
      pull({ authoritative: false })
        .then((remote) => {
          if (!remote) return;
          // If our local state has something the server doesn't, push it.
          if (snapshotJson() !== lastSyncedJson) schedulePush();
        })
        .catch(() => { online = false; setPill('off', '☁ Offline — saved locally'); scheduleRetry(); });
    };
    es.onerror = () => { /* EventSource auto-reconnects (retry: 3000 set by server) */ };
  }

  /* ------------------------------ token banner ------------------------------ */

  function showTokenBanner() {
    const host = document.getElementById('bannerHost');
    if (!host || document.getElementById('zt-token-banner')) return;
    const el = document.createElement('div');
    el.id = 'zt-token-banner';
    el.className = 'banner banner-warn';
    el.innerHTML =
      '<span class="banner-msg">The server needs a passkey before your data can sync online. Open ⚙ Settings → Cloud sync and paste it.</span>' +
      '<button class="banner-close" aria-label="Dismiss">×</button>';
    el.querySelector('.banner-close').onclick = () => el.remove();
    host.appendChild(el);
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.hidden = false;
    const inp = document.getElementById('cloudToken');
    if (inp) inp.focus();
  }

  /* ------------------------------ settings UI ------------------------------ */

  function wireSettingsUI(onReconnect) {
    const epIn = document.getElementById('cloudEndpoint');
    const tkIn = document.getElementById('cloudToken');
    const enIn = document.getElementById('cloudEnabled');
    const saveBtn = document.getElementById('cloudSaveBtn');
    const info = document.getElementById('cloudInfo');
    if (!epIn || !tkIn || !saveBtn) return;
    epIn.value = cfg.endpoint || '';
    tkIn.value = cfg.token || '';
    if (enIn) enIn.checked = cfg.enabled !== false;
    if (info) info.textContent = 'Endpoint: ' + (endpoint() || 'not available (open the app via http)');

    saveBtn.onclick = async () => {
      cfg.endpoint = epIn.value.trim().replace(/\/+$/, '');
      cfg.token = tkIn.value.trim();
      if (enIn) cfg.enabled = !!enIn.checked;
      saveJSON(CFG_KEY, cfg);
      saveBtn.disabled = true;
      try { await onReconnect(); } finally { saveBtn.disabled = false; }
      if (info) info.textContent = 'Endpoint: ' + (endpoint() || 'not available');
    };
  }

  /* ------------------------------ main entry ------------------------------- */

  /**
   * Attach after the local engine has recovered. Never throws: on any problem
   * the app simply continues in local-only mode (which is what ZeroTodo was
   * before cloud sync existed).
   */
  async function attach(deps) {
    if (attached) return;
    store = deps.store;
    getState = deps.getState;
    onChange = deps.onChange;

    // --- capture deletes as store-scoped tombstones + schedule pushes -----
    // Tombstone keys are "tasks:<id>" / "trash:<id>": a delete only kills
    // records in the store it happened in. That makes moves (soft delete =
    // tasks→trash, restore/undo = trash→tasks) propagate correctly: the stale
    // copy on other devices is removed from the store it left, while the new
    // copy in the destination store survives. Hard deletes (destroy, empty
    // trash) tombstone the trash side and fully remove the record everywhere.
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

    // Import replaces the whole dataset: the next push must be a replace, so
    // records that only exist on the server are removed too.
    const origReplace = store.replaceMemory.bind(store);
    store.replaceMemory = function (tasks, trash) {
      replaceNext = true;
      return origReplace(tasks, trash);
    };

    // A full local disk heal shouldn't push by itself — leave resync untouched
    // (it funnels through commit with isResync → no user-visible ops → no
    // push spam beyond the debounced snapshot push, which is idempotent).

    attached = true;
    wireSettingsUI(async () => { serverRev = null; lastSyncedJson = null; await reconnect(); });
    await reconnect();

    // Re-sync when the browser comes back online or the tab becomes visible.
    global.addEventListener('online', () => { push(false).catch(() => {}); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && attached && (!online || endpoint())) {
        pull({ authoritative: false }).then((remote) => {
          if (remote && snapshotJson() !== lastSyncedJson) schedulePush();
        }).catch(() => {});
      }
    });
  }

  async function reconnect() {
    const ep = endpoint();
    if (!cfg.enabled || !ep) {
      online = false;
      setPill('off', '☁ Local only');
      return;
    }
    try {
      const probe = await fetchT(ep + '/api/config', {}, 8000);
      if (!probe.ok) throw new Error('config http ' + probe.status);
      const conf = await probe.json();
      if (conf.authRequired && !cfg.token) {
        online = false;
        setPill('error', '☁ Passkey needed');
        showTokenBanner();
        connectStream(); // SSE will work once the token is set; harmless meanwhile
        return;
      }
      await pull({ authoritative: false });
      // Then always push: local may be ahead of the server (edits made while
      // offline, or first-run migration of data that predates the server).
      // The server-side LWW merge makes this idempotent and conflict-safe,
      // so an extra push costs one request and can never duplicate or lose.
      const pushed = await push(true);
      if (pushed) {
        online = true;
        retryDelay = 5000;
        setPill('saved', '☁ Synced · ' + fmtTime(Date.now()));
      }
      connectStream();
    } catch (e) {
      online = false;
      setPill('off', '☁ Offline — saved locally');
      scheduleRetry();
      connectStream(); // EventSource will reconnect by itself when the server returns
    }
  }

  /* -------------------------------- exports -------------------------------- */

  global.ZTCloud = {
    attach,
    status: () => ({ online, serverRev, endpoint: endpoint() }),
    /** Force a manual "Sync now" (settings button / dev console). */
    syncNow: () => push(true),
  };
})(typeof window !== 'undefined' ? window : globalThis);
