/* ZTPLAN — AI daily-planning engine. PURE: reads the user's own data
 * (tasks, priorities, deadlines, projects, subtask load, reminders, estimated
 * durations, and the day's calendar schedule) and PROPOSES a day plan.
 * It never writes anything: the app only touches stored data when the user
 * presses [Accept plan] (and edits they make happen in the proposal UI, not
 * in the stores). Deterministic: same input (incl. `now`) → same plan, byte
 * for byte — which is also what makes it fully testable.
 *
 * Ranking follows the brief, in exactly this order:
 *   1. overdue tasks        (score 1000+; deeper overdue ranks higher)
 *   2. urgent deadlines     (due today 800; due within 2 days 600)
 *   3. high-priority tasks  (+120; low gets −40 so it can drop below fillers)
 *   4. project dependencies (a task that unblocks others +80 each; a task
 *     whose blocker is also in the pool is moved AFTER its blocker)
 *   5. user-selected goals  (+250, the goal project picked in the panel)
 * Untagged open tasks still fill leftover space (base 25) — the plan is
 * optional and generous, but the five rules above always decide the order.
 *
 * Calendar respect: anything already pinned to a time today — a task's own
 * dueTime (+ its estimate) and every pending reminder that fires that day —
 * becomes a BUSY window; blocks are only placed in free 15-minute-grid slots
 * between them. Days end at the user's own cutoff (default 22:00), and blocks
 * keep a breathing gap (default 15 min) between them.
 * ======================================================
 */
(function (global) {
  'use strict';

  var GRID = 15; // minutes — everything snaps to a quarter hour

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function ymdParse(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function toMin(hhmm) { if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null; return +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5); }
  function fromMin(m) { m = ((m % 1440) + 1440) % 1440; return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
  function snapUp(m) { return Math.ceil(m / GRID) * GRID; }
  function clampInt(v, lo, hi, dflt) { var n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; }
  function dayDiff(aYmdStr, bYmdStr) { return Math.round((ymdParse(bYmdStr) - ymdParse(aYmdStr)) / 86400000); }

  var DEFAULT_PREFS = { dayStart: '09:00', dayEnd: '22:00', gapMin: 15, maxBlocks: 6, goalProjectId: null };

  function sanitizePrefs(p) {
    p = (p && typeof p === 'object') ? p : {};
    return {
      dayStart: toMin(p.dayStart) != null ? p.dayStart : DEFAULT_PREFS.dayStart,
      dayEnd: toMin(p.dayEnd) != null ? p.dayEnd : DEFAULT_PREFS.dayEnd,
      gapMin: clampInt(p.gapMin != null ? p.gapMin : DEFAULT_PREFS.gapMin, 0, 120, 15),
      maxBlocks: clampInt(p.maxBlocks != null ? p.maxBlocks : DEFAULT_PREFS.maxBlocks, 1, 12, 6),
      goalProjectId: typeof p.goalProjectId === 'string' && p.goalProjectId ? p.goalProjectId : null,
    };
  }

  /** Round an estimate to a friendly block length (15-min grid, sane bounds). */
  function blockMin(t) {
    var raw = Number(t.estMin) > 0 ? Math.round(Number(t.estMin))
      : (t.priority === 'high' ? 60 : t.priority === 'low' ? 30 : 45);
    raw = Math.ceil(raw / GRID) * GRID;
    return Math.min(120, Math.max(GRID, raw));
  }

  /**
   * planDay({ tasks, reminders, subtasks?, projects?, now, date?, prefs? })
   * → { date, blocks, skipped, notes, analyzed }  (see header for semantics)
   */
  function planDay(input) {
    input = input || {};
    var now = input.now instanceof Date ? new Date(input.now.getTime()) : new Date(input.now || Date.now());
    var prefs = sanitizePrefs(input.prefs);
    var date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : ymd(now);
    var today = ymd(now);

    var all = Array.isArray(input.tasks) ? input.tasks : [];
    var live = all.filter(function (t) { return t && t.id && t.status !== 'completed'; });
    var subCount = {}; // subtask load per parent: a task with open subtasks is heavier
    (Array.isArray(input.subtasks) ? input.subtasks : []).forEach(function (s) {
      if (s && s.parentTaskId && !s.done) subCount[s.parentTaskId] = (subCount[s.parentTaskId] || 0) + 1;
    });
    var remToday = (Array.isArray(input.reminders) ? input.reminders : []).filter(function (r) {
      return r && r.status === 'pending' && Number.isFinite(Number(r.triggerAt)) &&
        r.triggerAt > 0 && ymd(new Date(r.triggerAt)) === date;
    });

    // ---------- 1. score the candidates (the brief's five tiers, in order) ----------
    var scored = [];
    for (var i = 0; i < live.length; i++) {
      var t = live[i];
      var why = [];
      var score = 0;
      if (t.dueDate) {
        var dd = dayDiff(date, t.dueDate); // dueDate − planDate (negative = overdue)
        if (dd < 0) { score += 1000 + Math.min(-dd, 10) * 40; why.push('overdue by ' + (-dd) + 'd'); }
        else if (dd === 0) { score += 800; why.push('due today'); }
        else if (dd <= 2) { score += 600; why.push('urgent: due ' + (dd === 1 ? 'tomorrow' : 'in ' + dd + ' days')); }
      }
      if (t.priority === 'high') { score += 120; if (why.length < 3) why.push('high priority'); }
      else if (t.priority === 'low') score -= 40;
      if (prefs.goalProjectId && t.projectId === prefs.goalProjectId) { score += 250; why.push('your goal'); }
      if (subCount[t.id]) score += 30; // open subtasks: real load, nudge it up
      if (score === 0) score = 25; // plain open task → eligible filler, never above the tiers
      scored.push({ t: t, score: score, why: why });
    }
    var pool = {};
    scored.forEach(function (x) { pool[x.t.id] = x; });

    // dependency bonuses + the AFTER-blocker constraint (tier 4)
    scored.forEach(function (x) {
      var unblocks = 0;
      scored.forEach(function (o) {
        if (o !== x && Array.isArray(o.t.deps) && o.t.deps.indexOf(x.t.id) >= 0) unblocks++;
      });
      if (unblocks) { x.score += 80 * unblocks; x.unblocks = unblocks; x.why.unshift('unblocks ' + unblocks + ' task' + (unblocks > 1 ? 's' : '')); }
      x.needs = (Array.isArray(x.t.deps) ? x.t.deps : []).filter(function (d) { return pool[d] && pool[d] !== x; });
      if (x.needs.length) x.why.push('after its blocker' + (x.needs.length > 1 ? 's' : ''));
    });

    scored.sort(function (a, b) {
      return (b.score - a.score) ||
        ((a.t.dueDate || '9999') < (b.t.dueDate || '9999') ? -1 : (a.t.dueDate || '9999') > (b.t.dueDate || '9999') ? 1 : 0) ||
        (a.t.sortOrder - b.t.sortOrder) || (a.t.title < b.t.title ? -1 : a.t.title > b.t.title ? 1 : 0);
    });
    // stable reorder: push every dependent task just after its latest blocker
    for (var pass = 0; pass < 3; pass++) {
      var moved = false;
      for (var a = 0; a < scored.length; a++) {
        var nb = -1;
        for (var b = 0; b < scored.length; b++) if (scored[a].needs.indexOf(scored[b].t.id) >= 0 && b > a) nb = Math.max(nb, b);
        if (nb > a) { var item = scored.splice(a, 1)[0]; scored.splice(nb - 1 + 1, 0, item); moved = true; }
      }
      if (!moved) break;
    }

    // ---------- 2. the day's schedule = busy windows (never overlapped) ----------
    var busy = [];
    live.forEach(function (t) {
      if (t.dueDate === date && toMin(t.dueTime) != null) {
        var s0 = toMin(t.dueTime), dur0 = blockMin(t);
        busy.push({ s: s0, e: Math.min(1440, s0 + dur0), label: t.title, owner: t.id });
      }
    });
    remToday.forEach(function (r) {
      var d = new Date(r.triggerAt), m = d.getHours() * 60 + d.getMinutes();
      busy.push({ s: Math.max(0, m - GRID), e: m, label: 'reminder' });
    });
    busy.sort(function (x, y) { return x.s - y.s || x.e - y.e; });

    // ---------- 3. place blocks on the grid ----------
    var notes = [];
    var openMin = toMin(prefs.dayStart), closeMin = toMin(prefs.dayEnd);
    if (closeMin <= openMin) closeMin = openMin + 15;
    var floorMin = openMin;
    if (date === today) {
      var nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin + 5 > floorMin) floorMin = snapUp(nowMin + 5);
      if (floorMin >= closeMin) notes.push('the planned part of today is already past — accept later blocks or re-plan for tomorrow');
    }
    // A candidate scans from the earliest legal minute (NOT one-way): a task
    // pinned to 17:00 leaves a real morning hole, and the planner fills it.
    // Between plan blocks the user's gap rule holds; busy windows just must
    // not be overlapped.
    function collides(s, e, ignoreOwner) {
      for (var k = 0; k < busy.length; k++) {
        if (busy[k].owner === ignoreOwner) continue; // the task's OWN pin is not an obstacle
        if (s < busy[k].e && e > busy[k].s) return true;
      }
      for (var j = 0; j < placed.length; j++) {
        if (s < placed[j].eMin + prefs.gapMin && e + prefs.gapMin > placed[j].sMin) return true;
      }
      return false;
    }

    var placed = [];
    var skipped = [];
    for (var q = 0; q < scored.length; q++) {
      var cand = scored[q];
      if (cand.score < 25 && !cand.needs.length) { continue; } // low-priority nothing — leave it out silently
      if (placed.length >= prefs.maxBlocks) { skipped.push({ taskId: cand.t.id, title: cand.t.title, reason: 'day is full (' + prefs.maxBlocks + ' blocks — raise the cap in ⚙)' }); continue; }
      var dur = blockMin(cand.t);
      var found = -1, pinned = false;
      // a task already pinned to a time today gets its OWN slot — the plan
      // uses the user's schedule, it does not fight it (the brief's 17:00
      // Exercise is exactly this case)
      var pin = (cand.t.dueDate === date) ? toMin(cand.t.dueTime) : null;
      if (pin != null && pin >= floorMin && pin + dur <= closeMin && !collides(pin, pin + dur, cand.t.id)) {
        found = pin; pinned = true;
      } else {
        var s = snapUp(floorMin);
        while (s + dur <= closeMin) {
          if (!collides(s, s + dur, cand.t.id)) { found = s; break; }
          s += GRID;
        }
      }
      if (found < 0) { skipped.push({ taskId: cand.t.id, title: cand.t.title, reason: 'no free ' + dur + '-min slot before ' + fromMin(closeMin) }); continue; }
      placed.push({
        taskId: cand.t.id, title: cand.t.title, priority: cand.t.priority || 'med',
        dueDate: cand.t.dueDate || null, projectId: cand.t.projectId || null,
        start: fromMin(found), end: fromMin(found + dur), min: dur, sMin: found, eMin: found + dur,
        why: (pinned ? ['at its scheduled time'] : []).concat(cand.why.slice(0, pinned ? 2 : 3)),
      });
    }
    placed.sort(function (x, y) { return toMin(x.start) - toMin(y.start); }); // the day, in order
    placed.forEach(function (p) { delete p.sMin; delete p.eMin; }); // keep the object minimal (it is what UI/tests read)

    // ---------- 4. the transparency ledger (what the AI actually saw) ----------
    var overdueN = scored.filter(function (x) { return x.why.some(function (w) { return w.indexOf('overdue') === 0; }); }).length;
    var todayN = scored.filter(function (x) { return x.why.indexOf('due today') >= 0; }).length;
    var analyzed = {
      tasks: live.length,
      overdue: overdueN,
      dueToday: todayN,
      high: scored.filter(function (x) { return x.t.priority === 'high'; }).length,
      remindersToday: remToday.length,
      busyWindows: busy.length,
      goalProject: prefs.goalProjectId,
    };
    notes.unshift('analyzed ' + live.length + ' open task' + (live.length === 1 ? '' : 's') +
      ' · ' + overdueN + ' overdue · ' + todayN + ' due today · ' + busy.length + ' scheduled item' + (busy.length === 1 ? '' : 's') +
      ' kept clear' + (prefs.goalProjectId ? ' · goal project boosted' : ''));
    if (skipped.length) notes.push(skipped.length + ' eligible task' + (skipped.length === 1 ? '' : 's') + ' did not fit and were left unscheduled');
    if (!placed.length && scored.length) notes.push('nothing fit — widen your day or raise the block cap');
    if (!scored.length) notes.push('no open tasks to plan — the day is yours');

    return { date: date, blocks: placed, skipped: skipped, notes: notes, analyzed: analyzed, dayStart: prefs.dayStart, dayEnd: prefs.dayEnd };
  }

  /* Accept/Reject stays in the app; the engine also offers a tiny helper to
     validate an EDITED block (manual time moves are user law — only shape is
     checked, the user may overlap whatever they like). */
  function validEditedBlock(b) {
    return !!(b && toMin(b.start) != null && toMin(b.end) != null && toMin(b.end) > toMin(b.start));
  }
  function fmtRange(b) { return b.start + '–' + b.end; }

  var ZTPLAN = {
    planDay: planDay,
    sanitizePrefs: sanitizePrefs,
    validEditedBlock: validEditedBlock,
    fmtRange: fmtRange,
    // exported for tests / reuse, mirroring the ZTNL convention:
    toMin: toMin, fromMin: fromMin, ymd: ymd,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ZTPLAN;
  else global.ZTPLAN = ZTPLAN;
  if (global) global.ZTPLAN = ZTPLAN; // browser global even when CJS is around
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
