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
- `zerotodo-standalone.html` is a single-file build of the same app
  (everything inlined) — handy if you want to keep one file.

## Features

- Add / edit / delete / complete tasks (title, optional description, due date,
  priority low/med/high, tags, UUID id, createdAt/updatedAt).
- Filters: All / Active / Completed / Trash, plus **by tag**, plus full-text
  search over title + description.
- Reordering: drag-and-drop (desktop) **and** ↑/↓ buttons (touch-friendly).
- Dark mode (auto/light/dark), responsive layout, live "Saving… / All changes
  saved" indicator.

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

## Development notes

- `storage.js` — the persistence engine (recovery, dual-write, migrations,
  cross-tab sync, quota handling). This is where the safety logic lives.
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
