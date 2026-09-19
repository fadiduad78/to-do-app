/* test-ui.mjs — drive the REAL app UI in a headless DOM (jsdom).
 * Proves the subtask feature renders and behaves in the browser layer:
 * add / tick / reorder / delete+undo / auto-complete setting / search /
 * persistence mirror — things the Node-only suites can't see (they cover the
 * data layer; this one covers the actual rendered interface).
 * Run: node server/test-ui.mjs   (needs: npm i --no-save jsdom)
 * ==========================================================================*/
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Needs jsdom once:  npm i --no-save jsdom
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(PUB + '/index.html', 'utf8');
const storageSrc = readFileSync(PUB + '/storage.js', 'utf8');
const appSrc = readFileSync(PUB + '/app.js', 'utf8');

let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
// app.js expects a couple of browser bits jsdom lacks
window.HTMLElement.prototype.scrollIntoView = function () {};
if (!window.crypto || !window.crypto.randomUUID) {
  let n = 0;
  Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'uuid-' + (++n) + '-' + Date.now() } });
}
window.eval(storageSrc);   // the very file the browser loads
window.eval(appSrc);       // boots async init() → recover() → renderAll()
await sleep(300);

const doc = window.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];

ok($('#projectBar') && $('#projectBar').hidden === false, 'projects bar visible (empty state)');
ok($('#taskList'), 'task list mounted');

/* 1. create the spec's example task through the real composer */
$('#newTaskBtn').click();
await sleep(50);
$('#f-title').value = 'Build Expense Tracker';
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(300);
let li = $('#taskList .task');
ok(li && li.textContent.includes('Build Expense Tracker'), 'task row renders after submit');
ok(li.querySelector('.sub-toggle') && /subtasks/.test(li.querySelector('.sub-toggle').textContent),
  'row shows the subtasks affordance: ' + JSON.stringify(li.querySelector('.sub-toggle').textContent.trim()));

/* 2. expand + add subtasks with Enter */
li.querySelector('.sub-toggle').click();
await sleep(120);
const addInput = () => $('#taskList .sub-add-input');
ok(!!addInput(), '▸ expands and shows the Add-subtask input');
const titles = ['Design database', 'Create expense model', 'Build expense form', 'Add reports', 'Test application'];
for (const t of titles) {
  addInput().value = t;
  addInput().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(160);
}
let rows = $$('#taskList .sub-row:not(.sub-add)');
ok(rows.length === 5, 'all 5 subtasks added (rows: ' + rows.length + ')');
ok([...rows].map((r) => r.querySelector('.sub-title').textContent).join('|') === titles.join('|'), 'subtasks render in creation order');
let toggleTxt = $('#taskList .task .sub-toggle').textContent;
ok(/0\/5 subtasks · 0%/.test(toggleTxt), 'progress line reads "0/5 subtasks · 0%" — got: ' + JSON.stringify(toggleTxt.trim()));
const barW = $('#taskList .task .sub-mini i').style.width;
ok(barW === '0%', 'mini progress bar width follows (got ' + barW + ')');

/* 3. complete three of them → 3/5 · 60%; parent must NOT auto-complete */
for (let i = 0; i < 3; i++) {
  $$('#taskList .sub-row:not(.sub-add) .sub-check')[0].click(); // rows keep order; first is next open one
  // tick the FIRST *unchecked* row instead (robust):
  await sleep(160);
}
// above clicked the first row each time (toggling it repeatedly) — fix deliberately:
let subRows = () => $$('#taskList .sub-row:not(.sub-add)');
const openFirst = () => subRows().find((r) => !r.classList.contains('is-done'));
while (subRows().filter((r) => r.classList.contains('is-done')).length < 3 && openFirst()) {
  openFirst().querySelector('.sub-check').click();
  await sleep(150);
}
const doneN = subRows().filter((r) => r.classList.contains('is-done')).length;
ok(doneN === 3, 'three subtasks ticked (is-done rows: ' + doneN + ')');
toggleTxt = $('#taskList .task .sub-toggle').textContent;
ok(/3\/5 subtasks · 60%/.test(toggleTxt), 'progress reads "3/5 subtasks · 60%" — got: ' + JSON.stringify(toggleTxt.trim()));
ok(!$('#taskList .task').classList.contains('is-done'), 'PARENT NOT auto-completed by default (spec rule)');
ok($('#taskList .sub-row.is-done .sub-title').parentElement.classList.contains('is-done'), 'done subtask gets strikethrough styling');

/* 4. persistence: the LS mirror that survives a browser refresh */
const mirror = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
ok(mirror.schemaVersion === 5 && mirror.subtasks.length === 5, 'localStorage mirror carries 5 subtasks at schema v5');
ok(mirror.subtasks.filter((s) => s.completed).length === 3, 'completed flags in the mirror');
ok(mirror.subtasks.every((s) => s.completedAt !== null || !s.completed), 'completedAt set when done');

/* 5. rename (edit) */
const editBtn = subRows()[0].querySelector('[data-sact="subedit"]');
editBtn.click();
await sleep(120);
const editInput = $('#taskList .sub-edit-input');
ok(!!editInput, 'inline edit input appears');
editInput.value = 'Create expense model v2';
editInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(160);
ok(subRows()[0].querySelector('.sub-title').textContent === 'Create expense model v2', 'rename applied in place');

/* 6. reorder */
const secondTitle = subRows()[1].querySelector('.sub-title').textContent;
subRows()[1].querySelector('[data-sact="subdown"]').click();
await sleep(200);
ok(subRows()[2].querySelector('.sub-title').textContent === secondTitle, '↓ moved the 2nd subtask to 3rd');
ok(mirrorPositionsAsc(), 'positions renumbered sensibly after move');
function mirrorPositionsAsc() {
  const m = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  const ps = m.subtasks.map((s) => s.position);
  return new Set(ps).size === ps.length;
}

/* 7. delete + undo toast */
subRows()[4].querySelector('[data-sact="subdel"]').click();
await sleep(200);
ok(subRows().length === 4, 'delete removed the subtask row');
ok(!!$('#undoSubBtn'), 'undo toast button present');
$('#undoSubBtn').click();
await sleep(220);
ok(subRows().length === 5, 'undo restored the subtask');

/* 8. search matches subtask text; project progress counts subtasks */
$('#searchInput').value = 'renovate-nope';
$('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(120);
ok(!$$('#taskList .task').length, 'search with no match hides the task');
$('#searchInput').value = 'v2';
$('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(120);
ok($$('#taskList .task').length === 1, 'search matches the RENAMED SUBTASK title and shows the parent');
$('#searchInput').value = '';
$('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(120);

/* 9. the setting: auto-complete parent when all subtasks complete */
const auto = $('#subtaskAuto');
ok(auto && auto.checked === false, 'setting exists and defaults to OFF');
auto.checked = true;
auto.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(200);
while (subRows().some((r) => !r.classList.contains('is-done'))) {
  const next = subRows().find((r) => !r.classList.contains('is-done'));
  next.querySelector('.sub-check').click();
  await sleep(150);
}
li = $('#taskList .task');
ok(li.classList.contains('is-done'), 'with the setting ON, last subtask completed the parent (one click)');
// untick one → parent reopens (auto rule is symmetric)
subRows().find((r) => r.classList.contains('is-done')).querySelector('.sub-check').click();
await sleep(200);
ok(!$('#taskList .task').classList.contains('is-done'), 'parent reopens when a subtask unticks');
// delete one of the last subtasks: parent stays consistent (no crash, count updates)
subRows()[0].querySelector('[data-sact="subdel"]').click();
await sleep(220);
ok($('#undoSubBtn') && subRows().length === 4, 'delete toast works mid-flow (4 rows left)');
$('#undoSubBtn').click();
await sleep(200);

/* 10. simulated refresh: new JSDOM sharing nothing, seeded from the mirror */
const mirror2 = window.localStorage.getItem('todo_backup_v1');
const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
dom2.window.HTMLElement.prototype.scrollIntoView = function () {};
dom2.window.localStorage.setItem('todo_backup_v1', mirror2);
dom2.window.eval(storageSrc);
dom2.window.eval(appSrc);
await sleep(400);
const doc2 = dom2.window.document;
const li2 = doc2.querySelector('#taskList .task');
ok(li2 && li2.textContent.includes('Build Expense Tracker'), 'after refresh: task recovered from the mirror');
const rows2 = [...doc2.querySelectorAll('#taskList .task')].length; // expand requires click
ok(JSON.parse(dom2.window.localStorage.getItem('todo_backup_v1')).subtasks.length === 5, 'after refresh: all 5 subtasks present in recovered state');
doc2.querySelector('.sub-toggle').click();
await sleep(150);
ok(doc2.querySelectorAll('#taskList .sub-row:not(.sub-add)').length === 5, 'after refresh: checklist renders with 5 rows');

/* 11. Projects UI flow — regression for the empty-modal bug:
       create via dialog, open, detail header, add task, tick → 100%,
       ⋯ menu non-empty, archive, delete toast, mirror persistence. */
doc.querySelector('#projectBar [data-act="new"]').click();
await sleep(120);
ok(!!doc.querySelector('#modalHost .modal #pf-name'), 'New project dialog renders its form (name field present)');
doc.querySelector('#pf-name').value = 'Renovation';
// NOTE: no emoji inside querySelector — jsdom's nwsapi can't match non-BMP
// chars in attribute selectors (browsers can; this is harness-only). Index 3 = 🎯.
doc.querySelectorAll('#modalHost .pf-icon')[3].click();
doc.querySelector('#modalHost [data-m="save"]').click();
await sleep(250);
let card = doc.querySelector('#projectBar .project-card');
ok(!!card && /Renovation/.test(card.textContent) && card.textContent.includes('🎯'), 'project card appears with chosen icon+name');
card.querySelector('.pc-open').click();
await sleep(250);
ok(doc.querySelector('#projectDetail').hidden === false && /0% complete/.test(doc.querySelector('#projectDetail').textContent), 'project view opens: detail header with 0% progress');
ok(!doc.querySelector('#emptyState').hidden && /Nothing in this project/.test(doc.querySelector('#emptyState').textContent), 'empty project shows its own empty-state message');
doc.querySelector('#projectDetail [data-act="add"]').click();
await sleep(120);
ok(doc.querySelector('#f-project').value === card.dataset.pid, 'Add-task from detail opens composer PRE-SELECTED to the project');
doc.querySelector('#f-title').value = 'Paint kitchen';
doc.querySelector('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(250);
card = doc.querySelector('#projectBar .project-card');
ok(/0\/1/.test(card.textContent), 'card progress shows 0/1 after task added');
ok(doc.querySelector('#taskList .task .proj-ref'), 'task row shows the project chip');
doc.querySelector('#taskList .task .check').click(); // complete the task
await sleep(250);
card = doc.querySelector('#projectBar .project-card');
ok(/1\/1/.test(card.textContent) && /100%/.test(doc.querySelector('#projectDetail').textContent), 'tick → 1/1 on card and detail 100% complete');
card.querySelector('[data-act="menu"]').click();
await sleep(120);
ok(/Rename \/ edit/.test(doc.querySelector('#modalHost .modal').textContent), '⋯ project menu renders its actions (non-empty overlay)');
doc.querySelector('#modalHost [data-m="close"]').click();
await sleep(80);
doc.querySelector('#projectDetail [data-act="delete"]').click();
await sleep(120);
const delBtn = doc.querySelector('#modalHost .btn-danger');
ok(!!delBtn, 'project delete asks for confirmation');
delBtn.click();
await sleep(250);
ok(!!doc.querySelector('#undoProjBtn'), 'deleted project offers 8s undo toast');
doc.querySelector('#undoProjBtn').click();
await sleep(250);
card = doc.querySelector('#projectBar .project-card');
ok(!!card, 'undo restores the project card');
card.querySelector('.pc-open').click(); // re-open the project view (as a user clicks it)
await sleep(150);
ok(doc.querySelector('#projectDetail').hidden === false, 'reopened card shows the detail header again');
doc.querySelector('#projectDetail [data-act="archive"]').click();
await sleep(250);
ok(doc.querySelector('#projectBar').textContent.includes('Archived (1)'), 'archive moves the card behind the Archived toggle');
const mirror3 = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
ok(mirror3.projects.length === 1 && mirror3.projects[0].name === 'Renovation' && mirror3.projects[0].archived === true, 'project (incl. archived flag) persisted to the refresh mirror');
ok(mirror3.tasks.some((x) => x.title === 'Paint kitchen' && x.projectId === mirror3.projects[0].id && x.status === 'completed'), 'task keeps projectId + completion in the mirror');

/* =========================== 12. Calendar ============================ */
/* The calendar must be a pure VIEW: same task objects, same ids, dates read
   from task.dueDate/dueTime only. Every check below cross-verifies against
   the localStorage mirror (the engine's own persisted state) so a "second
   source of truth" could not slip through unnoticed. */
const ymdS = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = ymdS(new Date());
const YDAY = ymdS(new Date(Date.now() - 864e5));
const IN3 = ymdS(new Date(Date.now() + 3 * 864e5));
const IN9 = ymdS(new Date(Date.now() + 9 * 864e5));
const tsk = () => JSON.parse(window.localStorage.getItem('todo_backup_v1')).tasks;
const tskOf = (title) => tsk().find((x) => x.title === title);
const mk = async (title, due, time, prio) => {
  $('#calBtn').classList.contains('on') && $('#calBtn').click(); // back to list so composer path is the normal one
  await sleep(80);
  $('#newTaskBtn').click(); await sleep(60);
  $('#f-title').value = title;
  if (due) $('#f-due').value = due;
  if (time) $('#f-time').value = time;
  if (prio) $('#f-priority').value = prio;
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(250);
};
await mk('Cal Alpha', TODAY, null, 'high');
await mk('Cal Beta', YDAY, null, 'med');
await mk('Cal Gamma', YDAY, null, 'low');

/* toggle Gamma done from the list (proves done state flows from the task) */
{
  const row = $$('#taskList .task').find((li) => li.textContent.includes('Cal Gamma'));
  row.querySelector('button.check').click();
  await sleep(250);
  ok(tskOf('Cal Gamma').status === 'completed', 'completed via list checkbox (calendar shows the same task state, no separate store)');
}

$('#calBtn').click(); await sleep(160);
ok(!$('#calendar').hidden && $('#taskList').hidden && $('#calBtn').classList.contains('on'),
  '📅 Calendar opens: view swaps, task list steps aside');
ok($$('#calHost .cal-month .cal-cell').length === 42 && $$('#calHost .cal-week-heads .cal-wh').length === 7,
  'month grid = 7×6 cells + Mon-first weekday heads');

{
  const todayCell = doc.querySelector(`#calHost [data-cdate="${TODAY}"]`);
  const yCell = doc.querySelector(`#calHost [data-cdate="${YDAY}"]`);
  ok(todayCell && todayCell.textContent.includes('Cal Alpha'), 'today chip renders the task due today');
  ok(/0\/1/.test(todayCell.textContent), 'per-day done/total count badge (0/1)');
  ok(yCell && yCell.querySelector('.cal-over') && /!1/.test(yCell.textContent), 'yesterday shows overdue indicator (!1 — Alpha is today, Gamma is done)');
  ok(yCell.querySelector('.cal-chip.is-done') && yCell.querySelector('.cal-chip.prio-high') === null, 'completed chip carries is-done; high dot only where priority is high');
  ok(yCell.querySelectorAll('.cal-chip').length === 2, 'both yesterday tasks in one cell (count=2, three chips max before "+more")');
}

/* click chip → EXISTING composer in edit mode; add a time there */
{
  const chip = doc.querySelector(`#calHost [data-cdate="${TODAY}"] .cal-chip`);
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  ok($('#f-title').value === 'Cal Alpha' && !$('#composer').hidden, 'clicking a chip opens the EXISTING task editor (no second detail UI)');
  $('#f-time').value = '09:00';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(250);
  ok(tskOf('Cal Alpha').dueTime === '09:00' && tskOf('Cal Alpha').dueDate === TODAY, 'edit writes dueTime onto the same task (id ' + (tskOf('Cal Alpha').id === chip.dataset.tid) + ', no duplicate: ' + (tsk().filter((x) => x.title === 'Cal Alpha').length === 1) + ')');
}

/* week view: timed task lands on its hour row; empty slot quick-create */
doc.querySelector('#calBar [data-cview="week"]').click(); await sleep(150);
{
  const slot9 = doc.querySelector(`#calHost [data-cdate="${TODAY}"][data-chour="9"]`);
  ok(slot9 && slot9.textContent.includes('Cal Alpha') && !slot9.textContent.includes('Cal Beta'), 'week places Cal Alpha on 09:00 of the right day; untimed tasks stay off hour rows');
  const slot16 = doc.querySelector(`#calHost [data-cdate="${TODAY}"][data-chour="16"]`);
  slot16.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  ok($('#f-due').value === TODAY && $('#f-time').value === '16:00', 'empty-slot click quick-creates with date+time prefilled');
  $('#f-title').value = 'Slot Quick';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(260);
  ok(tskOf('Slot Quick').dueTime === '16:00' && tskOf('Slot Quick').dueDate === TODAY, 'quick-created task persists on the same fields (dueDate/dueTime) — no calendar table');
  doc.querySelector('#calBtn').click(); await sleep(140); doc.querySelector('#calBtn').click(); await sleep(160); // reopen → re-render
}

/* drag & drop: month day-change, week hour-change, all-day clear — SAME ids */
const dragTo = async (chipSel, targetSel) => {
  const chip = doc.querySelector(chipSel);
  const target = doc.querySelector(targetSel);
  const dt = { _d: {}, setData(k, v) { this._d[k] = v; }, getData(k) { return this._d[k] || ''; } };
  const mkEv = (type) => { const ev = new window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt }); return ev; };
  chip.dispatchEvent(mkEv('dragstart'));
  target.dispatchEvent(mkEv('dragover'));
  target.dispatchEvent(mkEv('drop'));
  await sleep(260);
};
{
  doc.querySelector('#calBar [data-cview="month"]').click(); await sleep(140);
  const beforeId = tskOf('Cal Beta').id, nBefore = tsk().length;
  await dragTo(`#calHost [data-cdate="${YDAY}"] .cal-chip:nth-child(1)`, `#calHost [data-cdate="${IN3}"] .cal-cell-inner, #calHost [data-cdate="${IN3}"]`);
  const af = tskOf('Cal Beta');
  ok(af.dueDate === IN3 && af.id === beforeId && tsk().length === nBefore, 'drag to another day updates the EXISTING task (id kept, count ' + nBefore + ' → ' + tsk().length + ')');
  doc.querySelector('#calBar [data-cview="week"]').click(); await sleep(140);
  await dragTo(`#calHost [data-cdate="${TODAY}"][data-chour="16"] .cal-chip`, `#calHost [data-cdate="${TODAY}"][data-chour="10"]`);
  ok(tskOf('Slot Quick').dueTime === '10:00' && tskOf('Slot Quick').dueDate === TODAY, 'drag to 10:00 slot sets dueTime, keeps date & id');
  await dragTo(`#calHost [data-cdate="${TODAY}"][data-chour="10"] .cal-chip`, `#calHost .cal-allday-row [data-cdate="${TODAY}"]`);
  ok(tskOf('Slot Quick').dueTime === null, 'drop on All-day clears dueTime (back to date-only)');
}

/* month quick-create on an empty future day + day view + "+more" jump */
{
  doc.querySelector('#calBar [data-cview="month"]').click(); await sleep(140);
  const cell = doc.querySelector(`#calHost [data-cdate="${IN9}"]`);
  cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  ok($('#f-due').value === IN9 && $('#f-time').value === '', 'empty month cell prefills date only (no forced time)');
  $('#f-title').value = 'Day Quick';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(250);
  ok(tskOf('Day Quick').dueDate === IN9 && tskOf('Day Quick').dueTime === null, 'month quick-create lands as a normal task');
  doc.querySelector('#calBar [data-cview="day"]').click(); await sleep(140);
  const t0 = $('#calHost').textContent;
  // re-query every click: renderAll replaces calBar's children (stale refs are no-ops)
  for (let i = 0; i < 14 && !$('#calHost').textContent.includes('Day Quick'); i++) {
    doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(110);
  }
  ok($('#calHost').textContent.includes('Day Quick') && !$('#calHost').textContent.includes('Cal Alpha'), 'day view shows only the anchored day (Prev/Next navigate it)');
  ok(/1 task\(s\)/.test($('#calHost .cal-day-summary').textContent) && /0 done/.test($('#calHost .cal-day-summary').textContent), 'day summary line (1 task, 0 done)');
  doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(120);
  void t0;
}

/* navigation + keyboard + view persistence */
{
  doc.querySelector('#calBar [data-cview="month"]').click(); await sleep(120);
  const title0 = $('#calBar .cal-title').textContent;
  doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(120);
  const title1 = $('#calBar .cal-title').textContent;
  ok(title1 !== title0, 'Next › advances the month (' + title0 + ' → ' + title1 + ')');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await sleep(120);
  ok($('#calBar .cal-title').textContent === title0, '← returns to the previous month (keyboard nav)');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'w', bubbles: true })); await sleep(120);
  ok(!!$('#calHost .cal-scroll'), 'w → week view');
  $('#searchInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true })); await sleep(100);
  ok(!!$('#calHost .cal-scroll'), 'typing in the search box does NOT hijack shortcuts (guard holds)');
  const calViewPersisted = JSON.parse(window.localStorage.getItem('todo_backup_v1')).settings.calendarView;
  ok(calViewPersisted === 'week', 'view preference persists into settings (survives refresh)');
}

/* filters: status/priority/project, applied to the view only — never the data */
{
  doc.querySelector('#calBar [data-cview="month"]').click(); await sleep(140);
  const cell = doc.querySelector(`#calHost [data-cdate="${YDAY}"]`);
  ok(cell.textContent.includes('Cal Gamma'), 'baseline: completed task visible in cell');
  const fStatus = doc.querySelector('#calBar [data-cfilter="calStatus"]');
  fStatus.value = 'active'; fStatus.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(140);
  ok(!doc.querySelector(`#calHost [data-cdate="${YDAY}"]`).textContent.includes('Cal Gamma'), 'status filter hides completed (task itself untouched: ' + (tskOf('Cal Gamma').status === 'completed') + ')');
  const fPrio = doc.querySelector('#calBar [data-cfilter="calPriority"]');
  fPrio.value = 'high'; fPrio.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(140);
  ok(tsk().length > 6 && $$('#calHost .cal-chip').length === 1 && $('#calHost .cal-chip').textContent.includes('Cal Alpha'), 'priority filter shows only high — and task COUNT in storage is unchanged (' + tsk().length + ')');
  fStatus.value = ''; fStatus.dispatchEvent(new window.Event('change', { bubbles: true }));
  fPrio.value = ''; fPrio.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(140);
  const fProj = doc.querySelector('#calBar [data-cfilter="calProject"]');
  fProj.value = 'none'; fProj.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(140);
  const inboxIds = new Set(tsk().filter((x) => !x.projectId).map((x) => x.id));
  ok($$('#calHost .cal-chip').every((c) => inboxIds.has(c.dataset.tid)), 'project filter (📥 Inbox) only shows Inbox-due tasks');
  fProj.value = ''; fProj.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(120);
}

/* refresh persistence: dueTime rides through the mirror; no dupes, ids stable */
{
  const m = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  const ids = m.tasks.map((x) => x.id);
  ok(m.schemaVersion === 5 && new Set(ids).size === ids.length, 'mirror at schema v5, task ids unique after all calendar ops');
  ok(m.tasks.find((x) => x.title === 'Cal Alpha').dueTime === '09:00' && m.tasks.find((x) => x.title === 'Cal Beta').dueDate === IN3, 'refresh source-of-truth: edits live on the tasks themselves (dueTime/dueDate), nowhere else');
}

/* ===================== 13. Reminder engine + recurrence ===================== */
if ($('#calBtn').classList.contains('on')) { $('#calBtn').click(); await sleep(160); } // list must be showing
const mrow = () => $$('#remRows .rem-row');
const setRowType = async (i, v) => { const sel = mrow()[i].querySelector('select'); sel.value = v; sel.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(60); };
const setCustom = async (i, d, tm) => {
  const inputs = mrow()[i].querySelectorAll('input');
  inputs[0].value = d; inputs[0].dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(40);
  inputs[1].value = tm; inputs[1].dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(40);
};
const remMirror = () => JSON.parse(window.localStorage.getItem('todo_backup_v1'));
const remsFor = (title) => { const tk = remMirror().tasks.find((x) => x.title === title); return tk ? remMirror().reminders.filter((r) => r.taskId === tk.id) : []; };
const locEpoch = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/* multiple reminders of different kinds on ONE new task */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Renew visa'; $('#f-due').value = '2026-10-05';
$('#addRemBtn').click(); await setRowType(0, 'd1');
$('#addRemBtn').click(); await setRowType(1, 'h1');
$('#addRemBtn').click(); await setRowType(2, 'custom'); await setCustom(2, '2026-12-01', '08:30');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(350);
{
  const rs = remsFor('Renew visa');
  ok(rs.length === 3 && rs.every((r) => r.status === 'pending' && r.enabled && !r.delivered), 'three reminders saved: pending + enabled (spec list incl. custom)');
  ok(rs.find((r) => r.reminderType === 'd1').triggerAt === locEpoch(2026, 10, 4, 9, 0) - 0, '1-day-before = dueDate 09:00 default − 24h (local zone)');
  ok(rs.find((r) => r.reminderType === 'h1').triggerAt === locEpoch(2026, 10, 5, 9, 0) - 3600e3, '1-hour-before computed from task due instant');
  ok(rs.find((r) => r.reminderType === 'custom').customDate === '2026-12-01' && rs.find((r) => r.reminderType === 'custom').triggerAt === locEpoch(2026, 12, 1, 8, 30), 'custom date/time stored as strings + derived epoch (tz-safe)');
  const idsBefore = rs.map((r) => r.id).sort().join('|');
  /* reopen editor: existing pending rows are editable, not duplicated */
  const visRow = $$('#taskList .task').find((li) => li.textContent.includes('Renew visa'));
  visRow.querySelector('[data-act="edit"]').click(); await sleep(120);
  ok(mrow().length === 3, 'edit mode re-shows the 3 pending reminders as editable rows');
  await setRowType(1, 'm10'); // 1h-before → 10min-before
  mrow()[0].querySelector('.rem-rm').click(); await sleep(80); // remove the d1 row
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
  const rs2 = remsFor('Renew visa');
  ok(rs2.length === 2, 'editor removal deletes exactly one reminder (2 remain, no duplicates)');
  ok(!rs2.some((r) => r.reminderType === 'd1'), 'removed reminder is gone from storage');
  const kept = rs2.find((r) => idsBefore.includes(r.id));
  ok(kept && kept.reminderType === 'm10' && kept.triggerAt === locEpoch(2026, 10, 5, 9, 0) - 10 * 60e3, 're-typed row keeps its id and re-derives triggerAt (edit-in-place)');
  ok(!!doc.querySelector('#taskList .badge.rem'), 'task row shows the 🔔 badge for pending reminders');
  ok(/2 pending reminder\(s\), next:/.test(doc.querySelector('#taskList .badge.rem').title), 'badge tooltip counts + previews next fire');
}

/* relative reminder without a due date → refused, not mis-scheduled */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'No date task';
$('#addRemBtn').click(); await setRowType(0, 'm5');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(250);
ok(remsFor('No date task').length === 0 && remMirror().tasks.some((x) => x.title === 'No date task'), 'relative reminder on an undated task: not saved (task still created, never silently fires at epoch)');

/* completion + skip/revive on a plain task */
await (async () => {
  $('#newTaskBtn').click(); await sleep(80);
  $('#f-title').value = 'One-off'; $('#f-due').value = '2026-09-25';
  $('#addRemBtn').click(); await setRowType(0, 'd1');
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
})();
{
  const row = $$('#taskList .task').find((li) => li.textContent.includes('One-off'));
  row.querySelector('button.check').click(); await sleep(300);
  ok(remsFor('One-off')[0].status === 'skipped', 'completing a task SKIPS its pending reminders (no nagging for finished work)');
  const row2 = $$('#taskList .task').find((li) => li.textContent.includes('One-off'));
  row2.querySelector('button.check').click(); await sleep(300);
  ok(remsFor('One-off')[0].status === 'pending' && remsFor('One-off')[0].delivered === false, 'un-completing revives the future reminder back to pending');
}

/* overdue-at-save → fires as "Missed" exactly once (persisted dedup) */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Pay tax'; $('#f-due').value = '2026-09-18';
$('#addRemBtn').click(); await setRowType(0, 'onTime');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(450);
{
  const r = remsFor('Pay tax')[0];
  ok(r.status === 'triggered' && r.delivered === true, 'overdue reminder caught up at save-time: triggered + delivered flag set');
  ok(!!doc.querySelector('.toast-rem') && /Missed reminder — Pay tax/.test(doc.querySelector('.toast-rem').textContent), 'overdue fires as a "Missed reminder" in-app alert (safe overdue handling)');
  const ledger = JSON.parse(window.localStorage.getItem('zt_rem_fired_v1') || '{}');
  ok(!!ledger[r.id], 'localStorage fire-ledger records the id (cross-tab duplicate guard)');
  const firedAt = r.firedAt;
  const taxRow = $$('#taskList .task').find((li) => li.textContent.includes('Pay tax'));
  taxRow.querySelector('[data-act="edit"]').click(); await sleep(120);
  $('#f-desc').value = 'paid by transfer';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(350);
  const r2 = remsFor('Pay tax')[0];
  ok(r2.firedAt === firedAt && r2.status === 'triggered' && $$('.toast-rem').filter((e) => /Pay tax/.test(e.textContent)).length === 1,
    'editing a task whose reminder already fired NEVER re-notifies (firedAt stable, single alert)');
}

/* dismiss button on the alert */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Call mom'; $('#f-due').value = TODAY; $('#f-time').value = '00:00';
$('#addRemBtn').click(); await setRowType(0, 'onTime');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(450);
{
  const dis = $$('.toast-rem [data-remdismiss]').pop();
  ok(!!dis, 'a fired alert offers Dismiss');
  dis.click(); await sleep(250);
  const r = remMirror().reminders.find((x) => x.id === (remsFor('Call mom')[0] && remsFor('Call mom')[0].id)) || remsFor('Call mom')[0];
  ok(r && r.status === 'dismissed' && r.dismissed === true, 'dismiss → status dismissed + dismissed flag stay consistent');
}

/* recurrence: daily completion rolls dueDate + re-arms the reminder */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Chores'; $('#f-due').value = '2026-09-20';
$('#f-recurrence').value = 'daily'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
$('#addRemBtn').click(); await setRowType(0, 'm5');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(320);
{
  const before = remsFor('Chores')[0];
  ok(before.status === 'pending' && before.triggerAt === locEpoch(2026, 9, 20, 9, 0) - 5 * 60e3, 'daily task armed with a 5-min-before reminder');
  let row = $$('#taskList .task').find((li) => li.textContent.includes('Chores'));
  row.querySelector('button.check').click(); await sleep(350);
  let tk = remMirror().tasks.find((x) => x.title === 'Chores');
  ok(tk.status === 'active' && tk.dueDate === '2026-09-21', 'completing a DAILY task rolls it to tomorrow (same task, same id)');
  let r = remsFor('Chores')[0];
  ok(r.status === 'pending' && r.triggerAt === locEpoch(2026, 9, 21, 9, 0) - 5 * 60e3 && r.delivered === false, 'reminder re-armed against the new occurrence');
  row = $$('#taskList .task').find((li) => li.textContent.includes('Chores'));
  row.querySelector('button.check').click(); await sleep(350);
  tk = remMirror().tasks.find((x) => x.title === 'Chores');
  ok(tk.dueDate === '2026-09-22', 'second cycle → Sep 22 (cycle math on the stored date string)');
  ok(remsFor('Chores')[0].id === r.id, 're-arm edits the SAME reminder record (no dupes per cycle)');
}
/* monthly clamp: Jan 31 → Feb 28 (never Mar 2) */
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Rent'; $('#f-due').value = '2026-01-31';
$('#f-recurrence').value = 'monthly'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(300);
{
  let row = $$('#taskList .task').find((li) => li.textContent.includes('Rent'));
  row.querySelector('button.check').click(); await sleep(350);
  ok(remMirror().tasks.find((x) => x.title === 'Rent').dueDate === '2026-02-28', 'monthly Jan 31 → Feb 28 (real calendar clamp)');
}

/* footer count + draft carries the editor state */
{
  ok(/reminder\(s\) armed/.test($('#footerCounts').textContent), 'footer counts armed reminders');
  $('#newTaskBtn').click(); await sleep(80);
  $('#f-title').value = 'Draft kid'; $('#f-due').value = '2026-11-01';
  $('#addRemBtn').click(); await setRowType(0, 'h2');
  await sleep(1400);
  const d = JSON.parse(window.localStorage.getItem('todo_draft_v1') || '{}');
  ok(d.remRows && d.remRows.length === 1 && d.remRows[0].reminderType === 'h2', 'draft autosave carries reminder rows (survives crash before save)');
  $('#cancelTaskBtn').click(); await sleep(80);
}

/* RESTART CATCH-UP: fresh boot from the mirror — detect overdue, skip unsafe,
   re-arm future, no duplicate notifications (this is THE spec scenario). */
{
  const seed = {
    app: 'zerotodo', type: 'backup', schemaVersion: 5, savedAt: Date.now() + 60000, settings: {},
    tasks: [
      { id: 'bt1', title: 'Overdue live', status: 'active', dueDate: '2026-09-18', dueTime: null, priority: 'med', tags: [], projectId: null, recurrence: null, createdAt: 1, updatedAt: 1, sortOrder: 0, description: '' },
      { id: 'bt2', title: 'Done one', status: 'completed', dueDate: '2026-09-18', dueTime: null, priority: 'med', tags: [], projectId: null, recurrence: null, createdAt: 1, updatedAt: 1, sortOrder: 0, description: '' },
      { id: 'bt3', title: 'Future one', status: 'active', dueDate: '2026-10-01', dueTime: null, priority: 'med', tags: [], projectId: null, recurrence: null, createdAt: 1, updatedAt: 1, sortOrder: 0, description: '' },
      { id: 'bt5', title: 'Other tab one', status: 'active', dueDate: '2026-09-18', dueTime: null, priority: 'med', tags: [], projectId: null, recurrence: null, createdAt: 1, updatedAt: 1, sortOrder: 0, description: '' },
    ],
    trash: [{ id: 'bt4', title: 'Trashed one', status: 'active', dueDate: '2026-09-18', dueTime: null, priority: 'med', tags: [], projectId: null, recurrence: null, trashedAt: 2, createdAt: 1, updatedAt: 1, sortOrder: 0, description: '' }],
    projects: [], subtasks: [],
    reminders: [
      { id: 'br1', taskId: 'bt1', triggerAt: Date.now() - 7200e3, reminderType: 'onTime', enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'br2', taskId: 'bt5', triggerAt: Date.now() - 7200e3, reminderType: 'onTime', enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'br3', taskId: 'bt3', triggerAt: Date.now() + 86400e3, reminderType: 'd1', enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'br4', taskId: 'bt4', triggerAt: Date.now() - 7200e3, reminderType: 'onTime', enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
    ],
  };
  const dom3 = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dom3.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom3.window.localStorage.setItem('todo_backup_v1', JSON.stringify(seed));
  dom3.window.localStorage.setItem('zt_rem_fired_v1', JSON.stringify({ br2: Date.now() - 1000 })); // pretend br2 was already handled in another tab
  dom3.window.eval(storageSrc); dom3.window.eval(appSrc);
  await sleep(900);
  const m3 = JSON.parse(dom3.window.localStorage.getItem('todo_backup_v1'));
  const g = (id) => m3.reminders.find((r) => r.id === id);
  ok(g('br1').status === 'triggered' && g('br1').delivered === true, 'boot: overdue pending reminder for a live task → caught up + delivered');
  ok(g('br2').status === 'triggered' && g('br2').delivered === true, 'boot: ledger-marked reminder is NOT re-notified (duplicate prevented), record settles');
  ok(g('br3').status === 'pending', 'boot: future reminder stays pending (re-armed from the record, no in-memory-only timer)');
  ok(g('br4').status === 'skipped', 'boot: reminder of a TRASHED task is skipped, never fired');
  const toasts3 = [...dom3.window.document.querySelectorAll('.toast-rem')].map((e) => e.textContent);
  ok(toasts3.length === 1 && /Overdue live/.test(toasts3[0]), 'exactly ONE alert for the one genuinely-missed reminder (completed/trashed/ledgered stay silent)');
  dom3.window.close();
}

/* refresh persistence: reminders ride the same mirror as everything else */
{
  const m4 = remMirror();
  ok(m4.schemaVersion === 5 && m4.reminders.length >= 6, 'mirror (the refresh source of truth) carries the reminder records at schema v5');
  ok(m4.reminders.every((r) => m4.tasks.some((t) => t.id === r.taskId)), 'no orphan reminders persist — cleanup on every path held');
}

console.log(failed ? `\n${failed} UI check(s) FAILED` : '\nAll UI smoke checks passed.');
process.exit(failed ? 1 : 0);
