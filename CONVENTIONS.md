# ZeroTodo engineering conventions

Non-negotiable rules for changing this app. They exist because the app's core
promise is *never silently lose data* — most of them follow from that.

## 1. One state, one store — ever

There is exactly **one** dataset: `{ tasks, trash, projects, settings }`.
It flows through four layers, all of which already know about every field:

| Layer | File | Shape |
|---|---|---|
| UI memory | `public/app.js` (`S`) | lives inside the storage engine's `memory` object |
| Browser disk | `public/storage.js` | IndexedDB stores `tasks` / `trash` / `projects` + `meta`, redundant `todo_backup_v1` localStorage mirror |
| Wire | `public/cloud.js` | `snapshotJson()` / `POST /api/sync { state: { savedAt, settings, tasks, trash, projects }, tombstones }` |
| Server disk | `server/server.js` | one JSON state doc per user (file or Supabase row) |

**Never add a second store, a second doc, or a second table for a new
record type.** Add a field/array to the existing state — that's how both
extra record types shipped: Projects (`projects: []` + `tasks[].projectId`)
and Subtasks (`subtasks: []` flat records with `parentTaskId`; the UI
supports one nesting level, subtree walks are visited-set cycle-safe).

## 2. Adding a record type or field — the exact checklist

1. **`storage.js`** — `SCHEMA_VERSION` +1 and add `MIGRATIONS[old]` that
   defaults the new field for every older payload (IDB data, LS mirror and
   imported backups all run this chain). Lenient coercion function
   (`coerceTask` / `coerceProject` pattern): **preserve unknown fields via
   spread**, only drop records whose *id* is unusable, clamp everything else
   to defaults. Wire it into `cleanPayload` (dedupe), `validatePayload`,
   `serializeBackup`/`readBackup`, `backupNewer` (compare the new array's
   `updatedAt` too), `fullResync`, `recover` (retention pruning),
   `replaceMemory`, `validateOp` (store whitelist + put-value validation),
   `STORES`.
2. **`server.js`** — mirror the coercion in `normalizeState`, include the
   array in the `before/after` change-detection and merge (per-id max
   `updatedAt`), `applyTombstones` (scope prefix `"<store>:<id>"`, kills iff
   `tombstoneAt >= updatedAt`), `pruneExpired` (soft-deleted records past the
   30-day window → tombstone), and bump `version` in `/api/config`.
3. **`cloud.js`** — include it in `snapshotJson`, the push body, and
   `adoptRemote` (same LWW + tombstone filter + prune). Delete-op capture is
   already generic (`op.store + ':' + op.key`) — no change needed.
4. **`app.js`** — every mutation = mutate `S`, then ONE `store.commit([...])`
   with ops for *every* store it touches (a purge that orphans tasks commits
   the detach in the same transaction).
5. **Server normalization is additive** — if `coerceTask` on the server gains
   a field (e.g. `dueTime`), every echoed row differs from what a client
   pushed *before* that field existed → `adoptRemote` swaps in its canonical
   objects. Anything holding a task reference across a sync (tests, or code
   that captured a row) goes stale: **re-query the live state by id at
   mutation time**, never mutate a captured object (see test-client detach).
6. **Attached records** (subtasks via `parentTaskId`, reminders via `taskId`):
   hard-delete cascades ride the SAME commit as the task purge; every load
   path (recovery, cross-tab adopt, import, cloud adopt) drops attached
   records whose owner exists in neither tasks nor trash — trashed owners KEEP
   theirs so restore is complete. Times: the user's wall-clock strings
   (`dueDate`/`dueTime`/`customDate`/`customTime`) are the truth; `triggerAt`
   is a derived epoch ms re-computed from those on every reconcile — a
   timezone change shifts instants consistently and never rewrites a date.
   Scheduling lives in the RECORDS, never in a live timer: boot = load →
   detect overdue → catch up ("Missed") → settle ledgered ones silently
   (`zt_rem_fired_v1`) → re-arm; timers are only a prompt-fire optimization.
7. **Tests** — extend all five suites (`server/test.mjs`,
   `test-storage.mjs`, `test-supabase.mjs`, `test-client.mjs`,
   `test-ui.mjs`).
   `test-storage.mjs` runs the real `storage.js` in Node (LS-only engine),
   `test-client.mjs` runs the real `cloud.js` against the real server — keep
   using them instead of re-implementing logic in tests.

## 3. Deletion semantics (three tiers — never skip one)

* **Soft delete** → move/flag inside the state (`trash` store with
  `trashedAt`, `projects[].deletedAt > 0`). Bump `updatedAt`. **No
  tombstone.** Undo = newer `updatedAt` revives it; 30-day retention prunes
  it with a notice on boot.
* **Purge / delete-forever** → `{ op: 'delete' }` commit — cloud.js turns it
  into a tombstone; server keeps tombstones 30 days so *stale* re-pushes
  from offline devices can't resurrect it, while a genuine newer edit wins
  ("edit beats delete"). Purging a project detaches its tasks
  (`projectId: null`) **in the same commit**.
* **Import (replace)** → clears tombstones for the ids the replacement
  contains; it is the *only* whole-state overwrite and always sits behind a
  confirm + auto-downloaded safety copy.

Tombstones are **store-scoped**: `tasks:x` never kills the `trash:x` copy
(that's how a soft delete survives sync on the other side).

## 4. UI/UX invariants

* **String-built HTML must be parse-safe**: every `<select>` template needs its
  `</select>` (an unclosed one silently swallows the following `<label>` /
  `<select>` start tags in real parsers too — this exact bug shipped once and
  only the jsdom harness caught it). After any `innerHTML` re-render, DOM
  references from before the render are dead: re-query every click.

* Anything destructive is either undoable via an 8 s toast *or* lands in the
  shared Trash view (restorable for 30 days).
* Filters that survive reload live in `settings` (persisted with
  `store.commit([])`); transient view state lives in `S.ui`.
* Drafts autosave to `LS_DRAFT_KEY` — composer-like forms must include their
  fields in `readForm`/`currentDraft`.
* Dark mode is free if you use the CSS tokens (`--panel`, `--border`,
  `--accent`, `--danger`, `--radius`…); `--pc` carries a per-project colour.
* All UI strings are injected through `esc()` (there is no framework).

## 5. Notification delivery (notify.js + sw.js)

Delivery belongs to **`public/notify.js`** (+ `public/sw.js`) — never inline it
in `app.js` or the composer UI. The engine (`app.js`) owns reminder RECORDS,
trigger computation, the fire pass and the snooze re-arm; notify owns channels,
settings UI, summaries, and the dedup ledger. Hooks meet at exactly one call
each way: `ZTNotify.attach({...})` (app→notify) and `ZTNotify.reminderAlert`
(notify←engine fire). Rules that keep users un-spammed:

- **Permission is requested only from the explicit “Enable Notifications”
  control** (`status()==='default'` guard inside it). No load-time, no
  save-task, no sneaky prompts. `denied` ⇒ the blocked sentence, and the
  Enable button itself is not rendered — asking again is impossible by
  construction.
- **Every send is deduped per delivery instance.** Key: `rem:<id>@<triggerAt>`
  (auto-overdue: `od:` prefix), day-keyed for summaries (`sum:d:`, `sum:w:`,
  `hab:<taskId>:<day>`, `pd:<projId>:<day>`). The ledger (`localStorage
  zt_notify_v1`, capped) is written **before** the send; the engine's own
  `zt_rem_fired_v1` mirrors the same instance key. Snoozing changes
  `triggerAt` ⇒ new key ⇒ legitimate re-fire; everything else stays silent.
- **Persistent on mobile/PWA**: when a service worker is registered, sends go
  through `registration.showNotification` with `requireInteraction` +
  Complete/Snooze actions; clicks route back via
  `{type:'zt-notif-action'}` postMessage (or a deep-link `#t=<id>` opens the
  task if no window is open). SW registration is skipped unless
  `isSecureContext` — `file://` silently uses in-app cards.
- **Fallback is never silent**: if the OS channel is unavailable or fails, the
  same alert renders as an in-app card with the full button set; the record is
  stamped `notify:{key,at,via:'inapp'}` so a later capable boot won't re-ring.
- **Overdue is an engine-managed `reminderType:'overdue'` record** (one per
  task, `forDue` tracks the due date it fired for) — it persists/syncs/dedupes
  like user reminders. Mode `once` (default) never re-alerts for the same due
  date; `repeat` re-arms the SAME record `odHours` later. The pending-recompute
  loop must NEVER touch these (or any `pinned` = snoozed record) or the
  cadence degenerates into a per-tick loop.
- User settings live in **`settings.notify`** (free-form object, sanitized by
  `ZTNotify.sanitize` at boot): no schema bump, rides meta + sync + backups
  for free. Server-side, `overdue` must stay in BOTH `REMINDER_TYPES` lists
  (`storage.js`, `server/server.js`) or records silently degrade to `custom`.
- `pinned` (set by snooze) protects a user-adjusted `triggerAt` from recompute
  until it fires; every code path that RE-derives `triggerAt` (task edit,
  recurrence re-arm) clears it.

## 6. Compat floor (tested, not aspirational)

A backup or IDB copy from **schemaVersion 0 or 1** must load, migrate, and
sync without touching user data. Existing task IDs, titles, tags, due dates
and trashed items are asserted to survive in `test-storage.mjs`. Old servers
(v2/v3) receiving v4 payloads ignore the unknown `projects` key instead of
crashing (server.js normalizes leniently) — a mixed fleet can't corrupt data,
it just doesn't sync projects until both sides upgrade.

## 7. Process

* `node --check` every touched file, then run **all four suites**
  (`for f in test test-storage test-supabase test-client; do node server/$f.mjs; done`).
* No unrelated refactors. Additive patches with exact-match anchors beat
  rewrites here — several times, a rewrite silently dropped a compat path.
* Secrets: never in the repo, never pasted in chat; `server/.dev.env`
  (gitignored) holds local dev config.
