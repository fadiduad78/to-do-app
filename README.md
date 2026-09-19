# ZeroTodo — a to-do list that never loses your data

A small to-do app whose entire design is organized around one goal: **your data
survives crashes, refreshes, browser restarts, and your own accidents.**

Everything is local-first (IndexedDB + redundant mirror, no build step) — and it can
now optionally **sync online to your own server** (see `README-ONLINE.md`, the
`server/` folder and `public/cloud.js`) so data also survives cleared browser
data and follows you between devices. Local and cloud layers are independent:
if the server is unreachable, every original guarantee still holds.

## Quick start

- **Easiest:** double-click `index.html` (it runs from `file://` in modern
  browsers), or
- **Served locally (recommended):** `python3 -m http.server 8080` (or
  `npx serve`) in this folder, then open `http://localhost:8080`.
- `zerotodo-standalone-local.html` is a single-file build of the same app
  (styles + storage + sync + notifications + UI, everything inlined) — handy
  if you want to keep one file. It is generated: after changing anything in
  `public/`, run `npm run build:standalone` (the UI test suite boots the
  committed file and fails if it was left stale). From `file://` there is no
  permission-able origin, so notifications degrade to the same in-app alert
  cards with Open/Complete/Snooze; hosted (or installed PWA) builds get full
  OS notifications.

## Features

- Add / edit / delete / complete tasks (title, optional description, due date
  + optional time, priority low/med/high, tags, UUID id, createdAt/updatedAt).
- Subtasks (checklists) per task, projects with progress, and a **📅 Calendar**
  (Month / Week / Day) — all *views over the same task records*: rescheduling
  by drag-and-drop updates the task's own `dueDate`/`dueTime`, never a copy.
  Calendar chips carry a live **🔔 N** indicator (pending reminder count, next
  fire in the tooltip); clicking it opens the task's reminder configuration.
- **Reminders** per task (any number): at time of task, 5/10/15/30 min, 1/2 h,
  1/2 days before, or a custom date+time — persisted as records (not
  `setTimeout`), so they catch up after a refresh or closed tab, never fire
  twice, and skip work that's completed or trashed. Recurring tasks
  (daily/weekly/monthly) re-arm their reminders on every cycle.
- **OS notifications** (desktop + mobile/PWA, delivered by `public/notify.js`):
  task reminders (body phrases the lead time — “Finish Python project is due
  in 30 minutes.”), overdue alerts with a configurable no-spam policy (once
  per task, or repeat every N hours until handled), daily/weekly summaries, habit
  check-ins, project-deadline warnings and Pomodoro timers. Permission is only
  ever requested from an explicit “Enable Notifications” button — never on
  load. Alerts use `registration.showNotification` (persistent, with
  Complete/Snooze/Open action buttons where the OS allows them — browsers
  that cap at two buttons open the task on the notification click instead)
  and are deduped per delivery instance, so refreshes, multi-tab and a second phone can never double-ring.
  Denied → “Notifications are blocked. Enable them in browser settings.”;
  unsupported browsers (and `file://`) degrade to the same alerts as in-app
  cards with Open / Complete / Snooze 5·10·30·60·Tomorrow. Every channel has
  its own on/off switch + timing in ⚙ Settings → Notifications.
- **Installable as a PWA** (`manifest.webmanifest` + generated launcher icons
  + theme-color): on Android (and iOS when added to Home Screen) the installed
  app keeps the service worker alive for notification delivery, and the
  manifest's “New task” shortcut (deep link `#new`) launches straight into the
  composer. Icons regenerate via `python3 scripts/make-pwa-icons.py`.
- Filters: All / Active / Completed / Trash, plus **by tag**, plus full-text
  search over title + description.
- Reordering: drag-and-drop (desktop) **and** ↑/↓ buttons (touch-friendly).
- **Mobile web is a first-class layout**: 16px form inputs (so iOS never
  zoom-jumps on focus), thumb-sized tap targets, modals as bottom sheets,
  notch/home-indicator safe-area padding, a horizontally swipeable project
  rail, and toasts stacked above the keyboard/home bar. Verified in real
  Chromium at 320/360/375/414 px by `server/test-ui.mjs` (overflow, font
  sizes, touch targets across 8 app states each).
- Dark mode (auto/light/dark), responsive layout, live "Saving… / All changes
  saved" indicator.

## Unified scheduling (task ⇄ calendar ⇄ reminders ⇄ notifications)

One contract ties the four layers together — **the task is the single source of
truth**. The calendar *displays* the task, the reminder engine *derives* its
schedules from the task, and the notification system *delivers* what the engine
produced. No layer stores its own copy of a date.

| Event on a task | Calendar | Reminder engine |
| --- | --- | --- |
| Due changed | chip moves to the new day | relative reminders (d1/h1/…) recalculate against the new due automatically. Absolute `custom` reminders are never moved silently: the app asks ("Shift with due" / "Keep them"); shifting rewrites the picked wall-clock by exactly the due delta, keeping the same record id. No stale future slot survives because triggers are derived, not copied |
| Trashed (soft delete) | its day empties | pending schedules are **cancelled immediately** in the same commit — a task in the trash can never surface a notification |
| Restored / undo | reappears | *valid future* reminders re-arm in place — same record ids, zero duplicates; ones that went stale while trashed stay skipped |
| Completed | shown struck-through | future reminders are skipped (no nagging for finished work); delivered ones remain in history (record + fire ledger) |
| Snoozed (from any alert) | untouched | the same record re-arms at the chosen time and the task's due date is **never** modified |
| Deleted forever | fully removed | the task's reminder records are purged in the same commit — nothing survives to fire |

The ask appears mid-save and cannot block work: cancel = keep the times you
originally picked. New custom rows added *during* that same edit are the user's
choice against the NEW due — they are never shifted.

Duplicate-proofing: the composer edits the existing pending records in place
(by id, so re-saving never forks copies), the engine keeps at most one
auto-managed overdue record per task, and storage dedupes by id on import and
recovery. The whole contract is pinned by **§17 of `server/test-ui.mjs`**,
which replays the "Submit assignment" scenario end-to-end (create with 3
reminders → due change → trash → restore → fire → snooze → complete →
purge) asserting record ids, statuses, derived trigger instants and the
rendered calendar DOM at every step.

## Where your data is stored

| Location | Key / store | Contents |
|---|---|---|
| **IndexedDB** (primary) | db `zerotodo` → stores `tasks`, `trash`, `meta` | All live tasks, soft-deleted tasks, and `{schemaVersion, savedAt, settings}` |
| **localStorage** (redundant mirror) | `todo_backup_v1` | A full JSON copy of tasks + trash + settings, rewritten after *every* successful IndexedDB write |
| **localStorage** (drafts) | `todo_draft_v1` | Your in-progress form text, auto-saved ~1.2 s after you stop typing |

## How the safety mechanisms work

1. **Write-through, single transaction.** Every add/edit/delete/toggle/reorder
   is committed to IndexedDB immediately (no save button, no batching), and each
   commit is one atomic transaction — all record changes plus the `meta`
   record apply together or not at all, so storage is never half-updated.
2. **Dual-write redundancy.** Only *after* IndexedDB durably commits does the
   app mirror the identical state to `todo_backup_v1`.
3. **Startup recovery.** On load the app reads IndexedDB first. If IndexedDB is
   empty, corrupted, or errors, it automatically falls back to the localStorage
   backup, restores from it, and **re-syncs it back into IndexedDB**. If the
   backup is ever *newer* than IndexedDB (a write lost in a crash), the backup
   wins. A final safety net: on tab close a synchronous last-resort mirror is
   written even if an in-flight IndexedDB transaction can't finish.
4. **Draft autosave.** Typing in the add/edit form is debounced into
   `todo_draft_v1`. After a crash/refresh you get a banner to **Resume or
   Discard** the draft (plus a "unsaved draft" pill in the toolbar).
5. **Undo / soft delete.** Delete moves a task to the `trash` store (kept **30
   days**, then pruned) and shows an **Undo** toast for 8 seconds. Trash is a
   normal view with Restore / Delete-forever / Empty-trash (confirmation + an
   automatic trash safety file before emptying).
6. **Export / Import.** *Export* downloads a full JSON backup; *Import*
   restores one. Importing over existing data asks for confirmation and
   downloads a **safety copy of your current data first**. The UI recommends a
   regular export habit, and a configurable **backup reminder** (every N days,
   tracked via `lastExportDate`) nudges you to do it.
7. **Versioning & migrations.** The data carries a `schemaVersion`; a
   migration chain upgrades old shapes on load/import. Migrations only
   transform known fields and **preserve any unrecognized fields**, so old data
   is never discarded.
8. **Corruption-proof writes.** Every read/write is try/catch-wrapped. Invalid
   records are dropped *with a notice* (never blindly), failed writes keep the
   good in-memory state and retry automatically (full re-sync), and JSON parse
   failures in the backup never touch live IndexedDB data.
9. **No destructive writes.** Writes are read-modify-write at record
   granularity and validated before commit. The only whole-state operation is
   the explicitly-confirmed import (which safety-exports first).
10. **Quota handling.** `QuotaExceededError` (IDB or localStorage) raises a
    sticky warning telling you to export and clean up — new entries are never
    silently dropped.
11. **Cross-tab sync.** Every commit broadcasts via `BroadcastChannel`
    (with the localStorage `storage` event as fallback). Other tabs re-read
    IndexedDB and adopt it; a tab with its own pending failed write flushes
    first so nothing is clobbered.

## Manual backups (the important habit)

IndexedDB data can be erased by "clear site data", browser cleanup tools, or
moving devices — none of which the app can protect against. So:

1. Click **Export** in the header → `zerotodo-backup-YYYY-MM-DD-HHMM.json`
   downloads. Keep it somewhere safe (drive, folder, etc.).
2. On a new device: open the app → **Import** → pick the file → confirm
   (your current data, if any, is downloaded as a safety copy first).
3. Suggested cadence: every few days, or after any big cleanup. Enable the
   reminder in ⚙ Settings → *Backup reminder* to get a nudge.

The backup file is plain JSON: `{ app, schemaVersion, savedAt, settings,
tasks, trash }`. You can also hand-edit it (carefully) and re-import.

## Troubleshooting

- **"Browser storage is full" banner** — export your data, delete old trash
  items/tasks, or free up browser storage. The app keeps working and retries
  automatically once space is free.
- **"IndexedDB is unavailable" (private mode)** — the app falls back to
  localStorage-only. It keeps working, but export backups more often.
- **"Restored N tasks from your local backup" notice** — normal and good:
  IndexedDB was empty or unreadable, and the mirror did its job.
- **Editing in two tabs at once** — each tab's *committed* changes converge
  (last commit wins per record). Unsaved drafts are per-tab session text.
- **Clearing site data** erases both IndexedDB and localStorage. That is the
  one event the app cannot survive on its own — which is exactly why the
  export habit exists.
- **App stuck on "Loading…" / blank after reload** (fixed Sept 2026): two boot
  bugs compounded. Cloud sync was `await`ed *before* the first render, so a
  slow mobile network starved the whole UI; and the reminder-history prune in
  `storage.js` read its clock constant before declaration — a TDZ crash on the
  first reload *after any reminder had fired* (the very first one, then always).
  Boot now paints from local data first, cloud merges in when it arrives, and
  the prune shares one hoisted recovery clock. A reload-with-fired-reminders
  case is pinned in `server/test-storage.mjs`.

## Development notes

- `storage.js` — the persistence engine (recovery, dual-write, migrations,
  cross-tab sync, quota handling). This is where the safety logic lives.
- `notify.js` — the whole notification layer: permission flow (explicit-only),
  OS delivery via the service worker or the Notification constructor, in-app
  fallback cards, summaries/habits/deadline/pomodoro scheduling, the dedup
  ledger and the Settings → Notifications UI. Loaded between `cloud.js` and
  `app.js`.
- `sw.js` — service worker: persistent notification display + routing clicks
  back to an open window (or deep-linking `#t=<id>` when there is none). It
  holds no app data and does no caching.
- `app.js` — UI, rendering, and user actions. Every mutation: mutate in-memory
  state → `store.commit(ops)` → re-render.
- `index.html` / `styles.css` — markup and themeable styles.
- `test/smoke.mjs` — Node smoke tests for the storage engine (run
  `node test/smoke.mjs`). They exercise: fresh start, IDB persistence,
  IDB-loss → backup restore, backup corruption, quota failure + auto-resync,
  migrations, payload validation, and cross-tab refresh.

To change the data shape in the future: bump `SCHEMA_VERSION` in `storage.js`
and add a `MIGRATIONS[oldVersion]` step that transforms only known fields
(spread everything else through).
