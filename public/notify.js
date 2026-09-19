/* ============================================================================
 * notify.js — the DELIVERY layer for ZeroTodo reminders and alerts.
 *
 * Deliberately separate from the task UI (like cloud.js): the reminder engine
 * in app.js decides WHEN something is due and owns the records; this module
 * decides HOW it reaches the user and owns all notification state:
 *
 *  • permission is NEVER requested on load. Only the explicit
 *    "Enable Notifications" control (settings → Notifications) calls
 *    Notification.requestPermission() — once. When the browser says
 *    "denied", we show a blocked notice and never ask again.
 *  • mobile/PWA: once a service worker is active, notifications go through
 *    registration.showNotification() — a PERSISTENT notification (survives
 *    the app being swiped away), with Complete / Snooze / Open actions.
 *    Where SWs are unavailable (file://, older browsers) the plain
 *    Notification constructor is used; where even that is missing
 *    (iOS <16.4, Android Firefox…) every alert degrades to an in-app card
 *    with the same buttons. The app never crashes and never loses the alert.
 *  • duplicate prevention: every delivery has a unique instance id
 *    ("<kind>:<reminderId>@<triggerAt>" — a snooze/overdue re-arm naturally
 *    mints a new one). An id is written to the persisted ledger
 *    (zt_notify_v1) BEFORE the OS is touched, so crashes, double ticks,
 *    other tabs and re-synchronised devices can never re-alert for it.
 *    Each reminder record also carries its `notify: { key, at, via }` —
 *    the unique delivery state — which rides sync/backup like any field.
 *  • summaries (daily/weekly), habit check-ins and project deadline
 *    warnings are scheduled HERE (day-keyed ids), reading task data only
 *    through getState() — no task logic lives here. Focus-Mode phase notices
 *    are pushed in from app.js via focusNotice() — the engine there owns the
 *    session, this module only delivers.
 *
 * Public: window.ZTNotify = { attach, sanitize, renderControls, status,
 *   requestEnable, deliver, reminderAlert, tick, policy, wantsOverdue,
 *   focusNotice }
 * ==========================================================================*/
(function (global) {
  'use strict';

  const LEDGER_KEY = 'zt_notify_v1'; // { deliveryId: sentAt } — persisted dedup
  const LEDGER_CAP = 400;
  const SW_SCOPE_OK = () => { try { return global.isSecureContext; } catch (_) { return false; } };

  // Settings → Notifications model (lives in settings.notify → persists with
  // meta, syncs in the state doc, lands in backups — no extra store needed).
  const DEFAULTS = {
    master: false,           // gate for ALL OS/in-app notifications
    reminders: true,         // task reminder alerts
    overdue: true,           // "Task overdue" alerts
    daily: false, weekly: false, habits: false, pomo: false, proj: true,
    dailyAt: '09:00',        // timing configuration
    weeklyDay: 'mon', weeklyAt: '09:00',
    habitAt: '09:00',
    odMode: 'once',          // overdue policy: 'once' | 'repeat'
    odHours: 12,             // …repeat cadence (never spam faster than this)
    odGraceMin: 0,           // …fire N minutes after the due instant
    snoozeMin: 10,           // default snooze (buttons offer 5/10/30/60/Tomorrow)
    projDays: 2,             // warn when a project due date is within N days
  };
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const SNOOZE_OPTS = [[5, '5 min'], [10, '10 min'], [30, '30 min'], [60, '1 hour'], ['tomorrow', 'Tomorrow']];

  let H = null;         // host hooks from app.js (getState/commit/toast/…)
  let swReg = null;     // ServiceWorkerRegistration once we have one
  let cardWired = false;
  let bound = false;

  /* ------------------------------- helpers -------------------------------- */

  function cfg() {
    const st = H && H.getState();
    const raw = (st && st.settings && st.settings.notify) || {};
    const out = Object.assign({}, DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] === undefined || raw[k] === null) continue;
      if (typeof DEFAULTS[k] === 'boolean') out[k] = !!raw[k];
      else if (typeof DEFAULTS[k] === 'number') { const n = Number(raw[k]); if (Number.isFinite(n) && n >= 0) out[k] = n; }
      else out[k] = String(raw[k]);
    }
    if (!TIME_RE.test(out.dailyAt)) out.dailyAt = '09:00';
    if (!TIME_RE.test(out.weeklyAt)) out.weeklyAt = '09:00';
    if (!TIME_RE.test(out.habitAt)) out.habitAt = '09:00';
    if (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(out.weeklyDay) < 0) out.weeklyDay = 'mon';
    if (out.odMode !== 'repeat') out.odMode = 'once';
    out.odHours = Math.min(Math.max(1, Math.round(out.odHours) || 12), 72);
    out.odGraceMin = Math.min(Math.max(0, Math.round(out.odGraceMin) || 0), 720);
    return out;
  }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function mondayOf(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); }
  function daysUntil(ds) {
    if (typeof ds !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) return Infinity;
    const p = ds.split('-').map(Number);
    const a = new Date(); const t = new Date(p[0], p[1] - 1, p[2]);
    a.setHours(0, 0, 0, 0); t.setHours(0, 0, 0, 0);
    return Math.round((t - a) / 864e5);
  }
  function atOrPast(hm) {
    if (!TIME_RE.test(String(hm))) return true;
    const p = String(hm).split(':').map(Number);
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes() >= p[0] * 60 + p[1];
  }
  const esc = (s) => (H && H.esc ? H.esc(s) : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const toast = (m) => { if (H && H.toast) H.toast(m); };
  function fmtShort(ms) {
    try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return ''; }
  }

  function ledger() {
    try { return JSON.parse(global.localStorage.getItem(LEDGER_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function ledgerMark(id) {
    const m = ledger();
    m[id] = Date.now();
    const keys = Object.keys(m);
    if (keys.length > LEDGER_CAP) {
      keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - LEDGER_CAP).forEach((k) => { delete m[k]; });
    }
    try { global.localStorage.setItem(LEDGER_KEY, JSON.stringify(m)); } catch (_) {}
  }

  /* ------------------------------ permission ------------------------------ */

  function status() {
    if (!('Notification' in global)) return 'unsupported';
    try { return global.Notification.permission || 'default'; } catch (_) { return 'unsupported'; }
  }
  /** ONLY ever called from an explicit click on the Enable control. */
  function requestEnable() {
    if (status() !== 'default') return Promise.resolve(status());
    return Promise.resolve(global.Notification.requestPermission())
      .then((p) => { renderControls(); return p; })
      .catch(() => { renderControls(); return 'denied'; });
  }

  /* --------------------------- service worker ------------------------------- */

  function registerSW() {
    try {
      if (!('serviceWorker' in global.navigator) || !SW_SCOPE_OK() || !global.document || !global.document.addEventListener) return;
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* file:// or unsupported — in-app is fine */ });
      if (navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) => { swReg = reg || null; renderControls(); }).catch(() => {});
      }
      navigator.serviceWorker.addEventListener('message', (e) => onSwMessage(e && e.data));
    } catch (_) { swReg = null; }
  }
  function onSwMessage(d) {
    if (!d || d.type !== 'zt-notif-action' || !d.data) return;
    const a = d.action; const ref = d.data;
    if (a === 'complete' && ref.taskId && H && H.completeTask) { H.completeTask(ref.taskId); return; }
    if (a === 'snooze' && ref.reminderId && H && H.snoozeReminder) { H.snoozeReminder(ref.reminderId, cfg().snoozeMin); return; }
    if (a === 'open') { if (ref.taskId && H && H.openTask) H.openTask(ref.taskId); else if (ref.projectId && H && H.openProject) H.openProject(ref.projectId); return; }
    if (ref.taskId && H && H.openTask) { H.openTask(ref.taskId); return; }
    if (ref.projectId && H && H.openProject) { H.openProject(ref.projectId); }
  }

  /* -------------------------------- delivery -------------------------------- */

  function allowed(kind) {
    const n = cfg();
    if (!n.master) return false;
    if (kind === 'reminder') return !!n.reminders;
    if (kind === 'overdue') return !!n.overdue;
    if (kind === 'daily' || kind === 'weekly') return true;
    if (kind === 'habit') return !!n.habits;
    if (kind === 'proj') return !!n.proj;
    if (kind === 'pomo') return !!n.pomo;
    return true;
  }

  function osSend(opts) {
    const body = {
      body: opts.body || '',
      tag: opts.id,
      data: { taskId: opts.taskId || null, projectId: opts.projectId || null, reminderId: opts.reminderId || null, kind: opts.kind },
    };
    if (swReg && swReg.showNotification) {
      body.requireInteraction = true; // PERSISTENT on mobile — stays until handled
      if (opts.actions !== false) body.actions = [
        { action: 'complete', title: '✓ Complete' },
        { action: 'snooze', title: 'Snooze' },
        { action: 'open', title: '↗ Open' }, // browsers that cap at 2 drop this; click = Open there
      ];
      const p = swReg.showNotification(opts.title, body);
      if (p && p.catch) p.catch(() => {});
      return 'sw';
    }
    try {
      const n = new global.Notification(opts.title, body);
      if (opts.taskId || opts.projectId) {
        n.onclick = () => {
          try { global.focus && global.focus(); } catch (_) {}
          if (opts.taskId && H && H.openTask) H.openTask(opts.taskId);
          else if (opts.projectId && H && H.openProject) H.openProject(opts.projectId);
        };
      }
      return 'constructor';
    } catch (_) {
      return 'failed';
    }
  }

  /** opts: { id, title, body, taskId?, projectId?, reminderId?, quiet?, actions? } */
  function deliver(kind, opts) {
    if (!H || !opts || !opts.id) return Promise.resolve({ via: 'invalid' });
    const gate = allowed(kind);
    const L = ledger();
    const dup = !!L[opts.id];
    if (!gate && !opts.force) return Promise.resolve({ via: dup ? 'duplicate' : 'muted', key: opts.id });
    if (dup) return Promise.resolve({ via: 'duplicate', key: opts.id });
    ledgerMark(opts.id); // FIRST — every path after this is at-most-once
    let via = 'inapp';
    // force = the engine already decided this alert is due (a fired reminder).
    // It ALWAYS gets the in-app channel; the OS channel additionally needs
    // the master/feature switches and granted permission.
    if (gate && status() === 'granted') via = osSend(Object.assign({ kind }, opts));
    if (via === 'failed' || via === 'inapp') {
      if (!opts.quiet) inAppCard(opts); // degrade gracefully — never lose the alert
    }
    if (opts.reminderId) patchDeliveryState(opts.reminderId, opts.id, via);
    if (H.onChange) { try { H.onChange(); } catch (_) {} }
    return Promise.resolve({ via, key: opts.id });
  }

  /** unique per-reminder delivery state, persisted with the record */
  function patchDeliveryState(reminderId, key, via) {
    try {
      const st = H.getState();
      const r = (st.reminders || []).find((x) => x.id === reminderId);
      if (!r) return;
      r.notify = { key, at: Date.now(), via };
      // A hard delivery failure (OS threw AND it wasn't a policy re-arm) is
      // recorded as 'failed' — the statuses the spec names, on the record.
      if (via === 'failed' && r.status === 'triggered') r.status = 'failed';
      r.updatedAt = Date.now();
      H.commitOps([{ store: 'reminders', op: 'put', value: r }]);
    } catch (_) {}
  }

  /* --------------------------- in-app alert cards --------------------------- */

  function inAppCard(opts) {
    const host = global.document && global.document.getElementById('toastHost');
    if (!host) return;
    const el = global.document.createElement('div');
    el.className = 'toast show toast-rem toast-notify';
    let html = '<span>' + esc(opts.title) + ' — ' + esc(opts.body) + '</span><div class="rem-actions">';
    if (opts.taskId) html += '<button type="button" class="btn btn-sm btn-ghost" data-remopen="' + esc(opts.taskId) + '">Open</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-remcomplete="' + esc(opts.taskId) + '">Complete</button>';
    if (opts.projectId) html += '<button type="button" class="btn btn-sm btn-ghost" data-projopen="' + esc(opts.projectId) + '">Open project</button>';
    if (opts.reminderId) {
      html += '<span class="rem-snoozes">Snooze:' + SNOOZE_OPTS.map(([v, l]) =>
        '<button type="button" class="btn btn-sm btn-ghost" data-snooze="' + v + '" data-remid="' + esc(opts.reminderId) + '">' + l + '</button>').join('') + '</span>';
    }
    if (opts.reminderId || opts.taskId) html += '<button type="button" class="btn btn-sm btn-ghost" data-remdismiss="' + esc(opts.reminderId || '') + '">Dismiss</button>';
    html += '</div>';
    el.innerHTML = html;
    host.appendChild(el);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 12000);
  }

  /* ----------------------------- reminder alert ----------------------------- */

  /* The task's own due moment (mirrors the engine's convention: all-day due
     dates are 09:00 local). Lets alert bodies carry the LEAD TIME the spec
     shows — “Finish Python project is due in 30 minutes.” — instead of a
     bare clock time. */
  function dueMoment(t) {
    if (!t || !t.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)) return null;
    const p = t.dueDate.split('-').map(Number);
    let hh = 9; let mi = 0;
    if (typeof t.dueTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime)) {
      const q = t.dueTime.split(':').map(Number); hh = q[0]; mi = q[1];
    }
    return new Date(p[0], p[1] - 1, p[2], hh, mi, 0, 0).getTime();
  }
  function leadPhrase(t) {
    const due = dueMoment(t);
    if (due == null) return null;
    const mins = Math.round((due - Date.now()) / 60000);
    if (mins <= 0) return ' is due now.';
    if (mins < 60) return ' is due in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.';
    if (mins < 24 * 60) { const h = Math.round(mins / 60); return ' is due in ' + h + ' hour' + (h === 1 ? '' : 's') + '.'; }
    const d = Math.round(mins / 1440);
    return d <= 1 ? ' is due tomorrow.' : ' is due in ' + d + ' days.';
  }


  function reminderAlert(r, t, lateMs) {
    const isOd = r.reminderType === 'overdue';
    const kind = isOd ? 'overdue' : 'reminder';
    const id = (isOd ? 'od:' : 'rem:') + r.id + '@' + r.triggerAt;
    const title = isOd ? 'Task overdue' : 'Task Reminder';
        const lead = leadPhrase(t);
    const body = isOd
      ? t.title + ' is overdue (was due ' + fmtShort(r.triggerAt) + ').'
      : (lateMs > 60000
        ? t.title + ' — reminder was due ' + fmtShort(r.triggerAt) + ' (missed).'
        : lead != null
          ? t.title + lead
          : t.title + ' is due ' + (t.dueTime ? 'at ' + t.dueTime : 'today') + '.');
    // force: a fired reminder record is never silently swallowed — worst case
    // the user sees the in-app card; OS delivery follows the switches.
    deliver(kind, { id, title, body, taskId: t.id, reminderId: r.id, force: true });
  }

  /* ------------------------- periodic schedules: tick ----------------------- */

  function buildSummary(days) {
    const st = H.getState();
    const today = new Date(); const end = new Date(today.getTime() + days * 864e5);
    let open = 0; let overdue = 0; let armed = 0;
    const todayS = ymd(today); const endS = ymd(end);
    const activeIds = new Set(st.tasks.filter((t) => t.status !== 'completed').map((t) => t.id));
    for (const t of st.tasks) {
      if (t.status === 'completed' || !t.dueDate) continue;
      if (t.dueDate < todayS) overdue++;
      else if (t.dueDate <= endS) open++;
    }
    for (const r of st.reminders) if (r.status === 'pending' && r.triggerAt >= Date.now() && r.triggerAt <= end.getTime()) armed++;
    void activeIds;
    const label = days === 1 ? 'Today' : 'This week';
    return label + ': ' + open + ' task(s) due, ' + overdue + ' overdue, ' + armed + ' reminder(s) firing ahead.';
  }

  function tick() {
    if (!H || !H.getState() || !H.getState().settings) return;
    const n = cfg();
    if (!n.master) { if (pomo) pomoStop(); return; }
    const now = new Date();
    const dayKey = ymd(now);
    if (n.daily && atOrPast(n.dailyAt)) {
      deliver('daily', { id: 'sum:d:' + dayKey, title: 'Daily summary', body: buildSummary(1), quiet: true });
    }
    if (n.weekly && nowDayIs(n.weeklyDay) && atOrPast(n.weeklyAt)) {
      deliver('weekly', { id: 'sum:w:' + mondayOf(now), title: 'Weekly summary', body: buildSummary(7), quiet: true });
    }
    if (n.habits && atOrPast(n.habitAt)) {
      const st = H.getState();
      for (const t of st.tasks) {
        if (t.status !== 'active' || t.recurrence !== 'daily' || t.dueDate !== dayKey) continue;
        deliver('habit', { id: 'hab:' + t.id + ':' + dayKey, title: 'Habit check-in', body: '“' + t.title + '” is on your plate today — knock it out.', taskId: t.id, quiet: true });
      }
    }
    if (n.proj) {
      const st = H.getState();
      for (const p of st.projects || []) {
        if (!p.dueDate || p.deletedAt || p.archived || p.status === 'completed') continue;
        const left = daysUntil(p.dueDate);
        if (left < 0 || left > n.projDays) continue;
        const openT = st.tasks.filter((t) => t.projectId === p.id && t.status !== 'completed').length;
        deliver('proj', {
          id: 'pd:' + p.id + ':' + dayKey,
          title: 'Project deadline',
          body: '“' + p.name + '” is ' + (left === 0 ? 'due today' : 'due in ' + left + ' day(s)') + ' — ' + openT + ' task(s) still open.',
          projectId: p.id, quiet: true,
        });
      }
    }
    if (pomo && Date.now() >= pomo.endsAt) pomoAdvance();
  }
  function nowDayIs(key) {
    return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()] === key;
  }

  /* ------------------------------- focus mode ------------------------------
   * The Focus-Mode engine lives in app.js (the session is TASK data: it is
   * persisted, synced and tracked). This module only delivers its phase
   * notices through the standard gated/deduped channel ('pomo' switch). */

  function focusNotice(title, body) {
    return deliver('pomo', { id: 'focus:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7), title: title, body: body, quiet: false });
  }

  /* ----------------------------- settings panel ----------------------------- */

  function el(id) { return global.document && global.document.getElementById(id); }

  function renderControls() {
    if (!global.document) return;
    const n = cfg();
    const set = (id, v) => { const e = el(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } };
    set('nMaster', n.master); set('nReminders', n.reminders); set('nOverdue', n.overdue);
    set('nDaily', n.daily); set('nDailyAt', n.dailyAt);
    set('nWeekly', n.weekly); set('nWeeklyDay', n.weeklyDay); set('nWeeklyAt', n.weeklyAt);
    set('nHabits', n.habits); set('nHabitAt', n.habitAt);
    set('nPomo', n.pomo);
    set('nProj', n.proj); set('nProjDays', String(n.projDays));
    set('nOdMode', n.odMode); set('nOdHours', String(n.odHours)); set('nOdGrace', String(n.odGraceMin));
    set('nSnooze', String(n.snoozeMin));
    const row = el('notifPermRow');
    if (row) {
      const st = status();
      if (st === 'unsupported') row.innerHTML = '<p class="muted small notif-status">This browser has no Notifications API — alerts stay in-app (and reminders still ring here while the app is open).</p>';
      else if (st === 'denied') row.innerHTML = '<p class="notif-status is-warn">🔕 Notifications are blocked. Enable them in browser settings.</p>';
      else if (st === 'granted') row.innerHTML = '<p class="notif-status is-ok">🔔 Notifications are ' + (swReg ? 'persistent (via service worker)' : 'enabled') + '. <button type="button" class="btn btn-sm btn-ghost" data-notif="test">Send test</button></p>';
      else row.innerHTML = '<p class="muted small notif-status">Permission has not been granted yet.</p> <button type="button" class="btn btn-sm btn-primary" data-notif="enable">Enable Notifications</button>';
    }
  }

  const CONTROLS = {
    nMaster: 'master', nReminders: 'reminders', nOverdue: 'overdue',
    nDaily: 'daily', nWeekly: 'weekly', nHabits: 'habits', nPomo: 'pomo', nProj: 'proj',
    nDailyAt: 'dailyAt', nWeeklyDay: 'weeklyDay', nWeeklyAt: 'weeklyAt', nHabitAt: 'habitAt',
    nOdMode: 'odMode', nOdHours: 'odHours', nOdGrace: 'odGraceMin',
    nSnooze: 'snoozeMin', nProjDays: 'projDays',
  };

  function bindControls() {
    if (bound || !global.document) return;
    bound = true;
    for (const [id, key] of Object.entries(CONTROLS)) {
      const e = el(id);
      if (!e) continue;
      const handler = () => {
        const st = H && H.getState();
        if (!st) return;
        st.settings.notify = Object.assign({}, cfg(), {
          [key]: e.type === 'checkbox' ? e.checked : e.value,
        });
        // Enabling the master switch from an explicit click is the ONE place
        // we ever ask for permission (and only while the answer is 'default').
        if (key === 'master' && e.checked && status() === 'default') requestEnable();
        if (key === 'master' && !e.checked) { if (pomo) pomoStop(); }
        if (H.commitSettings) H.commitSettings();
        renderControls();
      };
      e.addEventListener('change', handler);
    }
    const host = el('notifBox');
    if (host) {
      host.addEventListener('click', (e) => {
        const en = e.target.closest('[data-notif="enable"]');
        if (en) { requestEnable(); return; }
        const te = e.target.closest('[data-notif="test"]');
        if (te) {
          deliver('test', { id: 'test:' + Date.now(), title: 'ZeroTodo', body: 'This is how alerts will look. 🔔', quiet: true });
          toast('Test notification sent (check the OS tray even if the app is open).');
          return;
        }
      });
    }
    // In-app alert cards live in #toastHost — their action buttons must be
    // handled THERE (cards appear whether or not the settings panel is open).
    // Wired once; handlers read the live H, so re-attach can't double-bind.
    if (!cardWired) {
      cardWired = true;
      const th = el('toastHost') || (global.document && global.document.body);
      if (th) {
        th.addEventListener('click', (e) => {
          const sn = e.target.closest('[data-snooze]');
          if (sn) {
            const v = sn.dataset.snooze;
            if (H && H.snoozeReminder) H.snoozeReminder(sn.dataset.remid, v === 'tomorrow' ? 'tomorrow' : Number(v));
            const box = sn.closest('.toast'); if (box) box.remove();
            return;
          }
          const cp = e.target.closest('[data-remcomplete]');
          if (cp) {
            if (H && H.completeTask) H.completeTask(cp.dataset.remcomplete);
            const box = cp.closest('.toast'); if (box) box.remove();
            return;
          }
          const po = e.target.closest('[data-projopen]');
          if (po) {
            if (H && H.openProject) H.openProject(po.dataset.projopen);
            const box = po.closest('.toast'); if (box) box.remove();
          }
        });
      }
    }
  }

  /* --------------------------------- attach --------------------------------- */

  function sanitize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] === undefined || raw[k] === null) continue;
        if (typeof DEFAULTS[k] === 'boolean') out[k] = !!raw[k];
        else if (typeof DEFAULTS[k] === 'number') { const n = Number(raw[k]); if (Number.isFinite(n) && n >= 0) out[k] = n; }
        else if (typeof raw[k] === 'string') out[k] = raw[k];
      }
    }
    if (!TIME_RE.test(out.dailyAt)) out.dailyAt = '09:00';
    if (!TIME_RE.test(out.weeklyAt)) out.weeklyAt = '09:00';
    if (!TIME_RE.test(out.habitAt)) out.habitAt = '09:00';
    if (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(out.weeklyDay) < 0) out.weeklyDay = 'mon';
    if (out.odMode !== 'repeat') out.odMode = 'once';
    out.odHours = Math.min(Math.max(1, Math.round(out.odHours) || 12), 72);
    out.odGraceMin = Math.min(Math.max(0, Math.round(out.odGraceMin) || 0), 720);
    return out;
  }

  function attach(hooks) {
    H = hooks;
    bindControls();
    registerSW();
    renderControls();
    return true;
  }

  global.ZTNotify = {
    attach, sanitize, renderControls, status, requestEnable,
    deliver, reminderAlert, tick,
    policy: () => { const n = cfg(); return { odMode: n.odMode, odHours: n.odHours, odGraceMin: n.odGraceMin, snoozeMin: n.snoozeMin }; },
    wantsOverdue: () => { const n = cfg(); return n.master && n.overdue; },
    focusNotice,
    isPersistent: () => !!swReg,
    __swMessage: (d) => onSwMessage(d), // test hook: simulate a notification click routed by the SW
    DEFAULTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
