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
    fTitle: $('f-title'), fDesc: $('f-desc'), fDue: $('f-due'),
    fPriority: $('f-priority'), fTags: $('f-tags'),
    saveTaskBtn: $('saveTaskBtn'), cancelTaskBtn: $('cancelTaskBtn'), draftHint: $('draftHint'),
    searchInput: $('searchInput'), newTaskBtn: $('newTaskBtn'),
    draftResume: $('draftResume'), draftResumeBtn: $('draftResumeBtn'), draftDiscardBtn: $('draftDiscardBtn'),
    filterTabs: $('filterTabs'), tagChips: $('tagChips'),
    taskList: $('taskList'), emptyState: $('emptyState'),
    trashBar: $('trashBar'), trashCount: $('trashCount'), emptyTrashBtn: $('emptyTrashBtn'),
    settingsPanel: $('settingsPanel'), themeSelect: $('themeSelect'), reminderSelect: $('reminderSelect'),
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
    onExternalChange() { renderAll(); }, // another tab committed — disk is truth
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
    S.ui = { search: '', editingId: null, composerOpen: false };
    S.lastSavedAt = rec.lastSavedAt;
    // Re-persist filter preferences from disk (they are part of settings).
    S.settings.filterMode = ['all', 'active', 'completed', 'trash'].includes(S.settings.filterMode) ? S.settings.filterMode : 'all';

    store.startSync();

    // Cloud layer (see cloud.js): attaches after local recovery, LWW-merges
    // with the server, then mirrors every commit upstream. If the server is
    // unreachable the app keeps working fully local-only. Never blocks boot:
    // failures are caught inside and surfaced via the ☁ pill.
    if (window.ZTCloud) {
      try {
        await window.ZTCloud.attach({ store, getState: () => S, onChange: () => renderAll() });
      } catch (e) {
        console.warn('[zerotodo] cloud attach failed (staying local-only):', e);
      }
    }

    applyTheme();
    renderAll();
    // Recovery itself doesn't fire status callbacks, so settle the pill now.
    setPill('saved');

    for (const n of rec.notices) {
      showBanner({ kind: n.kind, message: n.message, sticky: n.kind !== 'info', id: 'notice-' + noticesSeq++ });
    }

    checkDraftOnLoad();
    checkExportReminder();
    startRelativeClock();
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
    const q = S.ui.search.trim().toLowerCase();
    if (q) list = list.filter((t) =>
      t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
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
    renderTrashBar();
    renderList();
    renderSettings();
    renderFooter();
    refreshDraftResumeUI();
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
    els.trashBar.hidden = !inTrash;
    if (inTrash) els.trashCount.textContent = S.trash.length + ' item(s)';
    els.emptyTrashBtn.hidden = inTrash && S.trash.length === 0;
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
            (t.tags || []).map((tag) => '<button class="chip" data-tag="' + esc(tag) + '" type="button">' + esc(tag) + '</button>').join('') +
            (inTrash ? '<span class="muted small">trashed ' + fmtWhen(t.trashedAt) + '</span>' : '') +
          '</div>' +
        '</div>' +
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
    const inTrash = S.settings.filterMode === 'trash';
    const list = visibleTasks();
    if (!list.length) {
      els.taskList.innerHTML = '';
      els.emptyState.hidden = false;
      let icon = '🗒️', text = 'No tasks yet — click <b>＋ New task</b> to add one. Everything you write is saved automatically, on every change.';
      if (inTrash) { icon = '🗑️'; text = 'Trash is empty. Deleted tasks land here for 30 days before they are removed automatically.'; }
      else if (S.tasks.length || S.trash.length) { icon = '🔍'; text = 'No tasks match the current filter or search.'; }
      els.emptyState.innerHTML = '<span class="big">' + icon + '</span>' + text;
      return;
    }
    els.emptyState.hidden = true;
    els.taskList.innerHTML = list.map((t) => taskItemHTML(t, inTrash)).join('');
  }

  function renderSettings() {
    els.themeSelect.value = S.settings.theme || 'auto';
    els.reminderSelect.value = String(S.settings.exportReminderDays || 0);
  }

  function renderFooter() {
    const done = S.tasks.filter((t) => t.status === 'completed').length;
    els.footerCounts.textContent = S.tasks.length + ' task(s) · ' + done + ' completed · ' + S.trash.length + ' in trash';
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
    els.fPriority.value = (prefill && prefill.priority) || (editing ? editing.priority : 'med');
    els.fTags.value = prefill && prefill.tags != null
      ? prefill.tags.join(', ')
      : (editing ? (editing.tags || []).join(', ') : '');
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
      description: els.fDesc.value.trim(),
      dueDate: els.fDue.value || null,
      priority: els.fPriority.value,
      tags: els.fTags.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
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
        title, description: v.description, dueDate: v.dueDate,
        priority: v.priority, tags: v.tags, updatedAt: now,
      });
      ops = [{ store: STORES.tasks, op: 'put', value: t }];
    } else {
      // New tasks slot in at the top (lowest sortOrder).
      const min = S.tasks.reduce((m, t) => Math.min(m, t.sortOrder), S.tasks.length ? Infinity : 0);
      const base = Number.isFinite(min) ? min : 0;
      const t = {
        id: helpers.uuid(),
        title, description: v.description, dueDate: v.dueDate,
        priority: v.priority, tags: v.tags,
        status: 'active',
        sortOrder: S.tasks.length ? base - 1 : 0,
        createdAt: now, updatedAt: now,
      };
      S.tasks.push(t);
      ops = [{ store: STORES.tasks, op: 'put', value: t }];
    }
    const ok = await store.commit(ops); // write-through: persisted immediately
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
    if (!v.title.trim() && !v.description && !v.dueDate && !v.tags.length) return null;
    return {
      kind: S.ui.editingId ? 'edit' : 'new',
      taskId: S.ui.editingId,
      title: v.title, description: v.description, dueDate: v.dueDate,
      priority: v.priority, tags: v.tags,
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
    t.status = t.status === 'completed' ? 'active' : 'completed';
    t.updatedAt = Date.now();
    await store.commit([{ store: STORES.tasks, op: 'put', value: t }]);
    renderAll();
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
    const ok = await store.commit([
      { store: STORES.trash, op: 'delete', key: id },
      { store: STORES.tasks, op: 'put', value: t },
    ]);
    renderAll();
    if (ok) toast('Task restored.');
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
    S.trash = S.trash.filter((x) => x.id !== id);
    await store.commit([{ store: STORES.trash, op: 'delete', key: id }]);
    renderAll();
    toast('Deleted forever.');
  }

  async function emptyTrash() {
    if (!S.trash.length) return;
    const ok = await confirmDialog({
      title: 'Empty trash?',
      body: 'This will permanently delete ' + S.trash.length + ' item(s). A small safety copy of the trash will be downloaded first, in case you change your mind.',
      confirmLabel: 'Download safety copy, then empty',
      danger: true,
    });
    if (!ok) return;
    try {
      downloadRaw(
        JSON.stringify({ app: 'zerotodo', type: 'trash-safety-copy', exportedAt: new Date().toISOString(), trash: S.trash }),
        'zerotodo-trash-' + stamp() + '.json'
      );
    } catch (_) { /* safety copy is best-effort */ }
    const ops = S.trash.map((t) => ({ store: STORES.trash, op: 'delete', key: t.id }));
    S.trash = [];
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
    store.replaceMemory(clean.tasks, clean.trash);
    // Local settings (theme, reminder cadence) are device preferences — keep
    // them; the imported tasks/trash replace ours entirely.
    const okc = await store.resync();
    if (S.settings.filterTag && !allTags().some(([t]) => t === S.settings.filterTag)) S.settings.filterTag = null;
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
    for (const el of [els.fTitle, els.fDesc, els.fDue, els.fPriority, els.fTags]) {
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

    // Task list: click actions
    els.taskList.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) { setFilterTag(S.settings.filterTag === chip.dataset.tag ? null : chip.dataset.tag); return; }
      const li = e.target.closest('.task');
      if (!li) return;
      const id = li.dataset.id;
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

    els.emptyTrashBtn.onclick = emptyTrash;

    // Follow system theme changes while in auto mode
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (S && (S.settings.theme || 'auto') === 'auto') applyTheme();
      });
    }
  }
})();
