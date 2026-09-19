/* ============================================================================
 * app.js — ZeroTodo UI layer
 * ----------------------------------------------------------------------------
 * This file owns rendering and user actions. Every mutation follows the same
 * pattern (write-through, zero-loss):
 *
 *   1. mutate the live in-memory state (store.state — the storage engine's
 *      authoritative copy; storage.js validates before anything hits disk)
 *   2. store.commit(ops) — ONE atomic IndexedDB transaction + the redundant
 *      localStorage mirror + a cross-tab broadcast (see storage.js)
 *   3. re-render
 *
 * If the write fails, the memory state is intentionally KEPT and the banner
 * / save-pill surface the problem — the user never sees data "disappear".
 * ==========================================================================*/
(function () {
  'use strict';

  const { constants, helpers } = globalThis.ZTStorage || window.ZTStorage;
  const LS_DRAFT_KEY = constants.LS_DRAFT_KEY;
  const STORES = constants.STORES;
  const DAY_MS = 86400000;

  /* ------------------------------ Elements ------------------------------ */

  const $ = (id) => document.getElementById(id);

  const els = {
    savePill: $('savePill'), savePillText: $('savePillText'),
    exportBtn: $('exportBtn'), importBtn: $('importBtn'),
    themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'),
    bannerHost: $('bannerHost'),
    composer: $('composer'), composerTitle: $('composerTitle'),
    taskForm: $('taskForm'),
    fTitle: $('f-title'), fDesc: $('f-desc'), fDue: $('f-due'), fTime: $('f-time'),
    fPriority: $('f-priority'), fProject: $('f-project'), fTags: $('f-tags'),
    saveTaskBtn: $('saveTaskBtn'), cancelTaskBtn: $('cancelTaskBtn'), draftHint: $('draftHint'),
    searchInput: $('searchInput'), newTaskBtn: $('newTaskBtn'),
    draftResume: $('draftResume'), draftResumeBtn: $('draftResumeBtn'), draftDiscardBtn: $('draftDiscardBtn'),
    filterTabs: $('filterTabs'), tagChips: $('tagChips'),
    projectBar: $('projectBar'), projectDetail: $('projectDetail'),
    calBtn: $('calBtn'), calendar: $('calendar'), calBar: $('calBar'), calHost: $('calHost'),
    dashBtn: $('dashBtn'), dashboard: $('dashboard'), dashHost: $('dashHost'),
    habBtn: $('habBtn'), habitsView: $('habitsView'), habitsHost: $('habitsHost'), habInStats: $('habInStats'),
    aiMode: $('aiMode'),
    nlBox: $('nlBox'), nlInput: $('nlInput'), nlParseBtn: $('nlParseBtn'), nlCard: $('nlCard'),
    focusBar: $('focusBar'),
    fRecurrence: $('f-recurrence'), remRows: $('remRows'), addRemBtn: $('addRemBtn'),
    recurPanel: $('recurPanel'), rcEvery: $('rcEvery'), rcUnit: $('rcUnit'), rcDays: $('rcDays'), rcHint: $('rcHint'),
    taskList: $('taskList'), emptyState: $('emptyState'),
    trashBar: $('trashBar'), trashCount: $('trashCount'), emptyTrashBtn: $('emptyTrashBtn'),
    settingsPanel: $('settingsPanel'), themeSelect: $('themeSelect'), reminderSelect: $('reminderSelect'),
    subtaskAuto: $('subtaskAuto'),
    fzWork: $('fzWork'), fzShort: $('fzShort'), fzLong: $('fzLong'), fzEvery: $('fzEvery'),
    fzNotify: $('fzNotify'), fzAuto: $('fzAuto'),
    storageInfo: $('storageInfo'),
    toastHost: $('toastHost'), modalHost: $('modalHost'), importFile: $('importFile'),
    footerCounts: $('footerCounts'),
  };

  /* --------------------------- Storage engine --------------------------- */

  const store = globalThis.ZTStorage ? ZTStorage.createStore({
    onStatus(state, at) {
      if (state === 'saving') setPill('saving');
      else if (state === 'saved') { S.lastSavedAt = at; setPill('saved'); }
      else if (state === 'error') setPill('error');
    },
    onError(msg) {
      showBanner({
        kind: 'error', id: 'commit-error',
        message: msg + ' Nothing was erased.',
        actions: [{
          label: 'Retry save', primary: true,
          fn: () => store.resync().then((ok) => { if (ok) dismissBanner('commit-error'); }),
        }],
      });
    },
    onQuota() {
      showBanner({
        kind: 'error', id: 'quota', sticky: true,
        message: 'Browser storage is full (quota exceeded) — recent changes may not be persisting. Export your data now, and delete tasks or trash items you no longer need.',
      });
    },
    onQuotaCleared() { dismissBanner('quota'); },
    onBackupWarn(msg) { showBanner({ kind: 'warn', id: 'backup-warn', sticky: true, message: msg }); },
    onExternalChange() { renderAll(); remReconcile(); }, // another tab committed — disk is truth
  }) : null;

  // `S` is the live in-memory state owned by the storage engine. The UI
  // mutates it directly; storage.commit() is what makes it durable.
  let S = null;

  /* =============================== INIT ================================= */

  init();

  async function init() {
    if (!store) {
      showBanner({ kind: 'error', sticky: true, message: 'The storage engine failed to load (storage.js missing?).' });
      return;
    }
    wireEvents();
    setPill('saving', 'Loading…');

    // Startup recovery: IndexedDB → localStorage fallback → fresh, with
    // migration + validation (see storage.js recover()).
    const rec = await store.recover();
    S = rec.state;
    S.ui = { search: '', editingId: null, composerOpen: false, projectView: null, showArchived: false, openSubs: {}, subEditing: null,
               cal: { open: false, view: 'month', anchor: '' },
               dash: { open: false }, hab: { open: false, showArch: false }, focus: { taskId: null } };
    S.lastSavedAt = rec.lastSavedAt;
    // Re-persist filter preferences from disk (they are part of settings).
    S.settings.filterMode = ['all', 'active', 'completed', 'trash'].includes(S.settings.filterMode) ? S.settings.filterMode : 'all';
    // Project filter persists like the tag filter, so "which project was open"
    // survives reload. Drop it if that project no longer exists (purged offline).
    S.settings.filterProject = typeof S.settings.filterProject === 'string' && S.settings.filterProject ? S.settings.filterProject : null;
    if (S.settings.filterProject && !S.projects.some((p) => p.id === S.settings.filterProject && !p.deletedAt)) S.settings.filterProject = null;
    S.ui.projectView = S.settings.filterProject;
    // Calendar prefs (view + filters) persist like the other settings; the
    // anchor date itself is transient per session.
    S.settings.calendarView = ['month', 'week', 'day'].includes(S.settings.calendarView) ? S.settings.calendarView : 'month';
    S.settings.calendarFilters = (S.settings.calendarFilters && typeof S.settings.calendarFilters === 'object') ? S.settings.calendarFilters : {};
    S.ui.cal.view = S.settings.calendarView;
    S.ui.cal.anchor = ymd(new Date());
    // Notification settings live in settings.notify (persisted + synced with
    // everything else). The module sanitizes; we never request permission at
    // load — the explicit control in Settings → Notifications does that.
    S.settings.notify = window.ZTNotify ? ZTNotify.sanitize(S.settings.notify) : {};
    S.reminders = S.reminders || []; // v5 — the engine guarantees the array
    S.habits = S.habits || []; // v6 habits store — same guarantee, additive

    store.startSync();

    if (window.ZTNotify) {
      try {
        ZTNotify.attach({
          getState: () => S,
          commitOps: (ops) => store.commit(ops),
          commitSettings: () => commitSettings(),
          onChange: () => renderAll(),
          openTask: (id) => { if (byId(id)) openComposer({ mode: 'edit', taskId: id }); },
          openProject: (id) => {
            S.settings.filterProject = S.projects.some((p) => p.id === id && !p.deletedAt) ? id : null;
            S.ui.projectView = S.settings.filterProject;
            renderAll();
          },
          toast: (m) => toast(m),
          esc: (s) => esc(s),
          completeTask: (id) => { const t = byId(id); if (t && t.status !== 'completed') toggleTask(id); },
          snoozeReminder: (id, opt) => remSnooze(id, opt),
        });
      } catch (e) { console.warn('[zerotodo] notify attach failed (alerts stay in-app):', e); }
    }

    applyTheme();
    renderAll();
    // Recovery itself doesn't fire status callbacks, so settle the pill now.
    setPill('saved');
    // Deep link from a notification tap when no window was open (#t=<task>)
    try {
      const mm = /^#(t|p)=([\w-]+)$/.exec(window.location.hash || '');
      if (window.location.hash === '#new') {
        // manifest shortcut target: launch straight into a fresh task
        const nb = document.getElementById('newTaskBtn');
        if (nb) nb.click();
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } else if (mm) {
        if (mm[1] === 't' && byId(mm[2])) openComposer({ mode: 'edit', taskId: mm[2] });
        else if (mm[1] === 'p' && S.projects.some((p) => p.id === mm[2] && !p.deletedAt)) {
          S.settings.filterProject = mm[2]; S.ui.projectView = mm[2]; renderAll();
        }
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch (_) {}

    for (const n of rec.notices) {
      showBanner({ kind: n.kind, message: n.message, sticky: n.kind !== 'info', id: 'notice-' + noticesSeq++ });
    }

    checkDraftOnLoad();
    checkExportReminder();
    startRelativeClock();
    remInit(); // load → detect overdue → catch up safely → reschedule (persisted schedule)
    await focusBoot(); // resume/catch-up any live Pomodoro session (it lives on the task)

    // Cloud layer (see cloud.js): LWW-merges with the server only AFTER the app
    // is rendered and interactive, then mirrors every commit upstream. A slow
    // or unreachable server affects nothing but the ☁ pill. (This await used to
    // sit before the first renderAll — on flaky mobile networks the whole UI
    // stayed skeleton-empty until cloud gave up.)
    if (window.ZTCloud) {
      try {
        await window.ZTCloud.attach({ store, getState: () => S, onChange: () => { renderAll(); remReconcile(); } });
      } catch (e) {
        console.warn('[zerotodo] cloud attach failed (staying local-only):', e);
      }
    }
  }

  let noticesSeq = 0;

  /* ------------------------------ Helpers ------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function byId(id) { return S.tasks.find((t) => t.id === id); }

  function sortedTasks() {
    return [...S.tasks].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt - b.createdAt));
  }

  function visibleTasks() {
    const mode = S.settings.filterMode;
    let list = mode === 'trash'
      ? [...S.trash].sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0))
      : sortedTasks();
    if (mode === 'active') list = list.filter((t) => t.status !== 'completed');
    if (mode === 'completed') list = list.filter((t) => t.status === 'completed');
    if (S.settings.filterTag) list = list.filter((t) => (t.tags || []).includes(S.settings.filterTag));
    if (S.settings.filterProject) list = list.filter((t) => t.projectId === S.settings.filterProject);
    const q = S.ui.search.trim().toLowerCase();
    if (q) list = list.filter((t) =>
      t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      || subsOfTask(t.id).some((s) => s.title.toLowerCase().includes(q))); // subtasks are findable too
    return list;
  }

  function allTags() {
    const map = new Map();
    for (const t of S.tasks) for (const tag of t.tags || []) map.set(tag, (map.get(tag) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function fmtWhen(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 45e3) return 'just now';
    if (diff < 3600e3) return Math.round(diff / 60e3) + ' min ago';
    if (diff < DAY_MS) return Math.round(diff / 3600e3) + ' h ago';
    if (diff < 7 * DAY_MS) return Math.round(diff / DAY_MS) + ' d ago';
    return new Date(ms).toLocaleDateString();
  }

  function timeShort(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function fmtBytes(n) {
    if (n == null) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatDue(ds, done) {
    if (!ds) return null;
    const parts = String(ds).split('-').map(Number);
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return null;
    const due = new Date(parts[0], parts[1] - 1, parts[2]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((due - today) / DAY_MS);
    let label;
    if (diff === 0) label = 'Due today';
    else if (diff === 1) label = 'Due tomorrow';
    else if (diff === -1) label = 'Due yesterday';
    else label = 'Due ' + due.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
      year: due.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
    });
    const cls = (!done && diff < 0) ? 'overdue' : (!done && diff === 0 ? 'today' : '');
    return { text: label, cls };
  }

  /* --------------------------- Save-status pill -------------------------- */

  function setPill(mode, customText) {
    const el = els.savePill;
    el.classList.remove('saving', 'error', 'saved');
    if (mode === 'saving') {
      el.classList.add('saving');
      els.savePillText.textContent = customText || 'Saving…';
    } else if (mode === 'error') {
      el.classList.add('error');
      els.savePillText.textContent = 'Not saved — see warning';
    } else {
      el.classList.add('saved');
      els.savePillText.textContent = S && S.lastSavedAt
        ? 'All changes saved · ' + timeShort(S.lastSavedAt)
        : 'All changes saved';
    }
  }

  function startRelativeClock() {
    setInterval(() => {
      if (els.savePill.classList.contains('saved')) setPill('saved');
    }, 30000);
  }

  /* ------------------------------- Banners ------------------------------- */

  const banners = new Map();

  function showBanner({ kind = 'info', message, sticky = false, actions = [], id }) {
    if (id && banners.has(id)) {
      const existing = banners.get(id);
      existing.msgEl.textContent = message; // update in place, keep visibility
      return () => existing.dismiss();
    }
    const el = document.createElement('div');
    el.className = 'banner banner-' + kind;
    const msgEl = document.createElement('span');
    msgEl.className = 'banner-msg';
    msgEl.textContent = message;
    const actEl = document.createElement('span');
    actEl.className = 'banner-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm ' + (a.primary ? 'btn-primary' : 'btn-ghost');
      b.textContent = a.label;
      b.onclick = a.fn;
      actEl.appendChild(b);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'banner-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';
    el.append(msgEl, actEl, closeBtn);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (id) banners.delete(id);
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    };
    closeBtn.onclick = dismiss;
    if (!sticky) setTimeout(dismiss, 10000);
    els.bannerHost.appendChild(el);
    if (id) banners.set(id, { msgEl, dismiss });
    return dismiss;
  }

  function dismissBanner(id) {
    const b = banners.get(id);
    if (b) b.dismiss();
  }

  /* -------------------------------- Toasts -------------------------------- */

  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    els.toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms || 3500);
  }

  // Undo toast for soft-deletes (8 s — comfortably inside the 5–10 s spec).
  // Only the most recent delete holds the button; an earlier delete that gets
  // superseded is still fully recoverable from the Trash view — nothing is
  // ever permanently erased by this flow.
  let undoTask = null;
  let undoTimer = null;

  function showUndoToast(task) {
    clearTimeout(undoTimer);
    undoTask = task;
    const title = task.title.length > 42 ? task.title.slice(0, 42) + '…' : task.title;
    els.toastHost.innerHTML =
      '<div class="toast show toast-undo">' +
      '<span>Deleted “' + esc(title) + '” — moved to Trash</span>' +
      '<button class="btn btn-sm btn-undo" id="undoBtn">Undo</button>' +
      '<div class="undo-bar"><div class="undo-bar-fill"></div></div>' +
      '</div>';
    $('undoBtn').onclick = undoDelete;
    undoTimer = setTimeout(() => { undoTask = null; els.toastHost.innerHTML = ''; }, 8000);
  }

  async function undoDelete() {
    const t = undoTask;
    if (!t) return;
    clearTimeout(undoTimer);
    undoTask = null;
    els.toastHost.innerHTML = '';
    // One restore path for undo AND the trash-row button: it re-arms the
    // future reminders this side of the cancel-on-delete (unified scheduling).
    await restoreTask(t.id);
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

  // f-project is part of the composer row the draft autosave watches; keep
  // the lookup lazy so the wiring above never races element creation.
  function fProjectSelect() { return els.fProject; }

  /* --------------------------- Confirmation modal ------------------------- */

  function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const card = document.createElement('div');
      card.className = 'modal';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const h = document.createElement('h3');
      h.textContent = title;
      const p = document.createElement('p');
      p.className = 'modal-body';
      p.textContent = body;
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      okBtn.textContent = confirmLabel;
      actions.append(cancelBtn, okBtn);
      card.append(h, p, actions);
      ov.appendChild(card);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      ov.addEventListener('click', (e) => {
        if (e.target === ov) finish(false);
        if (e.target === okBtn) finish(true);
        if (e.target === cancelBtn) finish(false);
      });
      document.addEventListener('keydown', onKey, true);
      els.modalHost.appendChild(ov);
      okBtn.focus();
    });
  }

  /* ------------------------------ Rendering ------------------------------ */

  function renderAll() {
    // If a cross-tab change deleted the task we're editing, close the editor
    // WITHOUT clearing its draft (the draft is the user's in-progress text).
    if (S.ui.editingId && !byId(S.ui.editingId) && S.settings.filterMode !== 'trash') {
      S.ui.composerOpen = false;
      S.ui.editingId = null;
      els.composer.hidden = true;
    }
    renderFilters();
    renderTagChips();
    renderProjects();
    renderProjectDetail();
    renderTrashBar();
    renderList();
    renderSettings();
    renderFooter();
    refreshDraftResumeUI();
    // Calendar / Dashboard mode: the task list UI steps aside; both overlays
    // are views over the SAME in-memory state — no duplicate data anywhere.
    const calOn = !!(S.ui && S.ui.cal.open);
    const dashOn = !!(S.ui && S.ui.dash && S.ui.dash.open);
    const habOn = !!(S.ui && S.ui.hab && S.ui.hab.open);
    els.calendar.hidden = !calOn || dashOn || habOn;
    els.calBtn.classList.toggle('on', calOn && !dashOn && !habOn);
    els.calBtn.setAttribute('aria-pressed', String(calOn && !dashOn && !habOn));
    els.dashboard.hidden = !dashOn || habOn;
    els.dashBtn.classList.toggle('on', dashOn && !habOn);
    els.dashBtn.setAttribute('aria-pressed', String(dashOn && !habOn));
    els.habitsView.hidden = !habOn;
    els.habBtn.classList.toggle('on', habOn);
    els.habBtn.setAttribute('aria-pressed', String(habOn));
    if (calOn || dashOn || habOn) {
      for (const el of [els.filterTabs, els.tagChips, els.projectBar, els.projectDetail, els.trashBar, els.taskList, els.emptyState]) el.hidden = true;
      if (habOn) renderHabits();
      if (dashOn && !habOn) renderDashboard();
      if (calOn && !dashOn && !habOn) renderCalendar();
    } else {
      els.taskList.hidden = false;
    }
    renderFocus(); // the session bar re-derives from t.focusActive like everything else
    if (els.savePill.classList.contains('saved')) setPill('saved');
  }

  function renderFilters() {
    const total = S.tasks.length;
    const active = S.tasks.filter((t) => t.status !== 'completed').length;
    const done = total - active;
    const mode = S.settings.filterMode;
    const items = [
      { m: 'all', label: 'All', n: total },
      { m: 'active', label: 'Active', n: active },
      { m: 'completed', label: 'Completed', n: done },
      { m: 'trash', label: 'Trash', n: S.trash.length },
    ];
    els.filterTabs.innerHTML = items.map((it) =>
      '<button class="filter-btn' + (mode === it.m ? ' on' : '') + '" data-mode="' + it.m + '" type="button">' +
      it.label + ' <span class="count">' + it.n + '</span></button>'
    ).join('');
  }

  function renderTagChips() {
    if (S.settings.filterMode === 'trash') { els.tagChips.hidden = true; return; }
    const tags = allTags();
    if (!tags.length) { els.tagChips.hidden = true; return; }
    els.tagChips.hidden = false;
    els.tagChips.innerHTML = tags.map(([tag, n]) =>
      '<button class="tag-chip' + (S.settings.filterTag === tag ? ' on' : '') + '" data-tag="' + esc(tag) + '" type="button">' +
      esc(tag) + ' <span class="count">' + n + '</span></button>'
    ).join('');
  }

  function renderTrashBar() {
    const inTrash = S.settings.filterMode === 'trash';
    const n = S.trash.length + trashedProjects().length;
    els.trashBar.hidden = !inTrash;
    if (inTrash) els.trashCount.textContent = n + ' item(s)';
    els.emptyTrashBtn.hidden = inTrash && n === 0;
  }

  /* ------------------------------ Subtasks -------------------------------- */
  /* Flat records (id, parentTaskId, title, completed, completedAt, position)
     in the SAME state document as tasks — see storage.js coerceSubtask. */

  function subsIndex() {
    const m = new Map();
    for (const s of S.subtasks) {
      if (!m.has(s.parentTaskId)) m.set(s.parentTaskId, []);
      m.get(s.parentTaskId).push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    return m;
  }
  function subsOfTask(taskId) { const a = subsIndex().get(taskId); return a || []; }
  /** Every id in a task's subtree. Visited-set = cycle-safe even for
      hand-edited/deep data (the UI only creates one level). */
  function subtreeIds(taskId) {
    const m = subsIndex();
    const out = [];
    const seen = new Set([taskId]);
    let frontier = (m.get(taskId) || []).map((s) => s.id);
    while (frontier.length) {
      const next = [];
      for (const sid of frontier) {
        if (seen.has(sid)) continue;
        seen.add(sid); out.push(sid);
        for (const c of (m.get(sid) || [])) next.push(c.id);
      }
      frontier = next;
    }
    return out;
  }
  function subStatsOf(taskId) {
    const subs = subsOfTask(taskId);
    const done = subs.filter((s) => s.completed).length;
    return { total: subs.length, done, pct: subs.length ? Math.round((done / subs.length) * 100) : 0 };
  }
  /** One task's 0..1 contribution to its project's progress: completed = 1;
      otherwise the fraction of its subtasks done (0 when it has none). */
  function taskProgress(t) {
    if (t.status === 'completed') return 1;
    const subs = subsOfTask(t.id);
    if (!subs.length) return 0;
    return subs.filter((s) => s.completed).length / subs.length;
  }

  function subBlockHTML(t) {
    const subs = subsOfTask(t.id);
    const ss = subStatsOf(t.id);
    const open = !!S.ui.openSubs[t.id];
    const head = '<div class="sub-block">' +
      '<button class="sub-toggle" data-sact="subs" type="button" aria-expanded="' + open + '">' +
        '<span class="sub-caret">' + (open ? '▾' : '▸') + '</span>' +
        (ss.total
          ? '<span class="sub-mini"><i style="width:' + ss.pct + '%"></i></span>' +
            '<span class="sub-progress">' + ss.done + '/' + ss.total + ' subtasks · ' + ss.pct + '%</span>'
          : '<span class="sub-progress">＋ subtasks</span>') +
      '</button>';
    if (!open) return head + '</div>';
    const rows = subs.map((s) => {
      if (S.ui.subEditing === s.id) {
        return '<li class="sub-row sub-edit"><input class="sub-edit-input" data-sid="' + esc(s.id) + '" maxlength="200" value="' + esc(s.title) + '">' +
          '<button class="btn btn-sm btn-primary" data-sact="subsave" data-sid="' + esc(s.id) + '" type="button">Save</button>' +
          '<button class="btn btn-sm btn-ghost" data-sact="subcancel" type="button">Cancel</button></li>';
      }
      return '<li class="sub-row' + (s.completed ? ' is-done' : '') + '" data-sid="' + esc(s.id) + '">' +
        '<button class="sub-check' + (s.completed ? ' on' : '') + '" data-sact="sbtoggle" data-sid="' + esc(s.id) + '" role="checkbox" aria-checked="' + s.completed + '" aria-label="Toggle subtask" type="button">' + (s.completed ? '✓' : '') + '</button>' +
        '<span class="sub-title">' + esc(s.title) + '</span>' +
        '<span class="sub-acts">' +
          '<button class="btn btn-ghost btn-sm btn-icon" data-sact="subup" data-sid="' + esc(s.id) + '" title="Move up" aria-label="Move up">↑</button>' +
          '<button class="btn btn-ghost btn-sm btn-icon" data-sact="subdown" data-sid="' + esc(s.id) + '" title="Move down" aria-label="Move down">↓</button>' +
          '<button class="btn btn-ghost btn-sm btn-icon" data-sact="subedit" data-sid="' + esc(s.id) + '" title="Rename subtask" aria-label="Rename">✎</button>' +
          '<button class="btn btn-danger-ghost btn-sm btn-icon" data-sact="subdel" data-sid="' + esc(s.id) + '" title="Delete subtask" aria-label="Delete subtask">🗑</button>' +
        '</span></li>';
    }).join('');
    return head +
      '<ul class="sub-list">' + rows +
        '<li class="sub-row sub-add"><input class="sub-add-input" data-parent="' + esc(t.id) + '" maxlength="200" placeholder="Add a subtask — Enter to save">' +
        '<button class="btn btn-sm btn-ghost" data-sact="subadd" data-parent="' + esc(t.id) + '" type="button">Add</button></li>' +
      '</ul></div>';
  }

  function taskItemHTML(t, inTrash) {
    const done = t.status === 'completed';
    const due = formatDue(t.dueDate, done);
    const prioLabel = t.priority === 'med' ? 'medium' : t.priority;
    return (
      '<li class="task' + (done ? ' is-done' : '') + '" data-id="' + esc(t.id) + '">' +
        '<button class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder" tabindex="-1">⋮⋮</button>' +
        (inTrash
          ? '<span class="check" aria-hidden="true">🗑</span>'
          : '<button class="check' + (done ? ' on' : '') + '" role="checkbox" aria-checked="' + done + '" aria-label="Toggle complete" data-act="toggle">' + (done ? '✓' : '') + '</button>') +
        '<div class="task-main">' +
          '<div class="task-title">' + esc(t.title) +
          (!inTrash && t.aiOffer && window.ZTAI ? ' <button type="button" class="btn btn-sm ai-cta" data-act="aidec" title="You asked for a big task — let the planner propose steps. Nothing is added until you approve them.">✨ Break this task down with AI</button>' : '') +
          '</div>' +
          (t.description ? '<div class="task-desc">' + esc(t.description) + '</div>' : '') +
          '<div class="task-meta">' +
            '<span class="badge prio-' + t.priority + '">' + prioLabel + '</span>' +
            (due && !inTrash ? '<span class="badge due ' + due.cls + '">' + due.text + '</span>' : '') +
            (!inTrash && remPendingFor(t.id) ? '<span class="badge rem" title="' + remPendingFor(t.id) + ' pending reminder(s), next: ' + esc(remNextLabel(t.id)) + '">🔔 ' + remPendingFor(t.id) + '</span>' : '') +
            (t.recurrence ? '<span class="badge recur" title="' + esc(recurLabel(t)) + ' · completing rolls to the next date; ↻ opens series actions' + '">↻ ' + esc(recurLabel(t)) + '</span>' : '') +
            (t.focusTotal > 0 ? '<span class="badge focus" title="' + t.focusTotal + ' focused min · ' + (t.focusSessions || 0) + ' completed session(s)">🍅 ' + (t.focusTotal < 60 ? t.focusTotal + 'm' : (Math.round(t.focusTotal / 6) / 10) + 'h') + '</span>' : '') +
            (t.estMin > 0 ? '<span class="badge est" title="Planned effort (from an AI breakdown — advisory)">⏱ ' + (window.ZTAI ? ZTAI.fmtEst(t.estMin) : t.estMin + 'm') + '</span>' : '') +
            (function () {
              const dd = t.deps || [];
              if (!dd.length) return '';
              let open = 0; const names = [];
              for (const d of dd) {
                const o = byId(d);
                if (!o) { names.push('(removed task)'); open++; continue; }
                names.push(truncate(o.title, 40));
                if (o.status !== 'completed') open++;
              }
              return '<span class="badge deps' + (open ? '' : ' ready') + '" title="Suggested after: ' + esc(names.slice(0, 3).join(', ')) +
                (names.length > 3 ? ' +' + (names.length - 3) : '') + (open ? ' — still open' : ' — all done, go ahead') + '">' +
                (open ? '🔗 ' + open : '🔗 ✓') + '</span>';
            })() +
            (function () {
              if (!t.projectId) return '';
              const pj = S.projects.find((p) => p.id === t.projectId);
              if (pj && !pj.deletedAt) {
                return '<button class="chip proj-ref" data-pid="' + esc(pj.id) + '" type="button" title="Open project ' + esc(pj.name) + '">' + esc(pj.icon) + ' ' + esc(pj.name) + '</button>';
              }
              return '<span class="badge proj-gone">in deleted project</span>';
            })() +
            (t.tags || []).map((tag) => '<button class="chip" data-tag="' + esc(tag) + '" type="button">' + esc(tag) + '</button>').join('') +
            (inTrash ? '<span class="muted small">trashed ' + fmtWhen(t.trashedAt) + '</span>' : '') +
          '</div>' +
        '</div>' +
        (inTrash
          ? (subtreeIds(t.id).length ? '<div class="sub-static muted small">⊂ ' + subtreeIds(t.id).length + ' subtask(s) — restore brings them back</div>' : '')
          : subBlockHTML(t)) +
        '<div class="task-actions">' +
          (inTrash
            ? '<button class="btn btn-ghost btn-sm" data-act="restore" title="Restore task">Restore</button>' +
              '<button class="btn btn-danger-ghost btn-sm" data-act="destroy" title="Delete forever">Delete forever</button>'
            : '<button class="btn btn-ghost btn-sm btn-icon" data-act="focus" title="Start Focus — a Pomodoro session on this task" aria-label="Start focus session">🍅</button>' +
              (window.ZTAI ? '<button class="btn btn-ghost btn-sm btn-icon" data-act="aidec" title="Break this task down with AI — suggestions you review first" aria-label="Break down with AI">✨</button>' : '') +
              (t.recurrence ? '<button class="btn btn-ghost btn-sm btn-icon" data-act="series" title="Series: complete / skip / edit occurrence or series / stop repeating" aria-label="Recurring series options">↻</button>' : '') +
              '<button class="btn btn-ghost btn-sm btn-icon" data-act="up" title="Move up" aria-label="Move up">↑</button>' +
              '<button class="btn btn-ghost btn-sm btn-icon" data-act="down" title="Move down" aria-label="Move down">↓</button>' +
              '<button class="btn btn-ghost btn-sm" data-act="edit" title="Edit task">Edit</button>' +
              '<button class="btn btn-danger-ghost btn-sm" data-act="delete" title="Move to trash (undoable)">Delete</button>') +
        '</div>' +
      '</li>'
    );
  }

  function renderList() {
    if (S.ui.cal.open) return; // calendar is showing; list content is hidden
    const inTrash = S.settings.filterMode === 'trash';
    const list = visibleTasks();
    const trashedProj = inTrash ? trashedProjects() : [];
    if (!list.length && !trashedProj.length) {
      els.taskList.innerHTML = '';
      els.emptyState.hidden = false;
      let icon = '🗒️', text = 'No tasks yet — click <b>＋ New task</b> to add one. Everything you write is saved automatically, on every change.';
      if (inTrash) { icon = '🗑️'; text = 'Trash is empty. Deleted tasks (and projects) land here for 30 days before they are removed automatically.'; }
      else if (S.settings.filterProject) {
        const p = projectById(S.settings.filterProject);
        icon = (p && p.icon) || '📁';
        text = 'Nothing in this project yet — use <b>＋ Add task</b> to put the first one here.';
      }
      else if (S.tasks.length || S.trash.length) { icon = '🔍'; text = 'No tasks match the current filter or search.'; }
      els.emptyState.innerHTML = '<span class="big">' + icon + '</span>' + text;
      return;
    }
    els.emptyState.hidden = true;
    els.taskList.innerHTML = trashedProj.map((p) => projectRowTrash(p)).join('')
      + list.map((t) => taskItemHTML(t, inTrash)).join('');
  }

  function renderSettings() {
    els.themeSelect.value = S.settings.theme || 'auto';
    els.reminderSelect.value = String(S.settings.exportReminderDays || 0);
    els.subtaskAuto.checked = !!S.settings.subtaskAutoComplete;
    if (els.fzWork) { const c = focusCfg(); els.fzWork.value = c.work; els.fzShort.value = c.short; els.fzLong.value = c.long; els.fzEvery.value = c.longEvery; els.fzNotify.checked = c.notify; els.fzAuto.checked = c.autoComplete; }
    if (els.habInStats) els.habInStats.checked = S.settings.habitsInStats === true;
    if (els.aiMode) els.aiMode.value = S.settings.aiMode === 'local' ? 'local' : 'auto';
    if (window.ZTNotify) ZTNotify.renderControls(); // the Notifications section owns itself
  }

  function renderFooter() {
    const done = S.tasks.filter((t) => t.status === 'completed').length;
    const liveProj = S.projects.filter((p) => !p.deletedAt).length;
    els.footerCounts.textContent = S.tasks.length + ' task(s) · ' + done + ' completed · ' + S.trash.length + ' in trash'
      + (liveProj ? ' · ' + liveProj + ' project(s)' : '')
      + (S.subtasks.length ? ' · ' + S.subtasks.filter((s) => s.completed).length + '/' + S.subtasks.length + ' subtasks' : '')
      + (S.reminders.some((r) => r.status === 'pending') ? ' · ' + S.reminders.filter((r) => r.status === 'pending').length + ' reminder(s) armed' : '');
  }

  function updateStorageInfo() {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(({ usage = 0, quota = 0 }) => {
        els.storageInfo.textContent = 'Approx. storage used by this app: ' + fmtBytes(usage) +
          (quota ? ' of ' + fmtBytes(quota) + ' available' : '') + '.';
      }).catch(() => {});
    }
  }

  function applyTheme() {
    const t = S.settings.theme || 'auto';
    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const dark = t === 'dark' || (t === 'auto' && mql && mql.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    els.themeBtn.textContent = dark ? '☀️' : '🌙';
  }

  /* ------------------------------ Composer -------------------------------- */

  function openComposer(opts = { mode: 'new' }, prefill = null) {
    const editing = opts.mode === 'edit' ? byId(opts.taskId) : null;
    S.ui.editingId = editing ? editing.id : null;
    S.ui.composerOpen = true;
    els.composer.hidden = false;
    els.composerTitle.textContent = editing ? 'Edit task' : 'New task';
    if (els.nlBox) els.nlBox.hidden = !!editing || !window.ZTNL;
    if (!editing && !S.ui.editingId) nlHide();
    els.saveTaskBtn.textContent = editing ? 'Save changes' : 'Add task';
    els.fTitle.value = prefill && prefill.title != null ? prefill.title : (editing ? editing.title : '');
    els.fDesc.value = prefill && prefill.description != null ? prefill.description : (editing ? editing.description : '');
    els.fDue.value = prefill && prefill.dueDate != null ? prefill.dueDate : (editing ? (editing.dueDate || '') : '');
    els.fTime.value = prefill && prefill.dueTime != null ? prefill.dueTime : (editing ? (editing.dueTime || '') : '');
    els.fPriority.value = (prefill && prefill.priority) || (editing ? editing.priority : 'med');
    els.fTags.value = prefill && prefill.tags != null
      ? prefill.tags.join(', ')
      : (editing ? (editing.tags || []).join(', ') : '');
    fillProjectSelect();
    els.fProject.value = prefill && prefill.projectId != null
      ? prefill.projectId
      : (editing ? (editing.projectId || '') : (S.settings.filterProject || ''));
    els.fRecurrence.value = (prefill && prefill.recurrence != null ? prefill.recurrence : (editing ? (editing.recurrence || '') : '')) || '';
    {
      const rr = (prefill && prefill.recurRule) || (editing && editing.recurRule) || null;
      S.ui.recurPanel = {
        every: rr && Number(rr.every) >= 1 ? Math.min(99, Math.floor(Number(rr.every))) : 1,
        unit: rr && ['day', 'week', 'month', 'year'].indexOf(rr.unit) >= 0 ? rr.unit : 'week',
        weekdays: rr && Array.isArray(rr.weekdays) ? rr.weekdays.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) : [],
      };
      renderRecurPanel();
    }
    // Reminder editor: editable rows = pending/skipped; fired history stays put.
    S.ui.remRows = prefill && Array.isArray(prefill.remRows)
      ? prefill.remRows.map((x) => ({ ...x }))
      : (editing
        ? S.reminders.filter((r) => r.taskId === editing.id && (r.status === 'pending' || r.status === 'skipped') && r.reminderType !== 'overdue')
            .map((r) => ({ id: r.id, reminderType: r.reminderType, customDate: r.customDate || '', customTime: r.customTime || '', status: r.status }))
        : []);
    renderRemRows();
    els.fTitle.classList.remove('invalid');
    els.composer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (opts.focusReminders) {
      // calendar 🔔 badge entry point: land the user on the reminder config
      const blk = els.remRows.closest('.rem-block') || els.remRows;
      blk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      els.addRemBtn.focus({ preventScroll: true });
    }
    if (opts.focusRecurrence) {
      const blk = els.fRecurrence.closest('.recur-panel') || els.fRecurrence.closest('label') || els.fRecurrence;
      blk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      els.fRecurrence.focus({ preventScroll: true });
    }
    setTimeout(() => { if (!opts.focusReminders && !opts.focusRecurrence) els.fTitle.focus(); }, 60);
    refreshDraftResumeUI();
  }

  function closeComposer() {
    if (els.nlInput) els.nlInput.value = '';
    nlHide();
    S.ui.composerOpen = false;
    S.ui.editingId = null;
    els.composer.hidden = true;
    els.draftHint.hidden = true;
    refreshDraftResumeUI();
  }

  function readForm() {
    return {
      title: els.fTitle.value,
      recurrence: els.fRecurrence.value || null,
      recurRule: els.fRecurrence.value === 'custom' ? curRecurRule() : null,
      description: els.fDesc.value.trim(),
      dueDate: els.fDue.value || null,
      dueTime: els.fTime.value || null,
      priority: els.fPriority.value,
      tags: els.fTags.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      projectId: els.fProject.value || null,
      remRows: (S.ui.remRows || []).map((x) => ({ ...x })),
    };
  }

  async function saveTask() {
    const v = readForm();
    const title = v.title.trim();
    if (!title) {
      els.fTitle.classList.add('invalid');
      els.fTitle.focus();
      return;
    }
    const now = Date.now();
    let ops;
    if (S.ui.editingId && byId(S.ui.editingId)) {
      const t = byId(S.ui.editingId);
      const prevDue = { dueDate: t.dueDate, dueTime: t.dueTime };
      const prevRecur = { recurrence: t.recurrence, rule: t.recurRule ? { ...t.recurRule } : null, anchor: t.recurAnchor, dueDate: t.dueDate };
      Object.assign(t, {
        title, description: v.description, dueDate: v.dueDate, dueTime: v.dueTime,
        priority: v.priority, tags: v.tags, projectId: v.projectId,
        recurrence: v.recurrence, recurRule: v.recurRule, updatedAt: now,
      });
      if (!t.recurrence) t.recurAnchor = null;
      else {
        const ruleChanged = prevRecur.recurrence !== t.recurrence || JSON.stringify(prevRecur.rule) !== JSON.stringify(t.recurRule || null);
        if (ruleChanged || !t.recurAnchor) t.recurAnchor = t.dueDate || ymd(new Date()); // a NEW pattern starts from what you see now
        else await askRecurrenceScope(t, prevRecur); // unchanged pattern, moved date: ask who moves
      }
      ops = [{ store: STORES.tasks, op: 'put', value: t }];
      await askShiftCustomReminders(t, v.remRows, prevDue);
      remSyncTask(t, v.remRows, ops);
    } else {
      // New tasks slot in at the top (lowest sortOrder).
      const min = S.tasks.reduce((m, t) => Math.min(m, t.sortOrder), S.tasks.length ? Infinity : 0);
      const base = Number.isFinite(min) ? min : 0;
      const t = {
        id: helpers.uuid(),
        title, description: v.description, dueDate: v.dueDate, dueTime: v.dueTime,
        priority: v.priority, tags: v.tags,
        projectId: v.projectId,
        recurrence: v.recurrence,
        recurRule: v.recurRule || null,
        recurAnchor: v.recurrence ? (v.dueDate || ymd(new Date())) : null,
        status: 'active',
        sortOrder: S.tasks.length ? base - 1 : 0,
        createdAt: now, updatedAt: now,
        aiOffer: !!(window.ZTAI && ZTAI.looksLarge(title, v.description)),
      };
      S.tasks.push(t);
      ops = [{ store: STORES.tasks, op: 'put', value: t }];
      remSyncTask(t, v.remRows, ops);
    }
    const ok = await store.commit(ops); // write-through: persisted immediately
    remReconcile(); // arm/reschedule from the new records (persisted schedule)
    clearDraft();
    closeComposer();
    renderAll();
    // If ok === false the storage layer already surfaced a banner.
  }

  /* ------------------------- Draft (autosave) protection ------------------ */
  /* In-progress composer input is debounced into localStorage under its own  */
  /* key (todo_draft_v1) so a tab crash/close/refresh can never lose typed    */
  /* text. On reload the user is asked to resume or discard.                  */

  let draftTimer = null;

  function currentDraft() {
    if (!S.ui.composerOpen) return null;
    const v = readForm();
    if (!v.title.trim() && !v.description && !v.dueDate && !v.tags.length && !v.remRows.length) return null;
    return {
      kind: S.ui.editingId ? 'edit' : 'new',
      taskId: S.ui.editingId,
      title: v.title, description: v.description, dueDate: v.dueDate, dueTime: v.dueTime,
      priority: v.priority, tags: v.tags,
      projectId: v.projectId, recurrence: v.recurrence, recurRule: v.recurRule, remRows: v.remRows,
      savedAt: Date.now(),
    };
  }

  function writeDraftNow() {
    const d = currentDraft();
    try {
      if (d) {
        localStorage.setItem(LS_DRAFT_KEY, JSON.stringify(d));
        els.draftHint.hidden = false;
      } else {
        localStorage.removeItem(LS_DRAFT_KEY);
        els.draftHint.hidden = true;
      }
    } catch (_) { /* best effort — the draft is convenience, not primary data */ }
    refreshDraftResumeUI();
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraftNow, 1200); // ~1.2 s debounce per spec
  }

  function clearDraft() {
    clearTimeout(draftTimer);
    els.draftHint.hidden = true;
    try { localStorage.removeItem(LS_DRAFT_KEY); } catch (_) {}
    refreshDraftResumeUI();
  }

  function readDraftFromDisk() {
    try {
      const raw = localStorage.getItem(LS_DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function resumeDraft() {
    const d = readDraftFromDisk();
    if (!d) return;
    const taskExists = d.taskId && byId(d.taskId);
    if (d.kind === 'edit' && taskExists) openComposer({ mode: 'edit', taskId: d.taskId }, d);
    else openComposer({ mode: 'new' }, d);
    toast('Draft restored — review and save when ready.');
    dismissBanner('draft');
  }

  function checkDraftOnLoad() {
    const d = readDraftFromDisk();
    if (!d || typeof d !== 'object') return;
    const preview = d.title ? '“' + truncate(d.title, 40) + '”' : 'untitled task';
    showBanner({
      kind: 'info', id: 'draft', sticky: true,
      message: 'You have an unsaved draft from ' + fmtWhen(d.savedAt) + ': ' + preview + ' — resume or discard it.',
      actions: [
        { label: 'Resume', primary: true, fn: resumeDraft },
        { label: 'Discard', fn: () => { clearDraft(); dismissBanner('draft'); } },
      ],
    });
  }

  function refreshDraftResumeUI() {
    if (!S) return;
    const d = readDraftFromDisk();
    if (d && !S.ui.composerOpen) {
      els.draftResume.hidden = false;
      const label = els.draftResume.querySelector('.draft-label');
      if (label) label.textContent = d.title ? truncate(d.title, 30) : 'untitled task';
    } else {
      els.draftResume.hidden = true;
    }
  }

  /* ------------------------------ Task actions ---------------------------- */

  async function toggleTask(id) {
    const t = byId(id);
    if (!t) return;
    const now = Date.now();
    const ops = [];
    if (t.status === 'completed') {
      t.status = 'active';
      t.updatedAt = now;
      // Undoing a completion retracts its most recent ledger mark, so the
      // dashboard never counts work the user just took back.
      if (Array.isArray(t.completions) && t.completions.length) t.completions = t.completions.slice(0, -1);
      t.completedAt = Array.isArray(t.completions) && t.completions.length ? t.completions[t.completions.length - 1] : null;
      ops.push({ store: STORES.tasks, op: 'put', value: t });
      remReviveSkipped(t.id, ops, now); // re-check reminders of the un-completed task
    } else if (t.recurrence) {
      // Recurring: completing means DONE FOR THIS CYCLE — the task rolls to
      // its next occurrence in place (same record, same id, same history).
      // Exactly ONE occurrence is ever materialized: "no infinite future
      // tasks" is a structural property, not a cleanup pass. If the rule
      // produces no future date (horizon/end), the task just completes.
      const adv = recurAdvance(t, ops, now);
      if (adv) {
        t.status = 'active';
        t.updatedAt = now;
        pushCompletion(t, now); // the occurrence WAS completed — the dashboard counts rolls
        ops.push({ store: STORES.tasks, op: 'put', value: t });
        toast('Completed this occurrence — next is ' + ((formatDue(adv.next) || {}).txt || adv.next) + (adv.rearmed ? ' · ' + adv.rearmed + ' reminder(s) re-armed' : ''));
      } else {
        finishComplete(t, ops, now);
        toast('Recurring task finished — no future occurrence within 10 years, marked done.');
      }
    } else {
      finishComplete(t, ops, now);
    }
    await store.commit(ops);
    renderAll();
    remReconcile();
  }

  /** The plain completion path: mark done + skip every pending schedule. */
  function finishComplete(t, ops, now) {
    pushCompletion(t, now); // timestamp for the dashboard ledger (rides the record)
    t.status = 'completed';
    t.updatedAt = now;
    ops.push({ store: STORES.tasks, op: 'put', value: t });
    // A finished task must not nag: its pending reminders become skipped.
    for (const r of S.reminders) {
      if (r.taskId === t.id && r.status === 'pending') {
        r.status = 'skipped'; r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
      }
    }
  }

  /** Soft delete: move to trash (single atomic tx touching both stores). */
  async function deleteTask(id) {
    const i = S.tasks.findIndex((t) => t.id === id);
    if (i === -1) return;
    const t = S.tasks.splice(i, 1)[0];
    if (t.focusActive) {
      const nowT = Date.now();
      const m = Math.round(focusElapsedMs(t.focusActive, nowT) / 60000);
      if (m > 0 && t.focusActive.phase === 'focus') focusLogAppend(t, nowT, m, false);
      t.focusActive = null;
      if (S.ui.focus && S.ui.focus.taskId === t.id) S.ui.focus.taskId = null;
      toast('Focus session abandoned — ' + (m > 0 ? m + ' focused minute(s) still logged.' : 'nothing was logged yet.'));
    }
    t.trashedAt = Date.now();
    t.updatedAt = t.trashedAt; // keep LWW ordering sane for the store move (sync)
    S.trash.push(t);
    const ops = [
      { store: STORES.trash, op: 'put', value: t },
      { store: STORES.tasks, op: 'delete', key: id },
    ];
    // Unified scheduling: trashing CANCELS the task's pending schedules right
    // now (same atomic commit) — not lazily at fire time. A task that isn't
    // in any schedule can never surface a notification. Undo/Restore revives
    // the future ones through remReviveSkipped.
    for (const r of S.reminders) {
      if (r.taskId === id && r.status === 'pending') {
        r.status = 'skipped'; r.pinned = false; r.updatedAt = t.trashedAt;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
      }
    }
    const ok = await store.commit(ops);
    if (S.ui.editingId === id) closeComposer();
    renderAll();
    remReconcile(); // re-arm the live timer without the cancelled records
    if (ok) showUndoToast(t); // 8-second undo window
  }

  async function restoreTask(id) {
    const i = S.trash.findIndex((t) => t.id === id);
    if (i === -1) return;
    const t = S.trash.splice(i, 1)[0];
    delete t.trashedAt;
    t.updatedAt = Date.now(); // the move must beat the soft-delete tombstone during cloud sync
    S.tasks.push(t);
    const ops = [
      { store: STORES.trash, op: 'delete', key: id },
      { store: STORES.tasks, op: 'put', value: t },
    ];
    remReviveSkipped(id, ops, Date.now()); // reminders that were skipped while trashed come back
    const ok = await store.commit(ops);
    renderAll();
    if (ok) toast('Restored “' + truncate(t.title, 40) + '”.');
    remReconcile();
  }

  async function destroyTask(id) {
    const t = S.trash.find((x) => x.id === id);
    if (!t) return;
    const ok = await confirmDialog({
      title: 'Delete forever?',
      body: '“' + t.title + '” will be permanently erased. This cannot be undone.',
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    // Subtasks die WITH the task forever — deletes + tombstones in the same
    // commit, so every device purges them too. (The soft delete didn't: they
    // sat attached for a possible restore.)
    const children = subtreeIds(id); // descendants ONLY (historical contract)
    const doomed = new Set([id].concat(children)); // reminders key off the ROOT id
    S.trash = S.trash.filter((x) => x.id !== id);
    S.subtasks = S.subtasks.filter((x) => !doomed.has(x.id));
    // Reminders die with the task forever — deletes (→ tombstones) ride the
    // SAME commit, so no device keeps a schedule for a task that's gone.
    const doomedRem = S.reminders.filter((r) => doomed.has(r.taskId)).map((r) => r.id);
    S.reminders = S.reminders.filter((r) => !doomed.has(r.taskId));
    await store.commit([{ store: STORES.trash, op: 'delete', key: id }]
      .concat(children.map((sid) => ({ store: STORES.subtasks, op: 'delete', key: sid })))
      .concat(doomedRem.map((rid) => ({ store: STORES.reminders, op: 'delete', key: rid }))));
    remArm();
    renderAll();
    toast('Deleted forever' + (children.length ? ' — ' + children.length + ' subtask(s) with it.' : '.'));
  }

  async function emptyTrash() {
    const deadProjects = trashedProjects();
    if (!S.trash.length && !deadProjects.length) return;
    const ok = await confirmDialog({
      title: 'Empty trash?',
      body: 'This will permanently delete ' + (S.trash.length + deadProjects.length) + ' item(s)'
        + (deadProjects.length ? ' including ' + deadProjects.length + ' project(s) — their tasks stay in your list, moved to the Inbox.' : '')
        + ' A small safety copy of the trash will be downloaded first, in case you change your mind.',
      confirmLabel: 'Download safety copy, then empty',
      danger: true,
    });
    if (!ok) return;
    try {
      downloadRaw(
        JSON.stringify({ app: 'zerotodo', type: 'trash-safety-copy', exportedAt: new Date().toISOString(), trash: S.trash, projects: S.projects }),
        'zerotodo-trash-' + stamp() + '.json'
      );
    } catch (_) { /* safety copy is best-effort */ }
    const ops = S.trash.map((t) => ({ store: STORES.trash, op: 'delete', key: t.id }));
    const doomedSubs = new Set();
    for (const t of S.trash) for (const sid of subtreeIds(t.id)) doomedSubs.add(sid);
    for (const sid of doomedSubs) ops.push({ store: STORES.subtasks, op: 'delete', key: sid });
    S.subtasks = S.subtasks.filter((x) => !doomedSubs.has(x.id));
    const doomedIds = new Set(S.trash.map((t) => t.id));
    for (const r of S.reminders) if (doomedIds.has(r.taskId)) ops.push({ store: STORES.reminders, op: 'delete', key: r.id });
    S.reminders = S.reminders.filter((r) => !doomedIds.has(r.taskId));
    S.trash = [];
    for (const p of deadProjects) {
      ops.push({ store: STORES.projects, op: 'delete', key: p.id });
      for (const arr of [S.tasks, S.trash]) {
        for (const t of arr) {
          if (t.projectId === p.id) {
            t.projectId = null;
            t.updatedAt = Date.now();
            ops.push({ store: arr === S.tasks ? STORES.tasks : STORES.trash, op: 'put', value: t });
          }
        }
      }
    }
    S.projects = S.projects.filter((p) => !p.deletedAt);
    if (deadProjects.some((p) => p.id === S.settings.filterProject)) {
      S.settings.filterProject = null;
      S.ui.projectView = null;
    }
    await store.commit(ops);
    renderAll();
    toast('Trash emptied.');
  }

  /* ------------------------------ Reordering ------------------------------ */

  function applyNewOrder(newVisibleIds) {
    const all = sortedTasks();
    const visSet = new Set(newVisibleIds);
    const slots = [];
    all.forEach((t, i) => { if (visSet.has(t.id)) slots.push(i); });
    if (slots.length !== newVisibleIds.length) { renderList(); return; } // view changed mid-drag
    const next = all.slice();
    slots.forEach((slot, k) => { next[slot] = byId(newVisibleIds[k]); });
    const ops = [];
    let changed = false;
    next.forEach((t, i) => {
      if (t.sortOrder !== i) { t.sortOrder = i; changed = true; ops.push({ store: STORES.tasks, op: 'put', value: t }); }
    });
    if (!changed) { renderList(); return; }
    store.commit(ops).then(renderAll); // one tx for the whole reorder
  }

  function moveVisible(id, dir) {
    const ids = visibleTasks().map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    applyNewOrder(ids);
  }

  function getDragAfterElement(y) {
    const items = [...els.taskList.querySelectorAll('.task:not(.dragging)')];
    let closest = { offset: -Infinity, el: null };
    for (const el of items) {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el };
    }
    return closest.el;
  }

  /* --------------------------- Subtask mutations -------------------------- */

  function setSubOpen(taskId) { S.ui.openSubs[taskId] = !S.ui.openSubs[taskId]; renderList(); }

  async function addSubtask(taskId, title) {
    title = String(title || '').trim();
    if (!title) return;
    const parent = byId(taskId);
    if (!parent) return;
    const now = Date.now();
    const maxPos = subsOfTask(taskId).reduce((m, s) => Math.max(m, s.position), -1);
    const s = {
      id: helpers.uuid(), parentTaskId: taskId, title,
      completed: false, completedAt: null,
      position: maxPos + 1, createdAt: now, updatedAt: now,
    };
    S.subtasks.push(s);
    const ops = [{ store: STORES.subtasks, op: 'put', value: s }];
    // With auto-complete ON, adding an open subtask reopens a completed parent.
    if (S.settings.subtaskAutoComplete && parent.status === 'completed') {
      parent.status = 'active'; parent.updatedAt = now;
      ops.push({ store: STORES.tasks, op: 'put', value: parent });
    }
    await store.commit(ops);
    renderAll();
  }

  async function toggleSubtask(sid) {
    const s = S.subtasks.find((x) => x.id === sid);
    if (!s) return;
    const now = Date.now();
    s.completed = !s.completed;
    s.completedAt = s.completed ? now : null;
    s.updatedAt = now;
    const ops = [{ store: STORES.subtasks, op: 'put', value: s }];
    // Parent auto-completion only when the user explicitly enabled it
    // (Settings). Parent + subtask change in ONE atomic commit.
    const parent = byId(s.parentTaskId);
    if (parent && S.settings.subtaskAutoComplete) {
      const subs = subsOfTask(parent.id);
      const allDone = subs.length > 0 && subs.every((x) => x.completed);
      const want = allDone ? 'completed' : 'active';
      if (parent.status !== want) {
        parent.status = want; parent.updatedAt = now;
        ops.push({ store: STORES.tasks, op: 'put', value: parent });
      }
    }
    await store.commit(ops);
    renderAll();
  }

  async function renameSubtask(sid, title) {
    const s = S.subtasks.find((x) => x.id === sid);
    title = String(title || '').trim();
    S.ui.subEditing = null;
    if (!s || !title || title === s.title) { renderList(); return; }
    s.title = title;
    s.updatedAt = Date.now();
    await store.commit([{ store: STORES.subtasks, op: 'put', value: s }]);
    renderAll();
  }

  let undoSubTimer = null;

  async function deleteSubtask(sid) {
    const i = S.subtasks.findIndex((x) => x.id === sid);
    if (i === -1) return;
    const s = S.subtasks.splice(i, 1)[0];
    await store.commit([{ store: STORES.subtasks, op: 'delete', key: sid }]); // cloud.js tombstones it
    renderAll();
    // 8 s undo window — the same pattern task deletes use.
    clearTimeout(undoSubTimer);
    els.toastHost.innerHTML =
      '<div class="toast show toast-undo">' +
      '<span>Subtask “' + esc(truncate(s.title, 36)) + '” deleted</span>' +
      '<button class="btn btn-sm btn-undo" id="undoSubBtn">Undo</button>' +
      '<div class="undo-bar"><div class="undo-bar-fill"></div></div>' +
      '</div>';
    $('undoSubBtn').onclick = async () => {
      clearTimeout(undoSubTimer);
      els.toastHost.innerHTML = '';
      if (!S.subtasks.some((x) => x.id === s.id)) S.subtasks.push(s);
      s.updatedAt = Date.now(); // newer than the tombstone → revives on every device
      await store.commit([{ store: STORES.subtasks, op: 'put', value: s }]);
      renderAll();
    };
    undoSubTimer = setTimeout(() => { els.toastHost.innerHTML = ''; }, 8000);
  }

  function moveSubtask(sid, dir) {
    const s = S.subtasks.find((x) => x.id === sid);
    if (!s) return;
    const sib = subsOfTask(s.parentTaskId);
    const i = sib.findIndex((x) => x.id === sid);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= sib.length) return;
    const a = sib[i]; const b = sib[j];
    const tmp = a.position; a.position = b.position; b.position = tmp;
    if (a.position === b.position) { a.position = i; b.position = j; } // equal positions → use slots
    const now = Date.now();
    a.updatedAt = now; b.updatedAt = now;
    store.commit([
      { store: STORES.subtasks, op: 'put', value: a },
      { store: STORES.subtasks, op: 'put', value: b },
    ]).then(renderAll);
  }

  function handleSubAction(btn, li) {
    const act = btn.dataset.sact;
    const sid = btn.dataset.sid;
    if (act === 'subs') { if (li) setSubOpen(li.dataset.id); return; }
    if (act === 'sbtoggle') { toggleSubtask(sid); return; }
    if (act === 'subedit') {
      S.ui.subEditing = sid;
      renderList();
      const inp = els.taskList.querySelector('.sub-edit-input');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      return;
    }
    if (act === 'subsave') {
      const inp = els.taskList.querySelector('.sub-edit-input');
      if (inp) renameSubtask(sid, inp.value);
      return;
    }
    if (act === 'subcancel') { S.ui.subEditing = null; renderList(); return; }
    if (act === 'subdel') { deleteSubtask(sid); return; }
    if (act === 'subup') { moveSubtask(sid, -1); return; }
    if (act === 'subdown') { moveSubtask(sid, 1); return; }
    if (act === 'subadd') {
      const wrap = btn.closest('.sub-add');
      const inp = wrap && wrap.querySelector('.sub-add-input');
      if (inp) addSubtask(btn.dataset.parent, inp.value);
    }
  }

  /* ------------------------------- Projects ------------------------------- */
  /* Projects share the tasks/trash machinery completely: same commit path,
     same backup, same tombstones. `deletedAt` marks a trashed project; a task
     whose project is gone keeps working — the reference just detaches on
     purge (emptyTrash / delete-forever move those tasks to the Inbox). */

  function projectByIdRaw(id) { return S.projects.find((p) => p.id === id) || null; }
  function projectById(id) { const p = projectByIdRaw(id); return p && !p.deletedAt ? p : null; }
  function liveProjects() { return S.projects.filter((p) => !p.deletedAt); }
  function trashedProjects() { return S.projects.filter((p) => p.deletedAt); }
  function isOverdueDate(ds) { const f = formatDue(ds, false); return !!(f && f.cls === 'overdue'); }

  function projStats(pid) {
    const tasks = S.tasks.filter((t) => t.projectId === pid);
    const done = tasks.filter((t) => t.status === 'completed').length;
    return {
      total: tasks.length,
      done,
      left: tasks.length - done,
      overdue: tasks.filter((t) => t.status !== 'completed' && isOverdueDate(t.dueDate)).length,
      // "Progress %" counts subtasks: a task contributes its completed
      // fraction (1 while status=completed, else subtasks done / total).
      pct: tasks.length ? Math.round((tasks.reduce((sum, t) => sum + taskProgress(t), 0) / tasks.length) * 100) : 0,
    };
  }

  function projDueBadge(p) {
    if (!p.dueDate) return '';
    const f = formatDue(p.dueDate, p.status === 'completed');
    if (!f) return '';
    return '<span class="badge due ' + f.cls + '">' + f.text + '</span>';
  }

  function renderProjects() {
    const bar = els.projectBar;
    const projects = liveProjects();
    fillProjectSelect();
    bar.hidden = false; // ALWAYS visible — with zero projects this is where
    // "New project" lives; hiding it there made the whole feature undiscoverable.
    if (!projects.length) {
      bar.innerHTML =
        '<div class="project-bar-head">' +
          '<span class="project-bar-title">📂 Projects</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-sm btn-primary" data-act="new" type="button">＋ New project</button>' +
        '</div>' +
        '<div class="project-cards"><span class="muted small">No projects yet — create one to group tasks, track progress and due dates together. Then pick it in the task form (or open a project and press “＋ Add task”).</span></div>';
      return;
    }
    const archivedOn = !!S.ui.showArchived;
    const vis = projects.filter((p) => p.archived === archivedOn);
    const archivedN = projects.filter((p) => p.archived).length;
    const cards = vis.map((p) => {
      const st = projStats(p.id);
      const on = S.ui.projectView === p.id;
      return '<div class="project-card' + (on ? ' on' : '') + (p.archived ? ' archived' : '') + '" data-pid="' + esc(p.id) + '" style="--pc:' + esc(p.color) + '">' +
        '<button class="pc-open" type="button" title="Open project">' +
          '<span class="pc-icon">' + esc(p.icon) + '</span>' +
          '<span class="pc-name">' + esc(p.name) + '</span>' +
          '<span class="pc-count">' + st.done + '/' + st.total + '</span>' +
        '</button>' +
        '<span class="pc-bar" title="' + st.pct + '% complete"><i style="width:' + st.pct + '%"></i></span>' +
        (st.overdue ? '<span class="badge due overdue" title="' + st.overdue + ' overdue task(s)">⚠ ' + st.overdue + '</span>' : projDueBadge(p)) +
        (p.status === 'completed' ? '<span class="badge done-badge">done</span>' : '') +
        '<button class="pc-menu btn btn-ghost btn-sm btn-icon" data-act="menu" type="button" title="Project actions" aria-label="Project actions for ' + esc(p.name) + '">⋯</button>' +
      '</div>';
    }).join('');
    bar.innerHTML =
      '<div class="project-bar-head">' +
        '<span class="project-bar-title">📂 Projects <span class="count">' + (projects.length - archivedN) + '</span></span>' +
        '<span class="spacer"></span>' +
        (archivedN ? '<button class="btn btn-sm btn-ghost" data-act="toggleArchived" type="button">' + (archivedOn ? 'Active (' + (projects.length - archivedN) + ')' : 'Archived (' + archivedN + ')') + '</button>' : '') +
        '<button class="btn btn-sm btn-primary" data-act="new" type="button">＋ New project</button>' +
      '</div>' +
      '<div class="project-cards">' + (cards || '<span class="muted small">No projects here yet.</span>') + '</div>';
  }

  function renderProjectDetail() {
    const host = els.projectDetail;
    const pid = S.ui.projectView;
    const p = pid && projectById(pid);
    if (!p) {
      if (pid && !projectByIdRaw(pid)) { S.ui.projectView = null; S.settings.filterProject = null; }
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const st = projStats(p.id);
    const due = p.dueDate ? formatDue(p.dueDate, p.status === 'completed') : null;
    host.hidden = false;
    host.innerHTML =
      '<div class="pd-card" style="--pc:' + esc(p.color) + '">' +
        '<button class="pd-back btn btn-ghost btn-sm" data-act="back" type="button">← All projects</button>' +
        '<div class="pd-head">' +
          '<span class="pd-icon">' + esc(p.icon) + '</span>' +
          '<div class="pd-titles"><h2>' + esc(p.name) + '</h2>' +
            (p.description ? '<p class="pd-desc">' + esc(p.description) + '</p>' : '') +
          '</div>' +
          '<div class="pd-actions">' +
            '<button class="btn btn-sm btn-primary" data-act="add" type="button">＋ Add task</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="edit" type="button">Edit</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="archive" type="button">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>' +
            '<button class="btn btn-sm btn-danger-ghost" data-act="delete" type="button">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="pd-stats">' +
          '<span class="pd-pct"><b>' + st.pct + '%</b> complete</span>' +
          '<span>·</span><span>' + st.done + ' done</span>' +
          '<span>·</span><span>' + st.left + ' remaining</span>' +
          (st.overdue ? '<span>·</span><span class="overdue-text">⚠ ' + st.overdue + ' overdue</span>' : '') +
          (due ? '<span>·</span><span>' + due.text + (due.cls === 'overdue' ? ' ⚠' : '') + '</span>' : '') +
          (p.status === 'completed' ? '<span>·</span><span>marked completed</span>' : '') +
          (p.archived ? '<span>·</span><span>archived</span>' : '') +
        '</div>' +
        '<span class="pd-progress" role="progressbar" aria-valuenow="' + st.pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + st.pct + '%"></i></span>' +
      '</div>';
  }

  function projectRowTrash(p) {
    return '<li class="task project-row" data-pid="' + esc(p.id) + '">' +
      '<span class="check" aria-hidden="true">🗑</span>' +
      '<div class="task-main">' +
        '<div class="task-title">' + esc(p.icon) + ' ' + esc(p.name) + ' <span class="badge">project</span></div>' +
        '<div class="task-meta"><span class="muted small">deleted ' + fmtWhen(p.deletedAt) + ' — tasks were never touched</span></div>' +
      '</div>' +
      '<div class="task-actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="restore" type="button">Restore</button>' +
        '<button class="btn btn-danger-ghost btn-sm" data-act="destroy" type="button">Delete forever</button>' +
      '</div>' +
    '</li>';
  }

  function fillProjectSelect() {
    const sel = els.fProject;
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = ['<option value="">📥 Inbox</option>'].concat(
      liveProjects()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => '<option value="' + esc(p.id) + '">' + esc(p.icon) + ' ' + esc(p.name) + (p.archived ? ' (archived)' : '') + '</option>')
    ).join('');
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  async function openProject(pid) {
    const p = projectById(pid);
    if (!p) return;
    if (S.ui.projectView === pid) { await closeProject(); return; }
    S.ui.projectView = pid;
    S.settings.filterProject = pid;
    if (S.settings.filterMode === 'trash') S.settings.filterMode = 'all';
    await store.commit([]); // persist the view choice (survives reload, like filterTag)
    renderAll();
  }

  async function closeProject() {
    S.ui.projectView = null;
    S.settings.filterProject = null;
    await store.commit([]);
    renderAll();
  }

  async function toggleArchiveProject(p) {
    p.archived = !p.archived;
    p.updatedAt = Date.now();
    await store.commit([{ store: STORES.projects, op: 'put', value: p }]);
    if (p.archived && S.ui.projectView === p.id) await closeProject();
    else renderAll();
    toast(p.archived ? 'Project archived — its tasks stay right where they are.' : 'Project unarchived.');
  }

  async function toggleProjectStatus(p) {
    p.status = p.status === 'completed' ? 'active' : 'completed';
    p.updatedAt = Date.now();
    await store.commit([{ store: STORES.projects, op: 'put', value: p }]);
    renderAll();
    toast(p.status === 'completed' ? 'Project marked completed.' : 'Project reopened.');
  }

  let undoProjId = null;
  let undoProjTimer = null;

  async function deleteProject(pid) {
    const p = projectByIdRaw(pid);
    if (!p || p.deletedAt) return;
    const ok = await confirmDialog({
      title: 'Delete project “' + truncate(p.name, 40) + '”?',
      body: 'The project moves to Trash (restorable for 30 days — or via the Undo toast). Its tasks are NOT deleted: they stay in place and stay usable; while the project is in Trash they just have no card.',
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!ok) return;
    const now = Date.now();
    p.deletedAt = now;
    p.updatedAt = now; // newer than any synced copy; purge writes the tombstone
    if (S.ui.projectView === pid) { S.ui.projectView = null; S.settings.filterProject = null; }
    await store.commit([{ store: STORES.projects, op: 'put', value: p }]);
    renderAll();
    showProjectUndoToast(p);
  }

  function showProjectUndoToast(p) {
    clearTimeout(undoProjTimer);
    undoProjId = p.id;
    els.toastHost.innerHTML =
      '<div class="toast show toast-undo">' +
      '<span>Deleted “' + esc(truncate(p.name, 30)) + '” — project moved to Trash</span>' +
      '<button class="btn btn-sm btn-undo" id="undoProjBtn">Undo</button>' +
      '<div class="undo-bar"><div class="undo-bar-fill"></div></div>' +
      '</div>';
    $('undoProjBtn').onclick = () => restoreProject(p.id);
    undoProjTimer = setTimeout(() => { undoProjId = null; els.toastHost.innerHTML = ''; }, 8000);
  }

  async function restoreProject(pid) {
    const p = projectByIdRaw(pid);
    if (!p) return;
    clearTimeout(undoProjTimer);
    els.toastHost.innerHTML = '';
    p.deletedAt = null;
    p.updatedAt = Date.now(); // beats the (absent) tombstone — restore semantics
    await store.commit([{ store: STORES.projects, op: 'put', value: p }]);
    renderAll();
    toast('Project restored.');
  }

  async function destroyProjectForever(pid) {
    const p = projectByIdRaw(pid);
    if (!p) return;
    const attached = S.tasks.filter((t) => t.projectId === pid).length + S.trash.filter((t) => t.projectId === pid).length;
    const ok = await confirmDialog({
      title: 'Delete forever?',
      body: '“' + p.name + '” will be permanently erased.'
        + (attached ? ' ' + attached + ' task(s) will stay in your list, detached from the project and moved back to the Inbox.' : '')
        + ' This cannot be undone.',
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    const now = Date.now();
    S.projects = S.projects.filter((x) => x.id !== p.id);
    const ops = [{ store: STORES.projects, op: 'delete', key: p.id }];
    for (const arr of [S.tasks, S.trash]) {
      for (const t of arr) {
        if (t.projectId === p.id) {
          t.projectId = null;
          t.updatedAt = now;
          ops.push({ store: arr === S.tasks ? STORES.tasks : STORES.trash, op: 'put', value: t });
        }
      }
    }
    if (S.settings.filterProject === p.id) { S.settings.filterProject = null; S.ui.projectView = null; }
    await store.commit(ops);
    renderAll();
    toast('Project deleted forever' + (attached ? ' — its tasks moved to the Inbox.' : '.'));
  }

  function onProjectBarClick(e) {
    const top = e.target.closest('[data-act]');
    const act = top && top.dataset.act;
    if (act === 'new') { projectFormModal(null); return; }
    if (act === 'toggleArchived') { S.ui.showArchived = !S.ui.showArchived; renderProjects(); return; }
    const card = e.target.closest('.project-card');
    if (!card) return;
    const p = projectByIdRaw(card.dataset.pid);
    if (!p) return;
    if (act === 'menu') { projectMenu(p); return; }
    openProject(card.dataset.pid);
  }

  function onProjectDetailClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = S.ui.projectView && projectById(S.ui.projectView);
    if (!p) return;
    switch (b.dataset.act) {
      case 'back': closeProject(); break;
      case 'edit': projectFormModal(p); break;
      case 'add': openComposer({ mode: 'new' }, { projectId: p.id }); break;
      case 'archive': toggleArchiveProject(p); break;
      case 'delete': deleteProject(p.id); break;
    }
  }

  function projectMenu(p) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal';
    card.setAttribute('role', 'dialog');
    card.innerHTML =
      '<h3>' + esc(p.icon) + ' ' + esc(p.name) + '</h3>' +
      '<div class="modal-actions col">' +
        '<button class="btn btn-ghost" data-m="edit" type="button">✏️ Rename / edit</button>' +
        '<button class="btn btn-ghost" data-m="status" type="button">' + (p.status === 'completed' ? '↩ Reopen project' : '✅ Mark completed') + '</button>' +
        '<button class="btn btn-ghost" data-m="archive" type="button">' + (p.archived ? '📂 Unarchive' : '🗄️ Archive') + '</button>' +
        '<button class="btn btn-danger-ghost" data-m="delete" type="button">🗑️ Move to Trash</button>' +
        '<button class="btn btn-ghost" data-m="close" type="button">Close</button>' +
      '</div>';
    const finish = () => ov.remove();
    ov.addEventListener('click', (e) => {
      if (e.target === ov) return finish();
      const b = e.target.closest('[data-m]');
      if (!b) return;
      finish();
      if (b.dataset.m === 'edit') projectFormModal(p);
      else if (b.dataset.m === 'status') toggleProjectStatus(p);
      else if (b.dataset.m === 'archive') toggleArchiveProject(p);
      else if (b.dataset.m === 'delete') deleteProject(p.id);
    });
    ov.appendChild(card); // ← was missing: menu card never entered the overlay
    els.modalHost.appendChild(ov);
  }

  const PROJECT_ICONS = ['📁', '💼', '🏠', '🎯', '🎨', '📚', '🏋️', '🌱', '✈️', '🛒', '🔧', '🎧', '💻', '📅', '⭐', '❤️', '🧪', '🎮'];
  const PROJECT_COLORS = ['var(--accent)', '#f2748c', '#f0a35e', '#e8cf6a', '#63c98b', '#57c2d3', '#7aa2ff', '#b48cf2', '#e26fd1'];

  function projectFormModal(existing) {
    const p = existing || null;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal modal-form';
    card.setAttribute('role', 'dialog');
    card.innerHTML =
      '<h3>' + (p ? 'Edit project' : 'New project') + '</h3>' +
      '<label class="field"><span>Name</span><input id="pf-name" type="text" maxlength="120" placeholder="e.g. Renovation — autumn" value="' + (p ? esc(p.name) : '') + '"></label>' +
      '<label class="field"><span>Description</span><textarea id="pf-desc" rows="2" maxlength="2000" placeholder="Optional notes">' + (p ? esc(p.description) : '') + '</textarea></label>' +
      '<div class="form-row">' +
        '<label class="field"><span>Due date</span><input id="pf-due" type="date" value="' + (p && p.dueDate ? p.dueDate : '') + '"></label>' +
        '<label class="field"><span>Status</span><select id="pf-status"><option value="active">Active</option><option value="completed">Completed</option></select></label>' +
      '</div>' +
      '<div class="field"><span>Icon</span><div class="pf-icons">' + PROJECT_ICONS.map((i) => '<button type="button" class="pf-icon" data-icon="' + i + '">' + i + '</button>').join('') + '</div></div>' +
      '<div class="field"><span>Colour theme</span><div class="pf-colors">' + PROJECT_COLORS.map((c) => '<button type="button" class="pf-color" data-color="' + c + '" style="background:' + c + '"></button>').join('') + '</div></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-m="cancel" type="button">Cancel</button>' +
        '<button class="btn btn-primary" data-m="save" type="button">' + (p ? 'Save changes' : 'Create project') + '</button>' +
      '</div>';
    let icon = p ? p.icon : '📁';
    let color = p ? p.color : PROJECT_COLORS[0];
    const mark = () => {
      card.querySelectorAll('.pf-icon').forEach((b) => b.classList.toggle('on', b.dataset.icon === icon));
      card.querySelectorAll('.pf-color').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
    };
    if (p) card.querySelector('#pf-status').value = p.status;
    mark();
    const nameEl = card.querySelector('#pf-name');
    nameEl.addEventListener('input', () => nameEl.classList.remove('invalid'));
    card.addEventListener('click', (e) => {
      const ic = e.target.closest('.pf-icon');
      if (ic) { icon = ic.dataset.icon; mark(); return; }
      const cc = e.target.closest('.pf-color');
      if (cc) { color = cc.dataset.color; mark(); return; }
      const b = e.target.closest('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'cancel') { ov.remove(); return; }
      if (b.dataset.m !== 'save') return;
      const name = nameEl.value.trim();
      if (!name) { nameEl.classList.add('invalid'); nameEl.focus(); return; }
      ov.remove();
      saveProject(p, {
        name,
        description: card.querySelector('#pf-desc').value.trim(),
        dueDate: card.querySelector('#pf-due').value || null,
        status: card.querySelector('#pf-status').value,
        icon,
        color,
      });
    });
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.appendChild(card); // ← the card has to be INSIDE the overlay (was missing!)
    els.modalHost.appendChild(ov);
    nameEl.focus();
  }

  async function saveProject(existing, v) {
    const now = Date.now();
    let p;
    if (existing) {
      p = { ...existing, ...v, updatedAt: now };
      S.projects = S.projects.map((x) => (x.id === p.id ? p : x));
    } else {
      p = { id: helpers.uuid(), createdAt: now, updatedAt: now, sortOrder: now, archived: false, deletedAt: null, ...v };
      S.projects.push(p);
    }
    await store.commit([{ store: STORES.projects, op: 'put', value: p }]);
    renderAll();
    toast(existing ? 'Project updated.' : 'Project “' + truncate(p.name, 30) + '” created.');
  }

  /* ------------------------------- Calendar ------------------------------- */
  /* A pure VIEW over S.tasks. One source of truth for dates: task.dueDate
     (+ optional task.dueTime). Dragging does not copy anything — it updates
     the existing task record (same id, all other properties intact) in one
     commit, so trash/backup/sync all follow automatically. */

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function ymdParse(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDaysYmd(s, n) { const d = ymdParse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function mondayOf(s) { const d = ymdParse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }

  function calFilters() { return S.settings.calendarFilters || {}; }
  function calVisible(t) {
    const f = calFilters();
    if (f.calPriority && t.priority !== f.calPriority) return false;
    if (f.calTag && !(t.tags || []).includes(f.calTag)) return false;
    if (f.calProject) {
      if (f.calProject === 'none') { if (t.projectId) return false; }
      else if (t.projectId !== f.calProject) return false;
    }
    if (f.calStatus === 'active' && t.status === 'completed') return false;
    if (f.calStatus === 'completed' && t.status !== 'completed') return false;
    return true;
  }
  function calTasksOn(ds) {
    return S.tasks
      .filter((t) => t.dueDate === ds && calVisible(t))
      .sort((x, y) => ((x.dueTime || '99:99') < (y.dueTime || '99:99') ? -1 : (x.dueTime || '99:99') > (y.dueTime || '99:99') ? 1 : 0)
        || (x.priority === 'high' ? -1 : 0) - (y.priority === 'high' ? -1 : 0));
  }
  function calStats(ds) {
    const tasks = calTasksOn(ds);
    const today = ymd(new Date());
    return {
      tasks,
      done: tasks.filter((t) => t.status === 'completed').length,
      overdue: tasks.filter((t) => t.status !== 'completed' && ds < today).length,
    };
  }
  function calChip(t, ghost) {
    const done = t.status === 'completed';
    const due = formatDue(t.dueDate, done);
    const overCls = due && due.cls === 'overdue' ? ' is-over' : '';
    // 🔔 N — live reminder count straight from the engine's records (pending +
    // enabled only). Clicking it opens that task's reminder configuration.
    const nRem = remPendingFor(t.id);
    const bell = nRem
      ? '<span class="cal-rem" data-remtid="' + esc(t.id) + '" role="button" tabindex="-1" title="🔔 ' + nRem +
        ' pending reminder(s) — next: ' + esc(remNextLabel(t.id)) + ' — click to configure">🔔 ' + nRem + '</span>'
      : '';
    if (ghost) {
      return '<span class="cal-chip prio-' + t.priority + ' is-ghost" data-gtid="' + esc(t.id) + '"' +
        ' title="↻ Future occurrence — ' + esc(recurLabel(t)) + ' (click to edit the current occurrence)">' +
        '<i class="cal-dot" aria-hidden="true"></i>' + (t.dueTime ? '<b>' + esc(t.dueTime) + '</b>' : '') + '↻ ' + esc(truncate(t.title, 18)) + '</span>';
    }
    return '<span class="cal-chip prio-' + t.priority + (done ? ' is-done' : '') + overCls + (t.recurrence ? ' is-recur' : '') + '" data-tid="' + esc(t.id) + '" draggable="true"' +
      ' title="' + esc((t.dueTime ? t.dueTime + ' — ' : '') + t.title + (t.recurrence ? ' — ' + recurLabel(t) : '')) + '">' +
      '<i class="cal-dot" aria-hidden="true"></i>' + (t.dueTime ? '<b>' + esc(t.dueTime) + '</b>' : '') +
      (t.recurrence ? '<i class="cal-rmark" aria-hidden="true" title="Recurring — completes roll forward">↻</i>' : '') +
      bell + (done ? '✓ ' : '') + esc(truncate(t.title, 22)) + '</span>';
  }
  function calMonthCell(ds, dim) {
    const st = calStats(ds);
    const today = ymd(new Date());
    const shown = st.tasks.slice(0, 3);
    const more = st.tasks.length - shown.length;
    return '<div class="cal-cell' + (ds === today ? ' is-today' : '') + (dim ? ' dim' : '') + '" data-cdate="' + ds + '">' +
      '<span class="cal-day">' + Number(ds.slice(8)) +
        (st.overdue ? '<em class="cal-over" title="' + st.overdue + ' overdue task(s)">!' + st.overdue + '</em>' : '') +
        (st.tasks.length ? '<em class="cal-n" title="' + st.done + ' of ' + st.tasks.length + ' done">' + st.done + '/' + st.tasks.length + '</em>' : '') +
      '</span>' +
      '<div class="cal-chips">' + shown.map((t) => calChip(t)).join('') +
        (more > 0 ? '<button class="cal-more" data-cmore="' + ds + '" type="button">+' + more + ' more</button>' : '') +
        (function () {
          const gs = recurGhosts.get(ds) || [];
          if (!gs.length) return '';
          const vis = more > 0 ? [] : gs.slice(0, Math.max(0, 3 - shown.length));
          return vis.map((x) => calChip(x, true)).join('') + (gs.length > vis.length ? '<span class="cal-more" title="more recurring occurrences">↻+' + (gs.length - vis.length) + '</span>' : '');
        })() +
      '</div></div>';
  }

  // Ghosts: FUTURE occurrences of recurring tasks are shown in the calendar
  // as display-only previews (dashed ↻ chips) — they are never records, so
  // there is nothing to spam, sync or clean up. Completing rolls the REAL
  // chip forward and the ghosts recompute.
  let recurGhosts = new Map();
  function buildRecurGhosts() {
    recurGhosts = new Map();
    for (const t of S.tasks) {
      if (!t.recurrence || t.status === 'completed' || !calVisible(t)) continue;
      const rule = helpers.recurOf(t.recurrence, t.recurRule);
      if (!rule) continue;
      let ds = t.dueDate || ymd(new Date());
      for (let i = 0; i < 14; i++) {
        const nx = helpers.recurNextAfter(ds, t.recurAnchor || (t.dueDate || ds), rule);
        if (!nx) break;
        if (!recurGhosts.has(nx)) recurGhosts.set(nx, []);
        recurGhosts.get(nx).push(t);
        ds = nx;
      }
    }
  }
  function renderCalendar() {
    const cal = S.ui.cal;
    const a = ymdParse(cal.anchor);
    const f = calFilters();
    buildRecurGhosts();
    let title = '';
    let body = '';

    if (cal.view === 'month') {
      title = MONTH_NAMES[a.getMonth()] + ' ' + a.getFullYear();
      const start = mondayOf(ymd(new Date(a.getFullYear(), a.getMonth(), 1)));
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const ds = addDaysYmd(start, i);
        cells += calMonthCell(ds, ymdParse(ds).getMonth() !== a.getMonth());
      }
      body = '<div class="cal-week-heads">' + DAY_NAMES.map((d) => '<span class="cal-wh">' + d + '</span>').join('') + '</div>' +
        '<div class="cal-month">' + cells + '</div>';
    } else if (cal.view === 'week') {
      const mon = mondayOf(cal.anchor);
      const days = []; for (let i = 0; i < 7; i++) days.push(addDaysYmd(mon, i));
      const d0 = ymdParse(days[0]); const d6 = ymdParse(days[6]);
      title = d0.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' – ' +
        d6.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const heads = '<span></span>' + days.map((ds) => {
        const st = calStats(ds);
        return '<span class="cal-wh' + (ds === ymd(new Date()) ? ' is-today' : '') + '">' +
          DAY_NAMES[(ymdParse(ds).getDay() + 6) % 7] + ' ' + Number(ds.slice(8)) +
          (st.tasks.length ? '<em>' + st.tasks.length + '</em>' : '') + '</span>';
      }).join('');
      const allDay = '<div class="cal-row cal-allday-row"><span class="cal-hour-lbl">All-day</span>' +
        days.map((ds) => {
          const ts = calTasksOn(ds).filter((t) => !t.dueTime);
          const gs = (recurGhosts.get(ds) || []).filter((t) => !t.dueTime);
          return '<div class="cal-cell allday" data-cdate="' + ds + '" data-allday="1">' +
            ts.slice(0, 4).map((t) => calChip(t)).join('') + (ts.length > 4 ? '<span class="cal-more">…+' + (ts.length - 4) + '</span>' : '') +
            gs.map((x) => calChip(x, true)).join('') + '</div>';
        }).join('') + '</div>';
      let rows = '';
      for (let h = 0; h < 24; h++) {
        const perDay = days.map((ds) => calTasksOn(ds).filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h));
        const perDayG = days.map((ds) => (recurGhosts.get(ds) || []).filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h));
        if ((h < 6 || h > 22) && !perDay.some((ts) => ts.length) && !perDayG.some((ts) => ts.length)) continue; // collapse quiet hours
        rows += '<div class="cal-row"><span class="cal-hour-lbl">' + String(h).padStart(2, '0') + ':00</span>' +
          days.map((ds, i) => '<div class="cal-cell slot' + (perDay[i].length ? ' has-t' : '') + '" data-cdate="' + ds + '" data-chour="' + h + '">' +
            perDay[i].map((t) => calChip(t)).join('') + perDayG[i].map((x) => calChip(x, true)).join('') + '</div>').join('') + '</div>';
      }
      body = '<div class="cal-week-heads">' + heads + '</div><div class="cal-scroll">' + allDay + rows + '</div>';
    } else { // day
      const ds = cal.anchor;
      title = ymdParse(ds).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const st = calStats(ds);
      const pct = st.tasks.length ? Math.round((st.done / st.tasks.length) * 100) : 0;
      const allday = st.tasks.filter((t) => !t.dueTime);
      const early = st.tasks.filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) < 6);
      const late = st.tasks.filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) > 22);
      const gs = recurGhosts.get(ds) || []; // display-only previews of the series
      let rows = '';
      for (let h = 6; h <= 22; h++) {
        const ts = st.tasks.filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h);
        const tg = gs.filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h);
        rows += '<div class="cal-row day"><span class="cal-hour-lbl">' + String(h).padStart(2, '0') + ':00</span>' +
          '<div class="cal-cell slot' + ((ts.length || tg.length) ? ' has-t' : '') + '" data-cdate="' + ds + '" data-chour="' + h + '">' +
          ts.map((t) => calChip(t)).join('') + tg.map((x) => calChip(x, true)).join('') + '</div></div>';
      }
      body = '<div class="cal-day-summary"><span>' + st.tasks.length + ' task(s)</span><span>·</span>' +
        '<span>' + st.done + ' done</span>' + (st.overdue ? '<span>·</span><span class="cal-over">⚠ ' + st.overdue + ' overdue</span>' : '') +
        '<span class="spacer"></span><span class="cal-mini"><i style="width:' + pct + '%"></i></span><span>' + pct + '%</span>' +
        '<button class="btn btn-sm btn-primary" data-cnew="' + ds + '" type="button">＋ New task</button></div>' +
        (allday.length || gs.some((x) => !x.dueTime) ? '<div class="cal-row cal-allday-row"><span class="cal-hour-lbl">All-day</span><div class="cal-cell allday" data-cdate="' + ds + '" data-allday="1">' + allday.map((t) => calChip(t)).join('') + gs.filter((x) => !x.dueTime).map((x) => calChip(x, true)).join('') + '</div></div>' : '') +
        (early.length ? '<div class="cal-row"><span class="cal-hour-lbl">Early</span><div class="cal-cell allday" data-cdate="' + ds + '" data-chour="3">' + early.map((t) => calChip(t)).join('') + '</div></div>' : '') +
        rows +
        (late.length ? '<div class="cal-row"><span class="cal-hour-lbl">Late</span><div class="cal-cell allday" data-cdate="' + ds + '" data-chour="23">' + late.map((t) => calChip(t)).join('') + '</div></div>' : '');
    }

    const mk = (key, cur, items) => '<label class="cal-filter"><select data-cfilter="' + key + '" title="Filter">' +
      items.map(([v, l]) => '<option value="' + esc(String(v)) + '"' + (String(cur || '') === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    els.calBar.innerHTML =
      '<div class="cal-nav">' +
        ['month', 'week', 'day'].map((v2) => '<button class="filter-btn' + (cal.view === v2 ? ' on' : '') + '" data-cview="' + v2 + '" type="button">' + v2[0].toUpperCase() + v2.slice(1) + '</button>').join('') +
        '<button class="btn btn-sm btn-ghost" data-cnav="prev" type="button" title="Previous (←)">‹ Prev</button>' +
        '<button class="btn btn-sm btn-ghost" data-cnav="today" type="button" title="Today (T)">Today</button>' +
        '<button class="btn btn-sm btn-ghost" data-cnav="next" type="button" title="Next (→)">Next ›</button>' +
        '<h2 class="cal-title">' + title + '</h2>' +
      '</div>' +
      '<div class="cal-filters">' +
        mk('calProject', f.calProject, [['', 'All projects'], ['none', '📥 Inbox']].concat(liveProjects().map((p) => [p.id, p.icon + ' ' + p.name]))) +
        mk('calPriority', f.calPriority, [['', 'Any priority'], ['high', '⚑ High'], ['med', 'Medium'], ['low', 'Low']]) +
        mk('calTag', f.calTag, [['', 'Any tag']].concat(allTags().map(([tag, n]) => [tag, tag + ' (' + n + ')']))) +
        mk('calStatus', f.calStatus, [['', 'Any status'], ['active', 'Active only'], ['completed', 'Completed only']]) +
      '</div>';
    els.calHost.innerHTML = body;
  }

  function calShift(dir) {
    const cal = S.ui.cal;
    const a = ymdParse(cal.anchor);
    if (cal.view === 'month') cal.anchor = ymd(new Date(a.getFullYear(), a.getMonth() + dir, 1));
    else if (cal.view === 'week') cal.anchor = addDaysYmd(cal.anchor, dir * 7);
    else cal.anchor = addDaysYmd(cal.anchor, dir);
    renderCalendar();
  }
  function calToday() { S.ui.cal.anchor = ymd(new Date()); renderCalendar(); }
  async function calSetView(v) {
    S.ui.cal.view = v;
    S.settings.calendarView = v;
    await store.commit([]); // persist preference (settings meta) — no task data touched
    renderCalendar();
  }
  async function calSetFilter(key, val) {
    S.settings.calendarFilters = { ...calFilters(), [key]: val || null };
    await store.commit([]);
    renderCalendar();
  }
  function calQuickCreate(ds, hour) {
    openComposer({ mode: 'new' }, { dueDate: ds, dueTime: hour != null ? String(hour).padStart(2, '0') + ':00' : null, title: '', description: '', tags: [] });
  }

  let calDragId = null;
  function onCalDragStart(e) {
    const chip = e.target.closest && e.target.closest('.cal-chip');
    if (!chip) return;
    calDragId = chip.dataset.tid || null;
    chip.classList.add('dragging');
    if (e.dataTransfer) { try { e.dataTransfer.setData('text/plain', calDragId || ''); e.dataTransfer.effectAllowed = 'move'; } catch (_) {} }
  }
  function onCalDragOver(e) {
    const z = e.target.closest('[data-cdate]');
    if (!z) return;
    e.preventDefault();
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} }
    z.classList.add('cal-drop');
  }
  function clearCalDrop() {
    els.calHost.querySelectorAll('.cal-drop').forEach((x) => x.classList.remove('cal-drop'));
    els.calHost.querySelectorAll('.cal-chip.dragging').forEach((x) => x.classList.remove('dragging'));
  }
  function onCalDrop(e) {
    const z = e.target.closest('[data-cdate]');
    clearCalDrop();
    if (!z) return;
    e.preventDefault();
    let id = '';
    try { id = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''; } catch (_) {}
    id = id || calDragId;
    calDragId = null;
    const t = id && byId(id);
    if (!t) { renderCalendar(); return; }
    const wasDate = t.dueDate; const wasTime = t.dueTime || null;
    t.dueDate = z.dataset.cdate || null;                    // update the EXISTING task…
    if (z.hasAttribute('data-allday')) t.dueTime = null;    // dropped All-day → no time
    else if (z.dataset.chour != null) t.dueTime = String(z.dataset.chour).padStart(2, '0') + ':00';
    t.updatedAt = Date.now();                               // …id + everything else preserved
    if (t.dueDate === wasDate && (t.dueTime || null) === wasTime) { renderCalendar(); return; }
    store.commit([{ store: STORES.tasks, op: 'put', value: t }]).then(() => {
      renderAll();
      const lbl = t.dueDate ? ymdParse(t.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'the Inbox';
      toast('Moved “' + truncate(t.title, 26) + '” to ' + lbl + (t.dueTime ? ' ' + t.dueTime : '') + ' — same task, same id.');
    });
  }
  function onCalHostClick(e) {
    const gh = e.target.closest('.cal-chip.is-ghost');
    if (gh) { if (gh.dataset.gtid && byId(gh.dataset.gtid)) openComposer({ mode: 'edit', taskId: gh.dataset.gtid }); return; }
    const bell = e.target.closest('[data-remtid]');
    if (bell) { openComposer({ mode: 'edit', taskId: bell.dataset.remtid, focusReminders: true }); return; }
    const chip = e.target.closest('.cal-chip');
    if (chip) { if (chip.dataset.tid) openComposer({ mode: 'edit', taskId: chip.dataset.tid }); return; }
    const more = e.target.closest('[data-cmore]');
    if (more) { S.ui.cal.anchor = more.dataset.cmore; calSetView('day'); return; }
    const cn = e.target.closest('[data-cnew]');
    if (cn) { calQuickCreate(cn.dataset.cnew, null); return; }
    const cell = e.target.closest('[data-cdate]');
    if (!cell) return;
    if (e.target.closest('.cal-day')) { S.ui.cal.anchor = cell.dataset.cdate; calSetView('day'); return; } // day-number → day view
    calQuickCreate(cell.dataset.cdate, cell.dataset.chour != null ? cell.dataset.chour : null); // empty area → quick create
  }
  function onCalBarClick(e) {
    const v = e.target.closest('[data-cview]');
    if (v) { calSetView(v.dataset.cview); return; }
    const n = e.target.closest('[data-cnav]');
    if (!n) return;
    if (n.dataset.cnav === 'today') calToday();
    else calShift(n.dataset.cnav === 'prev' ? -1 : 1);
  }
  function onCalKeys(e) {
    if (!S || !S.ui || !S.ui.cal.open || S.ui.composerOpen) return;
    const tg = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tg === 'input' || tg === 'textarea' || tg === 'select' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); calShift(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); calShift(1); }
    else if (e.key === 't' || e.key === 'T') calToday();
    else if (e.key === 'm' || e.key === 'M') calSetView('month');
    else if (e.key === 'w' || e.key === 'W') calSetView('week');
    else if (e.key === 'd' || e.key === 'D') calSetView('day');
  }
  function wireCalendar() {
    els.calBtn.onclick = () => {
      S.ui.cal.open = !S.ui.cal.open;
      if (S.ui.cal.open) { S.ui.cal.anchor = ymd(new Date()); S.ui.dash.open = false; S.ui.hab.open = false; }
      renderAll();
      if (S.ui.cal.open) els.calendar.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    els.habBtn.onclick = () => {
      S.ui.hab.open = !S.ui.hab.open;
      if (S.ui.hab.open) { S.ui.cal.open = false; S.ui.dash.open = false; }
      renderAll();
      if (S.ui.hab.open) els.habitsView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    els.habitsHost.addEventListener('click', onHabClick);
    els.calBar.addEventListener('click', onCalBarClick);
    els.calBar.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-cfilter]');
      if (sel) calSetFilter(sel.dataset.cfilter, sel.value);
    });
    els.calHost.addEventListener('click', onCalHostClick);
    els.calHost.addEventListener('dragstart', onCalDragStart);
    els.calHost.addEventListener('dragover', onCalDragOver);
    els.calHost.addEventListener('dragleave', (e) => { const z = e.target.closest('[data-cdate]'); if (z) z.classList.remove('cal-drop'); });
    els.calHost.addEventListener('drop', onCalDrop);
    els.calHost.addEventListener('dragend', clearCalDrop);
    document.addEventListener('keydown', onCalKeys);
  }

  /* ---------------------------- Reminder engine ----------------------------
   */
  /* The schedule lives IN the reminder records (persisted alongside the
     tasks — same stores, same sync, same backups). setTimeout is only ever
     an optimization to fire promptly while the page is open; on every boot
     remInit() re-derives state from the records: catch up overdue ones
     (as "Missed"), never double-fire (delivered flag + a localStorage
     ledger guards against a second tab), and re-arm future ones. */

  const REM_OFFSET_MIN = { onTime: 0, m5: 5, m10: 10, m15: 15, m30: 30, h1: 60, h2: 120, d1: 1440, d2: 2880 };
  const REM_TYPE_LABELS = [
    ['onTime', 'At time of task'], ['m5', '5 minutes before'], ['m10', '10 minutes before'],
    ['m15', '15 minutes before'], ['m30', '30 minutes before'], ['h1', '1 hour before'],
    ['h2', '2 hours before'], ['d1', '1 day before'], ['d2', '2 days before'], ['custom', 'Custom date/time'],
  ];
  const REM_FIRE_KEY = 'zt_rem_fired_v1'; // { reminderId: firedAt } — cross-tab dedup
  let remTimer = null;
  let remBeat = null;

  /* Timezone rule: everything the user picks is stored as wall-clock strings
     (task dueDate/dueTime, reminder customDate/customTime) and converted to
     an epoch ms for the LOCAL zone at compute time. Epochs display through the
     local zone too. A timezone change therefore never rewrites a date — it
     consistently re-derives the instant. */
  function localEpoch(ds, ts, fallbackHM) {
    if (typeof ds !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
    const p = ds.split('-').map(Number);
    let hh = 9, mi = 0;
    const src = (typeof ts === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(ts)) ? ts : (fallbackHM || '09:00');
    const q = src.split(':').map(Number);
    hh = q[0]; mi = q[1];
    return new Date(p[0], p[1] - 1, p[2], hh, mi, 0, 0).getTime();
  }
  function dueEpochFor(t) { return t && t.dueDate ? localEpoch(t.dueDate, t.dueTime, '09:00') : null; }
  function remComputeTrigger(r, t) {
    if (r.reminderType === 'custom') return localEpoch(r.customDate, r.customTime, '09:00');
    if (r.reminderType === 'overdue') {
      // "passes its due time": timed task → its instant; all-day → 23:59.
      const base = t && t.dueDate
        ? (t.dueTime ? dueEpochFor(t) : localEpoch(t.dueDate, '23:59', '23:59'))
        : null;
      if (base == null) return null;
      const grace = window.ZTNotify ? (ZTNotify.policy().odGraceMin || 0) : 0;
      return base + grace * 60000;
    }
    const base = dueEpochFor(t);
    return base == null ? null : base - (REM_OFFSET_MIN[r.reminderType] || 0) * 60000;
  }
  function remTaskOf(id) { return S.tasks.find((t) => t.id === id) || S.trash.find((t) => t.id === id) || null; }
  function remPendings(taskId) { return S.reminders.filter((r) => r.taskId === taskId && r.status === 'pending' && r.enabled); }
  function remPendingFor(taskId) { return remPendings(taskId).length; }
  function remNextLabel(taskId) {
    const n = remPendings(taskId).slice().sort((a, b) => a.triggerAt - b.triggerAt)[0];
    return n ? new Date(n.triggerAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function remFmt(ms) { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

  function remLedger() {
    try { return JSON.parse(window.localStorage.getItem(REM_FIRE_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function remLedgerMark(id) {
    const m = remLedger();
    m[id] = Date.now();
    const keys = Object.keys(m);
    if (keys.length > 300) {
      keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 300).forEach((k) => { delete m[k]; });
    }
    try { window.localStorage.setItem(REM_FIRE_KEY, JSON.stringify(m)); } catch (_) {}
  }

  /* --------- the editor rows inside the composer --------- */
  function renderRemRows() {
    const rows = S.ui.remRows || [];
    els.remRows.innerHTML = rows.map((rw, i) => {
      const opts = REM_TYPE_LABELS.map(([v, l]) =>
        '<option value="' + v + '"' + (rw.reminderType === v ? ' selected' : '') + '>' + l + '</option>').join('');
      return '<div class="rem-row" data-ri="' + i + '">' +
        (rw.status && rw.status !== 'pending' ? '<span class="rem-status st-' + rw.status + '">' + rw.status + '</span>' : '') +
        '<select data-rfield="reminderType" aria-label="Reminder type">' + opts + '</select>' +
        (rw.reminderType === 'custom'
          ? '<input type="date" data-rfield="customDate" value="' + esc(rw.customDate || '') + '" aria-label="Custom reminder date">' +
            '<input type="time" data-rfield="customTime" value="' + esc(rw.customTime || '') + '" aria-label="Custom reminder time">'
          : '') +
        '<button type="button" class="btn btn-sm btn-ghost rem-rm" data-rfield="remove" aria-label="Remove reminder" title="Remove reminder">✕</button>' +
        '</div>';
    }).join('') || '<span class="rem-none">No reminder</span>';
    if (rows.length && window.ZTNotify && ZTNotify.status() !== 'granted') {
      els.remRows.insertAdjacentHTML('beforeend',
        '<p class="notif-hint muted small">🔕 OS alerts are off — turn on “Enable notifications” in Settings → Notifications to get these as real notifications.</p>');
    }
  }
  function remRowEdit(e) {
    const host = e.target.closest('.rem-row');
    if (!host) return;
    const field = e.target.dataset.rfield;
    if (!field) return;
    const rw = (S.ui.remRows || [])[Number(host.dataset.ri)];
    if (!rw) return;
    rw[field] = e.target.value;
    if (field === 'reminderType') renderRemRows(); // 'custom' swaps in date/time inputs
    scheduleDraft();
  }

  /** Rebuild a task's *pending* reminders from the editor rows. Fired or
   *  dismissed history is preserved. New/kept rows get recomputed triggerAt
   *  values; removed pending rows are deleted (→ tombstone → other devices). */
  function remSyncTask(t, rows, ops) {
    const now = Date.now();
    const editable = S.reminders.filter((r) => r.taskId === t.id && (r.status === 'pending' || r.status === 'skipped') && r.reminderType !== 'overdue');
    const kept = new Set();
    for (const rw of (rows || [])) {
      if (rw.id) kept.add(rw.id);
    }
    for (const old of editable) {
      if (!kept.has(old.id)) {
        ops.push({ store: STORES.reminders, op: 'delete', key: old.id });
        S.reminders = S.reminders.filter((x) => x.id !== old.id);
      }
    }
    let created = 0; let droppedNoDate = 0;
    for (const rw of (rows || [])) {
      let r = rw.id ? S.reminders.find((x) => x.id === rw.id && x.taskId === t.id) : null;
      if (!r) {
        r = { id: helpers.uuid(), taskId: t.id, createdAt: now, customDate: null, customTime: null };
        S.reminders.push(r);
      }
      r.reminderType = REM_OFFSET_MIN.hasOwnProperty(rw.reminderType) || rw.reminderType === 'custom' ? rw.reminderType : 'onTime';
      r.customDate = rw.customDate || null;
      r.customTime = rw.customTime || null;
      r.enabled = true; r.delivered = false; r.dismissed = false; r.status = 'pending';
      r.triggerAt = remComputeTrigger(r, t);
      if (r.triggerAt == null) {
        // relative reminder but the task has no due date → cannot schedule;
        // the record is not saved rather than silently firing at epoch.
        S.reminders = S.reminders.filter((x) => x.id !== r.id);
        droppedNoDate++;
        continue;
      }
      r.updatedAt = now;
      created++;
      ops.push({ store: STORES.reminders, op: 'put', value: r });
    }
    if (droppedNoDate) toast(droppedNoDate + ' reminder(s) need a due date on the task — not saved.');
    return created;
  }

  /** Due-date policy (unified scheduling): relative reminders always ride the
   *  new due; CUSTOM reminders are absolute wall-clock choices, so a due move
   *  never rewrites them silently — the user is asked, and the default
   *  ("Keep them") preserves them. Shifting moves existing rows by the exact
   *  due delta so a "day before, 10 PM" intent survives a day-long slip. */
  async function askShiftCustomReminders(t, rows, prevDue) {
    const existing = (rows || []).filter((rw) => rw.id && rw.reminderType === 'custom');
    if (!existing.length) return;
    const oldB = dueEpochFor(prevDue);
    const newB = dueEpochFor(t);
    if (oldB == null || newB == null || oldB === newB) return;
    const delta = newB - oldB;
    const s = Math.round(Math.abs(delta) / 1000);
    const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60);
    const span = (dd ? dd + (dd === 1 ? ' day' : ' days') : '')
      + (dd && (hh || mi) ? ', ' : '') + (hh ? hh + (hh === 1 ? ' hour' : ' hours') : '')
      + ((dd || hh) && mi ? ', ' : '') + (mi || (!dd && !hh) ? (mi || 1) + (mi === 1 ? ' minute' : ' minutes') : '');
    const shift = await confirmDialog({
      title: 'Move custom reminders too?',
      body: 'The due date moved ' + span + ' ' + (delta > 0 ? 'later' : 'earlier') + '. Move '
        + existing.length + ' custom reminder(s) by the same amount, or keep the times you picked?',
      confirmLabel: 'Shift with due',
      cancelLabel: 'Keep them',
    });
    if (!shift) return;
    for (const rw of existing) {
      const rec = S.reminders.find((x) => x.id === rw.id && x.taskId === t.id);
      if (!rec) continue;
      const base = localEpoch(rw.customDate || rec.customDate, rw.customTime || rec.customTime, '09:00');
      if (base == null) continue;
      const nd = new Date(base + delta);
      rw.customDate = ymd(nd);
      rw.customTime = String(nd.getHours()).padStart(2, '0') + ':' + String(nd.getMinutes()).padStart(2, '0');
    }
  }

  /* --------- the engine: catch-up, dedup, arm, fire --------- */

  async function remFireDue() {
    if (!S || !S.reminders) return false;
    const now = Date.now();
    const dueList = S.reminders.filter((r) => r.status === 'pending' && r.enabled && r.triggerAt <= now);
    if (!dueList.length) return false;
    const ledger = remLedger();
    const ops = [];
    const alerts = [];
    const odPol = window.ZTNotify ? ZTNotify.policy() : null;
    for (const r of dueList) {
      if (r.habitId && !r.taskId) { // habit nudge — same fire path, then re-arm to the next due slot
        const h = habitOf(r.habitId);
        if (!h || h.archived || !h.remindTime) {
          r.status = 'skipped'; r.updatedAt = now;
          ops.push({ store: STORES.reminders, op: 'put', value: r });
          continue;
        }
        const slotDay = ymd(new Date(r.triggerAt));
        const alreadyMet = h.frequency === 'weekly' ? habitWeekMet(h, habitWeekMon(slotDay)) : habitMetOn(h, slotDay);
        const fk = r.id + '@' + r.triggerAt;
        if (!alreadyMet && !ledger[fk]) {
          remLedgerMark(fk); // mark BEFORE notifying — same at-most-once rule
          alerts.push({ r, t: { id: h.id, title: h.name }, habit: true, lateMs: now - r.triggerAt });
        }
        r.delivered = true; r.firedAt = now; r.pinned = false;
        const ns = habitNextSlot(h, now); // today is done (or was nagged): next due slot only
        if (ns != null) { r.status = 'pending'; r.delivered = false; r.triggerAt = ns; }
        else r.status = alreadyMet ? 'skipped' : 'triggered';
        r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
        continue;
      }
      const t = remTaskOf(r.taskId);
      if (!t || t.status === 'completed' || (S.trash || []).some((x) => x.id === r.taskId)) {
        r.status = 'skipped'; r.updatedAt = now; // safe handling: never nag for finished/deleted work
        ops.push({ store: STORES.reminders, op: 'put', value: r });
        continue;
      }
      // Dedup is per DELIVERY INSTANCE (a snooze or overdue re-arm changes
      // triggerAt and naturally mints a new one) — never per-reminder.
      const fkey = r.id + '@' + r.triggerAt;
      if (ledger[fkey]) { // already notified (this tab or another) — just settle the record
        r.status = 'triggered'; r.delivered = true; r.pinned = false; r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
        continue;
      }
      r.status = 'triggered'; r.delivered = true; r.firedAt = now; r.pinned = false; r.updatedAt = now;
      if (r.reminderType === 'overdue') r.forDue = t.dueDate; // spam guard: one alert per due date
      alerts.push({ r, t, lateMs: now - r.triggerAt });
      remLedgerMark(fkey); // mark BEFORE notifying — a crash mid-notify must not refire
      // Overdue policy: 'repeat' re-arms instead of staying fired — bounded by
      // odHours so it can never turn into spam.
      if (r.reminderType === 'overdue' && odPol && odPol.odMode === 'repeat') {
        r.status = 'pending'; r.delivered = false;
        r.triggerAt = now + Math.max(1, odPol.odHours | 0) * 3600e3;
        r.updatedAt = now;
      }
      ops.push({ store: STORES.reminders, op: 'put', value: r });
    }
    if (!ops.length) return false;
    await store.commit(ops);
    for (const al of alerts) remNotify(al.r, al.t, al.lateMs, al.habit);
    renderAll();
    return true;
  }

  function remNotify(r, t, lateMs, isHabit) {
    // Delivery, OS channels, actions and dedup all belong to notify.js —
    // the task UI just hands over the fired alert.
    if (isHabit) {
      if (window.ZTNotify && ZTNotify.habitAlert) { ZTNotify.habitAlert(r, t, lateMs); return; }
      toast('🔥 ' + t.title + ' — time for your habit check-in.');
      return;
    }
    if (window.ZTNotify && ZTNotify.reminderAlert) {
      ZTNotify.reminderAlert(r, t, lateMs);
      return;
    }
    const missed = lateMs > 60000;
    const msg = (missed ? '⏰ Missed reminder — ' : '🔔 Reminder — ') + t.title +
      (missed ? ' (was due ' + remFmt(r.triggerAt) + ')' : '');
    const el = document.createElement('div');
    el.className = 'toast show toast-rem';
    el.innerHTML = '<span>' + esc(msg) + '</span>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-remopen="' + esc(t.id) + '">Open</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-remdismiss="' + esc(r.id) + '">Dismiss</button>';
    els.toastHost.appendChild(el);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 10000);
  }

  /** Snooze an already-fired alert: same record, new instance (new dedup key
   *  via triggerAt), status back to pending. 5/10/30/60 min or Tomorrow 09:00. */
  async function remSnooze(id, opt) {
    const r = S.reminders.find((x) => x.id === id);
    if (!r) return;
    const now = Date.now();
    r.triggerAt = opt === 'tomorrow'
      ? localEpoch(ymd(new Date(now + 864e5)), null, '09:00')
      : now + Math.max(1, Number(opt) || 10) * 60000;
    if (r.triggerAt <= now) r.triggerAt = now + 60000;
    r.status = 'pending'; r.delivered = false; r.dismissed = false;
    r.pinned = true; // hold this adjusted instant against recompute until it fires
    r.updatedAt = now;
    await store.commit([{ store: STORES.reminders, op: 'put', value: r }]);
    renderAll();
    remReconcile();
    toast('Snoozed to ' + new Date(r.triggerAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '.');
  }

  function remArm() {
    if (remTimer) { clearTimeout(remTimer); remTimer = null; }
    if (!S || !S.reminders) return;
    const now = Date.now();
    let next = Infinity;
    for (const r of S.reminders) if (r.status === 'pending' && r.enabled && r.triggerAt > now) next = Math.min(next, r.triggerAt);
    if (next !== Infinity) {
      remTimer = setTimeout(() => { remTimer = null; remReconcile().catch(() => {}); },
        Math.min(Math.max(next - now, 250), 2000000000));
    }
  }

  /** Re-derive pending schedules from the tasks (single source of truth for
   *  dates). Runs on boot, after every relevant commit, after cloud adopts
   *  and on the heartbeat. Recompute covers: task date edits, timezone
   *  shifts, and recurring cycles. */
  async function remReconcile() {
    if (!S || !S.reminders || !S.ui) return;
    const now = Date.now();
    const ops = [];
    for (const r of S.reminders) {
      if (r.habitId && !r.taskId) continue; // habit nudges: own pass below (engine-owned like 'overdue')
      if (r.status !== 'pending' || !r.enabled) continue;
      if (r.pinned) continue; // user-snoozed: the adjusted time stands until it fires (then clears)
      if (r.reminderType === 'overdue') {
        // Auto-managed: its trigger is owned by the fire/re-arm policy, NOT by
        // recompute — overwriting it each tick would loop the alert. It only
        // moves when the task's dueDate actually changes.
        const tt = remTaskOf(r.taskId);
        if (tt && r.forDue != null && r.forDue !== tt.dueDate) {
          const nt2 = remComputeTrigger(r, tt);
          if (nt2 != null) {
            r.triggerAt = nt2; r.forDue = tt.dueDate; r.updatedAt = now;
            r.status = 'pending'; r.delivered = false; r.dismissed = false;
            ops.push({ store: STORES.reminders, op: 'put', value: r });
          }
        }
        continue;
      }
      const t = remTaskOf(r.taskId);
      let nt = null;
      if (t) nt = remComputeTrigger(r, t);
      if (nt == null) {
        r.status = 'skipped'; r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
        continue;
      }
      if (nt !== r.triggerAt) {
        r.triggerAt = nt; r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
      }
    }
    // Habit nudges: ONE engine-managed row per habit (id 'hr:'+habitId) in
    // this same store — created, repaired and re-armed here exactly like the
    // overdue record's policy. A habit with no time (or archived) retires its
    // row as 'skipped'; a met check-in day is skipped at fire time instead.
    for (const h of (S.habits || [])) {
      const rid = 'hr:' + h.id;
      const row = S.reminders.find((r) => r.id === rid);
      const slot = (!h.archived && h.remindTime) ? habitNextSlot(h, now) : null;
      if (slot == null) {
        if (row && row.status === 'pending' && !row.pinned) {
          row.status = 'skipped'; row.updatedAt = now;
          ops.push({ store: STORES.reminders, op: 'put', value: row });
        }
        continue;
      }
      if (!row) {
        const nr = {
          id: rid, habitId: h.id, taskId: '', reminderType: 'custom',
          triggerAt: slot, enabled: true, delivered: false, dismissed: false,
          status: 'pending', createdAt: now, updatedAt: now,
        };
        S.reminders.push(nr);
        ops.push({ store: STORES.reminders, op: 'put', value: nr });
      } else if (row.pinned && row.status === 'pending' && row.triggerAt > now) {
        // user snoozed this instance — the adjusted time stands until it fires
      } else {
        let touch = false;
        if (row.triggerAt !== slot) { row.triggerAt = slot; touch = true; }
        if (row.status !== 'pending') { row.status = 'pending'; row.delivered = false; row.dismissed = false; row.pinned = false; touch = true; }
        if (!row.enabled) { row.enabled = true; touch = true; }
        if (touch) { row.updatedAt = now; ops.push({ store: STORES.reminders, op: 'put', value: row }); }
      }
    }
    // Overdue alerts are ENGINE-MANAGED records (reminderType 'overdue') so
    // they persist, sync and dedupe exactly like user reminders. One per
    // task; re-armed automatically when the task's dueDate moves.
    const wantsOd = window.ZTNotify && ZTNotify.wantsOverdue();
    if (wantsOd) {
      for (const t of S.tasks) {
        if (t.status === 'completed' || !t.dueDate) continue;
        if (S.reminders.some((r) => r.taskId === t.id && r.reminderType === 'overdue' && r.status === 'pending')) continue;
        const trig = remComputeTrigger({ reminderType: 'overdue' }, t);
        if (trig == null) continue;
        const hist = S.reminders.find((r) => r.taskId === t.id && r.reminderType === 'overdue');
        if (hist && (hist.status === 'skipped' || hist.status === 'dismissed' || (hist.forDue != null && hist.forDue !== t.dueDate))) {
          hist.status = 'pending'; hist.delivered = false; hist.dismissed = false;
          hist.triggerAt = trig; hist.forDue = t.dueDate; hist.updatedAt = now;
          ops.push({ store: STORES.reminders, op: 'put', value: hist });
        } else if (!hist) {
          const r = { id: helpers.uuid(), taskId: t.id, triggerAt: trig, reminderType: 'overdue',
            enabled: true, delivered: false, dismissed: false, status: 'pending',
            customDate: null, customTime: null, forDue: t.dueDate, createdAt: now, updatedAt: now };
          S.reminders.push(r);
          ops.push({ store: STORES.reminders, op: 'put', value: r });
        }
      }
    } else {
      for (const r of S.reminders) {
        if (r.reminderType !== 'overdue') continue;
        ops.push({ store: STORES.reminders, op: 'delete', key: r.id });
      }
      if (ops.length) S.reminders = S.reminders.filter((x) => x.reminderType !== 'overdue');
    }
    if (ops.length) await store.commit(ops);
    await remFireDue();
    remArm();
    if (window.ZTNotify) { try { ZTNotify.tick(); } catch (_) {} } // summaries/habits/deadlines/pomodoro
  }

  function remReviveSkipped(taskId, ops, now) {
    for (const r of S.reminders) {
      if (r.taskId !== taskId || r.status !== 'skipped') continue;
      const t = remTaskOf(taskId);
      const nt = t ? remComputeTrigger(r, t) : null;
      if (nt != null && nt > now) {
        r.status = 'pending'; r.delivered = false; r.dismissed = false;
        r.triggerAt = nt; r.updatedAt = now;
        ops.push({ store: STORES.reminders, op: 'put', value: r });
      }
    }
  }

  function remInit() {
    remReconcile().catch(() => {});
    if (remBeat) clearInterval(remBeat);
    // Safety-net heartbeat: throttled-tab and clock-skew catch-up. The
    // records (not the timer) are the schedule, so a missed tick only means
    // a later fire, and a killed tab means a boot-time "Missed" fire.
    remBeat = setInterval(() => { remReconcile().catch(() => {}); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') remReconcile().catch(() => {});
    });
  }

  /* ========================= Recurrence (series tools) ======================
     The math lives in storage.js helpers (single engine for app, tests and
     validation). This layer only orchestrates: roll-on-complete, the composer
     custom panel, the per-series action sheet, and the occurrence-vs-series
     question when a date is edited on a live pattern. */

  /** Roll a recurring task to its next occurrence + re-arm its cycle-linked
   *  reminders against the new date. Returns { next, rearmed } or null when
   *  the rule has no future occurrence within the horizon. */
  function recurAdvance(t, ops, now) {
    const rule = t.recurrence ? helpers.recurOf(t.recurrence, t.recurRule) : null;
    if (!rule) return null;
    const base = t.dueDate || ymd(new Date());
    const next = helpers.recurNextAfter(base, t.recurAnchor || base, rule);
    if (!next) return null;
    const prevDue = t.dueDate;
    t.dueDate = next;
    let rearmed = 0;
    for (const r of S.reminders) {
      if (r.taskId !== t.id || r.reminderType === 'custom' || r.reminderType === 'overdue') continue; // custom is absolute; overdue is re-armed by reconcile's forDue policy
      r.status = 'pending'; r.delivered = false; r.dismissed = false;
      r.triggerAt = remComputeTrigger(r, t); r.pinned = false;
      if (r.triggerAt == null) {
        ops.push({ store: STORES.reminders, op: 'delete', key: r.id });
        S.reminders = S.reminders.filter((x) => x.id !== r.id);
        continue;
      }
      r.updatedAt = now;
      ops.push({ store: STORES.reminders, op: 'put', value: r });
      rearmed++;
    }
    void prevDue;
    return { next, rearmed };
  }

  const RECUR_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function recurLabel(t) {
    const r = t.recurrence ? helpers.recurOf(t.recurrence, t.recurRule) : null;
    if (!r) return 'Does not repeat';
    const anchor = ymdParse(t.recurAnchor || t.dueDate || ymd(new Date()));
    if (r.unit === 'week' && r.every === 1 && r.weekdays && r.weekdays.join() === '1,2,3,4,5') return 'Every weekday (Mon–Fri)';
    const plural = (n, w) => (n === 1 ? 'every ' + w : 'every ' + n + ' ' + w + 's');
    if (r.unit === 'day') return r.every === 1 ? 'Every day' : plural(r.every, 'day').replace(/^e/, 'E');
    if (r.unit === 'week') {
      const on = r.weekdays ? r.weekdays.map((d) => RECUR_DOW[d]).join(', ') : RECUR_DOW[anchor.getDay()];
      return (r.every === 1 ? 'Weekly' : plural(r.every, 'week').replace(/^e/, 'E')) + ' on ' + on;
    }
    if (r.unit === 'month') return (r.every === 1 ? 'Monthly' : plural(r.every, 'month').replace(/^e/, 'E')) + ' on day ' + anchor.getDate() + (anchor.getDate() >= 29 ? ' (clamped in shorter months)' : '');
    const md = (anchor.getMonth() + 1) + '/' + anchor.getDate();
    return (r.every === 1 ? 'Yearly' : plural(r.every, 'year').replace(/^e/, 'E')) + ' on ' + md;
  }

  /* composer panel state: read/write + live preview of what the rule means */
  function curRecurRule() {
    const st = S.ui.recurPanel || { every: 1, unit: 'week', weekdays: [] };
    return { unit: st.unit, every: st.every, weekdays: st.unit === 'week' && st.weekdays.length ? [...st.weekdays].sort((a, b) => a - b) : null };
  }
  function renderRecurPanel() {
    if (!els.recurPanel) return;
    const on = els.fRecurrence.value === 'custom';
    els.recurPanel.hidden = !on;
    if (!on) return;
    const st = S.ui.recurPanel || { every: 1, unit: 'week', weekdays: [] };
    els.rcEvery.value = st.every;
    els.rcUnit.value = st.unit;
    els.rcDays.hidden = st.unit !== 'week';
    for (const b of els.rcDays.querySelectorAll('[data-rday]')) b.classList.toggle('on', st.weekdays.indexOf(Number(b.dataset.rday)) >= 0);
    updateRecurHint();
  }
  function updateRecurHint() {
    if (!els.rcHint || els.fRecurrence.value !== 'custom') return;
    const rule = helpers.recurOf('custom', curRecurRule());
    const anchor = els.fDue.value || ymd(new Date());
    let ds = anchor; const parts = [];
    for (let i = 0; i < 3; i++) {
      const nx = helpers.recurNextAfter(ds, anchor, rule);
      if (!nx) break;
      parts.push(((formatDue(nx) || {}).txt || nx).replace(/^Due /, ''));
      ds = nx;
    }
    els.rcHint.textContent = parts.length
      ? 'Next occurrences: ' + parts.join(' · ') + ' (pattern starts from the due date)'
      : 'No occurrence within 10 years — this pattern would end immediately.';
  }

  /** Unchanged pattern + moved date → who moves? Default (cancel) keeps the
   *  series rhythm and changes only this occurrence. */
  async function askRecurrenceScope(t, prevRecur) {
    if (!t.recurrence || !prevRecur.recurrence || prevRecur.recurrence !== t.recurrence) return;
    if (!prevRecur.dueDate || !t.dueDate || prevRecur.dueDate === t.dueDate) return;
    const delta = Math.round((ymdParse(t.dueDate) - ymdParse(prevRecur.dueDate)) / DAY_MS);
    if (!delta) return;
    const shift = await confirmDialog({
      title: 'Move the whole series?',
      body: 'This recurring task\u2019s date moved ' + Math.abs(delta) + ' day' + (Math.abs(delta) === 1 ? '' : 's') +
        '. Shifting the whole series also moves future occurrences to the new rhythm; keeping it changes only this occurrence.',
      confirmLabel: 'Shift entire series',
      cancelLabel: 'This occurrence only',
    });
    if (shift) {
      const na = ymdParse(prevRecur.anchor || prevRecur.dueDate);
      na.setDate(na.getDate() + delta);
      t.recurAnchor = ymd(na);
    }
  }

  /* per-series action sheet: the brief's occurrence vs series verbs */
  function seriesDialog(t) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const card = document.createElement('div');
      card.className = 'modal modal-series';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const h = document.createElement('h3');
      h.textContent = '↻ ' + t.title;
      const p = document.createElement('p');
      p.className = 'modal-body muted small';
      p.textContent = recurLabel(t) + (t.dueDate ? ' · this occurrence: ' + t.dueDate : '') + (t.recurAnchor ? ' · anchor: ' + t.recurAnchor : '');
      const wrap = document.createElement('div');
      wrap.className = 'modal-actions series-actions';
      const mkB = (act, label, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (cls || 'btn-ghost');
        b.dataset.s = act;
        b.textContent = label;
        wrap.appendChild(b);
      };
      mkB('complete', '✓ Complete this occurrence', 'btn-primary');
      mkB('skip', '↷ Skip this occurrence');
      mkB('edit-occ', '✎ Edit this occurrence');
      mkB('edit-series', '⛓ Edit entire series');
      mkB('stop', '⏹ Stop repeating', 'btn-danger-ghost');
      mkB('', 'Close');
      card.append(h, p, wrap);
      ov.appendChild(card);
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') finish(null); };
      ov.addEventListener('click', (e) => {
        if (e.target === ov) { finish(null); return; }
        const b = e.target.closest('[data-s]');
        if (b) finish(b.dataset.s || null);
      });
      document.addEventListener('keydown', onKey, true);
      els.modalHost.appendChild(ov);
    });
  }

  async function skipOccurrence(t) {
    const ops = [];
    const adv = recurAdvance(t, ops, Date.now());
    if (!adv) { toast('No future occurrence to skip to.'); return; }
    t.updatedAt = Date.now();
    ops.push({ store: STORES.tasks, op: 'put', value: t });
    await store.commit(ops);
    renderAll();
    remReconcile();
    toast('Skipped this occurrence — next is ' + ((formatDue(adv.next) || {}).txt || adv.next) + '.');
  }

  async function stopRepeating(t) {
    t.recurrence = null;
    t.recurRule = null;
    t.recurAnchor = null;
    t.updatedAt = Date.now();
    await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
    renderAll();
    remReconcile();
    toast('Repetition stopped — the task stays as a one-off.');
  }

  async function onSeriesAction(act, t) {
    if (!act) return;
    if (act === 'complete') await toggleTask(t.id);
    else if (act === 'skip') await skipOccurrence(t);
    else if (act === 'edit-occ') openComposer({ mode: 'edit', taskId: t.id });
    else if (act === 'edit-series') openComposer({ mode: 'edit', taskId: t.id, focusRecurrence: true });
    else if (act === 'stop') await stopRepeating(t);
  }

  /* ------------------------------- Focus Mode --------------------------------
   * Task-bound Pomodoro, built on the app's own doctrines:
   *  • The session is a snapshot ON THE TASK ({ phase, endsAt, pausedAt, … })
   *    — derived-time like reminders, so nothing ticks per second into
   *    storage, and a refresh, a sleep or a sync can't lose progress: boot
   *    catches the phase machine up from wall-clock.
   *  • Focus TIME rides the task too (focusTotal minutes, focusSessions,
   *    capped focusLog), so trash/restore/export/sync and the dashboard
   *    aggregates need no special cases.
   *  • A task is NEVER auto-completed — that happens only behind the
   *    explicit ⚙ Settings → “Mark the task complete when a session ends”.
   * The old transient notify-only Pomodoro is gone; this IS that feature.
   * --------------------------------------------------------------------------*/

  const FOCUS_DEF = { work: 25, short: 5, long: 15, longEvery: 4, notify: true, autoComplete: false };
  function focusCfg() {
    const raw = (S.settings && S.settings.focus) || {};
    const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
    return {
      work: num(raw.work, 1, 180, FOCUS_DEF.work),
      short: num(raw.short, 1, 60, FOCUS_DEF.short),
      long: num(raw.long, 1, 120, FOCUS_DEF.long),
      longEvery: num(raw.longEvery, 1, 12, FOCUS_DEF.longEvery),
      notify: raw.notify === undefined ? FOCUS_DEF.notify : !!raw.notify,
      autoComplete: raw.autoComplete === undefined ? FOCUS_DEF.autoComplete : !!raw.autoComplete,
    };
  }
  async function focusSavePatch(patch) {
    S.settings.focus = Object.assign({}, S.settings.focus || {}, patch);
    await commitSettings();
    renderFocus();
  }
  function focusTask() { const id = S.ui.focus && S.ui.focus.taskId; return id ? byId(id) : null; }
  function focusRemainingMs(fa, now) { return Math.max(0, fa.pausedAt ? fa.endsAt - fa.pausedAt : fa.endsAt - now); }
  function focusElapsedMs(fa, now) {
    const start = fa.endsAt - fa.durMin * 60000;
    return Math.max(0, Math.min(fa.durMin * 60000, (fa.pausedAt || now) - start));
  }
  function focusLogAppend(t, now, min, completed) {
    if (min > 0) {
      t.focusTotal = (t.focusTotal || 0) + min;
      const log = (Array.isArray(t.focusLog) ? t.focusLog.slice() : []);
      log.push({ at: now, min });
      if (log.length > 128) log.splice(0, log.length - 128);
      t.focusLog = log;
    }
    if (completed) t.focusSessions = (t.focusSessions || 0) + 1;
  }
  async function focusStopQuiet(t) {
    if (!t || !t.focusActive) return;
    const fa = t.focusActive;
    if (fa.phase === 'focus') {
      const m = Math.round(focusElapsedMs(fa, Date.now()) / 60000);
      if (m > 0) focusLogAppend(t, Date.now(), m, false);
    }
    t.focusActive = null;
    if (S.ui.focus && S.ui.focus.taskId === t.id) S.ui.focus.taskId = null;
    await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
  }
  async function focusStart(taskId, workMin, breakMin) {
    const t = byId(taskId);
    if (!t) return;
    const c = focusCfg();
    const prev = focusTask();
    if (prev && prev.focusActive) await focusStopQuiet(prev); // ONE session at a time, always honest
    const now = Date.now();
    t.focusActive = { phase: 'focus', endsAt: now + workMin * 60000, pausedAt: null, durMin: workMin, breakMin, longMin: c.long, longEvery: c.longEvery };
    S.ui.focus.taskId = taskId;
    await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
    renderAll();
    focusTickOn();
    toast('🍅 Focus started — ' + workMin + ' minutes on \u201c' + truncate(t.title, 32) + '\u201d.');
  }
  async function focusStop() {
    const t = focusTask();
    if (!t || !t.focusActive) return;
    const fa = t.focusActive;
    let msg = '⏹ Focus stopped.';
    if (fa.phase === 'focus') {
      const m = Math.round(focusElapsedMs(fa, Date.now()) / 60000);
      msg = m > 0 ? '⏹ Stopped — you focused ' + m + ' minute' + (m === 1 ? '' : 's') + '.'
                  : '⏹ Stopped — no full minute yet, nothing logged.';
    }
    await focusStopQuiet(t);
    renderAll();
    toast(msg);
  }
  async function focusPauseToggle() {
    const t = focusTask();
    if (!t || !t.focusActive) return;
    const fa = t.focusActive;
    const now = Date.now();
    if (fa.pausedAt) { fa.endsAt += now - fa.pausedAt; fa.pausedAt = null; }
    else if (fa.endsAt - now > 0) fa.pausedAt = now;
    await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
    renderAll();
  }
  async function focusPhaseDone() {
    const t = focusTask();
    if (!t || !t.focusActive) return;
    const fa = t.focusActive;
    const now = Date.now();
    const c = focusCfg();
    if (fa.phase === 'focus') {
      const doneMin = fa.durMin;
      focusLogAppend(t, now, doneMin, true);
      const isLong = (t.focusSessions % fa.longEvery) === 0;
      const bmin = isLong ? fa.longMin : fa.breakMin;
      fa.phase = isLong ? 'long' : 'break';
      fa.durMin = bmin;
      fa.endsAt = now + bmin * 60000;
      fa.pausedAt = null;
      await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
      if (c.notify && window.ZTNotify) {
        ZTNotify.focusNotice('🍅 ' + doneMin + ' minutes focused',
          'Session on \u201c' + truncate(t.title, 40) + '\u201d done — take a ' + bmin + '-minute ' + (isLong ? 'long ' : '') + 'break.');
      }
      toast('🍅 ' + doneMin + ' minutes focused — ' + (isLong ? 'long break' : 'break') + ' ' + bmin + ' min.');
      if (c.autoComplete && t.status === 'active') await toggleTask(t.id); // the ONE explicit opt-in path
    } else {
      fa.phase = 'focus';
      fa.durMin = c.work; fa.breakMin = c.short; fa.longMin = c.long; fa.longEvery = c.longEvery;
      fa.endsAt = now + c.work * 60000;
      fa.pausedAt = null;
      await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
      if (c.notify && window.ZTNotify) {
        ZTNotify.focusNotice('☕ Break over', c.work + ' minutes back to \u201c' + truncate(t.title, 40) + '\u201d.');
      }
    }
    renderAll();
  }
  let focusTimer = null;
  function focusTickOn() {
    if (focusTimer) return;
    focusTimer = setInterval(() => {
      const t = focusTask();
      if (!t || !t.focusActive) { clearInterval(focusTimer); focusTimer = null; renderFocus(); return; }
      if (!t.focusActive.pausedAt && t.focusActive.endsAt - Date.now() <= 0) { focusPhaseDone(); return; }
      renderFocus();
    }, 1000);
  }
  function renderFocus() {
    if (!els.focusBar) return;
    const t = focusTask();
    const fa = t && t.focusActive;
    if (!fa) {
      if (!els.focusBar.hidden) { els.focusBar.hidden = true; els.focusBar.innerHTML = ''; }
      return;
    }
    const tot = Math.floor(focusRemainingMs(fa, Date.now()) / 1000);
    const clock = String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0');
    const phase = fa.phase === 'focus'
      ? '🍅 Focus · ' + esc(truncate(t.title, 40)) + (fa.pausedAt ? ' · paused' : '')
      : (fa.phase === 'long' ? '🌙 Long break' : '☕ Break') + ' · back to ' + esc(truncate(t.title, 28));
    els.focusBar.hidden = false;
    els.focusBar.innerHTML =
      '<span class="fz-phase">' + phase + '</span>' +
      '<b class="fz-time">' + clock + '</b>' +
      '<span class="fz-ctl">' +
      (fa.pausedAt
        ? '<button class="btn btn-sm btn-primary" data-fz="resume" type="button">Resume</button>'
        : '<button class="btn btn-sm btn-ghost" data-fz="pause" type="button">Pause</button>') +
      '<button class="btn btn-sm btn-ghost" data-fz="stop" type="button">Stop</button>' +
      '</span>';
  }
  function focusStartModal(taskId) {
    const t = byId(taskId);
    if (!t) return;
    const c = focusCfg();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal modal-focus';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.innerHTML =
      '<h3>🍅 Start Focus</h3>' +
      '<p class="modal-body muted small">' + esc(t.title) + (t.dueDate ? ' · due ' + esc(t.dueDate) : '') + (t.recurrence ? ' · ↻ recurring' : '') + '</p>' +
      '<div class="fz-presets">' +
        '<button type="button" class="btn btn-primary" data-fp="c">' + c.work + '/' + c.short + ' <small>settings</small></button>' +
        (c.work === 25 && c.short === 5 ? '' : '<button type="button" class="btn btn-ghost" data-fp="25/5">25/5</button>') +
        (c.work === 50 && c.short === 10 ? '' : '<button type="button" class="btn btn-ghost" data-fp="50/10">50/10</button>') +
        '<button type="button" class="btn btn-ghost" data-fp="custom">Custom…</button>' +
      '</div>' +
      '<div class="fz-custom" hidden>' +
        '<label>Work <input type="number" id="fzCustWork" min="1" max="180" step="1" value="' + c.work + '"> min</label>' +
        '<label>Break <input type="number" id="fzCustBreak" min="1" max="120" step="1" value="' + c.short + '"> min</label>' +
        '<button type="button" class="btn btn-sm btn-primary" data-fp="go">Start</button>' +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-fp="">Cancel</button></div>';
    ov.appendChild(card);
    const done = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') done(); };
    ov.addEventListener('click', (e) => {
      if (e.target === ov) { done(); return; }
      const b = e.target.closest('[data-fp]');
      if (!b) return;
      const pick = b.dataset.fp;
      if (!pick) { done(); return; }
      if (pick === 'c') { done(); focusStart(t.id, c.work, c.short); return; }
      if (pick === '25/5') { done(); focusStart(t.id, 25, 5); return; }
      if (pick === '50/10') { done(); focusStart(t.id, 50, 10); return; }
      if (pick === 'custom') {
        const cust = card.querySelector('.fz-custom');
        if (cust.hidden) { cust.hidden = false; const w = card.querySelector('#fzCustWork'); if (w) w.focus(); }
        return;
      }
      if (pick === 'go') {
        const w = Math.min(180, Math.max(1, Math.round(Number(card.querySelector('#fzCustWork').value)) || 25));
        const br = Math.min(120, Math.max(1, Math.round(Number(card.querySelector('#fzCustBreak').value)) || 5));
        done();
        focusStart(t.id, w, br);
      }
    });
    document.addEventListener('keydown', onKey, true);
    els.modalHost.appendChild(ov);
  }
  async function focusBoot() {
    const holders = S.tasks.filter((x) => x.focusActive);
    if (!holders.length) return;
    const now = Date.now();
    const c = focusCfg();
    const ops = [];
    let resumeId = null;
    let catchUp = null; // { min, title, taskId }
    for (const t of holders) {
      let changed = false;
      for (let i = 0; i < 24; i++) {
        const fa = t.focusActive;
        if (!fa || fa.pausedAt || fa.endsAt > now) break;
        changed = true;
        if (fa.phase === 'focus') {
          const doneMin = fa.durMin;
          focusLogAppend(t, fa.endsAt, doneMin, true);
          const isLong = (t.focusSessions % fa.longEvery) === 0;
          fa.phase = isLong ? 'long' : 'break';
          fa.durMin = isLong ? fa.longMin : fa.breakMin;
          fa.endsAt = fa.endsAt + fa.durMin * 60000;
          if (!catchUp) catchUp = { min: doneMin, title: t.title, taskId: t.id };
        } else {
          fa.phase = 'focus';
          fa.durMin = c.work;
          fa.endsAt = fa.endsAt + c.work * 60000;
        }
      }
      if (changed) ops.push({ store: STORES.tasks, op: 'put', value: t });
      if (t.focusActive && !t.focusActive.pausedAt && t.focusActive.endsAt > Date.now() && !resumeId) resumeId = t.id;
    }
    if (ops.length) await store.commit(ops);
    if (catchUp) {
      toast('🍅 Session completed while away — ' + catchUp.min + ' minutes focused on \u201c' + truncate(catchUp.title, 30) + '\u201d.');
      if (c.notify && window.ZTNotify) {
        ZTNotify.focusNotice('🍅 ' + catchUp.min + ' minutes focused', 'Your session on \u201c' + truncate(catchUp.title, 40) + '\u201d finished.');
      }
    }
    if (resumeId) { S.ui.focus.taskId = resumeId; focusTickOn(); }
    if (catchUp && c.autoComplete) {
      const at = byId(catchUp.taskId);
      if (at && at.status === 'active') await toggleTask(at.id);
    }
    renderAll();
  }

  /* ================================ Habits ==================================
     A habit is NOT a task, by design: it repeats forever (daily / weekly /
     selected days), can be checked off several times before the day's target
     is met, and has no due date — so it can never be "overdue". The record
     carries name/description/frequency/weekdays(0=Sun)/target/archived + a
     capped check-in history [{d:'YYYY-MM-DD', c}] as the SINGLE source of
     truth: streak, best and completion% are derived at render (habitStats),
     never stored, so nothing can drift out of sync with the history.
     Nudges reuse the REMINDER ENGINE: remReconcile keeps one pending row per
     habit in the reminders store (re-armed to the next due slot), and
     notify.js delivers through the existing reminder channel — zero new
     notification machinery. Dashboard mixing is opt-in: settings.habitsInStats. */

  function habitOf(id) { return (S.habits || []).find((h) => h.id === id) || null; }

  function ymdShift(ds, n) { const d = ymdParse(ds); d.setDate(d.getDate() + n); return ymd(d); }

  function habitDueOn(h, d) { // d: Date at local midnight
    if (h.frequency === 'daily' || h.frequency === 'weekly') return true;
    return h.weekdays.indexOf(d.getDay()) >= 0;
  }
  function habitCountOn(h, ds) { for (const e of h.history) if (e.d === ds) return e.c; return 0; }
  function habitMetOn(h, ds) { return habitCountOn(h, ds) >= h.target; }
  function habitWeekMon(ds) { const d = ymdParse(ds); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
  function habitWeekCount(h, monDs) {
    const endDs = ymdShift(monDs, 6);
    let c = 0;
    for (const e of h.history) if (e.d >= monDs && e.d <= endDs) c += e.c;
    return c;
  }
  function habitWeekMet(h, monDs) { return habitWeekCount(h, monDs) >= h.target; }

  /** Next local ms the habit's nudge should fire — or null (no nudge set).
   *  weekly habits nudge on Mondays (start-of-week), daily/selected-days on
   *  their due days; the time is the habit's remindTime. */
  function habitNextSlot(h, fromMs) {
    if (!h.remindTime) return null;
    const t0 = new Date(fromMs);
    for (let i = 0; i < 15; i++) {
      const d = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i);
      const anchor = h.frequency === 'weekly' ? d.getDay() === 1 : habitDueOn(h, d);
      if (!anchor) continue;
      const hm = h.remindTime.split(':').map(Number);
      d.setHours(hm[0], hm[1], 0, 0);
      if (d.getTime() > fromMs) return d.getTime();
    }
    return null;
  }

  /** {cur, best, pct, dueN} — always derived from history at render time.
   *  Streak rule mirrors the dashboard's: today (or the current week) still
   *  in progress does NOT break the run — it expires at midnight, not at
   *  breakfast. pct = met / due since creation over the last 730 days
   *  (days for daily/'days', weeks for weekly). */
  function habitStats(h, nowMs) {
    const now = nowMs || Date.now();
    const today = ymd(new Date(now));
    let cur = 0; let best = 0; let metN = 0; let dueN = 0;
    if (h.frequency === 'weekly') {
      const sums = {};
      for (const e of h.history) { const k = habitWeekMon(e.d); sums[k] = (sums[k] || 0) + e.c; }
      const startMon = habitWeekMon(ymd(new Date(h.createdAt)));
      const earliest = ymdShift(today, -363);
      const first = startMon < earliest ? earliest : startMon;
      const weeks = [];
      for (let m = (first < earliest ? earliest : first); m <= today; m = ymdShift(m, 7)) { weeks.push(habitWeekMon(m)); if (weeks.length > 60) break; }
      const list = [...new Set(weeks)];
      dueN = list.length;
      let run = 0;
      for (const w of list) {
        if ((sums[w] || 0) >= h.target) { run++; metN++; if (run > best) best = run; } else run = 0;
      }
      cur = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        if ((sums[list[i]] || 0) >= h.target) cur++;
        else if (i === list.length - 1 && today >= list[i]) continue; // current week in progress
        else break;
      }
    } else {
      const startD = ymd(new Date(h.createdAt));
      const floor = ymdShift(today, -729);
      let from = startD > floor ? startD : floor;
      const list = [];
      for (let d = from; d <= today; d = ymdShift(d, 1)) list.push(d);
      let run = 0;
      for (const ds of list) {
        if (h.frequency === 'days' && !habitDueOn(h, ymdParse(ds))) continue;
        dueN++;
        if (habitMetOn(h, ds)) { run++; metN++; if (run > best) best = run; } else run = 0;
      }
      cur = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const ds = list[i];
        if (h.frequency === 'days' && !habitDueOn(h, ymdParse(ds))) continue;
        if (habitMetOn(h, ds)) cur++;
        else if (ds === today) continue;
        else break;
      }
    }
    return { cur, best, pct: dueN ? Math.round((metN / dueN) * 100) : 0, dueN };
  }

  /** One check-in (+1) or undo (−1) on today, then persist. Reaching the
   * target flips the day to met; nothing here touches task stores. */
  async function habitBump(h, delta) {
    const now = Date.now();
    const ds = ymd(new Date(now));
    const i = h.history.findIndex((e) => e.d === ds);
    const c = (i >= 0 ? h.history[i].c : 0) + delta;
    if (i >= 0) { if (c > 0) h.history[i] = { d: ds, c }; else h.history.splice(i, 1); }
    else if (c > 0) { h.history.push({ d: ds, c }); h.history.sort((a, b) => (a.d < b.d ? -1 : 1)); }
    h.updatedAt = now;
    await store.commit([{ store: STORES.habits, op: 'put', value: h }]);
    await remReconcile(); // the nudge row may retire/re-arm as the target is met
    renderAll();
  }

  function habitFreqLabel(h) {
    if (h.frequency === 'daily') return h.target > 1 ? 'Daily ×' + h.target : 'Daily';
    if (h.frequency === 'weekly') return h.target > 1 ? h.target + '\u00d7/week' : 'Weekly';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return h.weekdays.map((d) => names[d]).join(' ') + (h.target > 1 ? ' ×' + h.target : '');
  }

  const HAB_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /** The brief's row: Mon ✓ Tue ✓ Wed ✓ … for the current week (Mon–Sun). */
  function habitWeekStrip(h, today) {
    const mon = habitWeekMon(today);
    let out = '';
    for (let i = 0; i < 7; i++) {
      const ds = ymdShift(mon, i);
      const d = ymdParse(ds);
      const isToday = ds === today;
      const future = ds > today;
      let cls; let mark;
      if (h.frequency === 'weekly') {
        const active = habitCountOn(h, ds) > 0;
        cls = active ? 'met' : (isToday ? 'todo' : ''); mark = active ? '✓' : '·';
      } else {
        const due = habitDueOn(h, d);
        const met = habitMetOn(h, ds);
        const partial = !met && habitCountOn(h, ds) > 0;
        if (met) { cls = 'met'; mark = '✓'; }
        else if (partial) { cls = 'part'; mark = String(habitCountOn(h, ds)); }
        else if (!due) { cls = 'off'; mark = '·'; }
        else if (future) { cls = 'future'; mark = '·'; }
        else if (isToday) { cls = 'todo'; mark = '·'; }
        else { cls = 'miss'; mark = '✗'; }
      }
      out += '<span class="hab-day ' + cls + (isToday ? ' today' : '') + '" title="' + ds + '">' +
        HAB_DAY_NAMES[i] + ' <b>' + mark + '</b></span>';
    }
    return out;
  }

  /** Calendar history: the current month as a Mon-first mini grid — ● met,
   *  ◐ partial (amber), ✗ missed due-day in the past (muted red), empty =
   *  nothing to do. Older months stay in the record (history is capped at
   *  730 entries) and still feed streak/best/percent. */
  function habitMonthCal(h, today, nowMs) {
    const base = ymdParse(today);
    const y = base.getFullYear(); const m = base.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const nDays = new Date(y, m + 1, 0).getDate();
    const title = new Date(y, m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let cells = HAB_DAY_NAMES.map((d) => '<span class="hab-cal-cell head">' + d[0] + '</span>').join('');
    for (let i = 0; i < lead; i++) cells += '<span class="hab-cal-cell empty"></span>';
    for (let day = 1; day <= nDays; day++) {
      const ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      const dObj = new Date(y, m, day);
      const c = habitCountOn(h, ds);
      let cls; let dot = '';
      if (h.frequency === 'weekly') { cls = c > 0 ? 'met' : ''; }
      else if (habitMetOn(h, ds)) { cls = 'met'; dot = '●'; }
      else if (c > 0) { cls = 'part'; dot = '◐'; }
      else if (!habitDueOn(h, dObj)) { cls = 'off'; }
      else if (ds > today) { cls = 'future'; }
      else { cls = 'miss'; dot = '✗'; }
      cells += '<span class="hab-cal-cell ' + cls + (ds === today ? ' today' : '') +
        '" title="' + ds + (c ? ' · ' + c + '/' + h.target : '') + '">' + day + (dot ? '<i>' + dot + '</i>' : '') + '</span>';
    }
    return '<div class="hab-cal"><div class="hab-cal-title">' + esc(title) +
      '</div><div class="hab-cal-grid">' + cells + '</div></div>';
  }

  function habitCardHtml(h, today, now, archived) {
    const st = habitStats(h, now);
    const isWeek = h.frequency === 'weekly';
    const cnt = isWeek ? habitWeekCount(h, habitWeekMon(today)) : habitCountOn(h, today);
    const done = cnt >= h.target;
    const per = isWeek ? 'this week' : 'today';
    return '<div class="hab-card' + (archived ? ' archived' : '') + (done ? ' done' : '') + '">' +
      '<div class="hab-top"><span class="hab-name">' + esc(h.name) + '</span>' +
      '<span class="hab-streak' + (st.cur > 0 ? ' hot' : '') + '">🔥 ' + st.cur + (st.cur === 1 ? ' day' : ' days') + '</span></div>' +
      (h.description ? '<div class="hab-desc">' + esc(truncate(h.description, 140)) + '</div>' : '') +
      '<div class="hab-stats"><span>' + esc(habitFreqLabel(h)) + '</span>' +
      '<span>Best ' + st.best + (st.best === 1 ? ' day' : ' days') + '</span>' +
      '<span>' + st.pct + '% done</span>' +
      '<span>' + (h.remindTime ? '⏰ ' + h.remindTime : '🔕 quiet') + '</span></div>' +
      '<div class="hab-week">' + habitWeekStrip(h, today) + '</div>' +
      '<div class="hab-actions"><span class="hab-count">' + cnt + '/' + h.target + ' ' + per + (done ? ' ✓' : '') + '</span>' +
      (archived ? '' : '<button type="button" class="btn btn-sm btn-primary" data-hact="plus" data-hid="' + esc(h.id) + '" title="One more completion today">✓ +1</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-hact="minus" data-hid="' + esc(h.id) + '"' + (cnt > 0 ? '' : ' disabled') + ' title="Undo one">−</button>') +
      '<button type="button" class="btn btn-sm btn-ghost" data-hact="edit" data-hid="' + esc(h.id) + '">✎ Edit</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-hact="' + (archived ? 'unarchive' : 'archive') + '" data-hid="' + esc(h.id) + '">' + (archived ? 'Unarchive' : 'Archive') + '</button></div>' +
      habitMonthCal(h, today, now) +
      '</div>';
  }

  function renderHabits() {
    if (!els.habitsHost) return;
    const now = Date.now();
    const today = ymd(new Date(now));
    const act = (S.habits || []).filter((h) => !h.archived);
    const arch = (S.habits || []).filter((h) => h.archived);
    let html = '<div class="hab-head"><h2>🔥 Habits</h2>' +
      '<button type="button" class="btn btn-primary" data-hact="new">＋ New habit</button></div>';
    html += '<p class="muted small">Repeating check-ins kept separate from one-time tasks. Hit ✓ every time you do it — the day is met when the target is reached. Stats only join the dashboard if you allow it in Settings.</p>';
    if (!act.length) html += '<div class="hab-empty">No habits yet. Try <i>Exercise</i>, <i>Read</i>, <i>Study Python</i>, <i>Practice IELTS</i>, or <i>Drink water ×8/day</i>.</div>';
    for (const h of act) html += habitCardHtml(h, today, now, false);
    if (arch.length) {
      html += '<button type="button" class="hab-arch-toggle" data-hact="togglearch">' +
        (S.ui.hab.showArch ? '▾' : '▸') + ' Archived (' + arch.length + ')</button>';
      if (S.ui.hab.showArch) for (const h of arch) html += habitCardHtml(h, today, now, true);
    }
    els.habitsHost.innerHTML = html;
  }

  /** Create/edit dialog — same modal-overlay contract as the rest of the app
   * (card appended to the overlay; click outside closes). */
  function habitModal(existing) {
    return new Promise((resolve) => {
      const editing = !!existing;
      const d = editing
        ? { name: existing.name, description: existing.description, frequency: existing.frequency, weekdays: existing.weekdays.slice(), target: existing.target, remind: !!existing.remindTime, remindTime: existing.remindTime || '09:00' }
        : { name: '', description: '', frequency: 'daily', weekdays: [1, 2, 3, 4, 5], target: 1, remind: false, remindTime: '09:00' };
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      ov.innerHTML = '<div class="modal-card hab-modal" role="dialog" aria-modal="true" aria-label="' + (editing ? 'Edit habit' : 'New habit') + '">' +
        '<h3>' + (editing ? 'Edit habit' : 'New habit') + '</h3>' +
        '<label>Name<input type="text" id="hh-name" maxlength="120" placeholder="e.g. Study Python" value="' + esc(d.name) + '"></label>' +
        '<label>Description<input type="text" id="hh-desc" maxlength="300" placeholder="optional" value="' + esc(d.description) + '"></label>' +
        '<label>Frequency<select id="hh-freq">' +
          '<option value="daily"' + (d.frequency === 'daily' ? ' selected' : '') + '>Daily</option>' +
          '<option value="weekly"' + (d.frequency === 'weekly' ? ' selected' : '') + '>Weekly (count completions toward one weekly target)</option>' +
          '<option value="days"' + (d.frequency === 'days' ? ' selected' : '') + '>Selected days</option>' +
        '</select></label>' +
        '<div id="hh-days" class="hab-days"' + (d.frequency === 'days' ? '' : ' hidden') + '>' +
          [0, 1, 2, 3, 4, 5, 6].map((i) => '<button type="button" class="rp-day' + (d.weekdays.indexOf(i) >= 0 ? ' on' : '') + '" data-d="' + i + '">' + names[i][0] + '</button>').join('') +
        '</div>' +
        '<label>Target per ' + '<span id="hh-per">' + (d.frequency === 'weekly' ? 'week' : 'day') + '</span><input type="number" id="hh-target" min="1" max="99" step="1" value="' + d.target + '"></label>' +
        '<label class="setting-row setting-check"><span>Nudge me (existing reminders engine)</span><input type="checkbox" id="hh-remind"' + (d.remind ? ' checked' : '') + '></label>' +
        '<label id="hh-remtime" class="setting-row"' + (d.remind ? '' : ' hidden') + '><span>At</span><input type="time" id="hh-remtime-i" value="' + d.remindTime + '"></label>' +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-hm="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-hm="save">' + (editing ? 'Save' : 'Create habit') + '</button></div></div>';
      const close = (saved) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(saved); };
      function onKey(e) { if (e.key === 'Escape') close(false); }
      document.addEventListener('keydown', onKey);
      const $ = (id) => ov.querySelector('#' + id);
      $('hh-freq').onchange = () => {
        d.frequency = $('hh-freq').value;
        $('hh-days').hidden = d.frequency !== 'days';
        $('hh-per').textContent = d.frequency === 'weekly' ? 'week' : 'day';
      };
      $('hh-days').onclick = (e) => {
        const b = e.target.closest('[data-d]'); if (!b) return;
        const i = Number(b.dataset.d);
        const at = d.weekdays.indexOf(i);
        if (at >= 0) d.weekdays.splice(at, 1); else d.weekdays.push(i);
        b.classList.toggle('on');
      };
      $('hh-remind').onchange = () => { $('hh-remtime').hidden = !$('hh-remind').checked; };
      ov.addEventListener('click', (e) => {
        const b = e.target.closest('[data-hm]');
        if (!b) { if (e.target === ov) close(false); return; }
        if (b.dataset.hm === 'cancel') { close(false); return; }
        const name = $('hh-name').value.trim();
        if (!name) { toast('Give the habit a name first.'); $('hh-name').focus(); return; }
        const freq = $('hh-freq').value;
        if (freq === 'days' && !d.weekdays.length) { toast('Pick at least one day — or switch to Daily.'); return; }
        const tgt = Math.round(Number($('hh-target').value));
        const remind = $('hh-remind').checked;
        const remTime = remind ? (/^([01]\d|2[0-3]):[0-5]\d$/.test($('hh-remtime-i').value) ? $('hh-remtime-i').value : '09:00') : null;
        const now = Date.now();
        const rec = {
          id: editing ? existing.id : helpers.uuid(),
          name, description: $('hh-desc').value.trim(),
          frequency: freq, weekdays: freq === 'days' ? d.weekdays.slice().sort((a, b2) => a - b2) : [],
          target: tgt >= 1 && tgt <= 99 ? tgt : 1,
          archived: editing ? !!existing.archived : false,
          remindTime: remTime,
          history: editing ? existing.history : [],
          createdAt: editing ? existing.createdAt : now,
          updatedAt: now,
        };
        if (editing) Object.assign(existing, rec);
        else S.habits.push(rec);
        store.commit([{ store: STORES.habits, op: 'put', value: editing ? existing : rec }]);
        close(true);
      });
      document.body.appendChild(ov);
      const inp = $('hh-name'); if (inp && !editing) inp.focus();
    });
  }

  async function onHabClick(e) {
    const b = e.target.closest('[data-hact]');
    if (!b) return;
    const act2 = b.dataset.hact;
    if (act2 === 'new') {
      if (await habitModal(null)) { await remReconcile(); renderAll(); toast('Habit created — check it off any day you do it.'); }
      return;
    }
    if (act2 === 'togglearch') { S.ui.hab.showArch = !S.ui.hab.showArch; renderAll(); return; }
    const h = habitOf(b.dataset.hid);
    if (!h) return;
    if (act2 === 'plus') { await habitBump(h, 1); return; }
    if (act2 === 'minus') { await habitBump(h, -1); return; }
    if (act2 === 'edit') { if (await habitModal(h)) { await remReconcile(); renderAll(); } return; }
    if (act2 === 'archive' || act2 === 'unarchive') {
      h.archived = act2 === 'archive';
      h.updatedAt = Date.now();
      await store.commit([{ store: STORES.habits, op: 'put', value: h }]);
      await remReconcile(); // archived → its nudge retires; unarchived → it re-arms
      renderAll();
      toast(h.archived
        ? 'Habit “' + truncate(h.name, 30) + '” archived — history kept, nudge silenced.'
        : 'Habit “' + truncate(h.name, 30) + '” is active again.');
    }
  }

  /* ================= Natural-language quick add (confirm-gated) =================
     ZTNL.parse() understands; this block only DISPLAYS the understanding. The
     “I understood” card has no write path: [Create task] pushes the values
     through the composer’s ONE existing submit pipeline (same validation, same
     reminder wiring, same draft cleanup), and [Edit] just fills the form for
     the user to fix and save. Ambiguous output therefore can never silently
     become a task — there is literally no other creation route from here. */
  let nlLast = null;
  function nlHide() { nlLast = null; if (els.nlCard) { els.nlCard.hidden = true; els.nlCard.innerHTML = ''; } }
  function nlProjectsForParse() {
    return (S.projects || []).filter((pr) => !pr.archived && !pr.deletedAt).map((pr) => ({ id: pr.id, name: pr.name }));
  }
  function nlUnderstand() {
    if (!window.ZTNL) { toast('Language parser module is missing.'); return; }
    const text = (els.nlInput && els.nlInput.value || '').trim();
    if (!text) { els.nlInput && els.nlInput.focus(); return; }
    nlLast = ZTNL.parse(text, { projects: nlProjectsForParse() });
    nlRender();
  }
  function nlRender() {
    if (!els.nlCard || !nlLast) return;
    const r = nlLast;
    const P_LABEL = { low: 'Low', med: 'Normal', high: 'High' };
    const item = (label, val, guessed) =>
      '<div class="nl-i"><span>' + label + '</span><b>' + val + (guessed ? ' <span class="nl-guessed">(guessed)</span>' : '') + '</b></div>';
    let html = '<div class="nl-head">' + (r.confidence === 'low' ? '⚠️ I understood — a few guesses, check me:' : '✓ I understood:') +
      '<span class="nl-via">local parser · nothing saved yet</span></div>';
    html += item('Task', esc(truncate(r.title, 120)));
    if (r.description) html += item('Description', esc(truncate(r.description, 160)));
    html += item('Date', r.dueDate ? esc(ZTNL.fmtDay(r.dueDate) || r.dueDate) + ' <small class="muted">(' + esc(r.dueDate) + ')</small>' : '<span class="muted">none — no due date</span>');
    html += item('Time', r.dueTime ? esc(ZTNL.fmtTime(r.dueTime)) + ' <small class="muted">(' + esc(r.dueTime) + ', your timezone)</small>' : '<span class="muted">any time</span>');
    html += item('Priority', P_LABEL[r.priority] || 'Normal');
    if (r.projectName) html += item('Project', esc(r.projectName));
    if (r.tags.length) html += item('Tags', r.tags.map((x) => '<span class="badge">#' + esc(x) + '</span>').join(' '));
    const rep = ZTNL.fmtRepeat(r);
    if (rep) html += item('Repeats', esc(rep));
    html += item('Reminder', r.remRows.length
      ? r.remRows.map((x) => esc((ZTNL.REM_LABEL[x.reminderType] || x.reminderType) + (x.reminderType === 'custom' && x.customTime ? ' @ ' + x.customTime : ''))).join(', ')
      : '<span class="muted">None</span>');
    if (r.notes.length) html += '<ul class="nl-notes">' + r.notes.map((n) => '<li>💡 ' + esc(n) + '</li>').join('') + '</ul>';
    html += '<div class="nl-foot">' +
      '<button type="button" class="btn btn-primary" data-nl="create"' + (r.title ? '' : ' disabled') + '>Create task</button>' +
      '<button type="button" class="btn btn-ghost" data-nl="edit">Edit</button>' +
      '<span class="nl-gap"></span><span class="nl-hint">or press Enter — I will never create without you</span>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-nl="close" aria-label="Dismiss">✕</button></div>';
    els.nlCard.className = 'nl-card' + (r.confidence === 'low' ? ' low' : '');
    els.nlCard.innerHTML = html;
    els.nlCard.hidden = false;
  }
  function nlPrefillFrom(r) {
    return {
      title: r.title || '',
      description: r.description || '',
      dueDate: r.dueDate || '',
      dueTime: r.dueTime || '',
      priority: r.priority || 'med',
      projectId: r.projectId || '',
      tags: r.tags || [],
      recurrence: r.recurrence || '',
      recurRule: r.recurRule || null,
      remRows: (r.remRows || []).map((x) => ({ reminderType: x.reminderType, customDate: x.customDate || '', customTime: x.customTime || '' })),
    };
  }

  /* ====================== AI task decomposition (review-gated) ======================
     The brief's contract, kept honest: the planner SUGGESTS structured steps and
     the task store is not touched — not one op — until the user presses
     “Add selected tasks” in this dialog. Every field of every suggestion is
     editable inline before that; unchecking simply leaves that step out. What
     gets created are ORDINARY tasks (plus advisory estMin/deps/⏱🔗 badges) —
     the AI never replaces or re-wires the task system. */

  function aiStepRow(s, i, steps) {
    const depChips = (s.dependsOn || []).filter((j) => steps[j]).map((j) =>
      '<span class="ai-dep-chip">#' + (j + 1) + ' ' + esc(truncate(steps[j].title || '?', 22)) +
      '<button type="button" data-ai="depdel" data-j="' + j + '" aria-label="Remove dependency">✕</button></span>').join('');
    const depOpts = steps.map((o, j) => (j !== i && String(o.title || '').trim()
      ? '<option value="' + j + '">#' + (j + 1) + ' ' + esc(truncate(o.title, 24)) + '</option>' : '')).join('');
    return '<div class="ai-step' + (s.checked ? '' : ' off') + '" data-airow="' + i + '">' +
      '<label class="ai-ck" title="Include this step"><input type="checkbox" data-ai="checked"' + (s.checked ? ' checked' : '') + '></label>' +
      '<div class="ai-fields">' +
        '<div class="ai-l1"><span class="ai-num">' + (i + 1) + '.</span>' +
        '<input class="ai-title" data-ai="title" value="' + esc(s.title) + '" maxlength="200" placeholder="Step title" aria-label="Title">' +
        '<input class="ai-est" type="number" data-ai="estMin" min="5" max="10080" step="5" value="' + s.estMin + '" title="Estimated minutes" aria-label="Estimated minutes"><span class="ai-unit">m</span>' +
        '<select data-ai="priority" title="Suggested priority" aria-label="Priority">' +
          ['low', 'med', 'high'].map((pp) => '<option value="' + pp + '"' + (s.priority === pp ? ' selected' : '') + '>' + pp + '</option>').join('') +
        '</select>' +
        '<input type="date" data-ai="dueDate" value="' + (s.dueDate || '') + '" title="Suggested due date — edit or clear it" aria-label="Due date">' +
        '</div>' +
        '<div class="ai-l2"><input class="ai-desc" data-ai="description" value="' + esc(s.description) + '" maxlength="500" placeholder="What “done” looks like" aria-label="Description">' +
        '<span class="ai-deps">' + depChips +
        '<select data-ai="depadd" title="Also start after…" aria-label="Add dependency"><option value="">+ after…</option>' + depOpts + '</select></span>' +
        '</div>' +
      '</div></div>';
  }

  function aiDecomposeModal(parent) {
    if (!window.ZTAI) { toast('AI planner module is missing.'); return; }
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card ai-modal';
    let D = null;
    let seed = 0;
    const footHtml = () => {
      if (!D) return '';
      const nSel = D.steps.filter((s) => s.checked).length;
      const allOn = nSel === D.steps.length;
      return '<button type="button" class="btn btn-ghost btn-sm" data-aim="all">' + (allOn ? '☐ Uncheck all' : '☑ Check all') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-aim="regen">✨ Regenerate</button>' +
        '<span class="ai-count muted small">' + nSel + ' of ' + D.steps.length + ' selected</span>' +
        '<span class="ai-gap"></span>' +
        '<button type="button" class="btn btn-ghost" data-aim="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-aim="add"' + (nSel ? '' : ' disabled') + '>Add selected tasks' + (nSel ? ' (' + nSel + ')' : '') + '</button>';
    };
    const renderFoot = () => { const f = card.querySelector('.ai-foot'); if (f) f.innerHTML = footHtml(); };
    const render = () => {
      if (!D) {
        card.innerHTML = '<h3>✨ AI suggestions</h3><p class="muted small ai-loading">Planning “' + esc(truncate(parent.title, 60)) + '”… ⏳</p>';
        return;
      }
      card.innerHTML =
        '<h3>✨ AI suggestions</h3>' +
        '<p class="muted small">For: <b>' + esc(truncate(parent.title, 70)) + '</b> · via ' + esc(D.engine || 'planner') + (D.model ? ' (' + esc(D.model) + ')' : '') +
        (D.playbook && D.playbook !== 'generic' ? ' · playbook: ' + esc(D.playbook) : '') +
        ' · edit anything — <b>nothing is added until you press “Add selected tasks”</b>.</p>' +
        '<div class="ai-body">' + D.steps.map((s, i) => aiStepRow(s, i, D.steps)).join('') + '</div>' +
        '<div class="ai-foot">' + footHtml() + '</div>';
    };
    const load = () => {
      D = null; render();
      ZTAI.decompose(parent, { mode: S.settings.aiMode === 'local' ? 'local' : 'auto', seed })
        .then((p) => {
          if (!p || !p.steps || !p.steps.length) { card.innerHTML = '<h3>✨ AI suggestions</h3><p class="muted small">The planner returned nothing usable — try again or add steps yourself.</p>'; return; }
          D = { engine: p.engine, model: p.model, playbook: p.playbook, steps: p.steps.map((s, i) => Object.assign({}, s, { checked: true, __gi: i })) };
          render();
        });
    };
    render();
    load();
    ov.appendChild(card);
    document.body.appendChild(ov);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
    document.addEventListener('keydown', onKey);
    card.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-ai]');
      if (!inp || !D) return;
      const row = inp.closest('[data-airow]');
      const s = D.steps[Number(row && row.dataset.airow)];
      if (!s) return;
      const f = inp.dataset.ai;
      if (f === 'title') s.title = inp.value;
      else if (f === 'description') s.description = inp.value;
      else if (f === 'estMin') { const v = Math.round(Number(inp.value)); if (Number.isFinite(v)) s.estMin = Math.min(10080, Math.max(5, v)); }
      else if (f === 'dueDate') s.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(inp.value) ? inp.value : null;
    });
    card.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-ai]');
      if (!inp || !D) return;
      const row = inp.closest('[data-airow]');
      const i = Number(row && row.dataset.airow);
      const s = D.steps[i];
      if (!s) return;
      const f = inp.dataset.ai;
      if (f === 'priority') { s.priority = inp.value; return; }
      if (f === 'checked') { s.checked = inp.checked; row.classList.toggle('off', !s.checked); renderFoot(); return; }
      if (f === 'depadd') {
        const j = Number(inp.value);
        if (inp.value !== '' && Number.isInteger(j) && j !== i && D.steps[j] && !s.dependsOn.includes(j)) s.dependsOn.push(j);
        render(); // structure changed (chips)
      }
    });
    card.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-ai="depdel"]');
      if (del && D) {
        const row = del.closest('[data-airow]');
        const s = D.steps[Number(row && row.dataset.airow)];
        if (s) { s.dependsOn = s.dependsOn.filter((j) => j !== Number(del.dataset.j)); render(); }
        return;
      }
      const b = e.target.closest('[data-aim]');
      if (!b) { if (e.target === ov) close(); return; }
      const m = b.dataset.aim;
      if (m === 'cancel') close();
      else if (m === 'all') { const allOn = D.steps.every((s) => s.checked); D.steps.forEach((s) => { s.checked = !allOn; }); render(); }
      else if (m === 'regen') { seed++; load(); }
      else if (m === 'add') { close(); await aiPlanAdd(parent, D); }
    });
  }

  /** Commit the APPROVED subset as ordinary tasks, in plan order, with the
   * dependency links re-pointed at the freshly created ids. This is the ONE
   * place the AI feature writes — only ever from the “Add selected tasks”
   * button. Unselected or titleless suggestions are simply not created. */
  async function aiPlanAdd(parent, D) {
    const sel = D.steps.filter((s) => s.checked);
    const cleaned = [];
    for (const s of sel) {
      const title = String(s.title || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!title) continue;
      cleaned.push(Object.assign({}, s, { title }));
    }
    if (!cleaned.length) { toast('Nothing to add — select at least one step with a title.'); return; }
    const now = Date.now();
    const ids = cleaned.map(() => helpers.uuid());
    const giToId = new Map(cleaned.map((s, i) => [s.__gi, ids[i]]));
    const minSoFar = S.tasks.reduce((m, x) => Math.min(m, x.sortOrder), S.tasks.length ? Infinity : 0);
    const base = Number.isFinite(minSoFar) ? minSoFar : 0;
    const ops = [];
    cleaned.forEach((s, i) => {
      const t = {
        id: ids[i], title: s.title,
        description: String(s.description || '').slice(0, 2000),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate || '') ? s.dueDate : null,
        dueTime: null,
        priority: ['low', 'med', 'high'].indexOf(s.priority) >= 0 ? s.priority : 'med',
        tags: [],
        projectId: parent.projectId || null,
        recurrence: null, recurRule: null, recurAnchor: null,
        status: 'active',
        estMin: s.estMin,
        deps: (s.dependsOn || []).map((g) => giToId.get(g)).filter(Boolean),
        aiOffer: false,
        sortOrder: base - (cleaned.length - i),
        createdAt: now + i, updatedAt: now,
      };
      S.tasks.push(t);
      ops.push({ store: STORES.tasks, op: 'put', value: t });
    });
    if (parent.aiOffer) {
      parent.aiOffer = false;
      parent.updatedAt = now;
      ops.push({ store: STORES.tasks, op: 'put', value: parent });
    }
    const okc = await store.commit(ops);
    renderAll();
    toast('✨ Added ' + cleaned.length + ' task' + (cleaned.length === 1 ? '' : 's') +
      ' from the breakdown — ordinary tasks now, edit anything as usual.' + (okc ? '' : ' (storage reported an error)'));
  }

  /* ------------------------- Productivity dashboard -------------------------
   * NOT a data source. Every tile, bar and row is derived at render time from
   * the same S.tasks / S.projects / S.reminders arrays the list and calendar
   * use; the dashboard itself never persists anything. Its two inputs that
   * were added WITH it — task.completedAt (last completion) and
   * task.completions (capped ledger, one entry per completion/roll) — live on
   * the task record like every other field: they ride commits, sync, trash,
   * restore, export and import for free.
   * -------------------------------------------------------------------------*/

  function mondayStart(nowMs) {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function dueInstant(t) {
    if (!t.dueDate) return null;
    const d = ymdParse(t.dueDate);
    if (t.dueTime) { const hm = String(t.dueTime).split(':'); d.setHours(Number(hm[0]) || 0, Number(hm[1]) || 0, 0, 0); }
    else d.setHours(23, 59, 59, 999); // all-day: overdue only once the day is over
    return d.getTime();
  }
  const dashStamps = (t) => (Array.isArray(t.completions) && t.completions.length ? t.completions : []);
  function pushCompletion(t, now) {
    const arr = (Array.isArray(t.completions) ? t.completions.slice() : []);
    arr.push(now);
    if (arr.length > 256) arr.splice(0, arr.length - 256); // bounded — no unbounded history
    t.completions = arr;
    t.completedAt = now;
  }

  function dashModel(nowMs) {
    const now = nowMs || Date.now();
    const today = ymd(new Date(now));
    const wkStart = mondayStart(now);
    const live = S.tasks; // trash excluded BY CONSTRUCTION — deleted rests; restore returns it
    const act = live.filter((t) => t.status !== 'completed');
    const done = live.filter((t) => t.status === 'completed');
    const over = act.filter((t) => { const di = dueInstant(t); return di !== null && di < now; });
    const overIds = new Set(over.map((t) => t.id));
    const dueTodayOpen = act.filter((t) => t.dueDate === today && !overIds.has(t.id));
    let completedToday = 0;
    const stampDays = new Set();
    const weekDays = {};
    for (let i = 0; i < 7; i++) weekDays[ymd(new Date(wkStart + i * 86400e3))] = 0;
    for (const t of live) {
      for (const ts of dashStamps(t)) {
        const ds = ymd(new Date(ts));
        if (ds === today) completedToday++;
        stampDays.add(ds);
        if (ts >= wkStart && weekDays[ds] !== undefined) weekDays[ds]++;
      }
    }
    // Habit check-ins live in a separate module — they touch dashboard
    // numbers ONLY when the user explicitly opts in (Settings → Habits).
    // They never enter overdue/backlog; only met days are mixed in.
    if (S.settings && S.settings.habitsInStats === true && Array.isArray(S.habits)) {
      const monDs = ymd(new Date(wkStart));
      for (const h of S.habits) {
        if (h.archived) continue;
        if (h.frequency === 'weekly') {
          if (habitWeekMet(h, monDs)) { stampDays.add(today); weekDays[today]++; completedToday++; }
        } else {
          for (const e of h.history) {
            if (e.c < h.target) continue;
            stampDays.add(e.d);
            if (weekDays[e.d] !== undefined) weekDays[e.d]++;
            if (e.d === today) completedToday++;
          }
        }
      }
    }
    let completedWeek = 0;
    for (const k in weekDays) completedWeek += weekDays[k];
    const createdWeek = live.filter((t) => Number(t.createdAt) >= wkStart).length;
    // Streak: consecutive days with ≥1 completion, counted back from today.
    // A day still in progress (nothing done yet today) does not break the
    // run — it expires at midnight, not at breakfast.
    let streak = 0;
    {
      const cur = new Date(now);
      if (!stampDays.has(today)) cur.setDate(cur.getDate() - 1);
      for (;;) { const ds = ymd(cur); if (!stampDays.has(ds)) break; streak++; cur.setDate(cur.getDate() - 1); }
    }
    // Today's board, one bucket per task (priority order): overdue first,
    // then high-priority (due today or unscheduled), then the rest of
    // today, then the dateless backlog. A high task due tomorrow is
    // tomorrow's problem — it belongs to Upcoming instead.
    const g = { overdue: [], high: [], scheduled: [], unscheduled: [] };
    for (const t of act) {
      if (overIds.has(t.id)) g.overdue.push(t);
      else if (t.priority === 'high' && (!t.dueDate || t.dueDate === today)) g.high.push(t);
      else if (t.dueDate === today) g.scheduled.push(t);
      else if (!t.dueDate) g.unscheduled.push(t);
    }
    g.overdue.sort((a, b) => (dueInstant(a) || 0) - (dueInstant(b) || 0));
    const denom = completedToday + dueTodayOpen.length + over.length;
    const pct = denom ? Math.round((completedToday / denom) * 100) : 0;
    const upcoming = act.filter((t) => t.dueDate && t.dueDate > today)
      .sort((a, b) => (dueInstant(a) || 0) - (dueInstant(b) || 0)).slice(0, 5);
    const rem = S.reminders
      .filter((r) => r.status === 'pending' && r.enabled !== false && byId(r.taskId))
      .sort((a, b) => a.triggerAt - b.triggerAt);
    const rate = done.length + act.length ? Math.round((done.length / (done.length + act.length)) * 100) : null;
    let focusMin = 0;
    let focusSessions = 0;
    let focusWeek = 0;
    const projFocus = {};
    const taskFocus = [];
    for (const t of live) {
      focusMin += Number(t.focusTotal) || 0;
      focusSessions += Number(t.focusSessions) || 0;
      for (const e of (Array.isArray(t.focusLog) ? t.focusLog : [])) if (e.at >= wkStart) focusWeek += e.min;
      if (t.projectId && (t.focusTotal || 0) > 0) projFocus[t.projectId] = (projFocus[t.projectId] || 0) + t.focusTotal;
      if ((t.focusTotal || 0) > 0) taskFocus.push({ title: t.title, min: t.focusTotal });
    }
    taskFocus.sort((a, b) => b.min - a.min);
    return { now, today, wkStart, completedToday, dueTodayOpen, over, g, denom, pct, streak,
      completedWeek, createdWeek, upcoming, rem, doneCount: done.length, rate, weekDays,
      focusMin, focusSessions, focusWeek, projFocus, taskFocus };
  }

  function dashRel(ms) {
    if (ms <= 0) return 'now';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'in <1 min';
    if (min < 90) return 'in ' + min + (min === 1 ? ' minute' : ' minutes');
    const h = Math.floor(min / 60);
    if (h < 24) return 'in ' + h + ' h ' + (min % 60) + ' min';
    return 'in ' + Math.round(h / 24) + ' days';
  }
  function dashDayLabel(ds, nowMs) {
    if (ds === ymd(new Date(nowMs))) return 'Today';
    const tm = new Date(nowMs); tm.setDate(tm.getDate() + 1);
    if (ds === ymd(tm)) return 'Tomorrow';
    return ymdParse(ds).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function renderDashboard() {
    if (!els.dashHost) return;
    const m = dashModel();
    const now = m.now;
    const h24 = new Date(now).getHours();
    const greet = h24 < 5 ? 'Good night' : h24 < 12 ? 'Good morning' : h24 < 17 ? 'Good afternoon' : h24 < 21 ? 'Good evening' : 'Good night';
    const dateLine = new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const tile = (n, label, cls) => '<div class="dash-tile' + (cls ? ' ' + cls : '') + '"><b>' + n + '</b><span>' + label + '</span></div>';

    const drow = (t, tag) =>
      '<div class="dash-row" data-drow="' + esc(t.id) + '">' +
      '<button class="dash-check" type="button" data-dact="done" aria-label="Complete" title="' +
        (t.recurrence ? 'Complete this occurrence — rolls to the next date' : 'Complete') + '">✓</button>' +
      '<button class="dash-fzbtn" type="button" data-dact="focus" aria-label="Start focus session" title="Start Focus — Pomodoro on this task">🍅</button>' +
      '<span class="dash-rtitle">' + esc(truncate(t.title, 52)) + '</span>' +
      '<span class="dash-rmeta">' + (tag ? '<b class="' + tag + '">' + (tag === 'late' ? 'overdue' : 'high') + '</b>' : '') +
      (t.dueDate ? '<span>' + esc(((formatDue(t.dueDate, false) || {}).txt) || t.dueDate) + (t.dueTime ? ' ' + esc(t.dueTime) : '') + '</span>' : '') +
      (t.recurrence ? '<span title="' + esc(recurLabel(t)) + '">↻</span>' : '') +
      '</span></div>';
    const groupSec = (name, list, cls, empty) =>
      '<div class="dash-gname' + (cls ? ' ' + cls : '') + '">' + name + (list.length ? ' · ' + list.length : '') + '</div>' +
      (list.length ? list.map((t) => drow(t, cls === 'overdue' ? 'late' : cls === 'high' ? 'hp' : '')).join('') : (empty || ''));
    const todayCard =
      groupSec('Overdue', m.g.overdue, 'overdue', '<div class="dash-empty">Nothing overdue — you are keeping up.</div>') +
      groupSec('High priority', m.g.high, 'high', '') +
      groupSec('Scheduled for today', m.g.scheduled, '', '') +
      groupSec('Unscheduled', m.g.unscheduled, '', '<div class="dash-empty">No dateless backlog.</div>');
    const hasToday = m.g.overdue.length + m.g.high.length + m.g.scheduled.length + m.g.unscheduled.length;

    const BLOCKS = 16;
    const filled = Math.round((m.pct / 100) * BLOCKS);
    const progCard =
      '<div class="dash-prog" aria-label="' + m.pct + ' percent complete">' +
      '\u2588'.repeat(filled) + '\u2591'.repeat(BLOCKS - filled) + ' ' + m.pct + '%</div>' +
      (m.denom ? '<div class="dash-prog-num">' + m.completedToday + ' / ' + m.denom + ' completed</div>'
               : '<div class="dash-prog-num">Nothing scheduled today — the day is wide open 🌿</div>');

    const hm = (mins) => (mins >= 60 ? (Math.round(mins / 6) / 10) + ' h' : mins + ' min');
    const projNames = {};
    for (const p of (S.projects || [])) projNames[p.id] = p.name;
    const focusCard = (m.focusMin || m.focusSessions)
      ? ('<div class="dash-stats"><div class="dash-stat"><b>' + hm(m.focusMin) + '</b><span>total focus time</span></div>' +
         '<div class="dash-stat"><b>' + m.focusSessions + '</b><span>session' + (m.focusSessions === 1 ? '' : 's') + ' completed</span></div>' +
         '<div class="dash-stat"><b>' + hm(m.focusWeek) + '</b><span>this week</span></div></div>' +
         (Object.keys(m.projFocus).length
           ? '<div class="dash-gname">By project</div>' + Object.keys(m.projFocus)
               .map((pid) => '<div class="dash-rrow"><span class="dash-rtitle">' + esc(truncate(projNames[pid] || 'a project', 30)) + '</span><span class="when2">' + hm(m.projFocus[pid]) + '</span></div>').join('')
           : '') +
         (m.taskFocus.length
           ? '<div class="dash-gname">Most focused tasks</div>' + m.taskFocus.slice(0, 3)
               .map((x) => '<div class="dash-rrow"><span class="dash-rtitle">' + esc(truncate(x.title, 34)) + '</span><span class="when2">' + hm(x.min) + '</span></div>').join('')
           : ''))
      : '<div class="dash-empty">No focus sessions yet — hit 🍅 on any task (25/5 from Settings → Focus).</div>';
    const stat = (label, value) => '<div class="dash-stat"><b>' + value + '</b><span>' + label + '</span></div>';
    const statsCard =
      stat('completed today', m.completedToday) + stat('completed this week', m.completedWeek) +
      stat('created this week', m.createdWeek) + stat('overdue', m.over.length) +
      stat('completion rate', m.rate === null ? '—' : m.rate + '%') +
      stat('current streak', m.streak + (m.streak === 1 ? ' day' : ' days'));

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(m.wkStart + i * 86400e3);
      const ds = ymd(d);
      days.push({ ds, n: m.weekDays[ds] || 0, lbl: 'MTWTFSS'[(d.getDay() + 6) % 7], today: ds === m.today });
    }
    const maxN = Math.max(1, ...days.map((d) => d.n));
    const chartCard = '<div class="dash-chart">' + days.map((d) =>
      '<div class="dash-col' + (d.today ? ' today' : '') + '" title="' +
      ymdParse(d.ds).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' — ' + d.n + ' completed">' +
      '<span class="dash-cn">' + d.n + '</span>' +
      '<div class="dash-bar" style="height:' + (d.n ? Math.max(8, Math.round((d.n / maxN) * 72)) : 2) + 'px"></div>' +
      '<span class="dash-cl">' + d.lbl + '</span></div>').join('') + '</div>';

    const pj = (S.projects || []).filter((p) => p.status !== 'completed');
    const projCard = pj.length ? pj.map((p) => {
      const inP = S.tasks.filter((x) => x.projectId === p.id);
      const dn = inP.filter((x) => x.status === 'completed').length;
      const pc = inP.length ? Math.round((dn / inP.length) * 100) : 0;
      return '<div class="dash-prow"><span class="dash-picon">' + esc(p.icon || '📁') + '</span>' +
        '<span class="dash-rtitle">' + esc(truncate(p.name, 26)) + '</span>' +
        '<span class="dash-mbar"><i style="width:' + pc + '%"></i></span><span class="dash-pn">' + dn + '/' + inP.length + '</span></div>';
    }).join('') : '<div class="dash-empty">No active projects yet — group related tasks in the composer.</div>';

    const upCard = m.upcoming.length ? m.upcoming.map((t) =>
      '<div class="dash-row" data-drow="' + esc(t.id) + '"><span class="dash-when">' + esc(dashDayLabel(t.dueDate, now)) + '</span>' +
      '<span class="dash-rtitle">' + esc(truncate(t.title, 44)) + '</span><span class="dash-rmeta">' +
      (t.dueTime ? '<span>' + esc(t.dueTime) + '</span>' : '') + (t.recurrence ? '<span title="' + esc(recurLabel(t)) + '">↻</span>' : '') +
      '</span></div>').join('') : '<div class="dash-empty">Nothing on the horizon beyond today 🌤️</div>';

    const REM_LBL = {};
    for (const [k, v] of REM_TYPE_LABELS) REM_LBL[k] = v;
    const next = m.rem.find((r) => r.triggerAt > now) || m.rem[0] || null;
    const remCard = next
      ? ('<div class="dash-next"><span class="k">Next reminder</span><br>' +
         '<b>' + esc((byId(next.taskId) || {}).title || 'a task') + '</b> <span class="when">' + dashRel(next.triggerAt - now) + '</span>' +
         '<div class="lead">' + esc(REM_LBL[next.reminderType] || 'custom time') + (next.triggerAt <= now ? ' — it is due now' : '') + '</div></div>' +
        (m.rem.length > 1 ? m.rem.slice(1, 5).map((r) =>
          '<div class="dash-rrow"><span class="dash-rtitle">' + esc(truncate((byId(r.taskId) || {}).title || '', 40)) + '</span>' +
          '<span class="when2">' + dashRel(r.triggerAt - now) + '</span></div>').join('') : ''))
      : '<div class="dash-empty">No reminders armed — add lead times on any task.</div>';

    els.dashHost.innerHTML =
      '<div class="dash-hero">' +
        '<div class="dash-hero-row"><div><div class="dash-greet">' + greet + '</div>' +
        '<div class="dash-date">' + esc(dateLine) + '</div></div>' +
        '<div class="dash-streak' + (m.streak > 0 ? ' hot' : '') + '" title="Consecutive days with at least one completion">' +
        (m.streak > 0 ? '🔥 ' + m.streak + '-day streak' : 'no streak yet — check something off today') + '</div></div>' +
        '<div class="dash-tiles">' +
          tile(m.completedToday, 'completed today') +
          tile(m.dueTodayOpen.length, 'remaining today') +
          tile(m.over.length, 'overdue', m.over.length ? 'warn' : '') +
          tile(m.streak, 'current streak', m.streak ? 'hot' : '') +
        '</div>' +
      '</div>' +
      '<div class="dash-card dash-today"><h3>Today</h3>' +
        (hasToday ? todayCard : '<div class="dash-empty">Nothing on today\u2019s board. New task from the composer, or browse the unscheduled backlog below.</div>') +
      '</div>' +
      '<div class="dash-card"><h3>Today\u2019s Progress</h3>' + progCard + '</div>' +
      '<div class="dash-card"><h3>Focus</h3>' + focusCard + '</div>' +
      '<div class="dash-card"><h3>Statistics</h3><div class="dash-stats">' + statsCard + '</div></div>' +
      '<div class="dash-card"><h3>This week — completions by day</h3>' + chartCard + '</div>' +
      '<div class="dash-card"><h3>Projects</h3>' + projCard + '</div>' +
      '<div class="dash-card"><h3>Upcoming</h3>' + upCard + '</div>' +
      '<div class="dash-card"><h3>Reminders</h3>' + remCard + '</div>';
  }

  function wireDashboard() {
    els.dashBtn.onclick = () => {
      S.ui.dash.open = !S.ui.dash.open;
      if (S.ui.dash.open) { S.ui.cal.open = false; S.ui.hab.open = false; } // the overlays are exclusive
      renderAll();
      if (S.ui.dash.open) {
        els.dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Aging matters here ("in 42 min"): refresh quietly while it is open.
        if (!S.ui.dash.timer) S.ui.dash.timer = setInterval(() => { if (S.ui.dash.open) renderDashboard(); }, 60000);
      }
    };
    els.dashHost.addEventListener('click', (e) => {
      const fz = e.target.closest('[data-dact="focus"]');
      if (fz) { const h = fz.closest('[data-drow]'); if (h) focusStartModal(h.getAttribute('data-drow')); return; }
      const chk = e.target.closest('[data-dact="done"]');
      if (chk) { const host = chk.closest('[data-drow]'); if (host) toggleTask(host.getAttribute('data-drow')); return; }
      const rw = e.target.closest('[data-drow]');
      if (rw && byId(rw.getAttribute('data-drow'))) openComposer({ mode: 'edit', taskId: rw.getAttribute('data-drow') });
    });
  }

  /* --------------------------- Filters & search --------------------------- */

  async function setFilterMode(m) {
    if (S.settings.filterMode === m) return;
    S.settings.filterMode = m;
    await store.commit([]); // meta-only write (keeps backup + other tabs in sync)
    renderAll();
  }

  async function setFilterTag(tag) {
    S.settings.filterTag = tag;
    await store.commit([]);
    renderAll();
  }

  /* ------------------------------- Settings ------------------------------- */

  async function commitSettings() {
    await store.commit([]); // writes meta (settings + savedAt) and mirrors
  }

  /* ----------------------------- Export / import -------------------------- */

  function downloadRaw(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportNow() {
    try {
      downloadRaw(store.exportData(), 'zerotodo-backup-' + stamp() + '.json');
      S.settings.lastExportDate = Date.now();
      commitSettings();
      dismissBanner('export-reminder');
      toast('Backup downloaded — keep it somewhere safe.');
    } catch (e) {
      showBanner({ kind: 'error', message: 'Export failed: ' + (e && e.message ? e.message : e) });
    }
  }

  async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (_) {
      showBanner({ kind: 'error', message: 'Import failed: that file is not valid JSON.' });
      return;
    }
    const v = helpers.validatePayload(data);
    if (!v.ok) {
      showBanner({ kind: 'error', message: 'Import failed: that file does not look like a ZeroTodo backup (no valid tasks array).' });
      return;
    }
    let migrated;
    try {
      migrated = helpers.migratePayload({
        schemaVersion: v.schemaVersion, tasks: v.tasks,
        trash: v.trash, projects: v.projects, subtasks: v.subtasks,
        reminders: v.reminders, habits: v.habits, settings: v.settings || {},
      });
    } catch (e) {
      showBanner({ kind: 'error', message: 'Import failed: data migration error — ' + e.message });
      return;
    }
    const clean = helpers.cleanPayload(migrated);

    const haveLive = S.tasks.length;
    const haveTrash = S.trash.length;
    if (haveLive + haveTrash > 0) {
      const ok = await confirmDialog({
        title: 'Replace current data?',
        body: 'The file contains ' + clean.tasks.length + ' task(s)' +
          (clean.trash.length ? ' and ' + clean.trash.length + ' trashed item(s)' : '') +
          '.\n\nThis browser currently has ' + haveLive + ' task(s) and ' + haveTrash + ' in trash. Importing replaces everything. A safety copy of your current data will be downloaded first.',
        confirmLabel: 'Download safety copy, then import',
        danger: true,
      });
      if (!ok) return;
      try { downloadRaw(store.exportData(), 'zerotodo-pre-import-' + stamp() + '.json'); }
      catch (_) { /* best effort */ }
    }

    // Adopt the imported dataset, then make disk converge to it (full
    // read-modify-write resync: put all, delete orphans, mirror, broadcast).
    store.replaceMemory(clean.tasks, clean.trash, clean.projects, clean.subtasks, clean.reminders, clean.habits);
    // Local settings (theme, reminder cadence) are device preferences — keep
    // them; the imported tasks/trash replace ours entirely.
    const okc = await store.resync();
    if (S.settings.filterTag && !allTags().some(([t]) => t === S.settings.filterTag)) S.settings.filterTag = null;
    if (S.settings.filterProject && !S.projects.some((p) => p.id === S.settings.filterProject && !p.deletedAt)) {
      S.settings.filterProject = null;
      S.ui.projectView = null;
    }
    renderAll();
    if (okc) toast('Imported ' + clean.tasks.length + ' task(s) from “' + file.name + '”.');
  }

  /* --------------------------- Backup reminder ---------------------------- */

  function checkExportReminder() {
    const days = Number(S.settings.exportReminderDays) || 0;
    if (!days) return;
    if (!S.tasks.length && !S.trash.length) return; // nothing to back up yet
    const last = Math.max(S.settings.lastExportDate || 0, S.settings.lastReminderDismissedAt || 0);
    if (Date.now() - last >= days * DAY_MS) {
      showBanner({
        kind: 'info', id: 'export-reminder', sticky: true,
        message: 'It has been a while since your last backup export. Download a backup JSON file so you always have an off-browser copy — it also protects you if you clear site data.',
        actions: [
          { label: 'Export now', primary: true, fn: exportNow },
          {
            label: 'Not now',
            fn: () => {
              S.settings.lastReminderDismissedAt = Date.now();
              commitSettings();
              dismissBanner('export-reminder');
            },
          },
        ],
      });
    }
  }

  /* -------------------------------- Events -------------------------------- */

  function wireEvents() {
    // New task / cancel
    els.newTaskBtn.onclick = () => {
      if (S.ui.composerOpen) { els.fTitle.focus(); return; }
      // If a draft from a previous session exists, pick it up automatically.
      const d = readDraftFromDisk();
      openComposer({ mode: 'new' }, d && d.kind === 'new' ? d : null);
    };
    els.cancelTaskBtn.onclick = () => closeComposer(); // draft stays on disk

    // Composer input → debounced draft autosave
    for (const el of [els.fTitle, els.fDesc, els.fDue, els.fTime, els.fRecurrence, els.fPriority, fProjectSelect(), els.fTags]) {
      el.addEventListener('input', () => {
        el.classList.remove('invalid');
        scheduleDraft();
      });
    }
    els.taskForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveTask();
    });
    if (els.nlParseBtn) els.nlParseBtn.addEventListener('click', () => nlUnderstand());
    if (els.nlInput) els.nlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); nlUnderstand(); } // NEVER submit the form raw
    });
    if (els.nlCard) els.nlCard.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nl]');
      if (!b || !nlLast) return;
      const a = b.dataset.nl;
      if (a === 'close') { nlHide(); return; }
      if (a === 'edit') {
        const keep = els.nlInput.value;
        openComposer({ mode: 'new' }, nlPrefillFrom(nlLast));
        els.nlInput.value = keep;
        els.fTitle.focus();
        toast('Applied to the form below — fix anything, then press “Add task”.');
        return;
      }
      if (a === 'create') {
        const r = nlLast;
        openComposer({ mode: 'new' }, nlPrefillFrom(r));
        nlHide();
        els.nlInput.value = '';
        // the ONE creation path: the composer’s own submit, with its validation
        els.taskForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    // If the tab dies while typing, flush the draft synchronously.
    window.addEventListener('pagehide', () => {
      if (S && S.ui.composerOpen) {
        const d = currentDraft();
        if (d) { try { localStorage.setItem(LS_DRAFT_KEY, JSON.stringify(d)); } catch (_) {} }
      }
    });

    // Draft resume pill
    els.draftResumeBtn.onclick = resumeDraft;
    els.draftDiscardBtn.onclick = () => { clearDraft(); dismissBanner('draft'); };

    // Search (UI-only filter, not persisted)
    els.searchInput.addEventListener('input', () => {
      S.ui.search = els.searchInput.value;
      renderList();
    });

    // Filter tabs
    els.filterTabs.addEventListener('click', (e) => {
      const b = e.target.closest('.filter-btn');
      if (b) setFilterMode(b.dataset.mode);
    });

    // Tag chips (toolbar row + per-task chips)
    els.tagChips.addEventListener('click', (e) => {
      const c = e.target.closest('.tag-chip');
      if (c) setFilterTag(S.settings.filterTag === c.dataset.tag ? null : c.dataset.tag);
    });

    // Projects: quick-switch bar + detail header (markup rendered in renderProjects)
    els.projectBar.addEventListener('click', onProjectBarClick);
    els.projectDetail.addEventListener('click', onProjectDetailClick);

    // Task list: click actions
    // recurrence controls in the composer
    els.fRecurrence.addEventListener('change', () => {
      if (els.fRecurrence.value === 'custom' && !S.ui.recurPanel) S.ui.recurPanel = { every: 1, unit: 'week', weekdays: [] };
      renderRecurPanel();
      scheduleDraft();
    });
    if (els.rcEvery) els.rcEvery.addEventListener('input', () => {
      const n = Math.max(1, Math.min(99, Math.floor(Number(els.rcEvery.value) || 1)));
      if (S.ui.recurPanel) S.ui.recurPanel.every = n;
      updateRecurHint(); scheduleDraft();
    });
    if (els.rcUnit) els.rcUnit.addEventListener('change', () => {
      if (S.ui.recurPanel) S.ui.recurPanel.unit = els.rcUnit.value;
      renderRecurPanel(); scheduleDraft();
    });
    if (els.rcDays) els.rcDays.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rday]');
      if (!b || !S.ui.recurPanel) return;
      const d = Number(b.dataset.rday);
      const arr = S.ui.recurPanel.weekdays;
      const i = arr.indexOf(d);
      if (i >= 0) arr.splice(i, 1); else arr.push(d);
      renderRecurPanel(); scheduleDraft();
    });
    if (els.fDue) els.fDue.addEventListener('input', updateRecurHint);

    els.taskList.addEventListener('click', (e) => {
      const prow = e.target.closest('.project-row');
      if (prow) {
        const pid = prow.dataset.pid;
        const b = e.target.closest('button');
        if (b && b.dataset.act === 'restore') restoreProject(pid);
        else if (b && b.dataset.act === 'destroy') destroyProjectForever(pid);
        return;
      }
      const prj = e.target.closest('.proj-ref');
      if (prj) { openProject(prj.dataset.pid); return; }
      const chip = e.target.closest('.chip');
      if (chip) { setFilterTag(S.settings.filterTag === chip.dataset.tag ? null : chip.dataset.tag); return; }
      const li = e.target.closest('.task');
      if (!li) return;
      const id = li.dataset.id;
      const sbtn = e.target.closest('[data-sact]');
      if (sbtn) { if (S.settings.filterMode !== 'trash') handleSubAction(sbtn, li); return; }
      const inTrash = S.settings.filterMode === 'trash';
      const btn = e.target.closest('button');

      if (inTrash) {
        if (!btn) return;
        if (btn.dataset.act === 'restore') restoreTask(id);
        else if (btn.dataset.act === 'destroy') destroyTask(id);
        return;
      }
      if (btn && btn.dataset.act === 'toggle') { toggleTask(id); return; }
      if (btn && btn.dataset.act === 'up') { moveVisible(id, -1); return; }
      if (btn && btn.dataset.act === 'down') { moveVisible(id, 1); return; }
      if (btn && btn.dataset.act === 'edit') { openComposer({ mode: 'edit', taskId: id }); return; }
      if (btn && btn.dataset.act === 'delete') { deleteTask(id); return; }
      if (btn && btn.dataset.act === 'series') { const tt = byId(id); if (tt) seriesDialog(tt).then((a) => onSeriesAction(a, tt)); return; }
      if (btn && btn.dataset.act === 'focus') { focusStartModal(id); return; }
      if (btn && btn.dataset.act === 'aidec') { const tt = byId(id); if (tt) aiDecomposeModal(tt); return; }
      // Clicking the task body opens the editor
      if (e.target.closest('.task-main')) openComposer({ mode: 'edit', taskId: id });
    });

    // Drag-and-drop reordering (desktop; ↑/↓ buttons cover touch devices)
    els.taskList.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.drag-handle');
      const li = handle && handle.closest('.task');
      if (li) li.setAttribute('draggable', 'true');
    });
    document.addEventListener('mouseup', () => {
      els.taskList.querySelectorAll('.task[draggable]').forEach((li) => li.removeAttribute('draggable'));
    });
    els.taskList.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('.task');
      if (!li) return;
      li.dataset.dragId = li.dataset.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch (_) {}
    });
    els.taskList.addEventListener('dragover', (e) => {
      const dragging = els.taskList.querySelector('.dragging');
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = getDragAfterElement(e.clientY);
      if (after == null) {
        if (els.taskList.lastElementChild !== dragging) els.taskList.appendChild(dragging);
      } else if (after !== dragging) {
        els.taskList.insertBefore(dragging, after);
      }
    });
    els.taskList.addEventListener('drop', (e) => e.preventDefault());
    els.taskList.addEventListener('dragend', () => {
      const dragging = els.taskList.querySelector('.dragging');
      if (!dragging) return;
      const ids = [...els.taskList.querySelectorAll('.task')].map((li) => li.dataset.id);
      dragging.classList.remove('dragging');
      applyNewOrder(ids);
    });

    // Subtask inline inputs: Enter saves, Escape cancels (no modal needed)
    els.taskList.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('sub-add-input')) {
        if (e.key === 'Enter') { e.preventDefault(); addSubtask(e.target.dataset.parent, e.target.value); }
        return;
      }
      if (e.target.classList.contains('sub-edit-input')) {
        if (e.key === 'Enter') { e.preventDefault(); renameSubtask(e.target.dataset.sid, e.target.value); }
        else if (e.key === 'Escape') { e.preventDefault(); S.ui.subEditing = null; renderList(); }
      }
    });

    // Header actions
    els.exportBtn.onclick = exportNow;
    els.importBtn.onclick = () => els.importFile.click();
    els.importFile.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importFile(file);
    });

    // Theme quick toggle (light ⇄ dark; 'auto' selectable in settings)
    els.themeBtn.onclick = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      S.settings.theme = dark ? 'light' : 'dark';
      applyTheme();
      commitSettings();
    };

    // Settings panel
    els.settingsBtn.onclick = () => {
      els.settingsPanel.hidden = !els.settingsPanel.hidden;
      if (!els.settingsPanel.hidden) updateStorageInfo();
    };
    els.themeSelect.addEventListener('change', (e) => {
      S.settings.theme = e.target.value;
      applyTheme();
      commitSettings();
    });
    els.reminderSelect.addEventListener('change', (e) => {
      S.settings.exportReminderDays = Number(e.target.value);
      commitSettings();
    });
    const fzNum = (id, key, lo, hi) => {
      if (!els[id]) return;
      els[id].addEventListener('change', () => {
        const raw = Math.round(Number(els[id].value));
        const v = Math.min(hi, Math.max(lo, Number.isFinite(raw) ? raw : lo));
        if (String(v) !== els[id].value) els[id].value = v; // reflect clamping
        focusSavePatch({ [key]: v });
      });
    };
    fzNum('fzWork', 'work', 1, 180);
    fzNum('fzShort', 'short', 1, 60);
    fzNum('fzLong', 'long', 1, 120);
    fzNum('fzEvery', 'longEvery', 1, 12);
    if (els.focusBar) els.focusBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fz]');
      if (!b) { const tt = focusTask(); if (tt) openComposer({ mode: 'edit', taskId: tt.id }); return; }
      if (b.dataset.fz === 'pause' || b.dataset.fz === 'resume') focusPauseToggle();
      else if (b.dataset.fz === 'stop') focusStop();
    });
    if (els.fzNotify) els.fzNotify.addEventListener('change', (e) => { focusSavePatch({ notify: e.target.checked }); toast(e.target.checked ? 'Focus sessions will announce themselves.' : 'Focus sessions will stay quiet.'); });
    if (els.fzAuto) els.fzAuto.addEventListener('change', (e) => {
      focusSavePatch({ autoComplete: e.target.checked });
      toast(e.target.checked
        ? '⚠ A finished session will complete the task automatically.'
        : 'Tasks will only be completed by you — sessions just record focus time.');
    });
    if (els.aiMode) els.aiMode.addEventListener('change', (e) => {
      S.settings.aiMode = e.target.value === 'local' ? 'local' : 'auto';
      commitSettings();
      toast(S.settings.aiMode === 'local' ? 'Task breakdowns will use the built-in planner only.' : 'Task breakdowns will try the server AI service first (falls back to built-in).');
    });
    if (els.habInStats) els.habInStats.addEventListener('change', (e) => {
      S.settings.habitsInStats = e.target.checked;
      commitSettings();
      renderAll();
      toast(e.target.checked
        ? 'Habit check-ins now count in dashboard stats.'
        : 'Dashboard stats are task-only again — habits stay their own module.');
    });
    els.subtaskAuto.addEventListener('change', (e) => {
      S.settings.subtaskAutoComplete = e.target.checked;
      commitSettings();
      toast(e.target.checked
        ? 'Parents will complete automatically when all their subtasks are done.'
        : 'Parents now complete only by you.');
    });

    els.emptyTrashBtn.onclick = emptyTrash;

    // Reminder editor (composer rows) + alert toast actions
    els.addRemBtn.onclick = () => {
      S.ui.remRows = S.ui.remRows || [];
      S.ui.remRows.push({ reminderType: S.tasks.find((x) => x.id === S.ui.editingId) ? 'onTime' : 'm10' });
      renderRemRows();
      scheduleDraft();
    };
    els.remRows.addEventListener('change', remRowEdit);
    els.remRows.addEventListener('input', remRowEdit);
    els.remRows.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rfield="remove"]');
      if (!rm) return;
      const host = rm.closest('.rem-row');
      const i = Number(host && host.dataset.ri);
      if (!Number.isFinite(i)) return;
      S.ui.remRows.splice(i, 1);
      renderRemRows();
      scheduleDraft();
    });
    els.toastHost.addEventListener('click', (e) => {
      const open = e.target.closest('[data-remopen]');
      if (open) {
        openComposer({ mode: 'edit', taskId: open.dataset.remopen });
        const box = open.closest('.toast'); if (box) box.remove();
        return;
      }
      const dis = e.target.closest('[data-remdismiss]');
      if (dis) {
        const r = S.reminders.find((x) => x.id === dis.dataset.remdismiss);
        if (r) {
          r.status = 'dismissed'; r.dismissed = true; r.updatedAt = Date.now();
          store.commit([{ store: STORES.reminders, op: 'put', value: r }]).then(() => renderAll());
        }
        const box = dis.closest('.toast'); if (box) box.remove();
      }
    });

    // Calendar module (view over tasks; keyboard + drag handlers inside)
    wireCalendar();
    wireDashboard();

    // Follow system theme changes while in auto mode
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (S && (S.settings.theme || 'auto') === 'auto') applyTheme();
      });
    }
  }
})();
