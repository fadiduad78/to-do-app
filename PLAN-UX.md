# Internal implementation plan — UX improvement / Calendar / Habits / Settings pass

Audit results (what already exists — REUSE, don’t rebuild):
- Home: renderHome() stats row is `'<b>2 · 1 ✓</b>'` string-concat — the confusing metric (brief §2).
- Planner: ↻ rescan DOES recompute (`planCompute()` reads live S.tasks) but gives zero feedback
  and renderPlan reuses a cached `P.sug` while task edits elsewhere happen (stale note needed).
  Engine notes carry the only 'window HH–HH' string (test §25 asserts it → reword test + UI together).
- Calendar: month cells render full task chips (brief says dots+counts); day view exists with
  hour rows + summary + data-cnew quick-create + slot click → calQuickCreate; drag-reschedule
  ALREADY updates the real task (dueDate/dueTime, same id, undo-less toast) ✓ §16 satisfied.
- Projects: form modal already has name/desc/due/icon/color/validation ✓ §19 satisfied;
  cards are an uneven flex-wrap → grid.
- Habits: engine (streaks/habitStats/weekly/monthly strips) is solid → UI layer only:
  Today progress header, streak prominence, milestones, forgiving miss line, recommendations
  (static catalog + derived personalization) prefilled into the EXISTING habitModal (steps =
  visual grouping, all hh-* ids + save handler untouched).
- Settings: one flat ~20-row stack → categorize into pages with left nav (desktop) / drill
  (mobile); zero ids change; ZTNotify keeps owning notifBox.
- estMin exists on tasks (AI breakdown, advisory) → usable for the “~2h 10m estimated” line.

Batch 1 (this): Home metric · planner re-analyze honesty + human language + balance panel ·
dashboard spacing · projects grid + metadata.
Batch 2: Calendar month density cells · Day Overview readability · Time Balance on day/week ·
quick-action labels.
Batch 3: Habits motivation (today header, streak, milestones, miss, week grid, recommendations,
completion feedback) · Settings IA pages + mobile drill + contextual “Enable in Settings →”.
Batch 4: new tests (§27 planner/home, §28 calendar, §29 habits, §30 settings), full suite,
README, standalone rebuild, commit+push, prod verify.

Rules: no new deps; no data-layer changes; every existing test stays green except the two
wording assertions deliberately updated (window/plan header); all derived math computed once
per render.


## STATUS (updated) — Batches 1–4 COMPLETE
B1 home/plan/projects ✅ · B2 calendar (month density, day overview, slot-create) ✅ · B3 habits motivation + wizard + settings IA ✅ · B4 tests §27–29 (581 total, 51 new) ✅ · suites: ui 581, storage 140, server 76, client 37, supabase 30 — all green · standalone rebuilt 552.6 KB · README UX-pass section added.
