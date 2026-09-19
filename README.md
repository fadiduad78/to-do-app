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
  twice, and skip work that's completed or trashed. Recurring tasks re-arm
  their relative reminders on every cycle.
- **OS notifications** (desktop + mobile/PWA, delivered by `public/notify.js`):
  task reminders (body phrases the lead time — “Finish Python project is due
  in 30 minutes.”), overdue alerts with a configurable no-spam policy (once
  per task, or repeat every N hours until handled), daily/weekly summaries, habit
  check-ins, project-deadline warnings and Focus-Mode (Pomodoro) phase
  notices. Permission is only
  ever requested from an explicit “Enable Notifications” button — never on
  load. Alerts use `registration.showNotification` (persistent, with
  Complete/Snooze/Open action buttons where the OS allows them — browsers
  that cap at two buttons open the task on the notification click instead)
  and are deduped per delivery instance, so refreshes, multi-tab and a second phone can never double-ring.
  Denied → “Notifications are blocked. Enable them in browser settings.”;
  unsupported browsers (and `file://`) degrade to the same alerts as in-app
  cards with Open / Complete / Snooze 5·10·30·60·Tomorrow. Every channel has
  its own on/off switch + timing in ⚙ Settings → Notifications.
- **Recurring tasks**: *Does not repeat / Every day / Every weekday (Mon–Fri) /
  Every week / Every month / Every year / Custom…* — custom covers any
  "every N days/weeks/months/years" stride with optional specific weekdays
  (Mon+Wed+Fri, every 2 weeks on Mon & Fri, …). Completing an occurrence
  **rolls the same record** to the next date instead of creating copies: the
  list and calendar always show exactly one live instance, plus dashed ghost
  previews of the upcoming pattern (display-only — zero extra records). A
  series menu offers *Complete / Skip this occurrence / Edit this occurrence /
  Edit the series / Stop repeating*; moving a recurring task's date asks
  whether the shift applies to the occurrence only or the whole series.
  Month/year rules clamp to the month's length (monthly on the 31st →
  Feb 28 → Mar 31), and a pattern with no future occurrence within ~10 years
  completes for good. Recurrence rides on the task record itself, so
  reminders, trash & restore, calendar, notifications, import/export, backup
  and sync keep working with no special cases.
- **Productivity dashboard** (📊 in the toolbar): greeting + date, tiles for
  completed-today / remaining-today / overdue / current streak, a *Today* board grouped
  into **overdue → high priority → scheduled → unscheduled**, an ASCII
  progress bar under a literal **Today’s Progress** heading (*██████░░ 75%* +
  *6 / 8 completed*), the six
  headline statistics (completed today/this week, created this week, overdue,
  completion rate, streak), a Mon–Sun completions chart, project progress
  rows, upcoming tasks and the next reminder with its lead time (*“Study
  Python — in 42 minutes”*). It is **not a data source** — every number is
  derived at render time from the same task/project/reminder records;
  checking a task off on the dashboard calls the very same `toggleTask` the
  list row uses, and opening/closing the view writes zero bytes.
- **Focus Mode (Pomodoro)**: every task row has a 🍅 **Start Focus** button →
  pick **25/5**, **50/10** or **Custom…** — a session bar drops in with the
  countdown (25:00) and **Pause / Resume / Stop**, and when the clock hits
  zero it says *“25 minutes focused”* (toast + optional system notification).
  Focus auto-cycles (work → short break → work…), earning a **long break**
  every N sessions — all configurable in ⚙ Settings → Focus (work, short,
  long, sessions-before-long, notify, and an *opt-in* “complete the task when
  a session ends”, off by default). Time is tracked per task *and* per
  project (dashboard → Focus card) because the aggregates + capped session
  log + live snapshot ride on the task record itself — the timer therefore
  survives refresh, sleep and sync, ticks with zero storage writes, and
  catches up honestly after being closed early. Pausing mid-day never breaks
  a streak; stopping before a full minute logs nothing.
- **Habit Tracking (🔥 in the toolbar)** — a separate module for recurring
  check-ins: **Daily / Weekly / Selected days**, an optional per-day (or
  per-week) **target** so *Drink water 8×/day* counts instead of toggles, and
  an editor for description + archive. Every habit card shows **current
  streak** (`🔥 12 days`), **longest streak**, **completion %** and a
  **Mon–Sun ✓ row** plus a mini **month calendar** of check-in history.
  Optional daily nudges **reuse the existing reminder & notification engine**
  (one re-arming record in the reminders store — snooze/dismiss/dedup/
  channels all work unchanged), and habit days are **never** mixed into task
  statistics unless you flip *Settings → Habits → count in dashboard stats*
  (off by default, like every opt-in here).
- **AI task decomposition (✨ on any task)** — for a big task like *“Build an
  expense tracker”* ZeroTodo proposes an ordered plan (**Define requirements →
  Design data model → Create database → Build expense form → Add categories →
  Add reports → Add export → Test application**). Every suggestion is
  **structured task data** — title, description, estimated duration, priority
  suggestion, optional due-date suggestion and a dependency suggestion — never
  a wall of chat. The “AI suggestions” dialog is a **☑/☐ checklist you review
  and edit inline (all six fields)** before pressing **Add selected tasks**;
  nothing is written to the task store until you do, and approved steps become
  **ordinary tasks**, editable with the existing editors like everything else.
  Works offline and with zero configuration via a deterministic built-in
  planner; a self-hoster can wire any OpenAI-compatible model through
  `ZT_AI_URL` / `ZT_AI_KEY` / `ZT_AI_MODEL` — keys never touch the browser.
- **Natural-language quick add** — at the top of the new-task composer, type a
  sentence: *“Study Python tomorrow at 7 PM”*, *“Call uncle Friday at 10 AM”*,
  *“Finish assignment tomorrow, high priority, remind me one hour before”*,
  *“Exercise every Monday Wednesday and Friday at 6 PM”*. A local, deterministic
  parser (no network, no AI keys) splits it into structured task data — title,
  description if identifiable, due date, due time, priority, project, tags,
  recurrence and reminder presets — and shows an **“I understood: …”** card
  with **[Create task] / [Edit]**. Nothing is ever created silently: the card
  is the gate, every guess is annotated (“bare *at 7* → 7 PM, Edit to flip”),
  low-confidence parses turn amber, and **[Edit]** hands the values to the
  ordinary form so you can fix anything before saving. Your **local timezone**
  is the only timezone in the pipeline.
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
rendered calendar DOM at every step. Recurrence rolling, the series sheet and
the occurrence-vs-series dialog are pinned by **§18** of the same file, and
the rule arithmetic itself by `server/test-storage.mjs`.

## Recurring tasks

The composer's **Repeat** select stores a kind on the task; *Custom…* opens an
inline panel (every N × day/week/month/year + weekday buttons). Everything a
recurring task needs lives on its one record:

| Field | Meaning |
|---|---|
| `recurrence` | `daily` / `weekdays` / `weekly` / `monthly` / `yearly` / `custom` (or empty) |
| `recurRule` | custom only: `{ every: 1–99, unit: 'day'\|'week'\|'month'\|'year', weekdays: [0–6] or null }` — Mon = 1, Sun = 0 |
| `recurAnchor` | `YYYY-MM-DD` the pattern is counted from (defaults to the due date at creation); weekly = "which weekday", monthly = "which day of month", custom weeks = parity + the weekday set |
| `dueDate` | always the **current occurrence** |

The brief's examples are the engine's test cases: *Every day*; *Every weekday*
(Sat → Mon); *Every Monday*; *Monday + Wednesday + Friday* (custom, week
stride 1); *Every 2 weeks* (even-week parity from the anchor); *Every month on
the 5th*; *Every year on December 31*. Month lengths clamp instead of skipping
(31-day anchors land on Feb 28, then return to the 31st).

Semantics, by design:

- **One rolling occurrence.** Complete (or *Skip this occurrence*) advances
  `dueDate` to the next pattern date — the same id, the same reminders, the
  same history; nothing multiplies when two devices roll at once.
- **Reminders follow the roll.** Relative reminder rows are re-armed against
  the new occurrence (toast: *next is … · N reminder(s) re-armed*); custom
  absolute times cannot repeat on a schedule, so they must be re-entered per
  occurrence — the roll never silently drops or drifts them.
- **Series vs occurrence.** Changing the due date via list/calendar/editor
  asks: shift the whole series (anchor moves by the same delta, rhythm
  preserved) or move this occurrence only (anchor untouched — the pattern
  returns to its rhythm next cycle). Changing the rule or title/notes/priority/tags
  through *Edit the series* re-anchors silently; *Stop repeating* keeps the
  current occurrence as a one-off.
- **Calendar** shows the current occurrence as a real chip (with a ↻ marker)
  and up to 14 upcoming dates as dashed ghost chips that click into the editor;
  trashing removes the ghosts, restoring brings them back.
- **Horizon.** A rule that yields no date within ~10 years completes the task
  for good (*"no future occurrence within 10 years, marked done."*) rather
  than storing a broken record.

## Productivity dashboard

A view, not a database: `dashModel()` reads `S.tasks`, `S.projects` and
`S.reminders` on every render and the whole page is plain derived HTML — the
only persistent thing it introduced lives **on the task record**:

| Field | Meaning |
|---|---|
| `completedAt` | when the last completion happened (set by complete **and** by a recurring roll; undo pops the newest ledger entry and rewinds this pointer to match) |
| `completions` | capped ledger (256 most recent stamps, oldest pruned) — a recurring task gains one entry per occurrence completed, which is what makes streaks honest |

Definitions the dashboard commits to (all pinned by **§19 of
`server/test-ui.mjs`** against a seeded store):

- **done today** = ledger stamps falling on today (rolls included);
  **left today** = open tasks due today whose instant hasn't passed;
  **overdue** = open tasks whose due instant (23:59 for all-day) is past.
- **streak** = consecutive days with ≥1 completion, counted back from today;
  a day still in progress doesn't break yesterday's run.
- **Today's Progress %** = done-today ÷ (done-today + left-today + overdue),
  bar drawn as 16 blocks, `█` count = round(pct·16/100).
- **this week** = Monday 00:00 → now (charts show Mon–Sun, future days at 0).
- **completion rate** = all-time `completed ÷ (completed + active)` from the
  live board only — trash is excluded by construction everywhere, and
  restoring a task brings its ledger with it.
- **Upcoming** = the 5 nearest open tasks dated after today; **Next
  reminder** = the earliest *pending* reminder on a live task (fired,
  disabled and orphaned records filtered out), aged by a 60 s ticker while
  open so “in 42 minutes” doesn't lie.
- Bucket rule for *Today*: each open task lands in exactly one group —
  overdue first, then high-priority (due today **or** dateless), then the
  rest of today, then the dateless backlog. Tasks due on later days are
  Upcoming, not Today.

Old data degrades honestly: completions made before this feature have no
ledger, so they count toward totals and the completion rate but not toward
per-day tiles, streaks or the chart.

## Focus Mode (task-bound Pomodoro)

`Start Focus` writes one snapshot on the task — `focusActive: { phase:
'focus'|'break'|'long', endsAt, pausedAt, durMin, breakMin, longMin,
longEvery }` — and everything else derives from wall-clock at render time
(the same philosophy as reminders: *stored instants, never ticking state*).

- **Tracking fields on the record:** `focusTotal` (minutes, monotonic),
  `focusSessions` (completed count — early stops don't increment it) and
  `focusLog` (capped at the 128 most recent `{at, min}` entries). The
  dashboard’s Focus card, the row’s 🍅 badge, per-project totals and sync all
  read these; there is no separate focus store, and none of it is recoverable
  from thin air — sanitize rules in `coerceTask` (client **and** server)
  clamp garbage back to zeros/defaults so a corrupt record can never wedge
  the timer.
- **One session app-wide:** starting Focus on another task quietly closes
  (and honest-logs) the previous one. Trashing a task abandons its session
  with a toast; partial focus ≥1 min is still logged.
- **Long breaks:** a focus phase that completes session #N where
  `N % longEvery == 0` gets `long` minutes instead of `short`. The cycle
  auto-continues until you press Stop.
- **Catch-up:** a session whose clock expired while the tab was closed is
  finalized on boot — minutes logged, break (or long break) started, notice
  delivered through the `nPomo` notification channel (deduped, in-app card
  fallback). Auto-complete, if enabled, applies to a completed *focus phase*
  only through the normal `toggleTask` path (so recurring tasks roll,
  reminders skip, undo works — nothing special-cased).
- **Never auto-completes** unless `S.settings.focus.autoComplete` was
  explicitly switched on in Settings → Focus. Default: off, pinned by §21.

Tests: `server/test-ui.mjs` **§21** (26 checks — menus, controls, persisted
settings, deterministic boot catch-up, long-break parity, both opt-in sides,
one-timer rule, trash honesty, zero-per-second writes) and
`server/test-storage.mjs` (coerce/cap/default-clamp cases).

## Habit Tracking (a separate module by design)

A habit is NOT a task with a recurrence rule: it never expires, it is *counted*
rather than completed (multiple times a day when `target > 1`), it can never be
“overdue”, and it lives in its own IndexedDB store (`habits`, DB v5) with its
own record:

```js
{ id, name, description,
  frequency: 'daily' | 'weekly' | 'days',   // 'days' = selected weekdays
  weekdays:  [1, 3, 5],                     // 0 = Sun … 6 = Sat (same as recurrence)
  target:    1..99,                          // per DAY (daily/days) or per WEEK (weekly)
  remindTime: 'HH:MM' | null,                // optional daily nudge
  archived:  false,                          // soft hide — history survives
  createdAt, updatedAt,
  history:   [{ d: 'YYYY-MM-DD', c: count }] // capped at 730 entries, deduped last-wins
}
```

- **Streak, best and % are derived, never stored.** `habitStats()` recomputes
  them from `history` at render: streak = consecutive met due-days (daily) /
  met due-days on due days (days) / met weeks (weekly); today (or the current
  week) still in progress does NOT break the run — the same grace rule as the
  dashboard streak. `pct` = met ÷ due since creation, over the last 730 days
  (weeks, for weekly). A stored streak could drift from its history; that is
  why it doesn't exist (the brief's `streak` field is a *display*, not a field).
- **The nudge reuses the reminder engine — no second pipeline.**
  `remReconcile()` keeps exactly **one** engine-managed row per habit
  (`id: 'hr:' + habitId`) in the ordinary `reminders` store; `coerceReminder`
  simply also accepts `habitId` as the owner (`taskId: ''`). It re-arms to the
  next due slot (weekly habits nudge Mondays — start of week), fires through
  the existing channels/dedup/snooze/in-app fallback (`ZTNotify.habitAlert`
  only changes the copy), is **skipped when the day's target is already
  met** (no nagging after you did it), and is retired (`skipped`) while the
  habit is archived. Delivery, storage and sync therefore ride code that was
  already tested for tasks.
- **Stats stay separate unless you say otherwise** — the brief’s one hard
  rule. `S.settings.habitsInStats` (default **off**) is the only gate: with it
  off, dashboard text is *byte-identical* no matter how many habits you check
  (pinned by §22); with it on, met habit days merge into the tiles, the
  Mon–Sun chart and the streak. Habit days **never** enter the overdue bucket
  or the backlog in either mode.
- **History is the single source and is bounded** — 730 dated entries,
  last-write-wins dedupe, counts clamped 1..999; invalid dates/types are
  dropped by `coerceHabit` (client and server hold identical rules).

Tests: `server/test-ui.mjs` **§22** (43 checks — toolbar view + overlay
exclusivity, live create/bump/undo with a fraction target, streak/best/%
derivation incl. the grace rule, archive ↔ nudge retire/re-arm, dashboard
isolation both directions, boot re-arm of a stale trigger, met-day
suppression with zero notification, 730-cap/junk-drop coercion, the
day-alignment-stable day-set case), plus habit cases in
`server/test-storage.mjs`, `server/test.mjs`, `server/test-client.mjs` and
`server/test-supabase.mjs` (single state doc, LWW + stale-push rejection,
nudge row persistence across restart).

## AI Task Decomposition (review-first, by construction)

**The one promise that shapes everything:** the AI never creates tasks. It can
only *suggest*; `public/app.js` renders suggestions in a review dialog and the
task store is not touched — *not one commit op* — until the user presses
**“Add selected tasks”** (a UI test snapshots the entire mirror before and
after opening, editing and regenerating a plan, and requires byte-equality;
Cancel adds nothing). Approved suggestions become ordinary tasks in the same
store, in plan order, with the parent's project inherited and the parent's
“break this down?” prompt retired.

- **The offer, not the shove** — new tasks whose title/description looks like a
  project (multi-word action phrasing, build/create/implement verbs, ≥5 words,
  ≥32 chars, or a fat description) are stamped `aiOffer: true`, which shows a
  one-line **“✨ Break this task down with AI”** button under the title. Small
  errands never get it. Regardless, every active row has the ✨ action, so any
  task can be decomposed on demand.
- **Structured contract** — every suggestion is
  `{ title, description, estMin, priority: low|med|high, dueDate: YYYY-MM-DD|null, dependsOn: [earlier step indices] }`.
  `sanitizePlan` (shared by browser and server via `public/ai.js`) rejects
  prose, caps plans at 12 steps, clamps estimates to 5–10080 minutes, and
  drops self-dependencies and out-of-range indices. A model that rambles
  produces *nothing*, not a paragraph.
- **Engines** — `Settings → AI → Task decomposition engine`:
  **Auto** asks `POST /api/ai/decompose` (auth-gated like every data route,
  per-user rate limit 1.5 s); if the server has `ZT_AI_URL` + `ZT_AI_KEY` +
  `ZT_AI_MODEL` it relays one chat-completions request with
  `response_format: json_object` and a strict system contract, else it answers
  with the **built-in planner**: deterministic domain playbooks (the pinned
  8-step software example, backend APIs, study plans, writing, events, home
  jobs, plus a generic 6-step ladder), due dates staggered along the
  dependency chain from the parent's own due date. **Any** failure — offline,
  429, malformed reply — falls back to the local plan silently; a standalone
  `file://` copy just uses it. **Built-in only** forces the offline engine.
- **What lands on tasks** — after approval, the three advisory fields persist
  on the ordinary task record: `estMin` (⏱ badge with the estimate), `deps`
  (🔗 badge, how many suggested predecessors are still open — ✓ when all are
  done), `aiOffer` (prompt, cleared on first breakdown). They are decoration on
  the existing record: identical coercion rules in `public/storage.js` and
  `server/server.js`, dangling deps are kept rather than rewritten, and nothing
  about them gates completion, reminders or the dashboard. Old servers simply
  pass the fields through — no schema bump, no migration, no new store.
- **Privacy by default** — with no AI env vars set, *no data ever leaves the
  device*: the built-in planner is pure local computation, and the server route
  with no provider configured only runs it. With a provider, exactly title,
  description and due date travel to it — configured server-side by the
  operator of *your* deployment.
- **Regenerate is safe** — re-planning (the ✨ Regenerate button, or flipping
  engines) never writes; it just refills the review dialog. Estimates jitter
  per seed so regenerated plans differ, while titles stay deterministic.

Tests: `server/test-ui.mjs` §23 pins the engine (exact example plan, clamp
rules, prose refusal, determinism), the offer heuristic, the full review flow
in JSDOM (8 rows → edit a title inline → uncheck three → add a dependency chip
→ Add → exactly 5 ordinary tasks with rewired real dependency ids, inherited
project, scheduled due dates, ⏱🔗 badges), zero-write guarantees on open /
regenerate / cancel, and the settings switch; plus route checks in
`server/test.mjs` (401 / 400-before-rate-limit / structured built-in plan /
429 / sync passthrough), coercion cases in `server/test-storage.mjs`, and
pipeline round-trips in `server/test-client.mjs` + `server/test-supabase.mjs`.

## Natural-Language Quick Add (`public/nl.js`)

**The promise:** understand freely, write only on confirmation. `ZTNL.parse()`
is a pure function with no write path; the app then offers exactly two
continuations — **[Create task]** (which feeds the composer's *existing* submit
pipeline — same validation, same reminder wiring, zero duplicated creation
logic) and **[Edit]** (which merely pre-fills the ordinary form). A task can
therefore never be born from a bad parse: press ✕, close the composer, or
ignore the card, and nothing was written (there is a byte-equality test pinning
this).

- **Grammar covered** — relative days (today/tonight/tomorrow/the day after
  tomorrow, `in N days/weeks`), weekday names (`on Friday`, `next Friday`),
  calendar dates (`March 3`, `3 March`, `2027-01-15`, `12/5` with a stated
  month/day reading), clock times (`7 PM`, `7pm`, `19:00`, `9:30am`, `noon`,
  `midnight`, `7 in the evening`), priorities (`high/urgent/asap/low/no rush`),
  `#tags`, project matching against **existing project names only** (it never
  invents one — an unknown “in Mars” just stays in the title), recurrence
  (`daily`, `weekly`, `monthly`, `every 2 weeks`, `every other day`,
  `every weekend`, `every weekday`, run-on day lists like `every Monday
  Wednesday and Friday`), and reminders mapped onto the app's real presets
  (`remind me one hour before` → *1 hour before*; `20 minutes before` →
  nearest preset **with a note saying it snapped**; `remind me at 9pm` →
  custom-time row; `Remind me to X tomorrow` → task X).
- **Honesty ledger** — every invented value (bare `at 7` assumed 19:00,
  `this weekend` assumed Saturday, a past `march 3` rolled to next year…)
  appends a human-readable note and drops `confidence` to `low`, which the UI
  renders as an amber card. High confidence still shows the card — this feature
  has **no silent path at all**, which is the only way the “never silently
  create” rule can't rot later.
- **Timezone** — all arithmetic uses local `Date` accessors (`getFullYear/
  getMonth/getDate`); no UTC conversion exists in the engine, so “tomorrow”
  at 23:30 on New Year's Eve is `2027-01-01` in the user's zone by
  construction (a test pins exactly that).
- **No new data model** — everything the parser finds lands in existing task
  fields (`dueDate`, `dueTime`, `priority`, `projectId`, `tags`, `recurrence`,
  `recurRule`) and existing reminder records. Schema, sync and backups are
  untouched; standalone `file://` copies get the identical parser inlined.
- **Tests** — `server/test-ui.mjs` §24 (43 checks): the four brief sentences
  parsed field-by-field, snap-with-note behaviour, project never-invented,
  local-zone midnight case, determinism, plus the whole UI gate: Enter shows
  the card, store byte-identical until [Create task], reminder records born
  with the task, Edit pre-fills the form (incl. the Mon/Wed/Fri chips in the
  repeat panel) with zero writes, ✕ abandons cleanly, and the bar hides
  itself in edit mode.

## Where your data is stored

| Location | Key / store | Contents |
|---|---|---|
| **IndexedDB** (primary) | db `zerotodo` (v5) → stores `tasks`, `trash`, `projects`, `subtasks`, `reminders`, `habits`, `meta` | All live tasks — recurrence included, since a recurring task is one record that rolls forward — soft-deleted tasks, schedules, habits, and `{schemaVersion, savedAt, settings}` |
| **localStorage** (redundant mirror) | `todo_backup_v1` | A full JSON copy of every store (tasks, trash, projects, subtasks, reminders, habits) + settings, rewritten after *every* successful IndexedDB write |
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
  fallback cards, summaries/habits/deadline scheduling + Focus-Mode notice
  delivery (`focusNotice` — the session engine itself lives in `app.js`), the dedup
  ledger and the Settings → Notifications UI. Loaded between `cloud.js` and
  `app.js`.
- `sw.js` — service worker: persistent notification display + routing clicks
  back to an open window (or deep-linking `#t=<id>` when there is none). It
  holds no app data and does no caching.
- `app.js` — UI, rendering, and user actions. Every mutation: mutate in-memory
  state → `store.commit(ops)` → re-render.
- `index.html` / `styles.css` — markup and themeable styles.
- `server/test.mjs` — Node smoke tests for the storage engine (run
  `node server/test.mjs`). They exercise: fresh start, IDB persistence,
  IDB-loss → backup restore, backup corruption, quota failure + auto-resync,
  migrations, payload validation, and cross-tab refresh.
- `server/test-storage.mjs` — the engine headless in Node, including the
  recurrence math (fixed-date cases for every rule family, clamping, parity
  and the horizon).
- `server/test-ui.mjs` — jsdom end-to-end sections (§1–§18): **§18** replays
  the full recurring flow through the real composer — rule pickers, rolling
  on completion, the series sheet verbs, the occurrence-vs-series dialog,
  calendar ghosts, trash/restore of patterns and export fidelity.

To change the data shape in the future: bump `SCHEMA_VERSION` in `storage.js`
and add a `MIGRATIONS[oldVersion]` step that transforms only known fields
(spread everything else through).
