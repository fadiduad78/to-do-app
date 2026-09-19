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
    fRecurrence: $('f-recurrence'), remRows: $('remRows'), addRemBtn: $('addRemBtn'),
    taskList: $('taskList'), emptyState: $('emptyState'),
    trashBar: $('trashBar'), trashCount: $('trashCount'), emptyTrashBtn: $('emptyTrashBtn'),
    settingsPanel: $('settingsPanel'), themeSelect: $('themeSelect'), reminderSelect: $('reminderSelect'),
    subtaskAuto: $('subtaskAuto'),
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
               cal: { open: false, view: 'month', anchor: '' } };
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

    store.startSync();

    // Cloud layer (see cloud.js): attaches after local recovery, LWW-merges
    // with the server, then mirrors every commit upstream. If the server is
    // unreachable the app keeps working fully local-only. Never blocks boot:
    // failures are caught inside and surfaced via the ☁ pill.
    if (window.ZTCloud) {
      try {
        await window.ZTCloud.attach({ store, getState: () => S, onChange: () => { renderAll(); remReconcile(); } });
      } catch (e) {
        console.warn('[zerotodo] cloud attach failed (staying local-only):', e);
      }
    }

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
    const i = S.trash.findIndex((x) => x.id === t.id);
    if (i !== -1) S.trash.splice(i, 1);
    delete t.trashedAt;
    t.updatedAt = Date.now(); // the move must beat the soft-delete tombstone during cloud sync
    S.tasks.push(t);
    const ok = await store.commit([
      { store: STORES.trash, op: 'delete', key: t.id },
      { store: STORES.tasks, op: 'put', value: t },
    ]);
    renderAll();
    if (ok) toast('Restored “' + truncate(t.title, 40) + '”.');
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
    // Calendar mode: the task list UI steps aside; the calendar is a view
    // over the SAME in-memory state — no duplicate data anywhere.
    const calOn = !!(S.ui && S.ui.cal.open);
    els.calendar.hidden = !calOn;
    els.calBtn.classList.toggle('on', calOn);
    els.calBtn.setAttribute('aria-pressed', String(calOn));
    if (calOn) {
      for (const el of [els.filterTabs, els.tagChips, els.projectBar, els.projectDetail, els.trashBar, els.taskList, els.emptyState]) el.hidden = true;
      renderCalendar();
    } else {
      els.taskList.hidden = false;
    }
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
          '<div class="task-title">' + esc(t.title) + '</div>' +
          (t.description ? '<div class="task-desc">' + esc(t.description) + '</div>' : '') +
          '<div class="task-meta">' +
            '<span class="badge prio-' + t.priority + '">' + prioLabel + '</span>' +
            (due && !inTrash ? '<span class="badge due ' + due.cls + '">' + due.text + '</span>' : '') +
            (!inTrash && remPendingFor(t.id) ? '<span class="badge rem" title="' + remPendingFor(t.id) + ' pending reminder(s), next: ' + esc(remNextLabel(t.id)) + '">🔔 ' + remPendingFor(t.id) + '</span>' : '') +
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
            : '<button class="btn btn-ghost btn-sm btn-icon" data-act="up" title="Move up" aria-label="Move up">↑</button>' +
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
    setTimeout(() => els.fTitle.focus(), 60);
    refreshDraftResumeUI();
  }

  function closeComposer() {
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
      Object.assign(t, {
        title, description: v.description, dueDate: v.dueDate, dueTime: v.dueTime,
        priority: v.priority, tags: v.tags, projectId: v.projectId, recurrence: v.recurrence, updatedAt: now,
      });
      ops = [{ store: STORES.tasks, op: 'put', value: t }];
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
        status: 'active',
        sortOrder: S.tasks.length ? base - 1 : 0,
        createdAt: now, updatedAt: now,
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
      projectId: v.projectId, recurrence: v.recurrence, remRows: v.remRows,
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
      ops.push({ store: STORES.tasks, op: 'put', value: t });
      remReviveSkipped(t.id, ops, now); // re-check reminders of the un-completed task
    } else if (t.recurrence) {
      // Recurring: completing rolls the task to its next occurrence instead
      // of leaving it done — dueDate is rewritten in place (same task, same
      // id), and its cycle-linked reminders are re-armed against the new date.
      const base = t.dueDate || ymd(new Date());
      t.dueDate = remNextOccurrence(base, t.recurrence);
      t.status = 'active';
      t.updatedAt = now;
      ops.push({ store: STORES.tasks, op: 'put', value: t });
      let rearmed = 0;
      for (const r of S.reminders) {
        if (r.taskId !== t.id || r.reminderType === 'custom') continue; // custom times are absolute, not per-cycle
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
      toast('Recurring task completed — rolled to ' + t.dueDate + (rearmed ? ' · ' + rearmed + ' reminder(s) re-armed' : ''));
    } else {
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
    await store.commit(ops);
    renderAll();
    remReconcile();
  }

  /** Soft delete: move to trash (single atomic tx touching both stores). */
  async function deleteTask(id) {
    const i = S.tasks.findIndex((t) => t.id === id);
    if (i === -1) return;
    const t = S.tasks.splice(i, 1)[0];
    t.trashedAt = Date.now();
    t.updatedAt = t.trashedAt; // keep LWW ordering sane for the store move (sync)
    S.trash.push(t);
    const ok = await store.commit([
      { store: STORES.trash, op: 'put', value: t },
      { store: STORES.tasks, op: 'delete', key: id },
    ]);
    if (S.ui.editingId === id) closeComposer();
    renderAll();
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
    if (ok) toast('Task restored.');
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
    const doomed = new Set(subtreeIds(id));
    S.trash = S.trash.filter((x) => x.id !== id);
    S.subtasks = S.subtasks.filter((x) => !doomed.has(x.id));
    // Reminders die with the task forever — deletes (→ tombstones) ride the
    // SAME commit, so no device keeps a schedule for a task that's gone.
    const doomedRem = S.reminders.filter((r) => doomed.has(r.taskId)).map((r) => r.id);
    S.reminders = S.reminders.filter((r) => !doomed.has(r.taskId));
    await store.commit([{ store: STORES.trash, op: 'delete', key: id }]
      .concat([...doomed].map((sid) => ({ store: STORES.subtasks, op: 'delete', key: sid })))
      .concat(doomedRem.map((rid) => ({ store: STORES.reminders, op: 'delete', key: rid }))));
    remArm();
    renderAll();
    toast('Deleted forever' + (doomed.size ? ' — ' + doomed.size + ' subtask(s) with it.' : '.'));
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
  function calChip(t) {
    const done = t.status === 'completed';
    const due = formatDue(t.dueDate, done);
    const overCls = due && due.cls === 'overdue' ? ' is-over' : '';
    return '<span class="cal-chip prio-' + t.priority + (done ? ' is-done' : '') + overCls + '" data-tid="' + esc(t.id) + '" draggable="true"' +
      ' title="' + esc((t.dueTime ? t.dueTime + ' — ' : '') + t.title) + '">' +
      '<i class="cal-dot" aria-hidden="true"></i>' + (t.dueTime ? '<b>' + esc(t.dueTime) + '</b>' : '') +
      (remPendingFor(t.id) ? '🔔' : '') + (done ? '✓ ' : '') + esc(truncate(t.title, 22)) + '</span>';
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
      '</div></div>';
  }

  function renderCalendar() {
    const cal = S.ui.cal;
    const a = ymdParse(cal.anchor);
    const f = calFilters();
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
          return '<div class="cal-cell allday" data-cdate="' + ds + '" data-allday="1">' +
            ts.slice(0, 4).map((t) => calChip(t)).join('') + (ts.length > 4 ? '<span class="cal-more">…+' + (ts.length - 4) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
      let rows = '';
      for (let h = 0; h < 24; h++) {
        const perDay = days.map((ds) => calTasksOn(ds).filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h));
        if ((h < 6 || h > 22) && !perDay.some((ts) => ts.length)) continue; // collapse quiet hours
        rows += '<div class="cal-row"><span class="cal-hour-lbl">' + String(h).padStart(2, '0') + ':00</span>' +
          days.map((ds, i) => '<div class="cal-cell slot' + (perDay[i].length ? ' has-t' : '') + '" data-cdate="' + ds + '" data-chour="' + h + '">' +
            perDay[i].map((t) => calChip(t)).join('') + '</div>').join('') + '</div>';
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
      let rows = '';
      for (let h = 6; h <= 22; h++) {
        const ts = st.tasks.filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h);
        rows += '<div class="cal-row day"><span class="cal-hour-lbl">' + String(h).padStart(2, '0') + ':00</span>' +
          '<div class="cal-cell slot' + (ts.length ? ' has-t' : '') + '" data-cdate="' + ds + '" data-chour="' + h + '">' +
          ts.map((t) => calChip(t)).join('') + '</div></div>';
      }
      body = '<div class="cal-day-summary"><span>' + st.tasks.length + ' task(s)</span><span>·</span>' +
        '<span>' + st.done + ' done</span>' + (st.overdue ? '<span>·</span><span class="cal-over">⚠ ' + st.overdue + ' overdue</span>' : '') +
        '<span class="spacer"></span><span class="cal-mini"><i style="width:' + pct + '%"></i></span><span>' + pct + '%</span>' +
        '<button class="btn btn-sm btn-primary" data-cnew="' + ds + '" type="button">＋ New task</button></div>' +
        (allday.length ? '<div class="cal-row cal-allday-row"><span class="cal-hour-lbl">All-day</span><div class="cal-cell allday" data-cdate="' + ds + '" data-allday="1">' + allday.map((t) => calChip(t)).join('') + '</div></div>' : '') +
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
      if (S.ui.cal.open) S.ui.cal.anchor = ymd(new Date());
      renderAll();
      if (S.ui.cal.open) els.calendar.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
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
  function remNextOccurrence(ds, kind) {
    const [y, m, d] = ds.split('-').map(Number);
    if (kind === 'weekly') return ymd(new Date(y, m - 1, d + 7));
    if (kind === 'monthly') {
      const last = new Date(y, m + 1, 0).getDate(); // days in the NEXT month (m here is 1-based)
      return ymd(new Date(y, m, Math.min(d, last))); // Jan 31 → Feb 28, never Mar 2
    }
    return ymd(new Date(y, m - 1, d + 1));
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
    for (const al of alerts) remNotify(al.r, al.t, al.lateMs);
    renderAll();
    return true;
  }

  function remNotify(r, t, lateMs) {
    // Delivery, OS channels, actions and dedup all belong to notify.js —
    // the task UI just hands over the fired alert.
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
        trash: v.trash, settings: v.settings || {},
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
    store.replaceMemory(clean.tasks, clean.trash, clean.projects, clean.subtasks, clean.reminders);
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

    // Follow system theme changes while in auto mode
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (S && (S.settings.theme || 'auto') === 'auto') applyTheme();
      });
    }
  }
})();
