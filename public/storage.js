/* ============================================================================
 * storage.js — ZeroTodo persistence engine (the safety-critical part)
 * ----------------------------------------------------------------------------
 * Design goals, in priority order:
 *
 *   1. NO SILENT LOSS. Every change is written to IndexedDB in a single
 *      atomic transaction (write-through, no batching). Only after IndexedDB
 *      has durably committed is an identical full copy mirrored to
 *      localStorage under the versioned key `todo_backup_v1`. If IndexedDB is
 *      ever lost, empty, or corrupted, startup recovery falls back to that
 *      mirror and re-syncs it back into IndexedDB.
 *
 *   2. A FAILED WRITE NEVER DESTROYS GOOD DATA. In-memory state is updated
 *      optimistically; if a write throws (quota, blocked tx, …) we keep the
 *      in-memory state, show a non-blocking banner, and retry via a full
 *      re-sync. We only ever write validated data, and only ever as
 *      read-modify-write record operations — never blind whole-store wipes.
 *
 *   3. EVERY read/write is wrapped in try/catch. Corrupted JSON, quota
 *      errors, missing IndexedDB (private mode) and cross-tab changes are
 *      all handled by falling back to the next available copy and telling
 *      the user.
 *
 * Storage layout
 *   IndexedDB  db "zerotodo" (IDB schema v1 — independent of the data's
 *              `schemaVersion`, which describes the task payload shape):
 *     ├─ store "tasks"  → live tasks, keyed by id
 *     ├─ store "trash"  → soft-deleted tasks, keyed by id (kept 30 days)
 *     └─ store "meta"   → single record { key:'meta', value:{ schemaVersion,
 *                      savedAt, settings } }
 *   localStorage:
 *     ├─ todo_backup_v1 → full JSON mirror { app, schemaVersion, savedAt,
 *                      settings, tasks, trash } — the redundant copy
 *     └─ todo_draft_v1  → in-progress form draft (managed by app.js)
 *
 * Cross-tab sync: every successful commit posts a BroadcastChannel message
 * AND (as a fallback for browsers without it) writes the localStorage
 * mirror, which fires a `storage` event in other tabs. Other tabs re-read
 * IndexedDB and adopt it — they never merge two in-memory copies, which is
 * how conflicting overwrites happen.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ----------------------------- Constants ------------------------------ */

  const DB_NAME = 'zerotodo';
  const DB_VERSION = 4; // v2 projects, v3 subtasks, v4 reminders (idempotent upgrades below)
  const STORE_TASKS = 'tasks';
  const STORE_TRASH = 'trash';
  const STORE_PROJECTS = 'projects';
  const STORE_SUBTASKS = 'subtasks';
  const STORE_REMINDERS = 'reminders';
  const STORE_META = 'meta';

  // Versioned localStorage keys: a future format can ship a *_v2 key without
  // clobbering what older versions wrote.
  const LS_BACKUP_KEY = 'todo_backup_v1';
  const LS_DRAFT_KEY = 'todo_draft_v1';
  const BC_CHANNEL = 'zerotodo-sync-v1';

  // The data-shape version written by this app. When you change the task or
  // settings shape, bump this and add a MIGRATIONS[oldVersion] step below.
  const SCHEMA_VERSION = 5;

  // Trash retention: items are auto-purged 30 days after being trashed.
  const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  // Stable id for THIS tab so it can ignore its own sync broadcasts.
  const TAB_ID = (global.crypto && global.crypto.randomUUID)
    ? global.crypto.randomUUID()
    : 'tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  const DEFAULT_SETTINGS = Object.freeze({
    theme: 'auto',               // 'light' | 'dark' | 'auto'
    exportReminderDays: 7,       // 0 = reminder off
    lastExportDate: null,        // set when the user exports a backup
    lastReminderDismissedAt: null,
    filterMode: 'all',           // 'all' | 'active' | 'completed' | 'trash'
    filterTag: null,
    filterProject: null,        // active project filter (like filterTag)
    subtaskAutoComplete: false, // "complete parent when all subtasks are done"
  });

  /* ----------------------------- Migrations ----------------------------- */

  // Migration registry: key = the schemaVersion the data currently has.
  // Each step receives the FULL payload {schemaVersion, tasks, trash, settings}
  // and returns the upgraded copy.
  //
  // IMPORTANT (zero-loss rule): migrations must PRESERVE any field they don't
  // recognize. They spread the record and only transform known fields, so
  // data written by other versions (or hand-edited) is never discarded.
  const MIGRATIONS = {
    // Live example migration, kept as a real path so the mechanism is proven
    // (see test/smoke.mjs): a hypothetical v0 payload stored tags as a
    // comma-separated string; v1 normalizes them to an array.
    0(payload) {
      const fix = (t) => ({
        ...t,
        tags: typeof t.tags === 'string'
          ? t.tags.split(',').map((s) => s.trim()).filter(Boolean)
          : Array.isArray(t.tags)
            ? t.tags.filter((x) => typeof x === 'string')
            : [],
      });
      return {
        ...payload,
        tasks: (payload.tasks || []).map(fix),
        trash: (payload.trash || []).map(fix),
      };
    },
    // v1 → v2: the Projects system. Entirely additive: every existing payload
    // keeps its shape; tasks get an explicit projectId (null = Inbox), and the
    // projects array is defaulted. Unknown fields still spread through.
    1(payload) {
      return {
        ...payload,
        projects: Array.isArray(payload.projects) ? payload.projects : [],
        tasks: (payload.tasks || []).map((t) => (
          typeof t.projectId === 'string' && t.projectId ? t : { ...t, projectId: null }
        )),
      };
    },
    // v2 → v3: subtasks. Entirely additive — a task with NO subtasks is
    // simply a task nothing references via parentTaskId, so all existing data
    // upgrades by defaulting the array.
    2(payload) {
      return { ...payload, subtasks: Array.isArray(payload.subtasks) ? payload.subtasks : [] };
    },
    // v3 → v4: calendar times. Purely additive — tasks without a time get an
    // explicit null and keep living on their dueDate alone.
    3(payload) {
      return {
        ...payload,
        tasks: (payload.tasks || []).map((t) => (
          typeof t.dueTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime) ? t : { ...t, dueTime: null }
        )),
      };
    },
    // v4 → v5: the Reminder engine + recurring tasks. Additive: the
    // reminders array defaults to empty (no old task ever had one), tasks get
    // an explicit recurrence (null = not recurring). triggerAt — the ONLY
    // scheduling field — is absolute epoch ms, computed from the task's
    // local dueDate/dueTime, so a timezone change can never shift a date:
    // the strings stay the truth, epochs are derived.
    4(payload) {
      return {
        ...payload,
        reminders: Array.isArray(payload.reminders) ? payload.reminders : [],
        tasks: (payload.tasks || []).map((t) => ('recurrence' in t ? t : { ...t, recurrence: null })),
        trash: (payload.trash || []).map((t) => ('recurrence' in t ? t : { ...t, recurrence: null })),
      };
    },
    // Future: 5(payload) { return { ...payload, /* transform */ }; }
    // …and bump SCHEMA_VERSION to 6.
  };

  /**
   * Upgrade `payload` to SCHEMA_VERSION by walking the migration chain.
   * Throws if no migration path exists (caller falls back to the next copy).
   */
  function migratePayload(payload) {
    let p = { ...payload };
    let v = Number.isFinite(p.schemaVersion) ? p.schemaVersion : 0;
    while (v < SCHEMA_VERSION) {
      const step = MIGRATIONS[v];
      if (!step) throw new Error('No migration path from data schema v' + v);
      p = { ...step(p), schemaVersion: v + 1 };
      v += 1;
    }
    return p;
  }

  /* ------------------------------ Helpers ------------------------------- */

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    // RFC4122-ish v4 fallback for very old browsers.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Recognize quota failures across engines (IDB + localStorage). */
  function isQuotaError(e) {
    if (!e) return false;
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    if (e.code === 22 || e.code === 1014) return true;
    return /quota/i.test(String(e.message || ''));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        return reject(new Error('IndexedDB is not available in this browser.'));
      }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        // Idempotent upgrades: safe to re-run if a future version adds stores.
        if (!db.objectStoreNames.contains(STORE_TASKS)) db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_TRASH)) db.createObjectStore(STORE_TRASH, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_SUBTASKS)) db.createObjectStore(STORE_SUBTASKS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_REMINDERS)) db.createObjectStore(STORE_REMINDERS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB.'));
      req.onblocked = () => reject(new Error('IndexedDB open is blocked by another open tab; close it and reload.'));
    });
  }

  /** Promise wrapper for a read-only transaction. */
  function readTx(d, storeNames, apply) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = d.transaction(storeNames, 'readonly'); } catch (e) { return reject(e); }
      tx.onerror = () => reject(tx.error || new Error('IndexedDB read failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB read aborted'));
      let result;
      try { result = apply(tx); } catch (e) { return reject(e); }
      Promise.resolve(result).then(resolve, reject);
    });
  }

  /** Promise wrapper for a read-write transaction. */
  function writeTx(d, storeNames, apply) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = d.transaction(storeNames, 'readwrite'); } catch (e) { return reject(e); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      try { apply(tx); }
      catch (e) { try { tx.abort(); } catch (_) { /* already dead */ } reject(e); }
    });
  }

  /* --------------------- Shape validation & coercion -------------------- */

  /**
   * Coerce one raw task record into the canonical shape. Unknown fields are
   * PRESERVED (spread first, then normalize known ones) so forward
   * compatibility is never broken. Returns false (and pushes nothing) if the
   * record is unusable (no id / no title) — callers count these as dropped.
   */
  function coerceTask(raw, into, isTrash) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (typeof raw.id !== 'string' || !raw.id) return false;
    if (typeof raw.title !== 'string' || !raw.title.trim()) return false;
    const now = Date.now();
    const t = { ...raw }; // ← keep unrecognized fields
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
    t.projectId = typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null;
    // Calendar support: an optional "HH:MM" placement on the due date. The
    // task remains the ONE source of truth for its dates — the calendar view
    // reads/writes exactly these two fields.
    t.dueTime = typeof raw.dueTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.dueTime) ? raw.dueTime : null;
    // Recurring tasks: the calendar/reminder engines derive everything else
    // from these + status. Advancing a cycle rewrites dueDate/dueTime.
    t.recurrence = raw.recurrence === 'daily' || raw.recurrence === 'weekly' || raw.recurrence === 'monthly'
      ? raw.recurrence : null;
    if (isTrash) t.trashedAt = Number(raw.trashedAt) || now;
    into.push(t);
    return true;
  }

  /**
   * Coerce a project record. Like tasks, unknown fields are preserved and
   * nothing is ever dropped for soft problems: a missing name becomes a
   * placeholder (the record's id and data must survive sync/recovery).
   * Only a missing id is fatal. deletedAt != null means "in trash".
   */
  function coerceProject(raw, into) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (typeof raw.id !== 'string' || !raw.id) return false;
    const now = Date.now();
    const p = { ...raw };
    p.id = raw.id;
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
    into.push(p);
    return true;
  }

  /**
   * Coerce a subtask record. Subtasks are FLAT siblings of tasks in the same
   * state document (per-record sync/merge — see CONVENTIONS.md). The UI
   * supports ONE level (task → subtasks); the record shape itself is
   * parent-agnostic so a future level is additive, and every subtree walk
   * carries a visited set, so malformed deep/cyclic data can never loop.
   * Subtasks have no trash of their own: a delete is tombstoned (UI offers an
   * 8 s undo); deleting the PARENT leaves subtasks untouched so restoring the
   * parent from trash re-attaches them, and only a PURGE cascades them away.
   */
  function coerceSubtask(raw, into) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (typeof raw.id !== 'string' || !raw.id) return false;
    if (typeof raw.parentTaskId !== 'string' || !raw.parentTaskId) return false;
    if (typeof raw.title !== 'string' || !raw.title.trim()) return false;
    const now = Date.now();
    const s = { ...raw };
    s.parentTaskId = raw.parentTaskId;
    s.title = raw.title.trim().slice(0, 200);
    s.completed = !!raw.completed;
    s.completedAt = Number.isFinite(Number(raw.completedAt)) && Number(raw.completedAt) > 0
      ? Number(raw.completedAt)
      : (s.completed ? now : null);
    s.position = Number.isFinite(Number(raw.position)) ? Number(raw.position) : 0;
    s.createdAt = Number(raw.createdAt) || now;
    s.updatedAt = Number(raw.updatedAt) || s.createdAt;
    into.push(s);
    return true;
  }

  /* Reminder record (schema v5). NEVER depends on a live JS timer: the
     record IS the schedule — the engine re-arms from it on every boot.
     Fields per spec: id, taskId, triggerAt, reminderType, enabled,
     delivered, dismissed, createdAt, updatedAt (+ status/custom/* extras). */
  const REMINDER_TYPES = ['onTime', 'm5', 'm10', 'm15', 'm30', 'h1', 'h2', 'd1', 'd2', 'custom'];
  const REMINDER_STATUSES = ['pending', 'triggered', 'dismissed', 'skipped', 'failed'];

  function coerceReminder(raw, into) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (typeof raw.id !== 'string' || !raw.id) return false;
    if (typeof raw.taskId !== 'string' || !raw.taskId) return false;
    const trig = Number(raw.triggerAt);
    if (!Number.isFinite(trig)) return false; // no fire time = not a reminder
    const now = Date.now();
    const r = { ...raw }; // lenient: preserve unknown fields, like the others
    r.taskId = raw.taskId;
    // An unknown type degrades to 'custom' (fires at its stored instant) —
    // never dropped, so an import from a newer build still notifies.
    r.reminderType = REMINDER_TYPES.indexOf(raw.reminderType) >= 0 ? raw.reminderType : 'custom';
    r.triggerAt = trig;
    r.enabled = raw.enabled !== false;
    r.delivered = !!raw.delivered;
    r.dismissed = !!raw.dismissed;
    r.status = REMINDER_STATUSES.indexOf(raw.status) >= 0 ? raw.status
      : (r.delivered ? 'triggered' : (r.dismissed ? 'dismissed' : 'pending'));
    // The booleans the spec names and the status enum must never disagree.
    if (r.status === 'dismissed') r.dismissed = true;
    if (r.status === 'skipped') r.dismissed = false;
    if (r.status === 'triggered' || r.status === 'failed') r.delivered = true;
    // Real-calendar validation (a Date round-trip), not just shape: 2026-13-99
    // or 2026-02-30 must not silently roll into another month.
    let cd = null;
    if (typeof raw.customDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.customDate)) {
      const parts = raw.customDate.split('-').map(Number);
      const probe = new Date(parts[0], parts[1] - 1, parts[2]);
      if (probe.getFullYear() === parts[0] && probe.getMonth() === parts[1] - 1 && probe.getDate() === parts[2]) cd = raw.customDate;
    }
    r.customDate = cd;
    r.customTime = typeof raw.customTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.customTime) ? raw.customTime : null;
    r.createdAt = Number(raw.createdAt) || now;
    r.updatedAt = Number(raw.updatedAt) || r.createdAt;
    into.push(r);
    return true;
  }

  /**
   * Lenient validation of a full payload (used for the localStorage backup,
   * import files, and recovery). Returns { ok, schemaVersion, savedAt,
   * tasks, trash, settings }. Records that fail coercion are silently
   * dropped here — cleanPayload below counts them.
   */
  function validatePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
    if (typeof data.app === 'string' && data.app !== 'zerotodo') return { ok: false }; // someone else's file
    if (!Array.isArray(data.tasks)) return { ok: false };
    const out = {
      ok: true,
      schemaVersion: Number.isFinite(data.schemaVersion) ? data.schemaVersion : 0,
      savedAt: Number(data.savedAt) || 0,
      tasks: [],
      trash: [],
      projects: [],
      subtasks: [],
      reminders: [],
      settings: null,
    };
    for (const raw of data.tasks) coerceTask(raw, out.tasks);
    if (Array.isArray(data.trash)) for (const raw of data.trash) coerceTask(raw, out.trash, true);
    if (Array.isArray(data.projects)) for (const raw of data.projects) coerceProject(raw, out.projects);
    if (Array.isArray(data.subtasks)) for (const raw of data.subtasks) coerceSubtask(raw, out.subtasks);
    if (Array.isArray(data.reminders)) for (const raw of data.reminders) coerceReminder(raw, out.reminders);
    if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) out.settings = data.settings;
    return out;
  }

  /**
   * Validate + dedupe a whole payload. Records that don't survive coercion
   * are dropped and counted (recovery surfaces the count to the user).
   * A task present in BOTH tasks and trash is kept live (live wins).
   */
  function cleanPayload(payload) {
    const tasks = [];
    const trash = [];
    let dropped = 0;
    const seen = new Set();
    for (const raw of (payload && Array.isArray(payload.tasks) ? payload.tasks : [])) {
      if (seen.has(raw && raw.id)) { dropped++; continue; }
      if (coerceTask(raw, tasks)) seen.add(raw.id);
      else dropped++;
    }
    const seenProj = new Set();
    const projects = [];
    for (const raw of (payload && Array.isArray(payload.projects) ? payload.projects : [])) {
      if (seenProj.has(raw && raw.id)) { dropped++; continue; }
      if (coerceProject(raw, projects)) seenProj.add(raw.id);
      else dropped++;
    }
    const seenSub = new Set();
    const subtasks = [];
    for (const raw of (payload && Array.isArray(payload.subtasks) ? payload.subtasks : [])) {
      if (seenSub.has(raw && raw.id)) { dropped++; continue; }
      if (coerceSubtask(raw, subtasks)) seenSub.add(raw.id);
      else dropped++;
    }
    const seenTrash = new Set();
    for (const raw of (payload && Array.isArray(payload.trash) ? payload.trash : [])) {
      if (seen.has(raw && raw.id) || seenTrash.has(raw && raw.id)) { dropped++; continue; }
      if (coerceTask(raw, trash, true)) seenTrash.add(raw.id);
      else dropped++;
    }
    // Reminders attach to a task — a live OR trashed one (restore must still
    // find its schedule). Anything pointing at nothing is stale → dropped.
    const ownerIds = new Set([...tasks, ...trash].map((t) => t.id));
    const seenRem = new Set();
    const reminders = [];
    for (const raw of (payload && Array.isArray(payload.reminders) ? payload.reminders : [])) {
      if (seenRem.has(raw && raw.id) || !ownerIds.has(raw && raw.taskId)) { dropped++; continue; }
      if (coerceReminder(raw, reminders)) seenRem.add(raw.id);
      else dropped++;
    }
    return {
      tasks,
      trash,
      projects,
      subtasks,
      reminders,
      settings: (payload && payload.settings && typeof payload.settings === 'object') ? payload.settings : {},
      dropped,
    };
  }

  /**
   * Heuristic: is the localStorage backup meaningfully NEWER than the
   * IndexedDB state? (Covers the rare case where an IDB commit was lost but
   * the last-resort pagehide mirror already captured it.) Requires both a
   * newer savedAt (with a 2 s grace) AND at least one task that is missing
   * or fresher in the backup.
   */
  function backupNewer(backup, idb) {
    if (!backup || !idb) return false;
    if (!backup.savedAt || !idb.savedAt) return false;
    if (backup.savedAt <= idb.savedAt + 2000) return false;
    const idbById = new Map((idb.tasks || []).map((t) => [t.id, t]));
    for (const t of backup.tasks || []) {
      const other = idbById.get(t.id);
      if (!other || (t.updatedAt || 0) > (other.updatedAt || 0)) return true;
    }
    const idbProj = new Map((idb.projects || []).map((p) => [p.id, p]));
    for (const p of backup.projects || []) {
      const other = idbProj.get(p.id);
      if (!other || (p.updatedAt || 0) > (other.updatedAt || 0)) return true;
    }
    const idbSub = new Map((idb.subtasks || []).map((s) => [s.id, s]));
    for (const s of backup.subtasks || []) {
      const other = idbSub.get(s.id);
      if (!other || (s.updatedAt || 0) > (other.updatedAt || 0)) return true;
    }
    const idbRem = new Map((idb.reminders || []).map((r) => [r.id, r]));
    for (const r of backup.reminders || []) {
      const other = idbRem.get(r.id);
      if (!other || (r.updatedAt || 0) > (other.updatedAt || 0)) return true;
    }
    return false;
  }

  /* --------------------------- Store factory ---------------------------- */

  /**
   * Create the storage engine.
   * Callbacks (all optional, all non-blocking UI concerns):
   *   onStatus('saving'|'saved'|'error', savedAt)  — drives the save pill
   *   onError(msg)          — non-recoverable write/read problems
   *   onQuota()             — QuotaExceededError detected (sticky warning)
   *   onQuotaCleared()      — a later write succeeded, quota seems free
   *   onBackupWarn(msg)     — IDB saved but the LS mirror failed
   *   onExternalChange()    — another tab committed; app should re-render
   */
  function createStore(callbacks) {
    const cb = Object.assign({
      onStatus() {}, onError() {}, onQuota() {}, onQuotaCleared() {},
      onBackupWarn() {}, onExternalChange() {},
    }, callbacks);

    let db = null;
    let idbAvailable = null;   // null = unknown, true/false after first attempt
    // The authoritative in-memory state. The UI mutates it directly (via
    // store.state); commit() persists it. A failed write never touches it.
    const memory = { tasks: [], trash: [], projects: [], subtasks: [], reminders: [], settings: { ...DEFAULT_SETTINGS } };
    let lastSavedAt = 0;
    let dirty = false;         // true while memory is ahead of disk (write failed)
    let resyncing = false;
    let quotaWarned = false;
    let bc = null;
    let resyncTimer = null;
    let externalTimer = null;
    let reloading = false;

    /* ------------------------- Low-level I/O ---------------------------- */

    async function ensureDB() {
      if (db) return db;
      if (idbAvailable === false) throw new Error('IndexedDB unavailable');
      try {
        const d = await openDB();
        db = d;
        idbAvailable = true;
        return d;
      } catch (e) {
        idbAvailable = false;
        throw e;
      }
    }

    async function loadFromIDB() {
      const d = await ensureDB();
      const data = await readTx(d, [STORE_TASKS, STORE_TRASH, STORE_PROJECTS, STORE_SUBTASKS, STORE_REMINDERS, STORE_META], (tx) => {
        const t = reqToPromise(tx.objectStore(STORE_TASKS).getAll());
        const tr = reqToPromise(tx.objectStore(STORE_TRASH).getAll());
        const pj = reqToPromise(tx.objectStore(STORE_PROJECTS).getAll());
        const sb = reqToPromise(tx.objectStore(STORE_SUBTASKS).getAll());
        const rm = reqToPromise(tx.objectStore(STORE_REMINDERS).getAll());
        const m = reqToPromise(tx.objectStore(STORE_META).get('meta'));
        return Promise.all([t, tr, pj, sb, rm, m]).then(([tasks, trash, projects, subtasks, reminders, meta]) => ({
          tasks, trash, projects, subtasks, reminders, meta: meta ? meta.value : null,
        }));
      });
      return data;
    }

    function metaRecord() {
      return {
        key: 'meta',
        value: {
          schemaVersion: SCHEMA_VERSION,
          savedAt: lastSavedAt || Date.now(),
          settings: memory.settings,
        },
      };
    }

    function serializeBackup(at) {
      at = at || lastSavedAt || Date.now();
      return JSON.stringify({
        app: 'zerotodo',
        type: 'backup',
        schemaVersion: SCHEMA_VERSION,
        savedAt: at,
        exportedAt: new Date(at).toISOString(),
        settings: memory.settings,
        tasks: memory.tasks,
        trash: memory.trash,
        projects: memory.projects,
        subtasks: memory.subtasks,
        reminders: memory.reminders,
      });
    }

    /** Read the redundant localStorage mirror. Never throws. */
    function readBackup() {
      let raw = null;
      try { raw = global.localStorage.getItem(LS_BACKUP_KEY); }
      catch (e) { return { raw: null, state: null, error: 'unreadable' }; }
      if (!raw) return { raw: null, state: null, error: null };
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { return { raw, state: null, error: 'parse' }; } // corrupted JSON
      const shape = validatePayload(parsed);
      if (!shape.ok) return { raw, state: null, error: 'shape' };
      return {
        raw,
        state: {
          schemaVersion: shape.schemaVersion,
          savedAt: shape.savedAt,
          tasks: shape.tasks,
          trash: shape.trash,
          projects: shape.projects,
          subtasks: shape.subtasks,
          reminders: shape.reminders || [],
          settings: shape.settings || {},
        },
        error: null,
      };
    }

    /**
     * DUAL-WRITE step 2: mirror the full in-memory state to localStorage.
     * Only called after an IndexedDB commit succeeded (or as the last-resort
     * pagehide mirror), so IDB is always the fresher of the two copies.
     */
    function mirrorToLocalStorage() {
      if (!memory.tasks.length && !memory.trash.length && !lastSavedAt) return true;
      try {
        global.localStorage.setItem(LS_BACKUP_KEY, serializeBackup());
        if (quotaWarned) { quotaWarned = false; cb.onQuotaCleared(); }
        return true;
      } catch (e) {
        // The IDB write already succeeded, so nothing is lost — but the
        // mirror is the copy we'd fall back to after catastrophic IDB loss,
        // so a quota error here must be surfaced loudly.
        if (isQuotaError(e)) { quotaWarned = true; cb.onQuota(); }
        else cb.onBackupWarn('IndexedDB saved your change, but the localStorage backup mirror failed (' +
          (e && e.message ? e.message : e) + '). Data is safe in IndexedDB.');
        return false;
      }
    }

    function broadcast() {
      if (!bc) return;
      try { bc.postMessage({ type: 'committed', source: TAB_ID, at: Date.now() }); }
      catch (_) { /* channel closed; the storage event still covers other tabs */ }
    }

    /* ------------------------- Commit pipeline -------------------------- */

    /**
     * Validate every operation BEFORE it may touch disk.
     * (Requirement: validate the new data shape before committing.)
     */
    function validateOp(op) {
      if (!op || typeof op !== 'object') throw new Error('invalid operation');
      if (op.store !== STORE_TASKS && op.store !== STORE_TRASH && op.store !== STORE_PROJECTS && op.store !== STORE_SUBTASKS && op.store !== STORE_REMINDERS && op.store !== STORE_META) {
        throw new Error('unknown store: ' + op.store);
      }
      if (op.op === 'put') {
        const v = op.value;
        if (!v || typeof v !== 'object') throw new Error('put needs an object value');
        if (op.store === STORE_META) {
          if (v.key !== 'meta' || !v.value) throw new Error('invalid meta record');
        } else if (op.store === STORE_PROJECTS) {
          const sink = [];
          if (!coerceProject(v, sink)) throw new Error('project failed validation (needs a string id)');
        } else if (op.store === STORE_SUBTASKS) {
          const sink = [];
          if (!coerceSubtask(v, sink)) throw new Error('subtask failed validation (needs string id + parentTaskId + title)');
        } else if (op.store === STORE_REMINDERS) {
          const sink = [];
          if (!coerceReminder(v, sink)) throw new Error('reminder failed validation (needs string id + taskId + finite triggerAt)');
        } else {
          // Reuse the same coercion rules as recovery: no id/title → refuse.
          const sink = [];
          if (!coerceTask(v, sink, op.store === STORE_TRASH)) {
            throw new Error('record failed validation (needs a string id and title)');
          }
          if (op.store === STORE_TRASH && !v.trashedAt) throw new Error('trashed record needs trashedAt');
        }
      } else if (op.op === 'delete') {
        if (!op.key) throw new Error('delete needs a key');
      } else {
        throw new Error('unknown operation type: ' + op.op);
      }
    }

    /**
     * THE write path. Every mutation in the app funnels through here.
     *   (1) validate the full intended change
     *   (2) if a previous write left memory ahead of disk, heal with a full
     *       re-sync first
     *   (3) apply ALL record changes + the meta record in ONE atomic IDB
     *       transaction — all-or-nothing, no partial writes
     *   (4) only after success: mirror the identical state to localStorage
     *   (5) broadcast to other tabs
     *   Failure path: memory is kept untouched-for-worse, a banner is shown,
     *   and a background re-sync retries. Returns true/false (never throws).
     */
    async function commit(ops, opts = {}) {
      try {
        for (const op of ops) validateOp(op);
      } catch (e) {
        cb.onError('Refused to write invalid data: ' + e.message);
        return false;
      }

      cb.onStatus('saving');
      lastSavedAt = Date.now();

      if (dirty && !resyncing && !opts.isResync) {
        try { await fullResync(); } catch (_) { /* resync reports its own failure */ }
      }

      try {
        if (idbAvailable !== false) {
          const d = await ensureDB();
          const storeNames = new Set(ops.map((o) => o.store));
          storeNames.add(STORE_META); // every commit refreshes meta (savedAt + settings)
          await writeTx(d, [...storeNames], (tx) => {
            for (const op of ops) {
              const os = tx.objectStore(op.store);
              if (op.op === 'put') os.put(op.value);
              else os.delete(op.key);
            }
            tx.objectStore(STORE_META).put(metaRecord());
          });
        }
        // Dual-write step 2 — safe now: IDB has the new state durably.
        mirrorToLocalStorage();
        dirty = false;
        broadcast();
        cb.onStatus('saved', lastSavedAt);
        return true;
      } catch (e) {
        // A failed write must never wipe good in-memory state: it is kept
        // (the user still sees their change), the pill flips to error, and a
        // full re-sync is scheduled to persist it.
        dirty = true;
        cb.onStatus('error');
        if (isQuotaError(e)) {
          quotaWarned = true;
          cb.onQuota();
        } else {
          cb.onError('A storage write failed: ' + (e && e.message ? e.message : e) +
            ' Your change is kept in memory and will be retried automatically.');
        }
        scheduleResync();
        return false;
      }
    }

    /**
     * Full-state re-sync: put every in-memory record AND delete disk records
     * that are no longer in memory (read-modify-write at whole-state
     * granularity). Used to repair after a failed write, to re-sync a
     * backup-restored state into an empty IDB, and before adopting another
     * tab's changes.
     */
    async function fullResync() {
      if (!memory) return false;
      resyncing = true;
      try {
        const ops = [];
        for (const t of memory.tasks) ops.push({ store: STORE_TASKS, op: 'put', value: t });
        for (const t of memory.trash) ops.push({ store: STORE_TRASH, op: 'put', value: t });
        for (const p of memory.projects) ops.push({ store: STORE_PROJECTS, op: 'put', value: p });
        for (const s of memory.subtasks) ops.push({ store: STORE_SUBTASKS, op: 'put', value: s });
        for (const r of memory.reminders) ops.push({ store: STORE_REMINDERS, op: 'put', value: r });
        if (idbAvailable !== false) {
          try {
            const disk = await loadFromIDB();
            const taskIds = new Set(memory.tasks.map((t) => t.id));
            const trashIds = new Set(memory.trash.map((t) => t.id));
            const projIds = new Set(memory.projects.map((p) => p.id));
            const subIds = new Set(memory.subtasks.map((s) => s.id));
            // (reminders id-set lives just below, after the disk read)
            for (const t of disk.tasks) if (!taskIds.has(t.id)) ops.push({ store: STORE_TASKS, op: 'delete', key: t.id });
            for (const t of disk.trash) if (!trashIds.has(t.id)) ops.push({ store: STORE_TRASH, op: 'delete', key: t.id });
            for (const p of disk.projects || []) if (!projIds.has(p.id)) ops.push({ store: STORE_PROJECTS, op: 'delete', key: p.id });
            for (const s of disk.subtasks || []) if (!subIds.has(s.id)) ops.push({ store: STORE_SUBTASKS, op: 'delete', key: s.id });
            const remIds = new Set(memory.reminders.map((r) => r.id));
            for (const r of disk.reminders || []) if (!remIds.has(r.id)) ops.push({ store: STORE_REMINDERS, op: 'delete', key: r.id });
          } catch (_) { /* disk unreadable — re-putting everything is still best effort */ }
        }
        return await commit(ops, { isResync: true });
      } finally {
        resyncing = false;
      }
    }

    function scheduleResync(delayMs) {
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (!dirty) return;
        fullResync().then((ok) => { if (!ok) scheduleResync(30000); });
      }, delayMs == null ? 1500 : delayMs);
    }

    /* ------------------------- Startup recovery -------------------------- */

    /**
     * RECOVERY LOGIC (requirement #3). Decision tree:
     *
     *   1. Read IndexedDB (primary). Read the localStorage mirror.
     *   2. Migrate + validate each candidate independently, so a corrupted
     *      candidate can never poison a good one.
     *   3. Choose the winner:
     *        - IDB has valid data  → IDB wins, UNLESS the mirror is
     *          meaningfully newer (backupNewer) → mirror wins + re-sync.
     *        - IDB empty/corrupt, mirror has data → MIRROR WINS and is
     *          re-synced back into IndexedDB (this is the "restore from
     *          backup" path).
     *        - both empty → start fresh.
     *   4. Prune trash older than 30 days.
     *   5. Make disk agree with the recovered state (fullResync) or refresh
     *      the mirror so the two copies share one timestamp.
     *
     * Returns { state, source, notices, idbAvailable, lastSavedAt }.
     * `state` is the LIVE in-memory object (store.state) — the app keeps
     * mutating it; disk converges to it.
     */
    async function recover() {
      const notices = [];

      // -- 1. read both copies, each in its own try/catch ------------------
      let idbData = null, idbError = null;
      try {
        idbData = await loadFromIDB();
      } catch (e) {
        idbError = e;
        if (idbAvailable === false) {
          notices.push({ kind: 'error', message: 'IndexedDB is unavailable in this browser (private browsing?). Data will be kept in the localStorage mirror only — please export backups regularly.' });
        } else {
          notices.push({ kind: 'warn', message: 'IndexedDB could not be read (' + (e && e.message ? e.message : e) + '). Falling back to the local backup.' });
        }
      }

      const backup = readBackup();
      if (backup.error === 'parse' || backup.error === 'shape') {
        notices.push({ kind: 'warn', message: 'The localStorage backup file was found but is corrupted and could not be read.' });
      }

      // -- 2. normalize each candidate (migrate → clean), independently ----
      let idbState = null, backupState = null;

      if (idbData) {
        try {
          const p = {
            schemaVersion: (idbData.meta && Number.isFinite(idbData.meta.schemaVersion)) ? idbData.meta.schemaVersion : SCHEMA_VERSION,
            tasks: idbData.tasks,
            trash: idbData.trash,
            projects: idbData.projects,
            subtasks: idbData.subtasks,
            reminders: idbData.reminders,
            settings: (idbData.meta && idbData.meta.settings) || {},
            savedAt: (idbData.meta && idbData.meta.savedAt) || 0,
          };
          idbState = Object.assign(cleanPayload(migratePayload(p)), { savedAt: p.savedAt });
          if (idbState.dropped) notices.push({ kind: 'warn', message: 'Ignored ' + idbState.dropped + ' malformed IndexedDB record(s) during recovery.' });
        } catch (e) {
          idbState = null;
          notices.push({ kind: 'warn', message: 'IndexedDB data could not be migrated/validated (' + e.message + '). Falling back to the local backup.' });
        }
      }
      if (backup.state) {
        try {
          const p = {
            schemaVersion: backup.state.schemaVersion,
            tasks: backup.state.tasks,
            trash: backup.state.trash,
            projects: backup.state.projects || [],
            subtasks: backup.state.subtasks || [],
            reminders: backup.state.reminders || [],
            settings: backup.state.settings || {},
            savedAt: backup.state.savedAt,
          };
          backupState = Object.assign(cleanPayload(migratePayload(p)), { savedAt: p.savedAt });
        } catch (e) {
          backupState = null;
          notices.push({ kind: 'warn', message: 'The local backup could not be migrated/validated (' + e.message + ').' });
        }
      }

      // -- 3. choose the source of truth ------------------------------------
      const idbHas = idbState && (idbState.tasks.length || idbState.trash.length || idbState.projects.length || idbState.subtasks.length || idbState.reminders.length);
      const bakHas = backupState && (backupState.tasks.length || backupState.trash.length || (backupState.projects || []).length || (backupState.subtasks || []).length || (backupState.reminders || []).length);

      let payload = null;
      let source = 'fresh';
      if (idbHas) {
        payload = idbState;
        source = 'idb';
        if (bakHas && backupNewer(backupState, idbState)) {
          payload = backupState;
          source = 'backup';
          notices.push({ kind: 'warn', message: 'The local backup was more recent than IndexedDB (a write may have been lost in a crash). Restored from the backup and re-synced it to IndexedDB.' });
        }
      } else if (bakHas) {
        payload = backupState;
        source = 'backup';
        notices.push({ kind: 'info', message: 'IndexedDB was empty' + (idbError ? ' or unreadable' : '') + ' — restored ' + backupState.tasks.length + ' task(s) and ' + backupState.trash.length + ' trashed item(s) from your local backup.' });
      } else if (backup.raw) {
        notices.push({ kind: 'warn', message: 'No usable data found: IndexedDB is empty and the local backup is unreadable. Starting fresh.' });
      }

      // -- 4. adopt into memory + prune expired trash -----------------------
      const clean = payload || { tasks: [], trash: [], projects: [], subtasks: [], reminders: [], settings: {} };
      memory.tasks = clean.tasks;
      memory.trash = clean.trash;
      memory.projects = clean.projects;
      memory.subtasks = clean.subtasks || [];
      memory.reminders = clean.reminders || [];
      // Reminders that already fired (or were dismissed/skipped) lose their
      // meaning after the 30-day window — prune them from history. PENDING
      // ones are NEVER pruned here: the engine owes them a catch-up fire.
      const remExpired = memory.reminders.filter((r) => r.status !== 'pending' && now2 - r.updatedAt > TRASH_RETENTION_MS);
      if (remExpired.length) {
        const goneR = new Set(remExpired.map((r) => r.id));
        memory.reminders = memory.reminders.filter((r) => !goneR.has(r.id));
        notices.push({ kind: 'info', message: 'Removed ' + remExpired.length + ' old reminder record(s) from history.' });
      }
      memory.settings = { ...DEFAULT_SETTINGS, ...(clean.settings || {}) };
      lastSavedAt = clean.savedAt || Date.now();

      const now = Date.now();
      const now2 = now;
      const expired = memory.trash.filter((t) => now - (t.trashedAt || 0) > TRASH_RETENTION_MS);
      if (expired.length) {
        memory.trash = memory.trash.filter((t) => (t.trashedAt || 0) > now - TRASH_RETENTION_MS);
        notices.push({ kind: 'info', message: 'Removed ' + expired.length + ' item(s) that had been in the trash for more than 30 days.' });
      }
      // Deleted projects share the trash retention window.
      const expiredProj = memory.projects.filter((p) => p.deletedAt && now - p.deletedAt > TRASH_RETENTION_MS);
      if (expiredProj.length) {
        const gone = new Set(expiredProj.map((p) => p.id));
        memory.projects = memory.projects.filter((p) => !gone.has(p.id));
        notices.push({ kind: 'info', message: 'Removed ' + expiredProj.length + ' project(s) that had been in the trash for more than 30 days.' });
      }

      // -- 4b. reminder history pruning used the recovery clock --------------
      // (now2 defined above where the prune runs)

      // -- 5. make disk agree with the recovered state ----------------------
      try {
        if (idbAvailable === false) {
          mirrorToLocalStorage(); // LS-only mode (e.g. private browsing)
        } else if (source === 'backup' || expired.length) {
          await fullResync(); // backup → IDB restore, or persist the prune
        } else {
          mirrorToLocalStorage(); // keep the mirror's timestamp in sync with IDB
        }
      } catch (e) {
        notices.push({ kind: 'warn', message: 'Could not sync the recovered state to disk yet (' + (e && e.message ? e.message : e) + '). It will be retried automatically.' });
      }

      return {
        state: memory,
        source,
        notices,
        idbAvailable: idbAvailable !== false,
        lastSavedAt,
      };
    }

    /* ------------------------- Cross-tab sync ---------------------------- */

    function adoptFromDisk(fresh) {
      // Another tab committed. Disk is the single source of truth: adopt it
      // wholesale (no merging of two in-memory copies). Settings come from
      // disk too — settings changes are committed synchronously, so the disk
      // copy is always at least as fresh as this tab's last commit.
      const clean = cleanPayload({
        tasks: fresh.tasks,
        trash: fresh.trash,
        projects: fresh.projects,
        subtasks: fresh.subtasks,
        reminders: fresh.reminders,
        settings: (fresh.meta && fresh.meta.settings) || {},
      });
      memory.tasks = clean.tasks;
      memory.trash = clean.trash;
      memory.projects = clean.projects;
      memory.subtasks = clean.subtasks;
      memory.reminders = clean.reminders || [];
      memory.settings = { ...DEFAULT_SETTINGS, ...clean.settings };
      lastSavedAt = (fresh.meta && fresh.meta.savedAt) || Date.now();
      dirty = false; // disk is authoritative again
    }

    let externalGuard = false;
    async function refreshFromOtherTab() {
      if (reloading || externalGuard) return;
      externalGuard = true;
      reloading = true;
      try {
        // If THIS tab has unflushed changes (a failed write), flush them
        // first — otherwise re-reading disk could drop them.
        if (dirty) {
          const ok = await fullResync();
          if (!ok) {
            cb.onError('Another tab changed your data, but this tab could not save its own pending changes first. Refresh was skipped to protect your data.');
            return;
          }
        }
        const fresh = await loadFromIDB();
        adoptFromDisk(fresh);
        cb.onExternalChange();
      } catch (e) {
        cb.onError('Could not refresh after a change in another tab (' + (e && e.message ? e.message : e) + '). If the list looks stale, reload the page.');
      } finally {
        reloading = false;
        externalGuard = false;
      }
    }

    function queueExternalReload() {
      if (externalTimer) return; // coalesce: storage event + broadcast both fire
      externalTimer = setTimeout(() => {
        externalTimer = null;
        refreshFromOtherTab();
      }, 250);
    }

    /**
     * Last-resort mirror on pagehide. The write is SYNCHRONOUS, so even if an
     * in-flight IndexedDB transaction doesn't finish before the tab dies, the
     * localStorage backup still captured the latest state. Recovery compares
     * savedAt timestamps and prefers whichever copy is newer, so this can
     * never lose a committed write.
     */
    function onPageHide() {
      if (!memory.tasks.length && !memory.trash.length && !lastSavedAt) return;
      try {
        global.localStorage.setItem(LS_BACKUP_KEY, serializeBackup(Date.now()));
      } catch (_) { /* best effort — nothing more we can do on the way out */ }
    }

    function startSync() {
      if (typeof window === 'undefined') return; // non-browser (tests)
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          bc = new BroadcastChannel(BC_CHANNEL);
          bc.onmessage = (e) => {
            const d = e && e.data;
            if (d && d.source !== TAB_ID && d.type === 'committed') queueExternalReload();
          };
        } catch (_) { bc = null; }
      }
      // Fallback for engines without BroadcastChannel: our LS mirror write
      // fires `storage` in every other tab. (The draft key deliberately does
      // NOT trigger sync — it's per-editing-session and shared by design.)
      window.addEventListener('storage', (e) => {
        if (e.key === LS_BACKUP_KEY) queueExternalReload();
      });
      window.addEventListener('pagehide', onPageHide);
      document.addEventListener('visibilitychange', () => {
        // Returning to a visible tab is a great moment to heal a failed write.
        if (document.visibilityState === 'visible' && dirty) fullResync().catch(() => {});
      });
    }

    /* ----------------------------- Public API ---------------------------- */

    return {
      recover,
      commit,
      resync: () => fullResync(),
      startSync,
      refreshFromOtherTab,
      /** Adopt an imported dataset (caller then calls resync()). */
      replaceMemory(tasks, trash, projects, subtasks, reminders) {
        memory.tasks = tasks;
        memory.trash = trash;
        memory.projects = Array.isArray(projects) ? projects : [];
        memory.subtasks = Array.isArray(subtasks) ? subtasks : [];
        memory.reminders = Array.isArray(reminders) ? reminders : [];
      },
      /** Serialize the current state as a downloadable backup file. */
      exportData: () => serializeBackup(Date.now()),
      get state() { return memory; },
      get dirty() { return dirty; },
    };
  }

  /* ------------------------------ Exports ------------------------------- */

  global.ZTStorage = {
    createStore,
    constants: {
      LS_BACKUP_KEY,
      LS_DRAFT_KEY,
      TRASH_RETENTION_MS,
      DEFAULT_SETTINGS,
      SCHEMA_VERSION,
      STORES: { tasks: STORE_TASKS, trash: STORE_TRASH, projects: STORE_PROJECTS, subtasks: STORE_SUBTASKS, reminders: STORE_REMINDERS, meta: STORE_META },
    },
    helpers: {
      uuid,
      isQuotaError,
      migratePayload,
      validatePayload,
      cleanPayload,
      backupNewer,
      coerceProject,
      coerceSubtask,
      coerceReminder,
      REMINDER_TYPES,
      REMINDER_STATUSES,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
