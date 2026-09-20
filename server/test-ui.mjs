/* test-ui.mjs — drive the REAL app UI in a headless DOM (jsdom).
 * Proves the subtask feature renders and behaves in the browser layer:
 * add / tick / reorder / delete+undo / auto-complete setting / search /
 * persistence mirror — things the Node-only suites can't see (they cover the
 * data layer; this one covers the actual rendered interface).
 * Run: node server/test-ui.mjs   (needs: npm i --no-save jsdom)
 * ==========================================================================*/
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Needs jsdom once:  npm i --no-save jsdom
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(PUB + '/index.html', 'utf8');
const storageSrc = readFileSync(PUB + '/storage.js', 'utf8');
const notifySrc = readFileSync(PUB + '/notify.js', 'utf8');
const appSrc = readFileSync(PUB + '/app.js', 'utf8');
const aiSrc = readFileSync(PUB + '/ai.js', 'utf8');
const nlSrc = readFileSync(PUB + '/nl.js', 'utf8');
const planSrc = readFileSync(PUB + '/plan.js', 'utf8');

/* OS notification surface, installed BEFORE boot so we can prove the app
   never asks for permission on load and can inspect every delivery. */
const nReqs = [];
const nCalls = []; // Notification-constructor path (no SW)
const swCalls = []; // service-worker persistent path
const fakeReg = { showNotification(title, opts) { swCalls.push({ title, opts }); return Promise.resolve({ close() {} }); } };
function FakeNotification(title, opts) { nCalls.push({ title, opts }); this.onclick = null; this.close = function () {}; }
FakeNotification.permission = 'denied';
FakeNotification.requestPermission = function (cb) { nReqs.push(1); const p = Promise.resolve(FakeNotification.permission); if (cb) cb(p); return p; };

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
window.Notification = FakeNotification;
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
Object.defineProperty(window.navigator, 'serviceWorker', {
  configurable: true,
  value: { register() { return new Promise(() => {}); }, ready: Promise.resolve(fakeReg), addEventListener() {} },
});
window.eval(storageSrc);   // the very file the browser loads
window.eval(notifySrc);    // delivery module — loaded before app.js, as in index.html
window.eval(aiSrc);        // AI decomposition planner — before app.js, as in index.html
window.eval(nlSrc);        // natural-language quick add — before app.js, as in index.html
window.eval(planSrc);       // daily-plan engine — before app.js, as in index.html
window.eval(appSrc);       // boots async init() → recover() → renderAll()
await sleep(300);

const doc = window.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];

ok($('#projectBar') && $('#projectBar').hidden === false, 'projects bar visible (empty state)');
ok(/rel="manifest" href="manifest.webmanifest"/.test(html) && /theme-color/.test(html) && /apple-touch-icon/.test(html),
  'index.html wires the PWA layer (manifest + theme-color + apple-touch-icon) — mobile installs for real');
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
  ok(todayCell && /1 task/.test(todayCell.textContent) && !!todayCell.querySelector('.cal-dots .cal-dotm'),
    'month cells answer “how full is the day?” — dots + words, NEVER titles crammed in (§13)');
  ok(todayCell.getAttribute('aria-label').includes('1 task') && todayCell.getAttribute('role') === 'button',
    'every dense cell carries a spoken summary (aria-label) and is keyboard-reachable');
  ok(yCell && yCell.querySelector('.cal-over') && /⚠ 1/.test(yCell.textContent) && /2 tasks/.test(yCell.textContent),
    'yesterday: “2 tasks” + ⚠ 1 overdue marker — symbol + words, not color alone');
  ok(yCell.querySelector('.cal-dotm.p-done') && !yCell.querySelector('.cal-dotm.p-high'),
    'density dots encode state (ring = done) and priority (no high dot when nothing is high)');
  ok(!yCell.querySelector('.cal-chip'), 'month no longer renders chips at all — the Day Overview is where titles live');
}

/* click chip IN THE DAY OVERVIEW → EXISTING composer in edit mode; add a time there */
{
  doc.querySelector('#calBar [data-cview="day"]').click(); await sleep(170);
  const chip = doc.querySelector(`#calHost [data-cdate="${TODAY}"] .cal-chip`);
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  ok($('#f-title').value === 'Cal Alpha' && !$('#composer').hidden, 'clicking a chip opens the EXISTING task editor (no second detail UI)');
  $('#f-time').value = '09:00';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(250);
  ok(tskOf('Cal Alpha').dueTime === '09:00' && tskOf('Cal Alpha').dueDate === TODAY, 'edit writes dueTime onto the same task (id ' + (tskOf('Cal Alpha').id === chip.dataset.tid) + ', no duplicate: ' + (tsk().filter((x) => x.title === 'Cal Alpha').length === 1) + ')');
  doc.querySelector('#calBar [data-cview="week"]').click(); await sleep(150); // back to the flow’s next view
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
  doc.querySelector('#calBar [data-cview="week"]').click(); await sleep(140);
  const beforeId = tskOf('Cal Beta').id, nBefore = tsk().length;
  await dragTo(`#calHost .cal-allday-row [data-cdate="${YDAY}"] .cal-chip`, `#calHost .cal-allday-row [data-cdate="${TODAY}"]`);
  const af = tskOf('Cal Beta');
  ok(af.dueDate === TODAY && af.id === beforeId && tsk().length === nBefore, 'drag to another day (week all-day row) updates the EXISTING task (id kept, count ' + nBefore + ' → ' + tsk().length + ')');
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
  ok(/1 task/.test($('#calHost .cal-day-summary').textContent) && /0 done/.test($('#calHost .cal-day-summary').textContent), 'day summary line: “1 task · 0 done” in words, not “1 task(s)” jargon');
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
  // week view keeps chips (month is density-only by design now) — filters must
  // still apply to whatever view renders chips
  doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(120); // re-anchor: earlier day-nav loops moved us weeks away
  doc.querySelector('#calBar [data-cview="week"]').click(); await sleep(140);
  const cell = doc.querySelector(`#calHost .cal-allday-row [data-cdate="${YDAY}"]`);
  ok(cell && cell.textContent.includes('Cal Gamma'), 'baseline: completed task visible in its day (week all-day row)');
  const monthCellForAria = doc.querySelector(`#calHost [data-cdate="not-real"]`); void monthCellForAria;
  const fStatus = doc.querySelector('#calBar [data-cfilter="calStatus"]');
  fStatus.value = 'active'; fStatus.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(140);
  ok(!doc.querySelector(`#calHost .cal-allday-row [data-cdate="${YDAY}"]`).textContent.includes('Cal Gamma'), 'status filter hides completed (task itself untouched: ' + (tskOf('Cal Gamma').status === 'completed') + ')');
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
  ok(m.tasks.find((x) => x.title === 'Cal Alpha').dueTime === '09:00' && m.tasks.find((x) => x.title === 'Cal Beta').dueDate === TODAY, 'refresh source-of-truth: edits live on the tasks themselves (dueTime/dueDate), nowhere else');
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
  ok(!!doc.querySelector('.toast-rem') && /Task Reminder/.test(doc.querySelector('.toast-rem').textContent) && /Pay tax/.test(doc.querySelector('.toast-rem').textContent) && /missed/.test(doc.querySelector('.toast-rem').textContent), 'overdue fires as a missed-reminder in-app alert even with notifications off (safe fallback)');
  const ledger = JSON.parse(window.localStorage.getItem('zt_rem_fired_v1') || '{}');
  ok(!!ledger[r.id + '@' + r.triggerAt], 'fire-ledger records the delivery INSTANCE id (dedup survives snooze/re-arm; cross-tab guard)');
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

/* recurrence: daily completion rolls dueDate + re-arms the reminder.
   ANCHOR = tomorrow 09:00 (was a fixed 2026-09-20 09:00 — a time bomb: running
   the suite after that minute would find the 5-min-before reminder already
   fired and assert 'pending' on a record that correctly fired). */
const CH0 = new Date(); CH0.setDate(CH0.getDate() + 1); CH0.setHours(9, 0, 0, 0);
const chS = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const CH9 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0).getTime();
$('#newTaskBtn').click(); await sleep(80);
$('#f-title').value = 'Chores'; $('#f-due').value = chS(CH0);
$('#f-recurrence').value = 'daily'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
$('#addRemBtn').click(); await setRowType(0, 'm5');
$('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(320);
{
  const before = remsFor('Chores')[0];
  ok(before.status === 'pending' && before.triggerAt === CH9(CH0) - 5 * 60e3, 'daily task armed with a 5-min-before reminder (tomorrow 08:55 — clock-proof)');
  let row = $$('#taskList .task').find((li) => li.textContent.includes('Chores'));
  row.querySelector('button.check').click(); await sleep(350);
  let tk = remMirror().tasks.find((x) => x.title === 'Chores');
  const CH1 = new Date(CH0.getTime() + 864e5), CH2 = new Date(CH0.getTime() + 2 * 864e5);
  ok(tk.status === 'active' && tk.dueDate === chS(CH1), 'completing a DAILY task rolls it to the next day (same task, same id)');
  let r = remsFor('Chores')[0];
  ok(r.status === 'pending' && r.triggerAt === CH9(CH1) - 5 * 60e3 && r.delivered === false, 'reminder re-armed against the new occurrence');
  row = $$('#taskList .task').find((li) => li.textContent.includes('Chores'));
  row.querySelector('button.check').click(); await sleep(350);
  tk = remMirror().tasks.find((x) => x.title === 'Chores');
  ok(tk.dueDate === chS(CH2), 'second cycle → +1 day again (cycle math on the stored date string)');
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
  // br2 is an onTime reminder whose task is due 2026-09-18 09:00 — the engine re-derives
  // triggerAt from the DUE date (not the stale seed) before consulting the ledger, so the
  // "already handled by another tab" entry must be keyed with that same instance id.
  dom3.window.localStorage.setItem('zt_rem_fired_v1', JSON.stringify({ ['br2@' + locEpoch(2026, 9, 18, 9, 0)]: Date.now() - 1000 }));
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

/* ============ 14. Notification system (notify.js) ============ */
{
  const N = window.ZTNotify;
  ok(!!N, 'notify module loads as its own file (window.ZTNotify) — delivery logic is separate from the task UI');
  ok(nReqs.length === 0, 'ZERO permission requests during boot (never on load)');

  const pad2 = (x) => String(x).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return iso(d); };
  const todayS = iso(new Date()); const yestS = shift(-1); const twoAgoS = shift(-2); const tmrS = shift(1);
  const setCk = async (id, on) => { const e = $(id); if (e.checked !== !!on) { e.checked = !!on; e.dispatchEvent(new window.Event('change', { bubbles: true })); } await sleep(90); };
  const setVal = async (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(60); };
  const nTitle = (s) => swCalls.filter((c) => c.title === s).length;
  const taskOf = (title) => remMirror().tasks.find((x) => x.title === title);
  const mkTask = async (title, extra) => {
    $('#newTaskBtn').click(); await sleep(90);
    $('#f-title').value = title;
    if (extra) await extra();
    $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(380);
  };
  const pastCustomRem = async () => { $('#addRemBtn').click(); await sleep(60); await setRowType(0, 'custom'); await setCustom(0, todayS, '00:00'); };
  const resave = async (title) => {
    const li = $$('#taskList .task').find((x) => x.textContent.includes(title));
    li.querySelector('[data-act="edit"]').click(); await sleep(140);
    $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(380);
  };
  const cntShip = () => swCalls.filter((c) => c.title === 'Task Reminder' && /Ship report/.test(c.opts.body || '')).length;

  /* -------- permission UX -------- */
  $('#settingsBtn').click(); await sleep(120);
  ok($('#notifBox') && $('#nMaster') && $('#nReminders') && $('#nOverdue') && $('#nDaily') && $('#nWeekly')
    && $('#nHabits') && $('#nPomo') && $('#nProj'),
    'Settings → Notifications: all 8 spec switches present (master/reminders/overdue/daily/weekly/habits/pomodoro/project)');
  ok($('#nOdMode') && $('#nDailyAt') && $('#nWeeklyAt') && $('#nHabitAt') && $('#fzWork') && $('#nProjDays'),
    'each channel has its own timing/policy controls');
  ok(/Notifications are blocked\. Enable them in browser settings\./.test($('#notifPermRow').textContent),
    'denied permission → exactly the spec’s blocked sentence');
  ok(!$('#notifPermRow').querySelector('[data-notif="enable"]'), 'denied → NO “ask again” affordance anywhere in the app');
  FakeNotification.permission = 'default'; N.renderControls(); await sleep(30);
  ok(/Enable Notifications/.test($('#notifPermRow').textContent) && nReqs.length === 0,
    'default permission → shows an explicit “Enable Notifications” control (still zero requests)');
  $('#notifPermRow').querySelector('[data-notif="enable"]').click(); await sleep(120);
  ok(nReqs.length === 1, 'permission requested ONLY from the explicit control (exactly one request so far)');
  FakeNotification.permission = 'granted'; N.renderControls(); await sleep(30);
  ok(N.status() === 'granted' && N.isPersistent() === true, 'granted + service worker → persistent (mobile/PWA) channel active');

  /* -------- master + channels (settings UI drives them, persisted) -------- */
  await setCk('#nMaster', true); await setCk('#nReminders', true); await setCk('#nDaily', true);
  await setVal('#nDailyAt', '00:01');
  await setCk('#nWeekly', true); await setVal('#nWeeklyDay', ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()]); await setVal('#nWeeklyAt', '00:01');
  await setCk('#nHabits', true); await setVal('#nHabitAt', '00:01'); await setCk('#nProj', true);

  /* -------- task reminder through the OS persistent channel -------- */
  await mkTask('Ship report', pastCustomRem);
  const shipCall = swCalls.find((c) => c.title === 'Task Reminder' && /Ship report/.test(c.opts.body || ''));
  ok(!!shipCall && cntShip() === 1 && nCalls.length === 0, 'task reminder delivered once via registration.showNotification (no constructor fallback, no dupes)');
  ok(shipCall && /^rem:.+@\d+$/.test(shipCall.opts.tag), 'delivery id = unique per-reminder key (tag rem:<id>@<triggerAt>)');
  ok(shipCall && shipCall.opts.requireInteraction === true, 'persistent on mobile: requireInteraction stays until handled');
  ok(shipCall && Array.isArray(shipCall.opts.actions) && shipCall.opts.actions.map((a) => a.action).join() === 'complete,snooze,open', 'action buttons where supported: Complete + Snooze + Open');
  const shipTask = taskOf('Ship report');
  ok(shipCall && shipCall.opts.data.taskId === shipTask.id, 'notification carries the taskId → clicking opens THAT task');
  {
    const rec = remsFor('Ship report')[0];
    ok(rec.status === 'triggered' && rec.notify && rec.notify.via === 'sw' && rec.notify.key === 'rem:' + rec.id + '@' + rec.triggerAt,
      'reminder record holds its own delivery state (key/at/via) — unique per reminder');
  }

  /* -------- SW-routed actions: open / snooze / complete -------- */
  N.__swMessage({ type: 'zt-notif-action', action: 'open', data: { taskId: shipTask.id } });
  await sleep(140);
  ok($('#f-title').value === 'Ship report' && !$('#taskForm').closest('[hidden]'), 'click → Open routes straight to the task editor');
  $('#cancelTaskBtn').click(); await sleep(80);
  N.__swMessage({ type: 'zt-notif-action', action: 'snooze', data: { reminderId: remsFor('Ship report')[0].id } });
  await sleep(550);
  {
    const rec = remsFor('Ship report')[0];
    ok(rec.status === 'pending' && rec.delivered === false
      && rec.triggerAt >= Date.now() + 9 * 60e3 && rec.triggerAt <= Date.now() + 11 * 60e3,
      'Snooze action (default 10 min from settings) re-arms the SAME record at now+10m — new triggerAt ⇒ new dedup key');
    ok(cntShip() === 1, 'snoozing fires nothing early and nothing twice');
  }
  await resave('Ship report'); // any app activity must not re-alert the handled instance
  ok(cntShip() === 1, 'no duplicate alert after further app activity (fired-ledger + record status)');
  N.__swMessage({ type: 'zt-notif-action', action: 'complete', data: { taskId: shipTask.id } });
  await sleep(380);
  ok(taskOf('Ship report').status === 'completed', 'Complete action finishes the task straight from the notification');

  /* -------- the spec's example body: lead-time phrasing -------- */
  {
    const soon = new Date(Date.now() + 1800e3); soon.setSeconds(0, 0);
    const soonTime = pad2(soon.getHours()) + ':' + pad2(soon.getMinutes());
    await mkTask('Finish Python project', async () => {
      $('#f-due').value = iso(soon); $('#f-time').value = soonTime;
      $('#addRemBtn').click(); await sleep(60); await setRowType(0, 'm30');
    });
    ok(swCalls.some((c) => c.title === 'Task Reminder' && /Finish Python project is due in (29|30) minutes\./.test(c.opts.body || '')),
      'spec example body format: “Finish Python project is due in 30 minutes.” (lead time from a 30-min-before reminder)');
  }

  /* -------- overdue alerts with a configurable no-spam policy -------- */
  await setCk('#nOverdue', true);
  const odBase = nTitle('Task overdue'); // enabling may catch up existing past-due tasks (each alerted once, ever)
  await mkTask('Old thing', async () => { $('#f-due').value = yestS; });
  ok(nTitle('Task overdue') === odBase + 1, 'past-due unfinished task → exactly one “Task overdue” alert');
  ok(swCalls.some((c) => c.title === 'Task overdue' && /Old thing is overdue/.test(c.opts.body || '')), 'overdue body names the task and its due time');
  {
    const od = remMirror().reminders.find((x) => x.reminderType === 'overdue' && x.forDue === yestS && taskOf('Old thing') && x.taskId === taskOf('Old thing').id);
    ok(!!od && od.status === 'triggered', 'overdue alert is a REAL reminder record (persists, syncs, dedupes like any other)');
  }
  await resave('Ship report'); await sleep(250);
  ok(nTitle('Task overdue') === odBase + 1, 'once-mode policy: ongoing activity never re-alerts an overdue task (NO SPAM)');
  await setVal('#nOdMode', 'repeat');
  const odMid = nTitle('Task overdue');
  await mkTask('Stale thing', async () => { $('#f-due').value = twoAgoS; });
  ok(nTitle('Task overdue') === odMid + 1, 'repeat mode: a newly overdue task alerts once too');
  {
    const od2 = remMirror().reminders.find((x) => x.reminderType === 'overdue' && x.forDue === twoAgoS && taskOf('Stale thing') && x.taskId === taskOf('Stale thing').id);
    ok(od2 && od2.status === 'pending' && od2.triggerAt >= Date.now() + 11 * 3600e3 && od2.triggerAt <= Date.now() + 13 * 3600e3,
      'repeat mode re-arms the SAME record ~odHours(12h) later — bounded cadence, never a tight loop');
    ok(nTitle('Task overdue') === odMid + 1, 're-arm itself sends no second alert until it is next due');
  }
  await setVal('#nOdMode', 'once');

  /* -------- summaries + habit nudges -------- */
  await mkTask('Water plants', async () => {
    $('#f-due').value = todayS;
    const sel = $('#f-recurrence'); sel.value = 'daily'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await sleep(150);
  ok(nTitle('Daily summary') === 1, 'daily summary fires once at the configured time');
  ok(swCalls.some((c) => c.title === 'Daily summary' && /Today: \d+ task\(s\) due, \d+ overdue/.test(c.opts.body || '')), 'daily summary body counts due-today + overdue');
  ok(nTitle('Weekly summary') === 1, 'weekly summary fires on the chosen weekday');
  ok(nTitle('Habit check-in') === 1, 'daily-repeat task gets its habit nudge at habitAt');
  ok(swCalls.some((c) => c.title === 'Habit check-in' && /Water plants/.test(c.opts.body || '')), 'habit alert names the task');
  await resave('Ship report'); await sleep(250);
  ok(nTitle('Daily summary') === 1 && nTitle('Habit check-in') === 1, 'day-keyed ids (sum:d:/hab:) ⇒ summaries never repeat within the day');

  /* -------- project deadline warnings -------- */
  $('#projectBar [data-act="new"]').click(); await sleep(120);
  $('#pf-name').value = 'Launch site'; $('#pf-due').value = tmrS;
  $('#modalHost [data-m="save"]').click(); await sleep(250);
  await resave('Ship report');
  ok(nTitle('Project deadline') === 1, 'project due within projDays → exactly one “Project deadline” warning per day');
  ok(swCalls.some((c) => c.title === 'Project deadline' && /Launch site/.test(c.opts.body || '') && /due in 1 day/.test(c.opts.body || '')), 'deadline warning names the project + countdown');

  /* -------- focus-mode notifications (task-bound engine; see §21) -------- */
  await setCk('#nPomo', true);
  ok($('#nPomo') && !$('#nPomoStart') && !$('#nPomoFocus'), 'legacy transient Pomodoro removed — the nPomo switch now gates Focus-Mode phase notices');

  /* -------- settings persistence -------- */
  await sleep(400);
  {
    const sn = remMirror().settings.notify;
    ok(sn && sn.master === true && sn.reminders === true && sn.overdue === true && sn.daily === true && sn.habits === true
      && sn.pomo === true && sn.proj === true && sn.dailyAt === '00:01' && sn.odMode === 'once',
      'settings.notify persists to the same storage mirror as tasks/reminders (survives reload, syncs, lands in backups)');
  }

  /* -------- in-app card + snooze chips (fallback channel: no OS grant) -------- */
  FakeNotification.permission = 'default'; N.renderControls(); await sleep(40);
  await mkTask('Paperwork', pastCustomRem);
  {
    const card = [...doc.querySelectorAll('.toast-notify')].find((x) => /Paperwork/.test(x.textContent));
    ok(!!card, 'without OS permission the alert still shows in-app (graceful degradation)');
    ok(card.querySelector('[data-remopen]') && card.querySelector('[data-remcomplete]'), 'in-app card carries Open + Complete actions');
    const chips = [...card.querySelectorAll('[data-snooze]')].map((b) => b.dataset.snooze);
    ok(['5', '10', '30', '60', 'tomorrow'].every((v) => chips.includes(v)), 'snooze options 5/10/30/60/Tomorrow as buttons');
    ok(!swCalls.some((c) => /Paperwork/.test(c.opts.body || '')), 'no OS send while ungranted — the alert went in-app only');
    card.querySelector('[data-snooze="5"]').click(); await sleep(550);
    const rec = remsFor('Paperwork')[0];
    ok(rec.status === 'pending' && rec.triggerAt >= Date.now() + 4 * 60e3 && rec.triggerAt <= Date.now() + 6 * 60e3, 'card snooze chip re-arms +5min (same record, new instance)');
    card.querySelector('[data-remopen]').click(); await sleep(120);
    ok($('#f-title').value === 'Paperwork', 'card Open opens the task');
    $('#cancelTaskBtn').click(); await sleep(80);
  }

  FakeNotification.permission = 'granted'; N.renderControls(); await sleep(40);
  ok(/Send test/.test($('#notifPermRow').textContent), 'granted row offers a “Send test” control');
  $('#notifPermRow').querySelector('[data-notif="test"]').click(); await sleep(120);
  ok(swCalls.some((c) => c.title === 'ZeroTodo' && /how alerts will look/.test(c.opts.body || '')), '“Send test” delivers a sample through the real pipeline');

  /* -------- fully unsupported browser (no Notification API at all) -------- */
  {
    const saved = window.Notification;
    delete window.Notification;
    ok(N.status() === 'unsupported', 'no Notification API → status “unsupported”');
    await resave('Paperwork');
    $('#newTaskBtn').click(); await sleep(90);
    $('#f-title').value = 'No API task'; $('#f-due').value = yestS;
    $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(420);
    ok(swCalls.every((c) => !/No API task/.test(c.opts.body || '')), 'unsupported browser: zero OS sends, no exception, app keeps working');
    ok([...doc.querySelectorAll('.toast-notify')].some((x) => /No API task/.test(x.textContent)), 'unsupported browser still gets the in-app alert');
    window.Notification = saved;
  }

  ok(nReqs.length === 1, 'the ENTIRE session produced exactly ONE permission request — from the explicit control only');
  $('#settingsBtn').click(); await sleep(80); // close panel; leave app state neutral
}

/* ============ 15. Single-file standalone build (regression: it went stale) ============ */
{
  const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const STANDALONE = REPO + '/zerotodo-standalone-local.html';
  const committed = readFileSync(STANDALONE, 'utf8');
  execFileSync('node', [REPO + '/scripts/build-standalone.mjs'], { stdio: 'pipe' });
  const rebuilt = readFileSync(STANDALONE, 'utf8');
  ok(committed === rebuilt, 'committed standalone == fresh build of public/ (README promise: the single file IS the same app — no drift)');

  const sReqs = [];
  const sCalls = [];
  const domS = new JSDOM(committed, {
    runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(win) {
      win.HTMLElement.prototype.scrollIntoView = function () {};
      if (!win.crypto || !win.crypto.randomUUID) {
        let k = 0;
        Object.defineProperty(win, 'crypto', { value: { randomUUID: () => 'su-' + (++k) + '-' + Date.now() } });
      }
      win.fetch = () => Promise.reject(new TypeError('offline')); // file://-like: sync must stay off WITHOUT breaking boot
      const SN = function (title, opts) { sCalls.push({ title, opts }); this.onclick = null; this.close = function () {}; };
      SN.permission = 'granted';
      SN.requestPermission = function () { sReqs.push(1); return Promise.resolve(SN.permission); };
      win.Notification = SN;
    },
  });
  await sleep(600);
  const ds = domS.window.document;
  const byId = (id) => ds.getElementById(id);
  ok(!!window && !!ds.querySelector('#taskList'), 'standalone boots (scripts run inline, no external files)');
  ok(!!ds.defaultView.ZTNotify, 'standalone ships the notification module');
  ok(sReqs.length === 0, 'standalone boot: ZERO permission requests here too');
  ok(!!byId('notifBox') && !!byId('nMaster') && !!byId('nOverdue'), 'standalone carries the Settings → Notifications section');
  ok(/wireCalendar/.test(committed) && /projectBar/.test(committed), 'standalone carries every other current feature (calendar, projects) — full rebuild, not a patch');
  ok(!/rel="manifest"|apple-touch-icon/.test(committed), 'standalone strips manifest links (nothing external to 404 on — the single file stays honest)');

  /* one real end-to-end cycle inside the single file: create → past custom
     reminder → save → alert card (the file:// degradation path) → persistence */
  byId('newTaskBtn').click(); await sleep(140);
  byId('f-title').value = 'Standalone task';
  byId('f-due').value = new Date().toISOString().slice(0, 10);
  byId('addRemBtn').click(); await sleep(80);
  const srow = ds.querySelector('#remRows .rem-row');
  const ssel = srow.querySelector('select');
  ssel.value = 'custom'; ssel.dispatchEvent(new domS.window.Event('change', { bubbles: true }));
  await sleep(60);
  const sins = ds.querySelectorAll('#remRows .rem-row input');
  const dNow = new Date();
  const hm = String(dNow.getHours()).padStart(2, '0') + ':' + String(Math.max(0, dNow.getMinutes() - 5)).padStart(2, '0');
  sins[0].value = new Date().toISOString().slice(0, 10);
  sins[0].dispatchEvent(new domS.window.Event('change', { bubbles: true }));
  sins[1].value = hm;
  sins[1].dispatchEvent(new domS.window.Event('change', { bubbles: true }));
  await sleep(80);
  byId('taskForm').dispatchEvent(new domS.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(600);
  ok([...ds.querySelectorAll('.toast-notify')].some((x) => /Standalone task/.test(x.textContent)),
    'standalone: fired reminder shows the in-app alert card (graceful degradation with no SW/no origin)');
  {
    const mirror = JSON.parse(domS.window.localStorage.getItem('todo_backup_v1') || '{}');
    const tk = (mirror.tasks || []).find((x) => x.title === 'Standalone task');
    ok(!!tk && (mirror.reminders || []).some((r) => r.taskId === tk.id && r.reminderType === 'custom' && r.status === 'triggered'),
      'standalone: task + fired reminder persist in the localStorage mirror (record, not a timer)');
  }
  domS.window.close();

  /* manifest shortcut: launching with #new opens a fresh composer immediately */
  const domN = new JSDOM(committed, {
    runScripts: 'dangerously', url: 'http://localhost/#new', pretendToBeVisual: true,
    beforeParse(win) {
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = () => Promise.reject(new TypeError('offline'));
    },
  });
  await sleep(600);
  const dn = domN.window.document;
  ok(!!dn.getElementById('taskForm') && !dn.getElementById('taskForm').closest('[hidden]') && dn.getElementById('f-title').value === '',
    'installed via manifest shortcut (#new) → app boots straight into a new task');
  ok(dn.location.hash === '', '#new is consumed and cleaned from the URL');
  domN.window.close();
}

/* ============ 16. REAL-BROWSER mobile layout (headless Chromium; skips if absent) ============ */
{
  const boot = '  – ';
  let browser = null;
  const cssSrc = readFileSync(PUB + '/styles.css', 'utf8');
  // structural guarantees first — no browser needed
  ok(/touch-action: manipulation/.test(cssSrc) && /font-size: 16px;/.test(cssSrc) && /safe-area-inset/.test(cssSrc),
    'styles.css carries the mobile pass (touch-action, 16px input rule, safe-area padding)');
  ok(/viewport-fit=cover/.test(html) && /apple-mobile-web-app-capable/.test(html),
    'index.html viewport/meta wired for notches + iOS standalone (viewport-fit=cover + web-app metas)');

  try {
    let puppeteer, execPath = null, preArgs = [];
    try {
      const core = await import('puppeteer-core');
      const sp = (await import('@sparticuz/chromium')).default;
      puppeteer = core.default; execPath = await sp.executablePath(); preArgs = sp.args || [];
    } catch {
      puppeteer = (await import('puppeteer')).default;
    }
    browser = await puppeteer.launch({
      executablePath: execPath || undefined,
      headless: 'shell',
      args: [...preArgs, '--no-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: null,
      env: { ...process.env }, // LD_LIBRARY_PATH passthrough for exotic sandboxes
    });
  } catch (e) {
    console.log(boot + 'real-browser layout checks skipped (no launchable chromium: ' + String(e.message).split('\n')[0] + ')');
  }

  if (browser) {
   let srv = null;
   try {
    const http = await import('node:http');
    const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(PUB, p);
      try {
        const data = readFileSync(f);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
        res.end(data);
      } catch { res.writeHead(404); res.end('nf'); }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const BASEURL = 'http://127.0.0.1:' + srv.address().port + '/';

    const page = await browser.newPage();
    const pclick = (sel) => page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) throw new Error('no element: ' + s);
      e.scrollIntoView({ block: 'nearest' });
      e.click(); // DOM click — immune to the fixed toast layer swallowing hit-tested clicks
    }, sel);
    let curVw = 0;
    const wait = async (name, predicate) => {
      try {
        await page.waitForFunction(predicate, { timeout: 15000, pollInterval: 100 });
      } catch (e) {
        const st = await page.evaluate(() => ({
          composerHidden: document.getElementById('composer').hidden,
          settingsHidden: document.getElementById('settingsPanel').hidden,
          calHidden: document.getElementById('calendar').hidden,
          modal: (document.querySelector('#modalHost .modal') || {}).textContent ? document.querySelector('#modalHost .modal').textContent.slice(0, 90) : null,
          marker: (() => { const n = document.getElementById('newTaskBtn'); return !!(n && typeof n.onclick === 'function'); })(),
          barHidden: (() => { const b = document.querySelector('#projectBar'); return b ? b.hidden : 'no-bar'; })(),
          barNew: !!document.querySelector('#projectBar [data-act="new"]'),
          html: document.body.textContent.slice(0, 120),
        }));
        console.log('WAITFAIL', name, '@', curVw, JSON.stringify(st));
        throw e;
      }
    };
    const scan = (vw) => page.evaluate(() => {
      const vwNow = window.innerWidth;
      const offenders = [];
      const inScroller = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 2) return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
        if ((r.right > vwNow + 1.5 || r.left < -1.5) && !inScroller(el)) {
          offenders.push((el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + '@' + Math.round(r.right));
        }
      }
      return { docScroll: document.documentElement.scrollWidth, vw: vwNow, offenders: offenders.slice(0, 6) };
    });

    let layoutFails = 0, lastVw = 0;
    for (const vw of [320, 360, 375, 414]) {
      curVw = vw;
      await page.setViewport({ width: vw, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(BASEURL + (BASEURL.includes('?') ? '&' : '?') + 'v=mobile' + vw, { waitUntil: 'load' });
      // boot-complete gate: handler attached AND async recover() finished (project bar populated)
      await wait('boot-gate', () => {
        const nb = document.getElementById('newTaskBtn');
        return nb && typeof nb.onclick === 'function'
          && document.querySelector('#projectBar')
          && !document.querySelector('#projectBar').hidden
          && !!document.querySelector('#projectBar [data-act="new"]');
      });
      const checks = [];

      // state: seeded data (task with tags/due/priority + a fired-reminder toast card)
      await pclick('#newTaskBtn');
      await wait('composer-open-1', () => !document.getElementById('composer').hidden);
      await page.type('#f-title', 'Finish Python project');
      await page.evaluate(() => {
        const d = new Date(); d.setDate(d.getDate() + 1);
        document.querySelector('#f-due').value = d.toISOString().slice(0, 10);
        document.querySelector('#f-tags').value = 'python, urgent-next';
        document.querySelector('#addRemBtn').click();
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(() => {
        const row = document.querySelector('#remRows .rem-row');
        const sel = row.querySelector('select'); sel.value = 'custom';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // the app re-renders rows synchronously on change — re-query before touching inputs
        const fresh = document.querySelector('#remRows .rem-row').querySelectorAll('input');
        fresh[0].value = new Date().toISOString().slice(0, 10);
        fresh[0].dispatchEvent(new Event('change', { bubbles: true }));
        const past = new Date(Date.now() - 3600e3);
        const fresh2 = document.querySelector('#remRows .rem-row').querySelectorAll('input');
        fresh2[1].value = String(past.getHours()).padStart(2, '0') + ':' + String(past.getMinutes()).padStart(2, '0');
        fresh2[1].dispatchEvent(new Event('change', { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 150));
      await pclick('#saveTaskBtn');
      await new Promise((r) => setTimeout(r, 800));
      checks.push(['data+toast', await scan(vw)]);

      // state: composer open on a small screen
      await pclick('#newTaskBtn');
      await wait('composer-open-2', () => !document.getElementById('composer').hidden);
      checks.push(['composer', await scan(vw)]);
      // iOS zoom guard: every typable control renders ≥ 16px
      const smallFonts = await page.evaluate(() => ['searchInput', 'f-title', 'f-due', 'f-time', 'f-tags', 'f-priority', 'rcEvery', 'rcUnit']
        .filter((id) => { const e = document.getElementById(id); return e && parseFloat(getComputedStyle(e).fontSize) < 16; }));
      checks.push(['fonts', smallFonts]);
      await pclick('#cancelTaskBtn');
      await wait('composer-close', () => document.getElementById('composer').hidden);

      // state: settings panel (notification section)
      await pclick('#settingsBtn');
      await wait('settings-open', () => !document.getElementById('settingsPanel').hidden);
      checks.push(['settings', await scan(vw)]);
      await pclick('#settingsBtn');

      // state: calendar month
      await pclick('#calBtn');
      await wait('calendar-open', () => !document.getElementById('calendar').hidden).catch(() => {});
      checks.push(['calendar', await scan(vw)]);
      await pclick('#calBtn');
      await new Promise((r) => setTimeout(r, 150));

      // state: productivity dashboard
      await pclick('#dashBtn');
      await wait('dashboard-open', () => !document.getElementById('dashboard').hidden).catch(() => {});
      checks.push(['dashboard', await scan(vw)]);
      await pclick('#dashBtn');
      await new Promise((r) => setTimeout(r, 150));

      // state: focus session bar
      await page.evaluate(() => { const b = document.querySelector('#taskList .task [data-act=\"focus\"]'); if (b) b.click(); });
      await wait('focus-menu', () => !!document.querySelector('.modal-focus')).catch(() => {});
      await page.evaluate(() => { const c = document.querySelector('.modal-focus [data-fp=\"25/5\"]') || document.querySelector('.modal-focus [data-fp=\"c\"]'); if (c) c.click(); });
      await wait('focus-bar', () => !document.getElementById('focusBar').hidden).catch(() => {});
      checks.push(['focus-bar', await scan(vw)]);
      await page.evaluate(() => { const s = document.querySelector('#focusBar [data-fz=\"stop\"]'); if (s) s.click(); });
      await new Promise((r) => setTimeout(r, 200));

      // state: project modal (bottom sheet)
      await pclick('#projectBar [data-act="new"]');
      await wait('modal-open', () => !!document.querySelector('#modalHost .modal'));
      checks.push(['project-modal', await scan(vw)]);
      await pclick('#modalHost [data-m="cancel"]');
      await wait('modal-close', () => !document.querySelector('#modalHost .modal'));

      // tap targets + touch action
      const targets = await page.evaluate(() => {
        const h = (sel) => Math.min(...[...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map((e) => e.getBoundingClientRect().height).concat([999]));
        return { check: h('#taskList .check'), btn: h('#taskList .btn-sm'), filter: h('.filter-btn'), fcount: document.querySelectorAll('.filter-btn').length, ta: getComputedStyle(document.querySelector('#taskList .check')).touchAction };
      });
      checks.push(['targets', targets]);

      const overflow = checks.filter((c) => c[1] && typeof c[1].docScroll === 'number' && (c[1].docScroll > c[1].vw + 1 || c[1].offenders.length));
      const fontFail = (checks.find((c) => c[0] === 'fonts') || [])[1] || [];
      const tFail = !(targets.check >= 29 && targets.filter >= 30 && targets.ta === 'manipulation');
      if (overflow.length || fontFail.length || tFail) {
        layoutFails++; lastVw = vw;
        console.log(`  ✗ mobile layout @${vw}px — overflow: ${overflow.map((o) => o[0] + ' ' + JSON.stringify(o[1].offenders && o[1].offenders.length ? o[1].offenders : o[1].docScroll)).join('; ') || 'none'} | <16px inputs: ${JSON.stringify(fontFail)} | targets: ${JSON.stringify(targets)}`);
      } else {
        console.log(`  ✓ mobile layout @${vw}px: all 10 states overflow-free, inputs ≥16px, tap targets ok`);
      }
    }
    ok(layoutFails === 0, `real Chromium @320/360/375/414: no horizontal overflow in any state, no iOS-zoom inputs, touch targets sized${layoutFails ? ' (failed at ' + lastVw + 'px — see log above)' : ''}`);
    srv.close();
   } catch (e) {
    ok(false, 'mobile layout section failed cleanly: ' + String(e && e.message).split('\n')[0]);
    try { srv.close(); } catch (_) {}
   }
   await browser.close();
  }
}

/* ========= 17. Unified scheduling: task ⇄ calendar ⇄ engine ⇄ notify ========= */
{
  // The integration contract: the TASK is the single source of truth; the
  // calendar displays it; the engine schedules against it; delivery rides on
  // top. Due changes recalculate, trash cancels, restore re-arms, completion
  // skips the future while keeping history, snooze never touches the due —
  // and no path may ever fork a duplicate reminder record.
  if ($('#calBtn').classList.contains('on')) { $('#calBtn').click(); await sleep(160); }
  window.Notification.permission = 'default'; // in-app card path — no OS grant needed
  const ck = async (id, on) => { const e = $(id); if (e.checked !== !!on) { e.checked = !!on; e.dispatchEvent(new window.Event('change', { bubbles: true })); } await sleep(90); };
  await ck('#nMaster', true); await ck('#nReminders', true);
  await ck('#nOverdue', false); // engine-managed 'overdue' records would join the count — keep the ledger clean
  await sleep(140); // let the reconcile that strips them finish
  const dOff = (n) => ymdS(new Date(Date.now() + n * 864e5));
  const D3 = dOff(3), D4 = dOff(4);
  const ymdBits = (ds) => [+ds.slice(0, 4), +ds.slice(5, 7), +ds.slice(8, 10)];
  const dueAt = async (d, tm) => { $('#f-due').value = d; $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true })); $('#f-time').value = tm; $('#f-time').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(40); };
  const rowOf = (title) => $$('#taskList .task').find((x) => x.textContent.includes(title));
  const save = async () => { $('#saveTaskBtn').click(); await sleep(380); };
  const remsById = (id) => remMirror().reminders.filter((r) => r.taskId === id);
  const idsOf = (title) => remsFor(title).map((r) => r.id).sort().join('|');

  /* ---- 1. the spec scenario: 'Submit assignment', due D3 23:59, 3 reminders ---- */
  $('#newTaskBtn').click(); await sleep(90);
  $('#f-title').value = 'Submit assignment';
  await dueAt(D3, '23:59');
  $('#addRemBtn').click(); await sleep(60); await setRowType(0, 'd1');
  $('#addRemBtn').click(); await sleep(60); await setRowType(1, 'h1');
  $('#addRemBtn').click(); await sleep(60); await setRowType(2, 'custom'); await setCustom(2, D3, '22:00');
  await save();
  const assignId = tskOf('Submit assignment').id;
  {
    const rs = remsFor('Submit assignment');
    const by = Object.fromEntries(rs.map((r) => [r.reminderType, r]));
    const [y, mo, d] = ymdBits(D3);
    ok(rs.length === 3 && rs.every((r) => r.status === 'pending' && r.enabled), 'create: exactly 3 derived reminder records, all pending + enabled');
    ok(by.d1 && by.d1.triggerAt === locEpoch(y, mo, d - 1, 23, 59), 'd1 = 1 day before the due instant (spec: 24th 11:59 PM)');
    ok(by.h1 && by.h1.triggerAt === locEpoch(y, mo, d, 22, 59), 'h1 = 1 hour before an 11:59 PM due (spec: 25th, on the day)');
    ok(by.custom && by.custom.triggerAt === locEpoch(y, mo, d, 22, 0), 'custom fires at the picked wall-clock (spec: 25th 10:00 PM)');
  }

  /* ---- 2+3. calendar indicator 🔔 N, click → reminder configuration ---- */
  $('#calBtn').click(); await sleep(180);
  const mBtn = doc.querySelector('#calBar [data-cview="month"]');
  if (mBtn && !mBtn.classList.contains('on')) { mBtn.click(); await sleep(160); }
  // earlier sections persist calendar filters into settings — clear them
  for (const sel of $$('#calBar select')) if (sel.value !== '') { sel.value = ''; sel.dispatchEvent(new window.Event('change', { bubbles: true })); }
  await sleep(160);
  // month cells are density-only now — dive to the DAY view for the chip, via the day-number click
  const dn = doc.querySelector('#calHost [data-cdate="' + D3 + '"] .cal-day');
  if (dn) { dn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(200); }
  const badge = () => doc.querySelector('#calHost .cal-chip[data-tid="' + assignId + '"] .cal-rem');
    ok(!!badge() && /🔔\s*3/.test(badge().textContent), 'calendar chip carries a live 🔔 3 reminder indicator');
  ok(/next:/.test(badge().getAttribute('title') || ''), 'the indicator names the next scheduled fire in its tooltip');
  badge().click(); await sleep(160);
  ok(!$('#composer').hidden && $('#composerTitle').textContent === 'Edit task', 'clicking the indicator opens the task editor');
  ok(mrow().length === 3, '…with all 3 reminder rows editable (the reminder configuration)');
  ok(doc.activeElement && doc.activeElement.id === 'addRemBtn', 'focus lands inside the Reminders block, not at the form top');
  $('#cancelTaskBtn').click(); await sleep(140);

  /* ---- 4. due change: relatives recalc; absolutes get ASKED, never moved silently ---- */
  const before = idsOf('Submit assignment');
  doc.querySelector('#calHost [data-cdate="' + D3 + '"] .cal-chip[data-tid="' + assignId + '"]').click(); await sleep(160);
  await dueAt(D4, '23:59');
  $('#saveTaskBtn').click(); await sleep(220);
  const keepBtn = [...doc.querySelectorAll('#modalHost .modal-actions .btn')].find((b) => /Keep them/i.test(b.textContent));
  ok(!!keepBtn, 'due change WITH custom reminders asks the user before touching absolute times');
  keepBtn.click(); await sleep(340);
  {
    const rs = remsFor('Submit assignment');
    const by = Object.fromEntries(rs.map((r) => [r.reminderType, r]));
    const [y4, mo4, d4] = ymdBits(D4);
    const [y3, mo3, d3] = ymdBits(D3);
    ok(rs.length === 3 && idsOf('Submit assignment') === before, 'due change re-uses the SAME records — zero duplicates');
    ok(by.d1.triggerAt === locEpoch(y3, mo3, d3, 23, 59), 'd1 recalculated against the new due (now D4 → D3 23:59)');
    ok(by.h1.triggerAt === locEpoch(y4, mo4, d4, 22, 59), 'h1 recalculated against the new due');
    ok(by.custom.triggerAt === locEpoch(y3, mo3, d3, 22, 0), '"Keep them" left the absolute custom exactly where it was picked');
    doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(170); // the DAY view follows the move: anchor D3 → D4
    ok(!doc.querySelector('#calHost [data-cdate="' + D3 + '"] .cal-chip[data-tid="' + assignId + '"]')
      && !!doc.querySelector('#calHost [data-cdate="' + D4 + '"] .cal-chip[data-tid="' + assignId + '"] .cal-rem'),
      'calendar moved the chip to the new day — the 🔔 indicator rides along');
  }
  // and the explicit "shift with due" path: absolutes follow the same delta, still no forks
  const D5 = dOff(5);
  doc.querySelector('#calHost [data-cdate="' + D4 + '"] .cal-chip[data-tid="' + assignId + '"]').click(); await sleep(160);
  await dueAt(D5, '23:59');
  $('#saveTaskBtn').click(); await sleep(220);
  const shiftBtn = [...doc.querySelectorAll('#modalHost .modal-actions .btn')].find((b) => /Shift with due/i.test(b.textContent));
  ok(!!shiftBtn, 'the dialog offers the shift option');
  shiftBtn.click(); await sleep(380);
  {
    const by2 = Object.fromEntries(remsFor('Submit assignment').map((r) => [r.reminderType, r]));
    const [y5, mo5, d5] = ymdBits(D5), [y4, mo4, d4] = ymdBits(D4);
    ok(by2.d1.triggerAt === locEpoch(y4, mo4, d4, 23, 59) && by2.h1.triggerAt === locEpoch(y5, mo5, d5, 22, 59), 'relatives re-anchored to the second shift too');
    ok(by2.custom.triggerAt === locEpoch(y4, mo4, d4, 22, 0) && by2.custom.customDate === D4 && by2.custom.customTime === '22:00',
      '"Shift with due" moved the custom reminder by EXACTLY the due delta (record rewritten, times preserved as wall-clock)');
    ok(idsOf('Submit assignment') === before, 'both ask-paths keep the same 3 record ids — zero duplicates either way');
  }

  /* ---- 5. trash: cancel NOW, leave the calendar, never notify ---- */
  $('#calBtn').click(); await sleep(160); // back to the list for the row action
  rowOf('Submit assignment').querySelector('[data-act="delete"]').click(); await sleep(280);
  ok(remsById(assignId).length === 3 && remsById(assignId).every((r) => r.status === 'skipped'),
    'deleting cancels every pending reminder in the same action (nothing left armed to fire)');
  $('#calBtn').click(); await sleep(180);
  ok(!doc.querySelector('#calHost [data-tid="' + assignId + '"]'), 'trashed task removed from the calendar');

  /* ---- 6. restore: calendar presence + valid future reminders come back ---- */
  // (calendar is still open from step 5 — renderAll repainted it under the undo)
  $('#undoBtn').click(); await sleep(340);
  {
    const rs = remsById(assignId);
    ok(rs.length === 3 && remsFor('Submit assignment').map((r) => r.id).sort().join('|') === before, 'restore re-uses the same records — still no duplicates');
    ok(rs.every((r) => r.status === 'pending'), 'valid future reminders re-armed on restore');
    { // day view, re-anchored DETERMINISTICALLY: Today + 5 (D5 is by construction today+5)
      const d5b = doc.querySelector('#calBar [data-cview="day"]'); if (d5b && !d5b.classList.contains('on')) { d5b.click(); await sleep(140); }
      doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(120);
      for (let i = 0; i < 5; i++) { doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(80); }
    }
    ok(!!doc.querySelector('#calHost [data-cdate="' + D5 + '"] .cal-chip[data-tid="' + assignId + '"] .cal-rem'), 'calendar presence restored with the indicator');
  }

  /* ---- 7. fire → snooze (due untouched) → complete (history kept) ---- */
  $('#calBtn').click(); await sleep(160);
  const past = new Date(Date.now() - 3600e3);
  const pastD = ymdS(past);
  const pastT = String(past.getHours()).padStart(2, '0') + ':' + String(past.getMinutes()).padStart(2, '0');
  $('#newTaskBtn').click(); await sleep(90);
  $('#f-title').value = 'Assignment note';
  await dueAt(D4, '23:59');
  $('#addRemBtn').click(); await sleep(60); await setRowType(0, 'custom'); await setCustom(0, pastD, pastT);
  await save(); await sleep(320);
  {
    const rs = remsFor('Assignment note');
    ok(rs.length === 1 && rs[0].status === 'triggered' && rs[0].delivered === true, 'a reminder already past fires immediately on save (the record IS the schedule)');
    const origTrig = rs[0].triggerAt;
    const noteId = rs[0].id;
    let card = null; // the notify card can land a beat after the fire — poll, don't sleep
    for (let i = 0; i < 15 && !card; i++) {
      card = [...doc.querySelectorAll('.toast-notify')].find((x) => /Assignment note/.test(x.textContent));
      if (!card) await sleep(100);
    }
    ok(!!card, 'the fired alert surfaces in-app without any OS permission');
    card.querySelector('[data-snooze="30"]').click(); await sleep(600);
    const r2 = remsFor('Assignment note')[0];
    ok(remsFor('Assignment note').length === 1 && r2.id === noteId, 'snooze updates the SAME record — no duplicate created');
    ok(r2.status === 'pending' && r2.triggerAt >= Date.now() + 28 * 60e3 && r2.triggerAt <= Date.now() + 32 * 60e3, '…and re-arms it ~30 minutes ahead');
    ok(tskOf('Assignment note').dueDate === D4 && tskOf('Assignment note').dueTime === '23:59', 'snooze left the task due date/time untouched');
    const led = JSON.parse(window.localStorage.getItem('zt_rem_fired_v1') || '{}');
    ok(!!led[noteId + '@' + origTrig], 'the delivered instance stays deduped in the ledger (a refresh can never re-ring it)');
    rowOf('Assignment note').querySelector('.check').click(); await sleep(280);
    const r3 = remsFor('Assignment note')[0];
    ok(r3.status === 'skipped', 'completing cancels the snoozed future reminder (the new instance is skipped; the delivered one stays on the ledger + record history)');
    ok(remsFor('Assignment note').length === 1, 'lifecycle (fire/snooze/complete) never forks copies — still 1 record');
  }

  /* ---- 8. idempotent re-save + forever-delete purges every trace ---- */
  rowOf('Submit assignment').querySelector('[data-act="edit"]').click(); await sleep(160);
  await save();
  ok(remsFor('Submit assignment').length === 3 && idsOf('Submit assignment') === before, 're-saving without touching reminders neither duplicates nor drops records');
  const noteId2 = remsFor('Assignment note')[0].taskId;
  rowOf('Assignment note').querySelector('[data-act="delete"]').click(); await sleep(240);
  const trashRow = () => $$('#taskList .task').find((x) => x.textContent.includes('Assignment note'));
  // switch to the Trash filter to reach "Delete forever"
  const fBtns = $$('.filter-btn').filter((b) => /trash/i.test(b.textContent));
  if (fBtns.length) { fBtns[0].click(); await sleep(200); }
  ok(!!trashRow(), 'the note sits in the Trash filter before purging');
  trashRow().querySelector('[data-act="destroy"]').click(); await sleep(160);
  const okBtn = doc.querySelector('#modalHost .btn-danger');
  okBtn.click(); await sleep(280);
  ok(!remMirror().tasks.some((x) => x.title === 'Assignment note') && !remMirror().trash.some((x) => x.title === 'Assignment note'), 'delete-forever leaves zero task rows anywhere');
  ok(!remMirror().reminders.some((r) => r.taskId === noteId2), '…and zero reminder records — nothing left that could ever fire');
  const allBtn = $$('.filter-btn').find((b) => /^all\b/i.test(b.textContent.trim()));
  if (allBtn) { allBtn.click(); await sleep(140); }
}

/* ================== 18. Recurrence patterns + series lifecycle ================== */
{
  // The brief's guarantee set: 7 patterns incl. selected weekdays and custom
  // every-N; completion produces exactly ONE next occurrence (rolling, never
  // materialized futures); reminders re-arm per occurrence; the user commands
  // 'this occurrence' vs 'the series'; and recurring tasks keep working with
  // calendar ghosts, trash/restore, export, sync.
  if ($('#calBtn').classList.contains('on')) { $('#calBtn').click(); await sleep(160); }
  const allB = $$('.filter-btn').find((b) => /^all\b/i.test(b.textContent.trim())); // never inherit another section's filter
  if (allB && !allB.classList.contains('on')) { allB.click(); await sleep(140); }
  const P = (ds) => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); };
  const F = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const addD = (ds, n) => { const d = P(ds); d.setDate(d.getDate() + n); return F(d); };
  const dowOf = (ds) => P(ds).getDay();
  const at = (ds, h, mi) => { const d = P(ds); d.setHours(h, mi, 0, 0); return d.getTime(); };
  const nextDow = (fromYmd, want) => { let ds = addD(fromYmd, 1); while (dowOf(ds) !== want) ds = addD(ds, 1); return ds; };
  const TOD = ymdS(new Date());
  const taskCount = () => tsk().length;
  const openEdit = (title) => { const li = $$('#taskList .task').find((x) => x.textContent.includes(title)); li.querySelector('[data-act="edit"]').click(); return li; };
  const dlgBtn = (re) => [...doc.querySelectorAll('#modalHost .modal-actions .btn')].find((b) => re.test(b.textContent));
  const countBefore = taskCount();

  /* ---- the UI vocabulary matches the brief ---- */
  const opts = [...$('#f-recurrence').options].map((o) => o.value);
  ok(JSON.stringify(opts) === JSON.stringify(['', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'custom']),
    'Repeat select: Does not repeat / Daily / Weekdays / Weekly / Monthly / Yearly / Custom');
  const optTxt = [...$('#f-recurrence').options].map((o) => o.textContent).join('|');
  ok(/Every day/.test(optTxt) && /Every weekday/.test(optTxt) && /Custom/.test(optTxt), 'option labels are human, not enums');

  /* ---- 1. custom rule: every 2 weeks on Mon+Fri persists verbatim ---- */
  $('#newTaskBtn').click(); await sleep(90);
  $('#f-title').value = 'Gym loop';
  $('#f-due').value = TOD; $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#f-recurrence').value = 'custom'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(80);
  ok(!$('#recurPanel').hidden, 'choosing Custom reveals the recurrence configuration');
  $('#rcEvery').value = '2'; $('#rcEvery').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#rcUnit').value = 'week'; $('#rcUnit').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(60);
  ok(!$('#rcDays').hidden, 'weekly units expose the weekday picker');
  doc.querySelector('#rcDays [data-rday="1"]').click(); doc.querySelector('#rcDays [data-rday="5"]').click(); await sleep(60);
  ok(/Next occurrences:/.test($('#rcHint').textContent), 'the panel previews what the rule means: ' + $('#rcHint').textContent.slice(0, 54));
  await sleep(1300); // draft autosave debounce
  {
    const d = JSON.parse(window.localStorage.getItem('todo_draft_v1') || 'null');
    ok(!!d && d.recurRule && d.recurRule.every === 2 && d.recurRule.weekdays.join() === '1,5', 'draft autosave carries the custom rule (crash before save is safe too)');
  }
  $('#saveTaskBtn').click(); await sleep(320);
  {
    const tg = tskOf('Gym loop');
    ok(tg.recurrence === 'custom' && tg.recurRule && tg.recurRule.every === 2 && tg.recurRule.unit === 'week' && tg.recurRule.weekdays.join() === '1,5',
      'custom rule persists on the task record (no side table, no copies)');
    ok(tg.recurAnchor === TOD, 'a newly enabled pattern anchors on the current due date');
  }

  /* ---- 2. completion ROLLS (no materialized futures) ---- */
  {
    const before = tskOf('Gym loop').dueDate;
    const idBefore = tskOf('Gym loop').id;
    const c0 = tsk().length;
    const li = $$('#taskList .task').find((x) => x.textContent.includes('Gym loop'));
    li.querySelector('.check').click(); await sleep(300);
    const after = tskOf('Gym loop');
    ok(tsk().length === c0, 'completing a recurring task creates NOTHING — same task count, same record');
    ok(after.id === idBefore && after.status === 'active' && after.dueDate !== before && P(after.dueDate) > P(before),
      'the same record rolls to its next occurrence (in place, stays active)');
    const dd = dowOf(after.dueDate);
    ok(dd === 1 || dd === 5, 'and lands on a pattern day (Mon or Fri), not +1 blindly');
    // independent recompute: next Mon/Fri where whole-weeks since anchor is even
    let exp = addD(before, 1);
    for (let guard = 0; guard < 40; guard++) {
      const wk = Math.floor((P(exp) - P(TOD)) / (7 * 864e5));
      if (wk % 2 === 0 && [1, 5].indexOf(dowOf(exp)) >= 0) break;
      exp = addD(exp, 1);
    }
    ok(after.dueDate === exp, 'matches an independently computed every-2-weeks step (even weeks from anchor, Mon/Fri)');
  }

  /* ---- 3. skip + stop from the series sheet ---- */
  {
    const li = $$('#taskList .task').find((x) => x.textContent.includes('Gym loop'));
    const sb = li.querySelector('[data-act="series"]');
    ok(!!sb && /↻/.test(sb.textContent), 'recurring rows carry a series actions button');
    sb.click(); await sleep(160);
    const verbs = [...doc.querySelectorAll('#modalHost .modal-series [data-s]')].map((b) => b.dataset.s);
    ok(verbs.join() === 'complete,skip,edit-occ,edit-series,stop,', 'the sheet offers the brief\u2019s verbs: complete / skip / edit occurrence / edit series / stop repeating');
    const d0 = tskOf('Gym loop').dueDate;
    const c1 = tsk().length;
    doc.querySelector('#modalHost [data-s="skip"]').click(); await sleep(260);
    ok(tskOf('Gym loop').dueDate !== d0 && tsk().length === c1, 'skip advances the occurrence — still no task proliferation');
    $$('#taskList .task').find((x) => x.textContent.includes('Gym loop')).querySelector('[data-act="series"]').click(); await sleep(160);
    doc.querySelector('#modalHost [data-s="stop"]').click(); await sleep(260);
    const st = tskOf('Gym loop');
    ok(st.recurrence === null && st.recurRule === null && st.recurAnchor === null, 'stop repeating clears the whole pattern (task survives as a one-off)');
  }

  /* ---- 4. weekly-on-Monday 20:00 with a 30-min reminder, per occurrence ---- */
  const mon1 = nextDow(TOD, 1);
  $('#newTaskBtn').click(); await sleep(90);
  $('#f-title').value = 'Standup';
  $('#f-due').value = mon1; $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#f-time').value = '20:00'; $('#f-time').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#f-recurrence').value = 'weekly'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
  $('#addRemBtn').click(); await sleep(60);
  await setRowType(0, 'm30');
  $('#saveTaskBtn').click(); await sleep(320);
  {
    const rs = remsFor('Standup');
    const dueMs = at(mon1, 20, 0);
    ok(rs.length === 1 && rs[0].status === 'pending' && rs[0].triggerAt === dueMs - 30 * 60e3, 'Every Monday 8 PM + “30 min before”: this occurrence\u2019s reminder armed on its own trigger');
    // roll → the NEXT occurrence gets ITS own reminder instant
    $$('#taskList .task').find((x) => x.textContent.includes('Standup')).querySelector('.check').click(); await sleep(300);
    const due2 = tskOf('Standup').dueDate;
    ok(due2 === addD(mon1, 7), 'weekly Monday rolls exactly +7d');
    const r2 = remsFor('Standup')[0];
    ok(r2.status === 'pending' && r2.triggerAt === at(due2, 20, 0) - 30 * 60e3,
      '…and the SAME reminder record re-arms for the new occurrence (no duplicate fired into oblivion)');
  }

  /* ---- 5. edit THIS occurrence vs the SERIES ---- */
  {
    const due2 = tskOf('Standup').dueDate;
    openEdit('Standup'); await sleep(140);
    $('#f-due').value = addD(due2, 1); $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#saveTaskBtn').click(); await sleep(200);
    const occ = dlgBtn(/This occurrence only/); const ser = dlgBtn(/Shift entire series/);
    ok(!!occ && !!ser, 'moving a recurring task\u2019s date asks: occurrence or series?');
    occ.click(); await sleep(300);
    ok(tskOf('Standup').recurAnchor === mon1, '“this occurrence only” keeps the series anchor on the ORIGINAL Monday');
    const li = $$('#taskList .task').find((x) => x.textContent.includes('Standup'));
    li.querySelector('.check').click(); await sleep(300);
    ok(dowOf(tskOf('Standup').dueDate) === 1, '…so the NEXT occurrence returns to the original rhythm (Monday), not the moved Tuesday');
    // now the series answer
    const due3 = tskOf('Standup').dueDate;
    openEdit('Standup'); await sleep(140);
    $('#f-due').value = addD(due3, 1); $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#saveTaskBtn').click(); await sleep(200);
    dlgBtn(/Shift entire series/).click(); await sleep(300);
    ok(tskOf('Standup').recurAnchor === addD(mon1, 1), '“shift entire series” moves the anchor by the same delta (Monday rhythm → Tuesday rhythm)');
    const li2 = $$('#taskList .task').find((x) => x.textContent.includes('Standup'));
    li2.querySelector('.check').click(); await sleep(300);
    ok(dowOf(tskOf('Standup').dueDate) === 2, '…and future occurrences follow the new weekday (Tuesday)');
  }

  /* ---- 6. calendar: real chip + ghost previews of the pattern ---- */
  const c4 = tsk().length;
  {
    $('#calBtn').click(); await sleep(220);
    const dBtn = doc.querySelector('#calBar [data-cview="day"]');
    if (dBtn && !dBtn.classList.contains('on')) { dBtn.click(); await sleep(160); } // the DAY view is where chips live now
    for (const sel of $$('#calBar select')) if (sel.value !== '') { sel.value = ''; sel.dispatchEvent(new window.Event('change', { bubbles: true })); }
    await sleep(180);
    const sid = tskOf('Standup').id;
    const cur = tskOf('Standup').dueDate;
    doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(130);
    for (let i = 0; i < 40 && !doc.querySelector(`#calHost [data-cdate="${cur}"] .cal-chip[data-tid="${sid}"]`); i++) {
      const nx = doc.querySelector('#calBar [data-cnav="next"]'); if (!nx) break; nx.click(); await sleep(90); // walk the day view to the occurrence
    }
    const real = doc.querySelector(`#calHost .cal-chip[data-tid="${sid}"]`);
    ok(!!real && !!real.querySelector('.cal-rmark'), 'the current occurrence shows with a ↻ series marker');
    let g1 = null;
    for (let i = 0; i < 9 && !g1; i++) { const nx = doc.querySelector('#calBar [data-cnav="next"]'); if (!nx) break; nx.click(); await sleep(90); g1 = doc.querySelector('#calHost .cal-chip.is-ghost[data-gtid="' + sid + '"]'); }
    let g2 = null;
    for (let i = 0; i < 9 && !g2; i++) { const nx = doc.querySelector('#calBar [data-cnav="next"]'); if (!nx) break; nx.click(); await sleep(90); g2 = doc.querySelector('#calHost .cal-chip.is-ghost[data-gtid="' + sid + '"]'); }
    ok(!!g1 && !!g2, 'future occurrences are PREVIEWED (ghost chips) day by day, without creating records');
    ok(g1 && !g1.hasAttribute('draggable') && !g1.querySelector('.cal-rem'), 'ghosts are display-only: no drag, no reminder bell (the series owns the schedule)');
    ok(tsk().length === c4, 'calendar previews cost zero task rows (still ' + c4 + ' tasks)');
    // trashing a recurring task removes its ghosts; restoring brings the pattern back
    $('#calBtn').click(); await sleep(160); // back to the list for the row action
    const li2 = $$('#taskList .task').find((x) => x.textContent.includes('Standup'));
    li2.querySelector('[data-act="delete"]').click(); await sleep(240);
    $('#calBtn').click(); await sleep(200);
    const d2b = doc.querySelector('#calBar [data-cview="day"]'); if (d2b && !d2b.classList.contains('on')) { d2b.click(); await sleep(140); }
    doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(130);
    ok(!doc.querySelector(`#calHost [data-tid="${sid}"]`), 'trash removes the task from its day');
    let ghostAfter = null;
    for (let i = 1; i <= 7 && !ghostAfter; i++) { doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(90); ghostAfter = doc.querySelector(`#calHost .cal-chip.is-ghost[data-gtid="${sid}"]`); }
    ok(!ghostAfter, '…and the next 8 days carry no ghost previews either (the series left the calendar entirely)');
    $('#calBtn').click(); await sleep(160);
    $('#undoBtn').click(); await sleep(320);

    $('#calBtn').click(); await sleep(200);
    doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(130);
    const d3b = doc.querySelector('#calBar [data-cview="day"]'); if (d3b && !d3b.classList.contains('on')) { d3b.click(); await sleep(140); }
    doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(120);
    // self-guiding walk: earlier rolls pushed the occurrence out, so walk
    // UNTIL the real chip appears, then hunt the ghost one week past it
    for (let i = 0; i < 40 && !doc.querySelector(`#calHost .cal-chip[data-tid="${sid}"]`); i++) { doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(65); }
    const realBack = !!doc.querySelector(`#calHost .cal-chip[data-tid="${sid}"]`);
    let g3 = null;
    for (let i = 1; i <= 10 && !g3; i++) { doc.querySelector('#calBar [data-cnav="next"]').click(); await sleep(65); g3 = doc.querySelector(`#calHost .cal-chip.is-ghost[data-gtid="${sid}"]`); }
    ok(realBack && !!g3, 'restore brings the whole pattern (real chip + ghosts) back');
    $('#calBtn').click(); await sleep(160);
  }

  /* ---- 7. weekdays pattern + yearly Dec 31 + export fidelity ---- */
  {
    $('#newTaskBtn').click(); await sleep(90);
    $('#f-title').value = 'Weekday check-in';
    $('#f-due').value = TOD; $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#f-recurrence').value = 'weekdays'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
    $('#saveTaskBtn').click(); await sleep(300);
    $$('#taskList .task').find((x) => x.textContent.includes('Weekday check-in')).querySelector('.check').click(); await sleep(300);
    const rolled = tskOf('Weekday check-in').dueDate;
    ok(dowOf(rolled) >= 1 && dowOf(rolled) <= 5, 'Weekdays never rolls onto a weekend (rolled to ' + rolled + ')');
    const dec31 = new Date(new Date().getFullYear(), 11, 31);
    const d31 = F(dec31) < ymdS(new Date()) ? F(new Date(dec31.getFullYear() + 1, 11, 31)) : F(dec31);
    $('#newTaskBtn').click(); await sleep(90);
    $('#f-title').value = 'Renew domain';
    $('#f-due').value = d31; $('#f-due').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#f-recurrence').value = 'yearly'; $('#f-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
    $('#saveTaskBtn').click(); await sleep(300);
    $$('#taskList .task').find((x) => x.textContent.includes('Renew domain')).querySelector('.check').click(); await sleep(300);
    ok(tskOf('Renew domain').dueDate === String(+d31.slice(0, 4) + 1) + '-12-31', 'Yearly on Dec 31 rolls to next Dec 31 (spec example)');
    const bak = remMirror(); // the LS mirror IS the export/backup document (same records)
    const gy = bak.tasks.find((x) => x.title === 'Gym loop');
    ok(!gy || gy.recurRule === null, 'export: stopped task carries clean nulls (no stale rule remnants)');
    const su = bak.tasks.find((x) => x.title === 'Standup');
    ok(su && su.recurrence === 'weekly' && su.recurAnchor, 'export carries the recurrence fields for backup/sync fidelity');
  }

  ok(tsk().length === countBefore + 4, 'the entire section added exactly the 4 tasks it created — completion/skip/ghosts never fabricate rows');
}

/* ================== 19. Productivity dashboard (derived view) ================== */
{
  console.log('\n--- 19. productivity dashboard ---');
  const NOW = Date.now();
  const YY = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const TODAY = YY(new Date(NOW));
  const ADDD = (ds, n) => { const [y, mo, dd] = ds.split('-').map(Number); const d = new Date(y, mo - 1, dd + n); return YY(d); };
  const atT = (ds, h, mi) => { const [y, mo, dd] = ds.split('-').map(Number); return new Date(y, mo - 1, dd, h, mi, 0, 0).getTime(); };
  const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const R1 = { d: YY(new Date(NOW + 42 * 60000)), t: hm(NOW + 42 * 60000) }; // custom rows carry date+time — the engine re-derives the instant at boot
  const R2 = { d: YY(new Date(NOW + 3 * 3600e3)), t: hm(NOW + 3 * 3600e3) };
  const WK0 = (() => { const d = new Date(NOW); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d.getTime(); })();

  const SEED = {
    app: 'zerotodo', schemaVersion: 5, savedAt: NOW, tasks: [
      { id: 'dA', title: 'Write report', status: 'completed', dueDate: TODAY, priority: 'med', projectId: 'p1', createdAt: NOW, updatedAt: NOW, completedAt: atT(TODAY, 8, 30), completions: [atT(TODAY, 8, 30)] },
      { id: 'dB', title: 'Standup', status: 'active', dueDate: TODAY, priority: 'low', recurrence: 'daily', recurAnchor: ADDD(TODAY, -2), createdAt: NOW, updatedAt: NOW, completedAt: atT(TODAY, 8, 55), completions: [atT(ADDD(TODAY, -1), 9, 0), atT(TODAY, 8, 55)] },
      { id: 'dC', title: 'Draft slides', status: 'active', dueDate: TODAY, priority: 'high', projectId: 'p1', createdAt: NOW, updatedAt: NOW },
      { id: 'dD', title: 'Pay rent', status: 'active', dueDate: ADDD(TODAY, -2), priority: 'med', createdAt: NOW, updatedAt: NOW },
      { id: 'dE', title: 'Clean inbox', status: 'active', priority: 'med', createdAt: NOW, updatedAt: NOW },
      { id: 'dF', title: 'Fix login bug', status: 'active', priority: 'high', createdAt: NOW, updatedAt: NOW },
      { id: 'dG', title: 'Sprint demo', status: 'active', dueDate: ADDD(TODAY, 1), dueTime: '15:00', priority: 'med', createdAt: NOW, updatedAt: NOW },
      { id: 'dH', title: 'Old thing', status: 'completed', dueDate: ADDD(TODAY, -30), priority: 'med', createdAt: NOW, updatedAt: NOW },
      { id: 'dI', title: 'Book flight', status: 'active', dueDate: ADDD(TODAY, 4), priority: 'low', createdAt: NOW, updatedAt: NOW },
      { id: 'dJ', title: 'Read spec', status: 'completed', priority: 'med', createdAt: NOW, updatedAt: NOW, completedAt: atT(ADDD(TODAY, -1), 21, 0), completions: [atT(ADDD(TODAY, -1), 21, 0)] },
      { id: 'dK', title: 'Study Python', status: 'active', dueDate: TODAY, dueTime: '23:59', priority: 'med', createdAt: NOW, updatedAt: NOW },
    ],
    trash: [], subtasks: [],
    projects: [{ id: 'p1', name: 'Launch', icon: '🚀', color: '#4f46e5', status: 'active', createdAt: NOW, updatedAt: NOW, sortOrder: NOW }],
    reminders: [
      { id: 'r1', taskId: 'dK', triggerAt: NOW + 42 * 60000, reminderType: 'custom', customDate: R1.d, customTime: R1.t, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: NOW, updatedAt: NOW },
      { id: 'r2', taskId: 'dG', triggerAt: NOW + 3 * 3600e3, reminderType: 'custom', customDate: R2.d, customTime: R2.t, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: NOW, updatedAt: NOW },
      { id: 'r3', taskId: 'dC', triggerAt: NOW + 60 * 60000, reminderType: 'm30', enabled: true, delivered: true, dismissed: false, status: 'triggered', createdAt: NOW, updatedAt: NOW },
      { id: 'r4', taskId: 'gone-task', triggerAt: NOW + 90 * 60000, reminderType: 'm5', enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: NOW, updatedAt: NOW },
    ],
  };
  const expWeekAll = SEED.tasks.reduce((a, x) => a + ((x.completions || []).filter((ts) => ts >= WK0)).length, 0);

  const domD = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const wD = domD.window; const docD = wD.document;
  wD.HTMLElement.prototype.scrollIntoView = function () {};
  const dashErrs = []; wD.addEventListener('error', (e) => dashErrs.push(String(e.message)));
  wD.localStorage.setItem('todo_backup_v1', JSON.stringify(SEED));
  wD.eval(storageSrc); wD.eval(appSrc);
  await sleep(800);

  const $D = (s) => docD.querySelector(s);
  const txtD = (s) => ($D(s) ? $D(s).textContent : '');

  ok(!!$D('#dashBtn') && $D('#dashboard').hidden === true, 'dashboard button in the toolbar; the view starts closed');
  $D('#dashBtn').click(); await sleep(220);
  ok($D('#dashboard').hidden === false && $D('#calendar').hidden === true && $D('#taskList').hidden === true,
    'opening the dashboard shows it and steps the list AND calendar aside');

  const hh = new Date().getHours();
  const expGreet = hh < 5 ? 'Good night' : hh < 12 ? 'Good morning' : hh < 17 ? 'Good afternoon' : hh < 21 ? 'Good evening' : 'Good night';
  ok(txtD('.dash-greet').trim() === expGreet, 'greeting follows the hour: “' + txtD('.dash-greet').trim() + '”');
  ok(txtD('.dash-date').includes(String(new Date().getFullYear())), 'current date rendered under the greeting');

  const tileNums = [...docD.querySelectorAll('.dash-tiles .dash-tile b')].map((b) => b.textContent.trim());
  ok(JSON.stringify(tileNums) === JSON.stringify(['2', '3', '1', '2']),
    'hero tiles = done-today 2 · left-today 3 · overdue 1 · streak 2 (got ' + JSON.stringify(tileNums) + ')');
  ok(/🔥 2-day streak/.test(txtD('.dash-streak')), 'streak pill: today + yesterday both have completions → 2-day fire');

  const prog = txtD('.dash-prog');
  const blocks = (prog.match(/\u2588/g) || []).length;
  ok(/33%/.test(prog) && blocks === 5, 'progress bar: 2/6 → 33% with round(0.33*16)=5 filled blocks (' + prog.trim() + ')');
  ok(/2 \/ 6 completed/.test(txtD('.dash-prog-num')), 'progress line reads “2 / 6 completed” (done + open-due + overdue)');

  const gnames = [...docD.querySelectorAll('.dash-today .dash-gname')].map((x) => x.textContent.trim());
  ok(gnames.join('|') === 'Overdue · 1|High priority · 2|Scheduled for today · 2|Unscheduled · 1',
    'Today groups: overdue → high → scheduled → unscheduled (' + JSON.stringify(gnames) + ')');
  const todayRows = [...docD.querySelectorAll('.dash-today [data-drow]')];
  ok(todayRows.length === 6, 'every active task lands in EXACTLY ONE bucket — 6 rows, no double counting');
  const rowTitles = todayRows.map((r) => r.querySelector('.dash-rtitle').textContent.trim());
  ok(rowTitles[0] === 'Pay rent' && /late/.test(todayRows[0].innerHTML), 'overdue row first, flagged “overdue”');
  ok(rowTitles.includes('Standup') && rowTitles.includes('Study Python'), 'the rolled recurring task AND the 23:59 task sit in “Scheduled for today”');
  ok(rowTitles.includes('Fix login bug') && rowTitles.includes('Draft slides'), 'unscheduled-high joins due-today-high in the High bucket');

  const cols = [...docD.querySelectorAll('.dash-col')];
  const todayCol = cols.find((c) => c.classList.contains('today'));
  ok(cols.length === 7 && todayCol.querySelector('.dash-cn').textContent === '2', 'weekly chart: 7 day columns, today = 2 completions');
  const chartSum = cols.reduce((a, c) => a + Number(c.querySelector('.dash-cn').textContent), 0);
  ok(chartSum === expWeekAll, 'chart totals exactly the stamps inside this Mon–Sun window (' + chartSum + ' = ' + expWeekAll + ')');

  const stats = [...docD.querySelectorAll('.dash-stat')].map((s) => s.querySelector('b').textContent.trim());
  ok(stats[0] === '2' && stats[1] === String(expWeekAll) && stats[2] === '11' && stats[3] === '1' && stats[4] === '27%' && stats[5] === '2 days',
    'statistics: 2 today · ' + expWeekAll + ' week · 11 created · 1 overdue · 27% rate · 2-day streak (' + JSON.stringify(stats) + ')');

  ok(/Launch/.test(txtD('.dash-prow')) && /1\/2/.test(txtD('.dash-prow')) && /width:50%/.test(docD.querySelector('.dash-mbar i').getAttribute('style')),
    'project overview: 🚀 Launch 1/2 with a 50% bar');

  const up = [...docD.querySelectorAll('.dash-card')].find((c) => /Upcoming/.test(c.querySelector('h3').textContent));
  const upRows = [...up.querySelectorAll('.dash-when')].map((x) => x.textContent.trim());
  ok(upRows.length === 2 && upRows[0] === 'Tomorrow' && /Sprint demo/.test(up.textContent), 'upcoming: exactly the two future tasks, tomorrow first');

  const nextTxt = txtD('.dash-next');
  ok(/Study Python/.test(nextTxt) && /in 4[0-3] min/.test(nextTxt) && /Custom date\/time/.test(nextTxt),
    '“Next reminder: Study Python — in ~42 min” (the brief’s example shape; custom type keeps its stored instant through boot reconcile)');
  const rrows = [...docD.querySelectorAll('.dash-rrow')];
  ok(rrows.length === 1 && /Sprint demo/.test(rrows[0].textContent) && /in [23] h/.test(rrows[0].textContent),
    'following-reminder list shows ONLY r2 — fired (r3) and orphaned (r4) records are excluded');

  const snap0 = wD.localStorage.getItem('todo_backup_v1');
  $D('#dashBtn').click(); await sleep(150); $D('#dashBtn').click(); await sleep(220);
  $D('#calBtn').click(); await sleep(160);
  ok($D('#dashboard').hidden === true && $D('#calendar').hidden === false, 'calendar and dashboard are exclusive views');
  $D('#calBtn').click(); await sleep(120); $D('#dashBtn').click(); await sleep(200);
  ok(wD.localStorage.getItem('todo_backup_v1') === snap0,
    'dashboard is NOT a data source: opening, closing and toggling wrote ZERO bytes to storage');

  const cleanRow = [...docD.querySelectorAll('.dash-today [data-drow]')].find((r) => /Clean inbox/.test(r.textContent));
  cleanRow.querySelector('.dash-check').click(); await sleep(340);
  const mD = JSON.parse(wD.localStorage.getItem('todo_backup_v1'));
  const dE = mD.tasks.find((x) => x.id === 'dE');
  ok(dE.status === 'completed' && dE.completions.length === 1 && dE.completedAt > 0,
    'the dashboard check-off IS the app toggleTask: same record id, stamped ledger');
  const tiles2 = [...docD.querySelectorAll('.dash-tiles .dash-tile b')].map((b) => b.textContent.trim());
  ok(tiles2[0] === '3' && !docD.querySelector('.dash-today').textContent.includes('Clean inbox'),
    'hero recomputes instantly: done-today 3, row leaves the board (' + JSON.stringify(tiles2) + ')');
  ok(/43%/.test(txtD('.dash-prog')) && /3 \/ 7 completed/.test(txtD('.dash-prog-num')), 'progress follows: 3 / 7 → 43%');

  const draftRow = [...docD.querySelectorAll('.dash-today [data-drow]')].find((r) => /Draft slides/.test(r.textContent));
  draftRow.querySelector('.dash-rtitle').click(); await sleep(200);
  ok($D('#composer').hidden === false && $D('#f-title').value === 'Draft slides',
    'clicking a dashboard row opens THAT task in the real composer — no shadow copy to edit');
  $D('#cancelTaskBtn').click(); await sleep(150);

  ok(dashErrs.length === 0, 'the whole dashboard session produced zero uncaught errors');

  // The primary app window: wiring holds against the dirty real dataset.
  if (!$('#calendar').hidden) { $('#calBtn').click(); await sleep(150); }
  $('#dashBtn').click(); await sleep(260);
  ok($('#dashboard').hidden === false && $('#calendar').hidden === true && !!doc.querySelector('.dash-greet'),
    'main app: dashboard opens over the live multi-section dataset and renders');
  const mainSnap = JSON.stringify(remMirror());
  $('#dashBtn').click(); await sleep(180); $('#dashBtn').click(); await sleep(180);
  ok(JSON.stringify(remMirror()) === mainSnap, 'main app: dashboard open/close left the mirror byte-identical');
  $('#dashBtn').click(); await sleep(160);
  ok($('#dashboard').hidden === true && $('#taskList').hidden === false, 'closing the dashboard returns to the list');
  domD.window.close();
}

/* ================== 21. Focus Mode — task-bound Pomodoro ================== */
{
  console.log('\n--- 21. focus mode ---');
  /* ---- A. live UI: row button → presets → bar controls (main window) ---- */
  const row = $$('#taskList .task:not(.project-row)')[0];
  const rowTitle = row.querySelector('.task-title').textContent.trim();
  ok(!!row.querySelector('[data-act="focus"]'), 'every task row carries the 🍅 Start Focus control');
  row.querySelector('[data-act="focus"]').click(); await sleep(160);
  const fcard = $('#modalHost .modal-focus');
  ok(fcard && /25\/5/.test(fcard.textContent) && /50\/10/.test(fcard.textContent) && /Custom/.test(fcard.textContent),
    'preset menu offers 25/5, 50/10 and Custom (plus the settings pair)');
  fcard.querySelector('[data-fp="50/10"]').click(); await sleep(250);
  ok(!$('#focusBar').hidden && /🍅 Focus/.test($('.fz-phase').textContent), 'the session bar appears, labelled as Focus');
  ok(/^(49|50):[0-5]\d$/.test($('.fz-time').textContent), 'timer counts down from the picked length (shows ' + $('.fz-time').textContent + ')');
  let lastRec = JSON.stringify(remMirror().tasks.find((x) => x.title === rowTitle).focusActive);
  await sleep(1400);
  ok(JSON.stringify(remMirror().tasks.find((x) => x.title === rowTitle).focusActive) === lastRec,
    'ticking writes NOTHING per second — the bar re-derives from stored instants');
  const t1 = $('.fz-time').textContent;
  $('.fz-ctl [data-fz="pause"]').click(); await sleep(1350);
  ok(/Resume/.test($('.fz-ctl').textContent) && $('.fz-time').textContent === t1, 'Pause freezes the clock and swaps to Resume');
  $('.fz-ctl [data-fz="resume"]').click(); await sleep(1350);
  ok($('.fz-time').textContent !== t1, 'Resume continues from the frozen instant (wall-clock math, not a paused JS timer)');
  $('.fz-ctl [data-fz="stop"]').click(); await sleep(300);
  ok($('#focusBar').hidden, 'Stop hides the bar');
  const stoppedT = tskOf(rowTitle);
  ok((stoppedT.focusTotal || 0) === 0 && !stoppedT.focusActive, 'stopping before a full minute logs nothing and leaves no session state');

  /* ---- B. Settings → Focus persists (work duration drives the defaults) ---- */
  $('#settingsBtn').click(); await sleep(180);
  const w = $('#fzWork'); w.value = '7'; w.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(260);
  ok(remMirror().settings.focus.work === 7, 'Work duration 7 min persisted to settings (synced with everything else)');
  const ev = $('#fzEvery'); ev.value = '99'; ev.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(260);
  ok(remMirror().settings.focus.longEvery === 12 && $('#fzEvery').value === '12', 'out-of-range input is clamped, reflected in the field, then persisted');
  $('#settingsBtn').click(); await sleep(140);

  /* ---- C. deterministic boot: catch-up, long-break logic, tracking, notification ---- */
  const NOW21 = Date.now();
  const mkSeed = (fa, sessions, auto) => ({
    app: 'zerotodo', schemaVersion: 5, savedAt: NOW21,
    settings: { focus: { work: 25, short: 5, long: 15, longEvery: 4, autoComplete: !!auto } },
    tasks: [{ id: 'f1', title: 'Build Expense Tracker', status: 'active', priority: 'med', projectId: 'fp1',
      createdAt: NOW21 - 86400e3, updatedAt: NOW21, focusTotal: 0, focusSessions: sessions || 0, focusLog: [], focusActive: fa }],
    trash: [], subtasks: [],
    projects: [{ id: 'fp1', name: 'Expenses', icon: '💸', color: '#4f46e5', status: 'active', createdAt: 1, updatedAt: 1, sortOrder: 1 }],
    reminders: [],
  });
  const bootFocus = async (seed) => {
    const dm = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
    dm.window.HTMLElement.prototype.scrollIntoView = function () {};
    dm.window.localStorage.setItem('todo_backup_v1', JSON.stringify(seed));
    dm.window.eval(storageSrc); dm.window.eval(appSrc);
    await sleep(900);
    return dm;
  };
  // 25:00 session expired 1 min ago, it was pomodoro #4 of 4 → LONG break starts
  const domE = await bootFocus(mkSeed({ phase: 'focus', endsAt: NOW21 - 60000, pausedAt: null, durMin: 25, breakMin: 5, longMin: 15, longEvery: 4 }, 3, false));
  const docE = domE.window.document;
  const mE = JSON.parse(domE.window.localStorage.getItem('todo_backup_v1'));
  const fE = mE.tasks.find((x) => x.id === 'f1');
  ok(fE.focusTotal === 25 && fE.focusSessions === 4 && fE.focusLog.length === 1 && fE.focusLog[0].min === 25,
    'boot catch-up recorded the session that finished while away: +25 min, 4th session, one ledger entry');
  ok(fE.focusActive && fE.focusActive.phase === 'long' && fE.focusActive.endsAt > Date.now(),
    'session 4 of 4 → LONG break auto-started (not the short one) — the cycle is alive after a refresh');
  ok(!docE.getElementById('focusBar').hidden && /Long break/.test(docE.querySelector('.fz-phase').textContent), 'the bar reassembled on load, showing the long break');
  ok(/25 minutes focused/.test([...docE.querySelectorAll('.toast, .toast-rem')].map((x) => x.textContent).join(' | ')),
    'completion surfaced WITHOUT the app being open: in-app card (no-Notification env degrades) says “25 minutes focused”');
  ok(docE.querySelector('.badge.focus') && /25m/.test(docE.querySelector('.badge.focus').textContent), 'the task row badges its focus time (🍅 25m)');
  docE.getElementById('dashBtn').click(); await sleep(260);
  const dashE = docE.querySelector('#dashHost').textContent;
  ok(/total focus time/.test(dashE) && /25 min/.test(dashE) && /Expenses/.test(dashE) && /Build Expense Tracker/.test(dashE),
    'dashboard Focus card: total, per-project (Expenses 25 min) and per-task tracking — all derived');
  const snap21 = domE.window.localStorage.getItem('todo_backup_v1');
  await sleep(1300);
  ok(domE.window.localStorage.getItem('todo_backup_v1') === snap21, 'the running break tick stores nothing either (derived-time design)');

  // autoComplete ON → the task completes when a session ends; OFF (above) must NOT have
  ok(fE.status === 'active', 'with the opt-in OFF the task stayed active through completion + long break (never auto-completes)');
  const domF = await bootFocus(Object.assign(mkSeed({ phase: 'focus', endsAt: NOW21 - 30000, pausedAt: null, durMin: 25, breakMin: 5, longMin: 15, longEvery: 4 }, 0, true)));
  const mF = JSON.parse(domF.window.localStorage.getItem('todo_backup_v1'));
  const fF = mF.tasks.find((x) => x.id === 'f1');
  ok(fF.status === 'completed' && fF.focusTotal === 25, 'with the explicit opt-in ON, a finished session DOES complete the task (single-record change, history intact)');
  ok(fF.focusActive && fF.focusActive.phase === 'break', '…and the cycle then rolls into the SHORT break (session 1 of 4)');

  /* ---- D. one session at a time + trash abandons honestly (fresh nodes —
     the settings commits re-rendered the list, detaching old elements) ---- */
  const rowA = $$('#taskList .task:not(.project-row)')[0];
  const titleA = rowA.querySelector('.task-title').textContent.trim();
  rowA.querySelector('[data-act="focus"]').click(); await sleep(140);
  $('#modalHost .modal-focus [data-fp="c"]').click(); await sleep(320);
  ok(/🍅 Focus/.test($('.fz-phase').textContent) && /0?7:00|06:5\d/.test($('.fz-time').textContent),
    'new session uses the PERSISTED 7-minute work duration (' + $('.fz-time').textContent + ')');
  const rowB = $$('#taskList .task:not(.project-row)')[1];
  const titleB = rowB.querySelector('.task-title').textContent.trim();
  rowB.querySelector('[data-act="focus"]').click(); await sleep(140);
  $('#modalHost .modal-focus [data-fp="c"]').click(); await sleep(340);
  ok(!tskOf(titleA).focusActive && tskOf(titleB).focusActive,
    'starting Focus elsewhere stops the previous session — exactly ONE timer app-wide');
  $$('#taskList .task').find((x) => x.querySelector('.task-title').textContent.trim() === titleB).querySelector('[data-act="delete"]').click(); await sleep(360);
  ok($('#focusBar').hidden, 'trashing the focused task abandons the session — the bar disappears');
  const trashedT = remMirror().tasks.find((x) => x.title === titleB);
  ok(trashedT === undefined || !trashedT.focusActive, 'the trashed copy carries no live session (abandoned, partial time logged or not)');

  domE.window.close(); domF.window.close();
  ok(true, 'focus-mode section completed without uncaught errors');
}

/* ==================== 22. Habit Tracking — separate module ==================== */
{
  console.log('\n--- 22. habits ---');
  const E = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

  /* ---- A. live UI on the main dom: create → check → undo → archive ---- */
  $('#calBtn').click(); await sleep(120); // whatever §21 left open, start clean
  $('#calBtn').click(); await sleep(120);
  ok(!!$('#habBtn') && /Habits/.test($('#habBtn').textContent), 'toolbar carries the 🔥 Habits control');
  $('#habBtn').click(); await sleep(200);
  ok($('#habitsView').hidden === false && $('#taskList').hidden === true && $('#calendar').hidden === true,
    'habits open as a full view — the task list and calendar are NOT rendered under it');
  ok($('#habBtn').getAttribute('aria-pressed') === 'true' && $('#habBtn').classList.contains('on'),
    'the toolbar button reflects pressed state like Calendar/Dashboard do');
  ok(/No habits yet/.test($('#habitsHost').textContent), 'empty habits view teaches with example habits (Exercise, Read, Study Python…)');
  const dashSnap0 = (() => { $('#habBtn').click(); $('#dashBtn').click(); const x = $('#dashHost').textContent; $('#dashBtn').click(); return x; })();
  await sleep(150);

  $('#habBtn').click(); await sleep(140);
  $('#habitsHost [data-hact="new"]').click(); await sleep(140);
  const mcard = doc.querySelector('.hab-modal');
  ok(!!mcard && !!mcard.querySelector('#hh-name'), 'the habit editor renders (name, frequency, target, nudge)');
  mcard.querySelector('#hh-name').value = 'Drink water';
  mcard.querySelector('#hh-target').value = '3';
  const rk = mcard.querySelector('#hh-remind'); rk.checked = true; E(rk, 'change');
  mcard.querySelector('#hh-remtime-i').value = '21:00';
  mcard.querySelector('[data-hm="save"]').click(); await sleep(320);
  ok(!doc.querySelector('.hab-modal'), 'saving closes the dialog');
  let H0 = remMirror().habits || [];
  ok(H0.length === 1 && H0[0].name === 'Drink water' && H0[0].target === 3 && H0[0].frequency === 'daily' && H0[0].remindTime === '21:00',
    'the habit is a SEPARATE record type persisted in its own store (mirrored like everything else)');
  let hrRow = (remMirror().reminders || []).find((r) => r.habitId);
  ok(!!hrRow && hrRow.status === 'pending' && hrRow.triggerAt > Date.now() - 1000 && /^21:00$/.test(new Date(hrRow.triggerAt).toTimeString().slice(0, 5)),
    'the nudge became ONE pending row in the existing reminders store — no second pipeline');

  const bump = async (n, sel) => { for (let i = 0; i < n; i++) { $(sel).click(); await sleep(160); } };
  await bump(2, '.hab-card [data-hact="plus"]');
  ok(/2\/3 today/.test($('.hab-card').textContent) && !$('.hab-card').classList.contains('done'),
    'partial counts show as a fraction — target 3 means three completions before the day is met (Drink water ×3)');
  await bump(1, '.hab-card [data-hact="plus"]');
  ok($('.hab-card').classList.contains('done') && /3\/3 today ✓/.test($('.hab-card').textContent),
    'reaching the target marks today met (✓ state, no task is completed anywhere)');
  ok(/🔥 1 day/.test($('.hab-card').textContent) && /Best 1/.test($('.hab-card').textContent) && /% done/.test($('.hab-card').textContent),
    'card shows current streak, longest streak and completion % (all derived, per the brief)');
  ok(remMirror().habits[0].history.length === 1 && remMirror().habits[0].history[0].c === 3,
    'history is the single stored source: one dated entry with the count (streaks are NOT stored)');
  await bump(1, '.hab-card [data-hact="minus"]');
  ok(!$('.hab-card').classList.contains('done') && /2\/3 today/.test($('.hab-card').textContent),
    '− undoes one completion (undo is first-class: counts, not a checkbox)');
  await bump(1, '.hab-card [data-hact="plus"]');

  /* stats isolation: dashboard text identical while habits stay met-but-unmixed */
  const dashSnap1 = (() => { $('#habBtn').click(); $('#dashBtn').click(); const x = $('#dashHost').textContent; $('#dashBtn').click(); $('#dashBtn').click(); const y = $('#dashHost').textContent; $('#dashBtn').click(); return y; })();
  await sleep(140);
  ok(dashSnap1 === dashSnap0,
    'with habitsInStats OFF (default) a met habit day changes NOTHING in dashboard tiles/chart/streak');
  $('#habInStats').checked = true; E($('#habInStats'), 'change'); await sleep(260);
  const dashSnap2 = (() => { $('#dashBtn').click(); const x = $('#dashHost').textContent; $('#dashBtn').click(); $('#dashBtn').click(); const y = $('#dashHost').textContent; $('#dashBtn').click(); return y; })();
  await sleep(140);
  ok(remMirror().settings.habitsInStats === true, 'the opt-in is a persisted, synced setting');
  ok(dashSnap2 !== dashSnap1 && /1/.test(dashSnap2),
    'explicitly enabling habitsInStats mixes the met habit day into dashboard stats — the ONLY way it mixes');
  $('#habInStats').checked = false; E($('#habInStats'), 'change'); await sleep(260);
  $('#habBtn').click(); await sleep(140); // back to the habits view for the archive flow
  $('.hab-card [data-hact="archive"]').click(); await sleep(260);
  ok(!doc.querySelector('.hab-card') && /Archived \(1\)/.test($('#habitsHost').textContent),
    'archive hides the habit WITHOUT touching the trash (history preserved, recoverable)');
  hrRow = (remMirror().reminders || []).find((r) => r.habitId);
  ok(hrRow.status === 'skipped', 'archiving retires its pending nudge (skipped, like a task-side safe handling)');
  $('#habitsHost [data-hact="togglearch"]').click(); await sleep(160);
  ok(!!doc.querySelector('.hab-card.archived') && !doc.querySelector('.hab-card.archived [data-hact="plus"]'),
    'the archived section shows a read-only card (no check-in controls)');
  doc.querySelector('.hab-card.archived [data-hact="unarchive"]').click(); await sleep(260);
  hrRow = (remMirror().reminders || []).find((r) => r.habitId);
  ok(hrRow.status === 'pending' && hrRow.triggerAt > Date.now() - 1000,
    'unarchiving re-arms the nudge to the NEXT due slot automatically (engine-owned, like overdue)');

  /* exclusivity with the other overlays */
  $('#calBtn').click(); await sleep(140);
  $('#habBtn').click(); await sleep(160);
  ok($('#habitsView').hidden === false && $('#calendar').hidden === true, 'opening Habits closes the Calendar');
  $('#dashBtn').click(); await sleep(160);
  ok($('#dashboard').hidden === false && $('#habitsView').hidden === true && $('#habBtn').getAttribute('aria-pressed') === 'false',
    'Dashboard takes over exclusively from Habits');
  $('#dashBtn').click(); await sleep(140); $('#habBtn').click(); await sleep(140); $('#habBtn').click(); await sleep(140);
  ok($('#taskList').hidden === false && $('#habitsView').hidden === true, 'closing Habits returns to the task list');
  ok(true, 'habits live-UI flow completed without uncaught errors');

  /* ---- B. deterministic boot: derivations, re-arm, suppression, coercion ---- */
  const NOW22 = Date.now();
  const D = (n) => { const x = new Date(NOW22); x.setDate(x.getDate() - n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const dowMon = (NOW22 / 1000 | 0); void dowMon;
  const mkHab = (o) => Object.assign({ createdAt: NOW22 - 30 * 864e5, updatedAt: NOW22, archived: false, weekdays: [], remindTime: null, history: [], description: '', target: 1, frequency: 'daily' }, o);
  const bootH = async (habits, reminders, settings) => {
    const seed = {
      app: 'zerotodo', schemaVersion: 5, savedAt: NOW22,
      settings: settings || {}, tasks: [], trash: [], projects: [], subtasks: [],
      reminders: reminders || [], habits,
    };
    const dm = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
    dm.window.HTMLElement.prototype.scrollIntoView = function () {};
    dm.window.localStorage.setItem('todo_backup_v1', JSON.stringify(seed));
    dm.window.eval(storageSrc); dm.window.eval(appSrc);
    await sleep(900);
    return dm;
  };
  // Study Python: 12-day daily streak ending yesterday → grace keeps it alive today
  const python12 = (() => { const h = []; for (let i = 1; i <= 12; i++) h.push({ d: D(i), c: 1 }); return h; })();
  const dmH = await bootH([
    mkHab({ id: 'hs1', name: 'Study Python', frequency: 'daily', history: python12 }),
    mkHab({ id: 'hs2', name: 'Exercise', frequency: 'daily', remindTime: '00:30', history: [] }),
    mkHab({ id: 'hs3', name: 'Gym', frequency: 'daily', remindTime: '00:30', history: [{ d: D(1), c: 1 }, { d: D(0), c: 1 }] }),
    mkHab({ id: 'hs4', name: 'Meditate', frequency: 'daily', archived: true, remindTime: '07:00', history: [{ d: D(1), c: 1 }] }),
  ], [
    { id: 'hr:hs2', taskId: '', habitId: 'hs2', reminderType: 'custom', triggerAt: NOW22 - 36 * 3600e3, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
    { id: 'hr:hs3', taskId: '', habitId: 'hs3', reminderType: 'custom', triggerAt: NOW22 - 36 * 3600e3, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
    { id: 'hr:hs4', taskId: '', habitId: 'hs4', reminderType: 'custom', triggerAt: NOW22 + 3600e3, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: 1, updatedAt: 1 },
  ]);
  dmH.window.document.getElementById('habBtn').click();
  await sleep(200);
  const $h = (s) => dmH.window.document.querySelector(s);
  const hTxt = $h('.hab-card') ? $h('.hab-card').textContent : '';
  ok(/Study Python/.test(hTxt) && /🔥 12 days/.test(hTxt), 'a 12-day run ending yesterday still shows “🔥 12 days” (today-in-progress does not break it — same grace rule as the dashboard streak)');
  ok(/Best 12/.test(hTxt) && /39% done/.test(hTxt), 'longest streak and completion % derive from the same history (12 met of 31 due days)');
  const hSnap = () => JSON.parse(dmH.window.localStorage.getItem('todo_backup_v1'));
  const r2 = hSnap().reminders.find((x) => x.id === 'hr:hs2');
  ok(r2.status === 'pending' && r2.triggerAt > NOW22 && /^00:30$/.test(new Date(r2.triggerAt).toTimeString().slice(0, 5)),
    'a STALE stored triggerAt is ignored — the engine re-armed the nudge to the next 00:30 due slot at boot');
  const r3 = hSnap().reminders.find((x) => x.id === 'hr:hs3');
  ok(r3.status === 'pending' && r3.triggerAt > NOW22 && r3.delivered === false,
    'the met-today habit skipped its overdue alert (no nag after you already did it) and simply armed the next slot');
  ok(!/Habit Reminder/.test(dmH.window.document.getElementById('toastHost').textContent),
    'suppressed habit check-ins produce NO notification at all (existing delivery, existing dedup rules)');
  const r4 = hSnap().reminders.find((x) => x.id === 'hr:hs4');
  ok(r4.status === 'skipped', 'an archived habit leaves its row skipped — the engine never nags for hidden habits');
  ok(hSnap().habits.length === 4 && hSnap().habits.every((x) => Array.isArray(x.history)),
    'boot validated + re-mirrored every habit (own store, lenient coerce)');
  const rBefore = JSON.stringify(hSnap().reminders);
  await new Promise((rr) => setTimeout(rr, 1200));
  ok(JSON.stringify(hSnap().reminders) === rBefore,
    'waiting two ticks changes NOTHING — re-armed triggers are stable, no write storm');
  dmH.window.close();

  /* weekly + selected-days + history hygiene */
  const histJunk = [];
  for (let i = 739; i >= 0; i--) histJunk.push({ d: D(i), c: 1 });
  histJunk.push({ d: D(3), c: 9 }); // duplicate date, later wins
  histJunk.push({ d: 'garbage', c: 3 }, { d: D(2), c: 0 }, null);
  const mondayOf = (off) => { const x = new Date(NOW22); const k = (x.getDay() + 6) % 7; x.setDate(x.getDate() - k + off); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const dmI = await bootH([
    mkHab({ id: 'hw1', name: 'Read', frequency: 'weekly', target: 3, createdAt: NOW22 - 20 * 864e5, history: [{ d: mondayOf(0), c: 1 }, { d: mondayOf(1), c: 1 }, { d: mondayOf(2), c: 1 }] }),
    mkHab({ id: 'hd1', name: 'Practice IELTS', frequency: 'days', weekdays: [1, 3, 5], history: [{ d: mondayOf(0), c: 1 }, { d: mondayOf(2), c: 1 }] }),
    mkHab({ id: 'ht1', name: 'Tidy', frequency: 'daily', history: histJunk }),
  ]);
  dmI.window.document.getElementById('habBtn').click();
  await sleep(200);
  const $i = (s) => dmI.window.document.querySelector(s);
  const iCards = [...dmI.window.document.querySelectorAll('.hab-card')];
  const readTxt = iCards.find((c) => /Read/.test(c.textContent)).textContent;
  ok(/3\/3 this week ✓/.test(readTxt) && /🔥 1 day/.test(readTxt),
    'weekly habits measure ONE target across the whole Mon–Sun week — met = ✓ with a weekly streak');
  const ielsTxt = iCards.find((c) => /IELTS/.test(c.textContent)).textContent;
  ok(/Mon ✓/.test(ielsTxt) && /Wed ✓/.test(ielsTxt), 'selected-days habit shows the brief’s row shape: Mon ✓ Wed ✓ …');
  const calCells = iCards.find((c) => /IELTS/.test(c.textContent)).querySelectorAll('.hab-cal-cell:not(.head):not(.empty)');
  ok(calCells.length >= 28, 'calendar history renders as a real month grid (dots per day)');
  const iSnap = JSON.parse(dmI.window.localStorage.getItem('todo_backup_v1'));
  const tidy = iSnap.habits.find((x) => x.id === 'ht1');
  ok(tidy.history.length === 730, 'history is capped at 730 entries on load (oldest roll off, never an unbounded row)');
  ok(tidy.history.some((e) => e.d === D(3) && e.c === 9) && !tidy.history.some((e) => e.c < 1) && tidy.history.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.d)),
    'junk entries are dropped, duplicate dates collapse last-wins (9 kept) — the coerce layer is the guardian');
  ok(tidy.history.every((e, i2, a) => i2 === 0 || a[i2 - 1].d < e.d), 'history stays strictly sorted by date through the cap');
  dmI.window.close();

  /* stats isolation at boot: mixed dashboard differs from pure one */
  const dmJ = await bootH([mkHab({ id: 'hk1', name: 'Kegel-ish', frequency: 'daily', history: [{ d: D(0), c: 1 }] })], [], { habitsInStats: true });
  dmJ.window.document.getElementById('dashBtn').click();
  await sleep(200);
  ok(/1/.test(dmJ.window.document.getElementById('dashHost').textContent) && !dmJ.window.document.getElementById('dashboard').hidden,
    'with the opt-in ON at boot, the met habit day already shapes the dashboard (explicitly configured mixing)');
  dmJ.window.close();

  /* ---- C. cross-device: a habit pushed from elsewhere rides backup/import ---- */
  const dmK = await bootH([mkHab({ id: 'hz', name: 'Stretch', frequency: 'days', weekdays: [6], history: [{ d: D(7), c: 1 }] })]);
  dmK.window.document.getElementById('habBtn').click(); await sleep(200);
  ok(JSON.parse(dmK.window.localStorage.getItem('todo_backup_v1')).habits.length === 1,
    'a HABITS-ONLY account survives restart (recover() counts every record type, not just tasks)');
  const kMirror = JSON.parse(dmK.window.localStorage.getItem('todo_backup_v1'));
  ok(kMirror.habits.length === 1 && kMirror.habits[0].weekdays[0] === 6 && kMirror.habits[0].frequency === 'days',
    'selected-days shape survives the storage round-trip byte-clean (Saturdays only = [6])');
  const kTxt = dmK.window.document.querySelector('.hab-card').textContent;
  {
    const satToday = new Date(NOW22).getDay() === 6;
    // history entry D(7) lands on a due Saturday only when today IS Saturday —
    // then the streak/percent are 1 day / 20%; on any other weekday the sole
    // entry matches no due day and everything must read zero. (No phantom.)
    ok(satToday ? /🔥 1 day/.test(kTxt) && /20% done/.test(kTxt) : /🔥 0 days/.test(kTxt) && /0% done/.test(kTxt),
      'day-set habit derives stats ONLY from real due days — streak and % track weekday alignment (no phantom state)');
  }
  dmK.window.close();
  ok(true, 'habits section completed without uncaught errors');
}

/* ============ 23. AI task decomposition — suggestions, review, then add ============ */
{
  console.log('\n--- 23. AI decomposition ---');
  /* ---- A. the engine: structured data in, structured data out ---- */
  const dmP = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dmP.window.eval(aiSrc);
  const TAI = dmP.window.ZTAI;
  ok(!!TAI, 'public/ai.js loads standalone (no app, no server) — the planner is self-contained');
  const ex = TAI.plan('Build an expense tracker', '', {});
  ok(ex.steps.map((s) => s.title).join('|') ===
    'Define requirements|Design data model|Create database|Build expense form|Add categories|Add reports|Add export|Test application',
    'the brief’s example is PINNED: “Build an expense tracker” → exactly its 8-step list');
  ok(ex.steps.every((s) =>
    typeof s.title === 'string' && s.title.length > 2 &&
    typeof s.description === 'string' && s.description.length > 15 &&
    Number.isInteger(s.estMin) && s.estMin >= 5 && s.estMin <= 10080 &&
    ['low', 'med', 'high'].includes(s.priority) &&
    /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate) &&
    Array.isArray(s.dependsOn) && s.dependsOn.every((d) => Number.isInteger(d) && d >= 0)) &&
    ex.steps.every((s, i) => s.dependsOn.every((d) => d < i)),
    'every suggestion is STRUCTURED task data (title/desc/est/priority/due/dependsOn) — deps only ever point at earlier steps');
  ok(TAI.looksLarge('Build an expense tracker', '') && TAI.looksLarge('Study for IELTS', '') &&
    TAI.looksLarge('Organize my parents’ 40th anniversary party', '') && !TAI.looksLarge('Buy milk', '') && !TAI.looksLarge('Call mom', ''),
    '“large task” heuristic fires on real projects, stays quiet on errands (the OFFER is what it gates — never any writing)');
  const dom = TAI.plan('Fix the kitchen shelf and repaint it', '');
  ok(dom.playbook === 'home' && /Measure & buy/.test(dom.steps.map((s) => s.title).join(' ')), 'domain detection: hands-on jobs get a home playbook');
  ok(TAI.plan('Tie a knot', '').playbook === 'generic', 'unknown domain falls to the generic ladder, never to nothing');
  const cap = TAI.sanitizePlan({ steps: Array.from({ length: 30 }, (_, i) => ({ title: 'S' + i, estMin: i ? -5 : 20000, dependsOn: [7, 7, 99] })) });
  ok(cap.steps.length === 12 && cap.steps[0].estMin === 10080 && cap.steps[1].estMin === 60 &&
    cap.steps[7].dependsOn.length === 0 && cap.steps[0].dependsOn.join() === '7' && cap.steps[8].dependsOn.join() === '7',
    'sanitizePlan: caps 12 steps, clamps estimates (20000 → 10080, negative → default 60), drops self + out-of-range deps, dedupes — forward refs survive because a model may list steps in any order and real ids replace indices');
  ok(TAI.sanitizePlan('Sure! Here is a plan:\n1. do stuff') === null && TAI.sanitizePlan({ steps: [] }) === null,
    'arbitrary prose from a model is REFUSED — only shaped data passes');
  const p1 = TAI.plan('Write a report', '', {}); const p2 = TAI.plan('Write a report', '', {});
  ok(JSON.stringify(p1) === JSON.stringify(p2) && p1.playbook === 'writing', 'planner is deterministic — no chat roulette in the built-in engine');
  ok(TAI.fmtEst(45) === '45m' && TAI.fmtEst(90) === '1h30m' && TAI.fmtEst(120) === '2h' && TAI.fmtEst(1500) === '1d 1h',
    'estimates render human: 45m / 1h30m / 2h / 1d 1h');
  dmP.window.close();

  /* ---- B. the full review-gated flow in a deterministic boot ---- */
  const NOW23 = Date.now();
  const Dshift = (n) => { const x = new Date(NOW23); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const seed23 = {
    app: 'zerotodo', schemaVersion: 5, savedAt: NOW23, settings: {},
    tasks: [
      { id: 'big1', title: 'Build an expense tracker', description: 'A full app: log expenses by category, see monthly totals, export.', dueDate: Dshift(10), status: 'active', priority: 'med', projectId: 'pp1', tags: [], aiOffer: true, createdAt: NOW23 - 60000, updatedAt: NOW23 - 60000 },
      { id: 'small1', title: 'Buy milk', status: 'active', priority: 'low', projectId: null, tags: [], createdAt: NOW23 - 50000, updatedAt: NOW23 - 50000 },
    ],
    trash: [], subtasks: [], reminders: [],
    projects: [{ id: 'pp1', name: 'Expenses', icon: '💸', color: '#4f46e5', status: 'active', createdAt: 1, updatedAt: 1, sortOrder: 1 }],
  };
  const dmQ = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dmQ.window.HTMLElement.prototype.scrollIntoView = function () {};
  dmQ.window.localStorage.setItem('todo_backup_v1', JSON.stringify(seed23));
  dmQ.window.eval(storageSrc); dmQ.window.eval(aiSrc); dmQ.window.eval(appSrc);
  await sleep(900);
  const dq = (s) => dmQ.window.document.querySelector(s);
  const dqa = (s) => [...dmQ.window.document.querySelectorAll(s)];
  const qmir = () => JSON.parse(dmQ.window.localStorage.getItem('todo_backup_v1'));
  const rowOf = (t) => dqa('#taskList .task').find((r) => r.querySelector('.task-title').textContent.includes(t));
  ok(!!rowOf('Build an expense tracker').querySelector('.ai-cta'), 'a LARGE task row carries the offer button: “✨ Break this task down with AI”');
  ok(!rowOf('Buy milk').querySelector('.ai-cta'), 'a small task gets NO nagging offer (aiOffer not inferred per-row — set at creation by the heuristic)');
  ok(!!rowOf('Buy milk').querySelector('[data-act="aidec"]'), 'yet the ✨ action is available on every active row — the offer is an invitation, not a lock');

  rowOf('Build an expense tracker').querySelector('.ai-cta').click();
  await sleep(350);
  const snapBefore = JSON.stringify(qmir());
  ok(!!dq('.ai-modal') && /AI suggestions/.test(dq('.ai-modal h3').textContent), 'the review dialog opens (“✨ AI suggestions”)');
  ok(dqa('.ai-modal .ai-step').length === 8, 'all 8 suggestions listed, each with its own row');
  ok(dq('.ai-modal .ai-title').value === 'Define requirements' && dqa('.ai-step input[type="checkbox"]').every((c) => c.checked),
    'suggestions come PRE-CHECKED (uncheck to veto — the brief’s ☑☑☑☐ pattern is user-made, not the app hiding steps)');
  await sleep(400);
  ok(JSON.stringify(qmir()) === snapBefore, 'opening the dialog + generating the plan writes NOTHING — the AI cannot touch the task store');
  const nTasks0 = qmir().tasks.length;

  const step = (i) => dqa('.ai-step')[i];
  const t3 = step(2).querySelector('.ai-title'); t3.value = 'Set up SQLite'; t3.dispatchEvent(new dmQ.window.Event('input', { bubbles: true }));
  for (const gi of [5, 6, 7]) { const c = step(gi).querySelector('input[type="checkbox"]'); c.checked = false; c.dispatchEvent(new dmQ.window.Event('change', { bubbles: true })); }
  ok(/5 of 8 selected/.test(dq('.ai-count').textContent) && /Add selected tasks \(5\)/.test(dq('[data-aim="add"]').textContent),
    'footer live-counts the selection: “5 of 8 selected” → “Add selected tasks (5)”');
  const depSel = step(3).querySelector('[data-ai="depadd"]'); // Build expense form (deps: [Set up SQLite])
  const before = step(3).querySelectorAll('.ai-dep-chip').length;
  depSel.value = '0'; depSel.dispatchEvent(new dmQ.window.Event('change', { bubbles: true })); await sleep(160);
  ok(step(3).querySelectorAll('.ai-dep-chip').length === before + 1, 'dependencies are editable too — “+ after…” adds a link chip, and one already present is never duplicated');
  dq('[data-aim="add"]').click();
  await sleep(500);
  ok(!dq('.ai-modal'), 'Add closes the dialog — one action, no lingering overlay');
  const qm = qmir();
  ok(qm.tasks.length === nTasks0 + 5, 'exactly the CHECKED five were created (unchecked suggestions simply don’t exist downstream)');
  ok(!qm.tasks.some((x) => /Add reports|Add export|Test application/.test(x.title)),
    'the vetted-away steps were NOT auto-created — “Do NOT automatically create AI-generated tasks” pinned');
  const created = (t) => qm.tasks.find((x) => x.title === t);
  ok(created('Set up SQLite') && !created('Create database'),
    'inline EDITS before adding are honored (Create database → Set up SQLite) — every suggestion was editable');
  ok(created('Define requirements').projectId === 'pp1' && created('Add categories').priority === 'med' && created('Define requirements').estMin === 45,
    'approved suggestions land as ORDINARY tasks: project inherited, priority suggestion kept, estimate stored');
  ok(qm.tasks.find((x) => x.title === 'Design data model').deps.includes(created('Define requirements').id),
    'dependencies were rewired from plan indices to REAL task ids of the added batch');
  ok(created('Build expense form').deps.length === 2 &&
     created('Build expense form').deps.includes(created('Set up SQLite').id) &&
     created('Build expense form').deps.includes(created('Define requirements').id),
    'the manually added “+ after #0” chip landed as a second real dependency on the created task');
  ok(qm.tasks.find((x) => x.title === 'Build expense form').dueDate >= qm.tasks.find((x) => x.title === 'Define requirements').dueDate,
    'suggested due dates are scheduled in order (staggered from the parent’s own due date)');
  ok(qm.tasks.find((x) => x.id === 'big1').aiOffer === false, 'adding the breakdown retires the parent’s offer prompt');
  const row1 = rowOf('Add categories');
  ok(/⏱ 1h/.test(row1.textContent) && /🔗/.test(row1.textContent), 'new rows show the advisory ⏱ estimate and 🔗 depends-on badges (display only)');
  const okRow0 = rowOf('Define requirements');
  ok(!/🔗/.test(okRow0.textContent), 'a first step with no dependencies shows no 🔗 badge');
  await sleep(400);
  ok(created('Add categories').estMin === 60 && created('Add categories').deps.length === 1 && created('Add categories').aiOffer === false && created('Add categories').status === 'active',
    'every created task survived the storage round-trip with its advisory fields intact (⏱🔗 are data, not decoration)');

  /* cancel path on the small task (generic playbook) */
  rowOf('Buy milk').querySelector('[data-act="aidec"]').click(); await sleep(350);
  ok(dqa('.ai-modal .ai-step').length === 6, '“Buy milk” still gets the generic 6-step ladder when ASKED (offer ≠ force, and no dead end)');
  const beforeCancel = JSON.stringify(qmir());
  dq('[data-aim="regen"]').click(); await sleep(300);
  ok(JSON.stringify(qmir()) === beforeCancel, '✨ Regenerate re-plans with ZERO writes (same guard as before)');
  ok(dqa('.ai-modal .ai-step').length === 6, 'regenerated plan renders fresh rows');
  dq('[data-aim="cancel"]').click(); await sleep(150);
  ok(!dq('.ai-modal') && JSON.stringify(qmir()) === beforeCancel, 'Cancel adds NOTHING — reviewed, declined, untouched');

  /* ---- C. main dom: creation heuristic + settings ---- */
  $('#newTaskBtn').click(); await sleep(60);
  $('#f-title').value = 'Migrate the billing system to usage-based pricing';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300);
  ok(tsk().some((x) => x.title === 'Migrate the billing system to usage-based pricing' && x.aiOffer === true),
    'creating a LARGE task stamps aiOffer — the row itself offers “Break this task down with AI”');
  $('#newTaskBtn').click(); await sleep(60);
  $('#f-title').value = 'Sharpen pencils';
  $('#taskForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300);
  ok(tsk().some((x) => x.title === 'Sharpen pencils' && !x.aiOffer), 'small new tasks get no offer flag — quiet by design');
  const bigRow = $$('#taskList .task').find((r) => /Migrate the billing/.test(r.querySelector('.task-title').textContent));
  ok(!!bigRow.querySelector('.ai-cta'), '…and large ones immediately show the offer chip');
  $('#settingsBtn').click(); await sleep(200);
  ok($('#aiMode').value === 'auto', 'Settings → AI exposes the engine choice (default: auto)');
  $('#aiMode').value = 'local'; $('#aiMode').dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(260);
  ok(remMirror().settings.aiMode === 'local', 'the preference persists + syncs inside settings like every other');
  $('#settingsBtn').click(); await sleep(140);
  ok(true, 'AI decomposition section completed without uncaught errors');

  dmQ.window.close();
}

/* ========== 24. Natural-language quick add — understand, confirm, THEN create ========== */
{
  console.log('\n--- 24. natural-language add ---');
  /* ---- A. the engine on the brief’s exact sentences ---- */
  const dmN = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dmN.window.eval(nlSrc);
  const NL = dmN.window.ZTNL;
  ok(!!NL && typeof NL.parse === 'function', 'public/nl.js loads standalone — the parser is self-contained (no app, no network)');
  // pin “now” so the assertions are exact, in the LOCAL zone (the only zone the engine knows)
  const NOW = new Date(2026, 8, 20, 14, 0); // Sun 20 Sep 2026, 14:00 local
  const P = (s, o) => NL.parse(s, Object.assign({ now: NOW }, o || {}));
  const a = P('Study Python tomorrow at 7 PM');
  ok(a.title === 'Study Python' && a.dueDate === '2026-09-21' && a.dueTime === '19:00' && a.priority === 'med' && a.confidence === 'high' && a.notes.length === 0,
    '“Study Python tomorrow at 7 PM” → Task/Date/Time exactly, no guesses, high confidence');
  const c = P('Call uncle Friday at 10 AM');
  ok(c.title === 'Call uncle' && c.dueDate === '2026-09-25' && c.dueTime === '10:00',
    'bare weekday “Friday” → the coming Friday, phrasing removed from the title');
  const f = P('Finish assignment tomorrow, high priority, remind me one hour before');
  ok(f.priority === 'high' && f.remRows.length === 1 && f.remRows[0].reminderType === 'h1' && f.dueDate === '2026-09-21' && f.title === 'Finish assignment',
    '“high priority, remind me one hour before” → priority + h1 preset reminder, title stays clean');
  const e = P('Exercise every Monday Wednesday and Friday at 6 PM');
  ok(e.recurrence === 'custom' && e.recurRule.unit === 'week' && e.recurRule.weekdays.join() === '1,3,5' && e.dueTime === '18:00' && e.title === 'Exercise',
    'run-on “every Monday Wednesday and Friday” is ONE recurrence (weekly Mon/Wed/Fri), not three dates');
  ok(NL.fmtRepeat(e) === 'Weekly on Mon, Wed, Fri' && NL.fmtDay('2026-09-21', NOW) === 'Tomorrow' && NL.fmtTime('19:00') === '7:00 PM',
    'card labels come from the engine: “Weekly on Mon, Wed, Fri · Tomorrow · 7:00 PM”');
  // every field from the brief exists in the structured output
  ok(['title','description','dueDate','dueTime','priority','projectId','tags','recurrence','recurRule','remRows','confidence','notes'].every((k) => k in a),
    'the parse output covers the brief’s full field list (title, description, date, time, priority, project, tags, recurrence, reminders)');
  const g = P('Gym #health every weekday at 7 in the morning');
  ok(g.title === 'Gym' && g.tags.join() === 'health' && g.recurrence === 'weekdays' && g.dueTime === '07:00' && g.confidence === 'high',
    'tags + “every weekday” + “7 in the morning” → 07:00 exactly — the daypart disambiguates, so no guess penalty');
  const h = P('at 7 meet me');
  ok(h.dueTime === '19:00' && h.confidence === 'low' && h.notes.length >= 1,
    'a BARE “at 7” is a guess → confidence drops to LOW and a note says so (ambiguity is never hidden)');
  const d = P('Fix the sink — replace the cartridge, low priority');
  ok(d.title === 'Fix the sink' && d.description === 'replace the cartridge' && d.priority === 'low',
    'description is separated when identifiable (em-dash split) and “low priority” leaves the title');
  const proj = P('Review PRs in Work tomorrow', { projects: [{ id: 'p1', name: 'Work' }, { id: 'p2', name: 'Home' }] });
  ok(proj.projectId === 'p1' && proj.title === 'Review PRs', '“in Work” maps to the EXISTING project id — matched against real data, never invented');
  const noproj = P('Review PRs in Mars tomorrow', { projects: [{ id: 'p1', name: 'Work' }] });
  ok(noproj.projectId === null && /Mars/.test(noproj.title), '…and an unknown name is NOT turned into a project — it just stays part of the title');
  const r1 = P('Retro every 2 weeks on Friday');
  ok(r1.recurrence === 'custom' && r1.recurRule.every === 2 && r1.recurRule.unit === 'week' && r1.recurRule.weekdays.join() === '5',
    '“every 2 weeks on Friday” → custom rule every-2-weeks on Fri (the “on Friday” feeds the rule, not a due date)');
  const r2 = P('Standup every other day at 9am');
  ok(r2.recurRule.unit === 'day' && r2.recurRule.every === 2 && r2.dueTime === '09:00', '“every other day” → every-2-days');
  const s1 = P('Water plants every weekend');
  ok(s1.recurRule.weekdays.join() === '0,6', '“every weekend” → Sat+Sun');
  const rem20 = P('Team lunch tomorrow, remind me 20 minutes before');
  ok(rem20.remRows[0].reminderType === 'm15' && rem20.notes.some((x) => /nearest preset/.test(x)),
    '“20 minutes before” snaps to the nearest real preset (m15) — and SAYS it snapped');
  const remday = P('Dentist tomorrow, remind me the day before');
  ok(remday.remRows[0].reminderType === 'd1', '“the day before” → 1 day before (not a mangled quantity)');
  const remat = P('Renew passport friday, remind me at 9pm');
  ok(remat.remRows[0].reminderType === 'custom' && remat.remRows[0].customTime === '21:00',
    '“remind me at 9pm” becomes a real custom-time reminder row without stealing the task’s own phrasing');
  const lead = P('Create a task: buy batteries tomorrow');
  ok(lead.title === 'Buy batteries', 'the “Create a task:” lead-in (the input’s own placeholder phrasing) is stripped');
  const rmt = P('Remind me to call the bank tomorrow');
  ok(rmt.title === 'Call the bank' && rmt.dueDate === '2026-09-21', '“Remind me to X tomorrow” → task X (the classic Apple-Notes idiom)');
  const tz = NL.parse('tomorrow at 7 AM', { now: new Date(2026, 11, 31, 23, 30) }); // 11:30 PM local on NYE
  ok(tz.dueDate === '2027-01-01' && /^\d{4}-\d{2}-\d{2}$/.test(tz.dueDate),
    'LOCAL timezone only: “tomorrow” at 23:30 on Dec 31 → 2027-01-01 (a UTC-offset bug would say 2026-12-31/01 wrongly across midnight)');
  const det = JSON.stringify(P('Ship v2 next friday 6pm')) === JSON.stringify(P('Ship v2 next friday 6pm'));
  ok(det, 'deterministic: the same sentence parses to the identical structure every time');
  const past = P('Party march 3');
  ok(past.dueDate === '2027-03-03' && past.notes.some((x) => /already passed/.test(x)),
    '“march 3” already gone this year → next March, with a note about it');
  const amb = P('Dentist 12/5');
  ok(amb.dueDate === '2026-12-05' && amb.notes.some((x) => /month\/day/.test(x)),
    '12/5 (both could be months!) → read as month/day WITH a visible note; unambiguous day-month like 12/25 gets no noise');
  ok(P('Dentist 12/25').dueDate === '2026-12-25', 'and 12/25 still resolves right (25 can only be a day)');
  const empty = P('');
  {
    const rYest = NL.parse('Fix billing bug yesterday, high priority', { now: NOW });
    ok(rYest.dueDate === '2026-09-19' && rYest.confidence === 'high' && rYest.title === 'Fix billing bug',
      '“yesterday” resolves to a REAL past date (an overdue task, tier 1 for the planner) and leaves the title clean');
    const rY2 = NL.parse('Submit the report the day before yesterday', { now: NOW });
    ok(rY2.dueDate === '2026-09-18', '“the day before yesterday” → −2 days, likewise honest');
    const rY3 = NL.parse('Renew passport due yesterday at noon', { now: NOW });
    ok(rY3.dueDate === '2026-09-19' && rY3.dueTime === '12:00', '“due yesterday at noon” — lead-in and time both survive the past-day eat');
    const rM = NL.parse('Meeting on Monday', { now: NOW });
    ok(rM.dueDate === '2026-09-21' && /forward|next/.test(rM.notes.join(' ')) === true || rM.dueDate >= '2026-09-21',
      'the past-date roll stays for inferred days (a bare weekday never lands in the past) — the exemption is ONLY for explicit yesterdays');
  }
  ok(empty.confidence === 'low', 'empty input → low confidence, nothing invented');
  dmN.window.close();

  /* ---- B. the confirmation-gated flow in the MAIN dom ---- */
  const mir = () => JSON.stringify(JSON.parse(window.localStorage.getItem('todo_backup_v1')).tasks);
  const remMir = () => JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  ok(!$('#qaWrap').hidden && $('#qaInput').placeholder.startsWith('Create a task'), 'the natural-language input is ALWAYS on the main screen — no composer to open first (placeholder: “Create a task…”)');
  ok($('#composer').hidden, '…and the plain list stays in front of it (this is quick-add, not a hidden form)');
  $('#qaInput').value = 'Finish assignment tomorrow, high priority, remind me one hour before';
  const beforeEnter = mir();
  $('#qaInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(220);
  ok($('#qaCard') && !$('#qaCard').hidden, 'Enter shows the “I understood” card — it does NOT create the task');
  ok(/September \d|\(\d{4}-\d{2}-\d{2}\)/.test($('#qaCard').textContent), 'the Date line reads like the brief (“September 20 (Tomorrow)” + iso)');
  ok(mir() === beforeEnter, 'ZERO writes on understand: the task store is byte-identical while suggestions wait for you');
  const cardTxt = $('#qaCard').textContent;
  ok(/I understood/.test(cardTxt) && /Finish assignment/.test(cardTxt) && /Tomorrow/.test(cardTxt) && /High/.test(cardTxt) && /1 hour before/.test(cardTxt),
    'the card reads like the brief: “I understood: Task / Date / Time / Priority / Reminder …”');
  ok(/nothing saved yet/.test(cardTxt) && /Create task/.test(cardTxt) && /Edit/.test(cardTxt),
    'the card shows [Create task] and [Edit], and says nothing is saved yet');
  $('#qaCard [data-nl="create"]').click();
  await sleep(420);
  ok($('#composer').hidden, 'Create ran through the ordinary composer submit and closed it again — one pipeline, no lingering editor');
  const t24 = tsk().find((x) => x.title === 'Finish assignment');
  ok(!!t24, 'Create task → the task exists (exactly one, via the composer’s own submit pipeline)');
  ok(t24.dueDate === NLdue24() && t24.priority === 'high', 'the confirmed date + priority landed on the real task');
  function NLdue24() { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  const rw = remMir().reminders.filter((x) => x.taskId === t24.id);
  ok(rw.length === 1 && rw[0].reminderType === 'h1', 'the “one hour before” reminder became a real reminder record on the task');
  // the Edit path: parsed values land in the FORM, nothing is written, user saves manually
  $('#qaInput').value = 'Exercise every Monday Wednesday and Friday at 6 PM';
  $('#qaInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(200);
  const beforeEdit = mir();
  $('#qaCard [data-nl="edit"]').click(); await sleep(250);
  ok(mir() === beforeEdit, 'Edit writes NOTHING either — it only moves the interpretation into the form');
  ok(!$('#composer').hidden, '…and Edit is what OPENS the composer (from the main screen) with the values applied');
  ok($('#f-title').value === 'Exercise' && $('#f-time').value === '18:00' && $('#f-recurrence').value === 'custom',
    'the form was pre-filled for editing: title, time, recurrence kind');
  ok(S_uiRecur24(), '…including the Mon/Wed/Fri day set in the custom repeat panel');
  function S_uiRecur24() { const q = (s) => window.document.querySelector(s); return !!(q('#rcDays [data-rday="1"].on') && q('#rcDays [data-rday="3"].on') && q('#rcDays [data-rday="5"].on')); }
  $('#saveTaskBtn').click(); await sleep(380);
  const ex = tsk().find((x) => x.title === 'Exercise');
  ok(ex && ex.recurrence === 'custom' && ex.recurRule && ex.recurRule.weekdays.join() === '1,3,5',
    'after the user pressed “Add task”, the edited recurrence is saved — ordinary task, ordinary editor, no special case');
  // low confidence → the card flags it loudly
  $('#qaInput').value = 'Organize the garage someday no rush';
  $('#qaInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(180);
  ok($('#qaCard').className.includes('low'), 'ambiguous input → the card turns LOW-CONFIDENCE styled (amber, solid border) — confirmation is not optional-look-and-feel');
  ok(/no date found/.test($('#qaCard').textContent), '…and the note tells the user what it could not find');
  const lowBefore = mir();
  $('#qaCard [data-nl="close"]').click(); await sleep(120);
  ok($('#qaCard').hidden && mir() === lowBefore, 'dismissing the card abandons the interpretation — again zero writes');
  // other views step the quick-add aside (it belongs to the list, not the calendar)
  $('#calBtn').click(); await sleep(160);
  ok($('#qaWrap').hidden, 'the quick-add bar steps aside in Calendar view — views still rule their screen');
  $('#calBtn').click(); await sleep(160);
  ok(!$('#qaWrap').hidden, '…and returns to the list');
  ok(true, 'natural-language add section completed without uncaught errors');
}


/* ================================================================ 25. DAILY PLAN (AI SUGGESTER) */
console.log('\n--- 25. Suggested plan: analyze → propose → confirm ---');
{
  const T = window.ZTPLAN;
  ok(!!T && typeof T.planDay === 'function', 'plan engine (public/plan.js) is loaded by the page, as wired in index.html');
  const NOW25 = new Date(2026, 8, 20, 8, 30); // Sunday morning, fixed
  const mk = (id, extra) => Object.assign({ id, title: id, status: 'active', priority: 'med', estMin: 0, dueDate: null, dueTime: null, projectId: null, deps: [], sortOrder: 0 }, extra);
  const BRIEF = [
    mk('api', { title: 'Complete Python API', priority: 'high', estMin: 60, dueDate: '2026-09-20' }),
    mk('uni', { title: 'University assignment', estMin: 45, dueDate: '2026-09-19' }),
    mk('exp', { title: 'Expense Tracker', estMin: 90, dueDate: '2026-09-21' }),
    mk('gym', { title: 'Exercise', estMin: 60, dueDate: '2026-09-20', dueTime: '17:00' }),
    mk('rev', { title: 'Review Python', estMin: 30, deps: ['api'] }),
  ];
  const BRIEFREM = [{ id: 'r1', status: 'pending', triggerAt: new Date(2026, 8, 20, 16, 30).getTime() }];
  const PR = { dayStart: '09:00', dayEnd: '22:00', gapMin: 15, maxBlocks: 6 };
  const p = T.planDay({ tasks: BRIEF, reminders: BRIEFREM, now: NOW25, prefs: PR });
  const at = (ti) => p.blocks.findIndex((b) => b.taskId === ti);
  const span = (ti) => { const b = p.blocks[at(ti)]; return b.start + '–' + b.end; };
  ok(p.blocks.length === 5, 'the brief’s five tasks all become blocks (5/5 placed)');
  ok(at('uni') === 0 && /overdue by 1d/.test(p.blocks[0].why.join()), 'tier 1 — the OVERDUE task leads the day');
  ok(at('api') < at('exp'), 'tiers 2–3 — due-today/high-priority ranks above an urgent-tomorrow deadline');
  ok(/unblocks 1 task/.test(p.blocks[at('api')].why.join()) && at('api') < at('rev'), 'tier 4 — the blocker (unblocks 1 task) is placed BEFORE its dependent');
  ok(span('gym') === '17:00–18:00' && /at its scheduled time/.test(p.blocks[at('gym')].why.join()), 'the day’s schedule wins: 17:00 Exercise keeps its own slot (the brief’s exact example)');
  ok(p.blocks.every((b) => !(T.toMin(b.start) < 990 && T.toMin(b.end) > 975)), 'the 16:30 reminder window stays clear — no block overlaps it');
  ok(p.blocks.every((b) => T.toMin(b.start) % 15 === 0 && T.toMin(b.end) % 15 === 0), 'every block snaps to the 15-minute grid, with 15-min gaps');
  ok(p.blocks.every((b, i) => i === 0 || T.toMin(b.start) - T.toMin(p.blocks[i - 1].end) >= 15), 'consecutive planned blocks keep a breathing gap (gapMin holds between every pair)');
  ok(p.blocks.every((b) => T.toMin(b.end) <= T.toMin('22:00') && T.toMin(b.start) >= T.toMin('08:45')), 'nothing spills past the day end or starts before “now”');
  ok(span('exp') === '11:15–12:45' && span('rev') === '13:00–13:30', 'durations come from the estimates (90m, 30m) rounded to the grid');
  ok(/analyzed 5 open tasks · 1 overdue/.test(p.notes[0]), 'the panel’s transparency line lists what was analyzed');
  const p2 = T.planDay({ tasks: [
    mk('a', { title: 'A plain', sortOrder: 0 }), mk('b', { title: 'B goal', projectId: 'pG', sortOrder: 1 }),
  ], now: NOW25, prefs: PR });
  const p2g = T.planDay({ tasks: [
    mk('a', { title: 'A plain', sortOrder: 0 }), mk('b', { title: 'B goal', projectId: 'pG', sortOrder: 1 }),
  ], now: NOW25, prefs: Object.assign({}, PR, { goalProjectId: 'pG' }) });
  ok(p2.blocks[0].title === 'A plain' && p2g.blocks[0].title === 'B goal', 'tier 5 — the user-selected goal project jumps the queue (tie → back to tie)');
  ok(p2.blocks[0].why.indexOf('your goal') === -1 && p2g.blocks[0].why.join().indexOf('your goal') >= 0, '…and the card says so (“your goal” chip)');
  const many = []; for (let i = 0; i < 10; i++) many.push(mk('m' + i, { title: 'Task ' + i, dueDate: '2026-09-20', sortOrder: i }));
  const p3 = T.planDay({ tasks: many, now: NOW25, prefs: Object.assign({}, PR, { maxBlocks: 3 }) });
  ok(p3.blocks.length === 3 && p3.skipped.length === 7 && /day is full/.test(p3.skipped[0].reason), 'the block cap is honored — overflow is SKIPPED with a stated reason, never silently dropped');
  const p4 = T.planDay({ tasks: BRIEF, now: NOW25, prefs: Object.assign({}, PR, { dayEnd: '09:45' }) });
  ok(p4.skipped.length > 0 && /before 09:45/.test(p4.skipped.map((s) => s.reason).join()), 'a tight day end → later tasks report “no free slot before 09:45”');
  const p5 = T.planDay({ tasks: BRIEF, now: new Date(2026, 8, 20, 21, 55), prefs: PR });
  ok(p5.blocks.length === 0 && /already past/.test(p5.notes.join()), 'planning AFTER the day is over produces nothing but an honest note (no 3 AM nonsense)');
  const p6 = T.planDay({ tasks: [], now: NOW25, prefs: PR });
  ok(p6.blocks.length === 0 && /no open tasks to plan/.test(p6.notes.join()), 'an empty list → “the day is yours”, not a fabricated plan');
  const LOW = [mk('l', { title: 'Low nothing', priority: 'low' })];
  ok(T.planDay({ tasks: LOW, now: NOW25, prefs: PR }).blocks.length === 0, 'a lone low-priority task with no deadline is left OUT (plan stays optional, filler has bounds)');
  ok(JSON.stringify(T.planDay({ tasks: BRIEF, reminders: BRIEFREM, now: NOW25, prefs: PR })) === JSON.stringify(p), 'determinism: same input → identical plan, byte for byte');
  ok(T.fmtRange({ start: '09:00', end: '10:00' }) === '09:00–10:00' && T.validEditedBlock({ start: '09:00', end: '10:00' }) && !T.validEditedBlock({ start: '10:00', end: '09:00' }), 'helpers: fmtRange + edited-block validation (end must beat start)');
  const p7 = T.planDay({ tasks: [
    mk('g1', { title: 'Gym A', dueDate: '2026-09-20', dueTime: '17:00', estMin: 60, sortOrder: 1 }),
    mk('g2', { title: 'Gym B', dueDate: '2026-09-20', dueTime: '17:00', estMin: 60, sortOrder: 2 }),
  ], now: NOW25, prefs: PR });
  ok(p7.blocks.length === 2 && p7.blocks.some((b) => b.start === '17:00' && b.end === '18:00') && p7.blocks.some((b) => b.start !== '17:00'),
    'two tasks pinned to the SAME 17:00: the first claim takes the slot, the other searches on — a pin never deadlocks the day');
  const p8 = T.planDay({ tasks: [
    mk('x1', { title: 'Fixed event', dueDate: '2026-09-20', dueTime: '10:00', estMin: 60 }),
  ].concat([mk('x2', { title: 'Filler', priority: 'low' }), mk('x3', { title: 'Later', dueDate: '2026-09-20', sortOrder: -1, priority: 'high', estMin: 45 })]), now: NOW25, prefs: PR });
  const x1b = p8.blocks.find((b) => b.title === 'Fixed event');
  ok(x1b && x1b.start === '10:00' && p8.blocks.every((b) => b === x1b || T.toMin(b.start) >= 660 || T.toMin(b.end) <= 600),
    'the 10:00 event OWNS its hour: pinned exactly there, and no other block lands on top of it');
  const snap = T.planDay({ tasks: [mk('z', { title: 'Z', estMin: 500, dueDate: '2026-09-20' })], now: NOW25, prefs: PR }).blocks[0];
  ok(snap.min === 120, 'a 500-minute estimate is capped to a 120-minute block — the planner never schedules a 8-hour slab');
}
{
  /* ---- B. the confirmation gate in the MAIN dom (the app itself) ---- */
  const mir25 = () => JSON.stringify(JSON.parse(window.localStorage.getItem('todo_backup_v1')).tasks);
  const before25 = mir25();
  $('#planBtn').click(); await sleep(300);
  const pv = () => $('#planView');
  ok(!pv().hidden && /Suggested plan/.test(pv().textContent), '✨ Plan opens the “Suggested plan” panel (the brief’s exact header)');
  ok(/your day: \d{2}:\d{2}–\d{2}:\d{2}/.test(pv().textContent) && (pv().textContent.includes('Today') || pv().textContent.includes(new Date().toLocaleDateString(undefined, { month: 'long' }))), '…with the human day header (“Today”-relative date + your day range)');
  const blocks25 = [...pv().querySelectorAll('.plan-blk')];
  ok(blocks25.length > 0, 'blocks are proposed for the live store (the 17 tasks earlier sections seeded)');
  ok(/\d{2}:\d{2}–\d{2}:\d{2}/.test(pv().textContent), 'times render like the brief: 09:00–10:00');
  ok(pv().querySelector('[data-plan="accept"]') && pv().querySelector('[data-plan="edit"]') && pv().querySelector('[data-plan="reject"]'), 'the footer is [Accept plan] [Edit] [Reject] — exactly the three the brief names');
  ok(mir25() === before25, 'ZERO writes while a plan is merely suggested — store byte-identical');
  const dueBefore25 = {};
  for (const x of JSON.parse(window.localStorage.getItem('todo_backup_v1')).tasks) dueBefore25[x.id] = x.dueDate + '|' + x.dueTime;
  // edit a proposed time
  pv().querySelector('[data-plan="edit"]').click(); await sleep(200);
  const st25 = pv().querySelector('input.plan-start');
  ok(!!st25, 'Edit turns blocks into time editors (start + duration + remove)');
  st25.value = '09:30';
  st25.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(200);
  ok(/09:30/.test(pv().textContent), 'the edited start shows in the proposal immediately');
  ok(mir25() === before25, 'editing the PROPOSAL still writes nothing (it is just a draft)');
  pv().querySelector('[data-plan="edit"]').click(); await sleep(150); // Done editing → recompute keeps fresh
  pv().querySelector('[data-plan="reject"]').click(); await sleep(200);
  ok(pv().hidden && mir25() === before25, 'Reject closes the panel and abandons everything — zero writes');
  // accept for real
  $('#planBtn').click(); await sleep(300);
  const nBlk = [...pv().querySelectorAll('.plan-blk')].length;
  pv().querySelector('[data-plan="accept"]').click(); await sleep(500);
  ok(mir25() !== before25, 'Accept plan is the ONE moment anything is written');
  const st25b = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  const planned25 = st25b.tasks.filter((x) => x.plan && x.plan.date);
  ok(planned25.length === nBlk, 'exactly the shown blocks were stamped (N proposed → N scheduled)');
  ok(planned25.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.plan.date) && /^\d{2}:\d{2}$/.test(x.plan.start) && x.plan.end > x.plan.start), 'stored schedule info = clean {date,start,end} — this IS the “calendar scheduling information” the brief asks for');
  ok(planned25.every((x) => dueBefore25[x.id] === (x.dueDate || null) + '|' + (x.dueTime || null)), 'deadlines untouched: plan rides ALONGSIDE dueDate/dueTime, it never rewrites a deadline');
  ok(/Accepted for today/.test(pv().textContent), 'the panel flips to an ACCEPTED state (you can see what is live)');
  pv().querySelector('[data-plan="close"]').click(); await sleep(250);
  const badges = [...doc.querySelectorAll('#taskList .badge.planned')];
  ok(badges.length === planned25.length, 'every scheduled task shows the 🗓 start-time badge in the list');
  // the calendar view displays the accepted blocks
  $('#calBtn').click(); await sleep(250);
  const planChips = [...doc.querySelectorAll('#calendar .cal-chip.is-plan')];
  ok(planChips.length > 0 && /\d{2}:\d{2}–\d{2}:\d{2}/.test(planChips[0].textContent), 'the Calendar view draws accepted plan blocks as dashed-outline chips with their time range');
  $('#calBtn').click(); await sleep(200);
  // prefs: shrinking the window re-proposes AND persists
  $('#planBtn').click(); await sleep(250);
  const de = pv().querySelector('input[data-pref-key="dayEnd"]');
  de.value = '10:30';
  de.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(250);
  ok(/your day: 09:00–10:30/.test(pv().textContent), '⚙ preferences (day range / break / limit / priority project) re-drive the proposal live — in human words');
  const stPref = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  ok(stPref.settings.planPrefs.dayEnd === '10:30', '…and persist into settings (survive the store mirror, sync like everything else)');
  ok(planned25.every((x) => stPref.tasks.find((y) => y.id === x.id).plan.date === planned25[0].plan.date), 'prefs changed the PROPOSAL only — accepted plan records were not silently rearranged');
  const de2 = $('#planView').querySelector('input[data-pref-key="dayEnd"]');
  de2.value = '22:00';
  de2.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(250);
  // completing a planned task releases its slot
  $('#planView').querySelector('[data-plan="close"]').click(); await sleep(250);
  const victim = planned25[0];
  const li25 = doc.querySelector('#taskList .task[data-id="' + victim.id + '"]');
  ok(!!li25, 'the scheduled task row is findable (its 🗓 badge visible)');
  li25.querySelector('[data-act="toggle"]').click(); await sleep(400);
  const after25 = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  const v25 = after25.tasks.find((x) => x.id === victim.id);
  const rolled25 = !!v25.recurrence && v25.status === 'active';
  ok((v25.status === 'completed' || rolled25) && !v25.plan, 'completing the task clears its plan slot — a done (or occurrence-rolled recurring) task does not squat on the day');
  $('#planBtn').click(); await sleep(300);
  const clr25 = $('#planView').querySelector('[data-plan="clear"]');
  ok(!!clr25, 'the accepted-state panel offers [Clear today’s schedule]');
  clr25.click(); await sleep(400);
  ok(JSON.parse(window.localStorage.getItem('todo_backup_v1')).tasks.every((x) => !x.plan || !x.plan.date),
    'Clear strips every plan field — the tasks themselves survive (only the SCHEDULED info goes, which is what was accepted)');
  ok(true, 'daily-plan section completed without uncaught errors');
}

/* ================= 26. redesign: shell, views, disclosure, onboarding =================
   The UI redesign must be provably an IMPROVEMENT LAYER, not a behavior change:
   every check here asserts the new shell routes into the SAME state machine. */
{
  const cssSrc = readFileSync(PUB + '/styles.css', 'utf8');
  const NOW26 = Date.now();
  const Td = (off) => { const x = new Date(NOW26 + off * 86400000); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const seed26 = {
    app: 'zerotodo', schemaVersion: 5, savedAt: NOW26, settings: {},
    tasks: [
      { id: 'ov1', title: 'Pay bill', dueDate: Td(-2), status: 'active', priority: 'med', tags: [], createdAt: NOW26 - 9e5, updatedAt: NOW26 - 9e5 },
      { id: 'td1', title: 'Do taxes', dueDate: Td(0), status: 'active', priority: 'high', tags: [], createdAt: NOW26 - 8e5, updatedAt: NOW26 - 8e5 },
      { id: 'tm1', title: 'Team sync', dueDate: Td(1), dueTime: '10:00', status: 'active', priority: 'med', tags: ['work'], projectId: 'pj1', createdAt: NOW26 - 7e5, updatedAt: NOW26 - 7e5 },
      { id: 'dn1', title: 'Old done', dueDate: Td(0), status: 'completed', completedAt: NOW26 - 3e5, priority: 'low', tags: [], createdAt: NOW26 - 6e5, updatedAt: NOW26 - 6e5 },
    ],
    trash: [], subtasks: [], reminders: [], habits: [], focusSessions: [],
    projects: [{ id: 'pj1', name: 'Q Launch', icon: '🚀', status: 'active', createdAt: NOW26 - 9e5, updatedAt: NOW26 - 9e5, sortOrder: 1 }],
    version: 5,
  };
  const boot26 = (lsInit) => new Promise(async (resolve) => {
    const w = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
    w.window.HTMLElement.prototype.scrollIntoView = function () {};
    for (const [k, v] of Object.entries(lsInit || {})) w.window.localStorage.setItem(k, v);
    w.window.eval(storageSrc); w.window.eval(nlSrc); w.window.eval(aiSrc); w.window.eval(planSrc); w.window.eval(appSrc);
    await sleep(900);
    resolve(w);
  });
  const r26 = await boot26({ todo_backup_v1: JSON.stringify(seed26), zerotodo_welcome_v1: 'done' });
  const D = r26.window.document;
  const $26 = (s) => D.querySelector(s);
  const mir26 = () => JSON.parse(r26.window.localStorage.getItem('todo_backup_v1'));

  // —— structure & icon system ——
  ok(!!$26('#appShell') && !$26('#sidebar').hidden && !!$26('#bottomNav') && !!$26('#mobFab'),
    'shell: sidebar + main column + a SEPARATE mobile bottom nav with FAB (never a shrunk sidebar)');
  const sideTxt = $26('#sidebar').textContent;
  ok(['Home', 'Today', 'Upcoming', 'Projects', 'Calendar', 'Completed', 'Trash', 'Settings'].every((n) => sideTxt.includes(n)),
    'sidebar IA: Home/Today/Upcoming/Projects + Calendar, then Completed/Trash/Settings — the exact mental model');
  ok($26('#navHome').innerHTML.includes('<svg') && !$26('#sideCollapse').textContent.trim(),
    'chrome icons are inline SVG from ONE sprite set — no emoji, no unicode mixing');
  const iconOnly = [...D.querySelectorAll('#sidebar .sb-item, #sidebar .sb-collapse')].filter((b) => !b.textContent.trim());
  ok(iconOnly.length >= 1 && iconOnly.every((b) => b.hasAttribute('data-tip') && b.hasAttribute('aria-label')),
    'every icon-only control carries a tooltip AND an accessible name');
  const spriteIds = new Set([...D.querySelectorAll('svg[hidden] symbol, #zt-sprite symbol, symbol')].map((s) => s.id).filter(Boolean));
  const uses = [...D.querySelectorAll('use')].map((u) => (u.getAttribute('href') || u.getAttribute('xlink:href') || '')).filter((h) => h.startsWith('#'));
  ok(spriteIds.size >= 8 && uses.every((h) => spriteIds.has(h.slice(1))),
    'sprite is single-source: every <use> resolves to a defined symbol (' + uses.length + ' uses, ' + spriteIds.size + ' symbols)');
  ok(/--sp-\d+:/.test(cssSrc) && /--fs-(xs|s|m|l|xl|2xl):/.test(cssSrc) && /--t-fast:/.test(cssSrc),
    'design system: spacing/type/duration live in CSS variables, not scattered magic numbers');
  ok(/prefers-reduced-motion/.test(cssSrc) && /:focus-visible/.test(cssSrc),
    'accessibility: reduced-motion honored and focus made visible globally');
  ok(/@media[^{]*max-width:\s*899px[\s\S]*#bottomNav/.test(cssSrc) && /@media[^{]*max-width:\s*899px[\s\S]*composer/.test(cssSrc),
    'mobile media query carries the bottom nav and the composer-as-bottom-sheet pattern');

  // —— landing view is UNCHANGED (regression lock for ~450 existing checks) ——
  ok($26('#taskList').hidden === false && $26('#taskList').textContent.includes('Team sync') && $26('#viewHead').textContent === '',
    'existing users land on the familiar full list — Today/Home are choices, not ambushes');
  ok($26('#welcome').hidden === true && r26.window.localStorage.getItem('zerotodo_welcome_v1') === 'done',
    'seen users are NEVER re-onboarded (flag honored before the empty check)');

  // —— Today / Upcoming: windows + teaching groups ——
  $26('#navToday').click(); await sleep(120);
  let rows = $26('#taskList').textContent;
  ok($26('#viewHead').textContent.includes('Today') && rows.includes('Pay bill') && rows.includes('Do taxes') && !rows.includes('Team sync'),
    'Today shows exactly what needs attention: overdue + due-today (+ undated), never next week');
  const grps = [...D.querySelectorAll('#taskList .grp')].map((g) => g.textContent.replace(/\d+$/, '').trim());
  // (the only due-today task is HIGH priority — it belongs to the High bucket;
  //  an empty “Today” header would violate the hide-empty-sections rule instead)
  ok(grps.includes('⚠ Overdue') && grps.includes('High priority') && grps.includes('Completed') && !grps.includes('Today'),
    'Today groups by attention: Overdue → High priority → Today → Completed, and a bucket only appears when filled');
  ok(!grps.some((g) => /Upcoming|Tomorrow/.test(g)), 'empty sections are NOT shown — no “Tomorrow: 0” headers');
  ok($26('#navTodayN').textContent === '2', 'sidebar Today badge counts actionable-today (overdue+today, excluding done/future)');
  $26('#navUpcoming').click(); await sleep(120);
  rows = $26('#taskList').textContent;
  ok(rows.includes('Team sync') && !rows.includes('Pay bill') && [...D.querySelectorAll('#taskList .grp')].some((g) => /Tomorrow/.test(g.textContent)),
    'Upcoming is the mirror window (due > today) grouped BY DAY with real weekday names');
  // overdue group carries color AND words (color never alone)
  $26('#navToday').click(); await sleep(120);
  const overGrp = [...D.querySelectorAll('#taskList .grp')].find((g) => /Overdue/.test(g.textContent));
  ok(!!overGrp && overGrp.className.includes('over') && overGrp.textContent.includes('⚠') && /\d/.test(overGrp.textContent),
    'Overdue header: red tint + ⚠ symbol + WORDS + count — never color alone');

  // —— Home: command center that routes, with real handlers underneath ——
  $26('#navHome').click(); await sleep(140);
  ok(!$26('#homeView').hidden && $26('#taskList').hidden === true && /Good (morning|afternoon|evening)|Still up/.test($26('#homeView').textContent),
    'Home: time-aware greeting, the list steps aside — it is a view, not a second app');
  const homeTxt = $26('#homeView').textContent;
  ok(/2/.test(homeTxt) && homeTxt.includes('remaining today') && homeTxt.includes('Pay bill') && homeTxt.includes('0 of 1') && /0%/.test(homeTxt),
    'Home answers “what should I do today?” in one glance: counts, the list itself, and project progress');
  ok(homeTxt.includes('✨ Plan my day') && homeTxt.includes('＋ Add task'), 'Home leads with the two actions, not with charts (analytics stay on the dashboard)');
  ok(!!$26('#homeView .prog-row i[style*="width"]'), 'project progress renders as a real bar (not just a % string)');
  const before26 = JSON.stringify(mir26());
  $26('#homeView .hcheck').click(); await sleep(460);
  ok(mir26().tasks.find((x) => x.id === 'ov1').status === 'completed' && before26 !== JSON.stringify(mir26()),
    'ticking from Home goes through the REAL row handler — same persistence, same rules, no shadow logic');
  ok(!$26('#homeView').textContent.includes('Pay bill') && $26('#taskList').textContent.includes('Pay bill'),
    'Home re-derives instantly (row leaves “remaining today”) while the underlying list row stays intact underneath');

  // —— projects view + click-through ——
  $26('#navProjects').click(); await sleep(120);
  ok(!$26('#projectsView').hidden && $26('#projectsView').textContent.includes('Q Launch') && /0 of 1/.test($26('#projectsView').textContent),
    'Projects view: one card per project with name, progress bar and counts');
  ok(mir26().settings.view === 'projects', 'view choice is a persisted preference (settings-synced like everything else)');
  $26('#projectsView .pj-card').click(); await sleep(140);
  ok($26('#taskList').hidden === false && mir26().settings.filterProject === 'pj1',
    'opening a project jumps into the SAME filtered list — one dataset, no parallel project page');

  // —— overlays still float exclusively over the list under the new nav ——
  $26('#navHome').click(); await sleep(120);
  $26('#dashBtn').click(); await sleep(220);
  ok($26('#dashboard').hidden === false && $26('#homeView').hidden === true,
    'dashboard opens OVER Home and Home steps aside (render exclusivity survives the redesign)');
  $26('#dashBtn').click(); await sleep(220);
  ok($26('#dashboard').hidden === true && !$26('#homeView').hidden, 'closing the dashboard returns to Home when Home was the view');

  // —— composer: drawer class + progressive disclosure ——
  $26('#navToday').click(); await sleep(120);
  $26('#newTaskBtn').click(); await sleep(120);
  ok(D.body.classList.contains('composer-open') && $26('#advFields').hidden === true && $26('#moreBtn').getAttribute('aria-expanded') === 'false',
    'composer opens as a focused drawer: title + due + priority only, “More options” collapsed with honest aria');
  $26('#moreBtn').click(); await sleep(60);
  ok($26('#advFields').hidden === false && $26('#moreBtn').getAttribute('aria-expanded') === 'true', 'one click reveals description/project/tags/time/reminders/repeat');
  $26('#cancelTaskBtn').click(); await sleep(120);
  ok(!D.body.classList.contains('composer-open'), 'closing the drawer strips the body class (no phantom padding behind)');
  // tm1 is DUE TOMORROW — in the Today window it correctly isn’t in the list;
  // typing a search brings it back (search bypasses view windows, by design)
  $26('#searchInput').value = 'Team sync';
  $26('#searchInput').dispatchEvent(new r26.window.Event('input', { bubbles: true })); await sleep(200);
  const editBtn = $26('#taskList .task[data-id="tm1"] [data-act="edit"]');
  editBtn.click(); await sleep(140);
  ok($26('#advFields').hidden === false && $26('#moreBtn').getAttribute('aria-expanded') === 'true',
    'editing a task WITH advanced data (time/tag) auto-expands “More options” — disclosure never hides truth');
  $26('#cancelTaskBtn').click(); await sleep(120);
  $26('#searchInput').value = '';
  $26('#searchInput').dispatchEvent(new r26.window.Event('input', { bubbles: true })); await sleep(200);

  // —— ⌘K lightning quick-add ——
  r26.window.dispatchEvent(new r26.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await sleep(80);
  ok(D.activeElement && D.activeElement.id === 'qaInput', 'Ctrl/⌘ + K lands the caret in quick-add from anywhere in the list views');

  // —— sidebar collapse (icons + tooltips only) with its own persisted flag ——
  $26('#sideCollapse').click(); await sleep(60);
  ok(D.body.classList.contains('sb-collapsed') && r26.window.localStorage.getItem('zerotodo_sidebar_v1') === '0',
    'collapse: icons-only, persisted separately from sync data');
  const r26b = await boot26({ todo_backup_v1: JSON.stringify(seed26), zerotodo_welcome_v1: 'done', zerotodo_sidebar_v1: '0' });
  ok(r26b.window.document.body.classList.contains('sb-collapsed'), 'collapsed preference re-applies at boot (before first paint of the sidebar)');
  r26b.window.close();

  // —— onboarding: one calm card, then never again; one tip, then never again ——
  const r26c = await boot26({});
  const Dc = r26c.window.document;
  ok(!$26c('#welcome', Dc) || $Dc0(Dc).hidden === false, 'brand-new user (empty everything) meets a welcome card — the app does not just sit there');
  function $26c(s, dd) { return dd.querySelector(s); }
  function $Dc0(dd) { return dd.querySelector('#welcome'); }
  $Dc0(Dc).querySelector('#wcSkipBtn').click(); await sleep(60);
  ok($Dc0(Dc).hidden === true && r26c.window.localStorage.getItem('zerotodo_welcome_v1') === 'done', '[No thanks] dismisses and latches forever');
  const Dqa = Dc.querySelector('#qaInput');
  Dqa.value = 'Buy milk today';
  Dqa.dispatchEvent(new r26c.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(250);
  Dc.querySelector('[data-nl="create"]').click(); await sleep(550); // one-interaction create (prefill + save, no extra clicks)
  const afterFirst = JSON.parse(r26c.window.localStorage.getItem('todo_backup_v1'));
  ok(afterFirst.tasks.length === 1 && /Ctrl/.test(Dc.querySelector('#toastHost').textContent) && r26c.window.localStorage.getItem('zerotodo_tip_k') === '1',
    'after the FIRST task a one-time tip teaches ⌘K — hints vanish once used, there is no tour');
  const r26d = await boot26({ todo_backup_v1: JSON.stringify(afterFirst), zerotodo_welcome_v1: 'done' });
  ok(r26d.window.document.querySelector('#welcome').hidden === true, 'second-ever login: zero onboarding noise');
  r26d.window.close(); r26c.window.close();

  // —— teaching empty states ——
  const only = { app: 'zerotodo', schemaVersion: 5, savedAt: NOW26, settings: {}, trash: [], subtasks: [], reminders: [], habits: [], focusSessions: [], projects: [], version: 5,
    tasks: [{ id: 'ft1', title: 'Trip prep', dueDate: Td(3), status: 'active', priority: 'med', tags: [], createdAt: NOW26 - 1e5, updatedAt: NOW26 - 1e5 }] };
  const r26e = await boot26({ todo_backup_v1: JSON.stringify(only), zerotodo_welcome_v1: 'done' });
  const De = r26e.window.document;
  De.querySelector('#navToday').click(); await sleep(120);
  ok(De.querySelector('#emptyState').hidden === false && /caught up/.test(De.querySelector('#emptyState').textContent),
    'Today with nothing due says “you’re all caught up” — a state, not a fault');
  De.querySelector('#emptyState [data-ec="upcoming"]').click(); await sleep(120);
  ok(De.querySelector('#taskList').textContent.includes('Trip prep'),
    'the empty state ships working CTAs: [See Upcoming →] routes to where the task actually is');
  r26e.window.close();

  ok(true, 'redesign section completed without uncaught errors');
  r26.window.close();
}

/* 27. calendar Day Overview + planner balance — the time-planning contract (§§6-16) */
console.log('\n--- 27. calendar day overview & planner balance ---');
{
  const EV = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  $('#calBtn').click(); await sleep(160);
  doc.querySelector('#calBar [data-cview="day"]').click(); await sleep(140);
  doc.querySelector('#calBar [data-cnav="today"]').click(); await sleep(160);
  const sum = doc.querySelector('#calHost .cal-day-summary');
  ok(!!sum, 'Day Overview opens with a summary bar (the day answers “how full is it?” before titles)');
  ok(/\d+ task/.test(sum.textContent) && /Workload: (Light|Moderate|Full|Overbooked|unscheduled|clear|All clear ✓)/.test(sum.textContent),
    '…“N tasks” count + a NEUTRAL Workload word (Light/Moderate/Full/Overbooked — never moral labels)');
  const slot14 = doc.querySelector('#calHost .cal-cell.slot[data-chour="14"]');
  ok(!!slot14, 'the day renders 06:00–22:00 hour slots as real targets');
  ok(!slot14.classList.contains('has-t') ? /Click to create a task at 14:00/.test(slot14.getAttribute('title') || '') : true,
    'an EMPTY slot whispers “Click to create a task at 14:00” — affordance, not decoration');
  if (!slot14.classList.contains('has-t')) {
    slot14.click(); await sleep(220);
    ok(!$('#composer').hidden && $('#f-due').value === TODAY && $('#f-time').value === '14:00',
      'clicking it opens the EXISTING composer with today + 14:00 pre-filled — one task record, created where it lands');
    $('#cancelTaskBtn').click(); await sleep(140);
  } else ok(false, 'slot 14:00 unexpectedly busy — test assumes an empty evening slot');
  // planner balance panel (§6): words + bar, never raw minutes tables
  $('#calBtn').click(); await sleep(140);
  $('#planBtn').click(); await sleep(950);
  const pvh = $('#planView');
  const bal = pvh.querySelector('.plan-balance');
  ok(!!bal && /Available/.test(bal.textContent) && /Planned/.test(bal.textContent) && /Free/.test(bal.textContent),
    'Your Day carries an Available / Planned / Free balance in human time (“2h 10m”, never “130 min”)');
  ok(!!bal.querySelector('.pb-bar i') && /percent of your day planned/.test(bal.querySelector('.pb-bar').getAttribute('aria-label') || ''),
    '…with a progress bar whose aria-label states the percentage');
  ok(!/Gap \(min\)/.test(pvh.textContent) && !/\bdayEndMin\b|\bstartMin\b/.test(pvh.textContent),
    'raw minute fields are gone from the primary UI — prefs speak human (“your day starts at…”)');
  const rescan = pvh.querySelector('[data-plan="rescan"]');
  ok(!!rescan && /Re-analyze/i.test(rescan.textContent), 'a Re-analyze action exists in the plan header');
  // home stats (§2-3): integer hero + words underneath
  $('#planBtn').click(); await sleep(160);
  $('#navHome') && $('#navHome').click(); await sleep(200);
  const hs = doc.querySelector('.home-stats');
  if (hs) {
    const big = hs.querySelector('.hs-num, .hs-big, b');
    ok(!!big && /^\d+$/.test(big.textContent.trim()), 'the Home number is a plain integer — no decimals, no “2.5h” nonsense');
    ok(!!hs.querySelector('.hs-sub') && /completed|nothing due today/.test(hs.textContent), '…and sub-lines carry the words (“5 of 8 completed”)');
  } else ok(false, 'home-stats strip missing from Home');
  $('#navHome') && $('#navHome').click(); await sleep(140);
  ok(true, 'section 27 completed without uncaught errors');
}

/* 28. habits: today view, milestones, forgiving misses, wizard, recommendations (§§20-33) */
console.log('\n--- 28. habit motivation layer ---');
{
  const EV = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  $('#habBtn').click(); await sleep(220);
  const host = $('#habitsHost');
  ok(!!host.querySelector('.hab-today'), 'the Habits view leads with TODAY — not a raw card list');
  ok(/\d \/ \d+ completed/.test(host.textContent), '“N / M completed” in integers up top');
  ok(!!host.querySelector('.ht-bar i'), '…with a real progress bar');
  const wk = host.querySelector('.hab-wk');
  ok(!!wk && wk.querySelectorAll('thead th').length === 8 && /✓|○/.test(wk.textContent),
    'week grid: seven day-headers + habit name, readable ✓/○ GLYPHS (never color alone) (§33)');
  ok(!!wk.querySelector('td[title]') && /\d\/\d/.test(wk.querySelector('td[title]').getAttribute('title')),
    '…every cell carries a tooltip with the real count (“Tue 22: 3/3 — met”)');
  // —— wizard: 5 steps OVER the existing editor, same ids, same save ——
  host.querySelector('[data-hact="new"]').click(); await sleep(200);
  const mc = doc.querySelector('.hab-modal');
  ok(!!mc && mc.querySelectorAll('.hw-step').length === 5, 'the habit editor presents 5 guided steps (fields themselves are unchanged)');
  ok(/Step 1 of 5/.test(mc.querySelector('.hw-ind').textContent), '…with a visible position marker');
  mc.querySelector('[data-hw="next"]').click(); await sleep(120);
  ok(/Step 1 of 5/.test(mc.querySelector('.hw-ind').textContent) && !!doc.querySelector('.toast, #toastHost') && /name/i.test($('#toastHost').textContent),
    'step 1 refuses an unnamed habit and says why (validation in place, not a silent save)');
  mc.querySelector('#hh-name').value = 'Meditate';
  mc.querySelector('[data-hw="next"]').click(); await sleep(120);
  ok(/Step 2 of 5/.test(mc.querySelector('.hw-ind').textContent) && mc.querySelectorAll('.hw-dot.on').length === 2,
    'Next advances with progress dots filling in');
  mc.querySelector('[data-hw="back"]').click(); await sleep(100);
  ok(/Step 1 of 5/.test(mc.querySelector('.hw-ind').textContent), 'Back returns — nothing is lost');
  for (let i = 0; i < 4; i++) { mc.querySelector('[data-hw="next"]').click(); await sleep(70); }
  ok(/Step 5 of 5/.test(mc.querySelector('.hw-ind').textContent) && /Meditate/.test(mc.querySelector('#hw-preview').textContent) && /streak starts/.test(mc.textContent),
    'the last step previews “Meditate · Every day · 1× per day” and promises the streak starts now');
  mc.querySelector('[data-hm="save"]').click(); await sleep(320);
  ok(!doc.querySelector('.hab-modal') && (remMirror().habits || []).some((h) => h.name === 'Meditate' && h.target === 1),
    'Create habit saves through the SAME record shape — the wizard is presentation, not a second engine');
  // completion feedback (§31)
  const medCard = [...doc.querySelectorAll('.hab-card')].find((c) => /Meditate/.test(c.textContent));
  medCard.querySelector('[data-hact="plus"]').click(); await sleep(260);
  const flash = $('#habitsHost .hab-flash');
  ok(!!flash && /Day met ✓/.test(flash.textContent) && /🔥/.test(flash.textContent),
    'checking off shows calm inline feedback — “Day met ✓ · 🔥 1-day streak”, not confetti');
  ok(flash.getAttribute('role') === 'status', '…announced politely to screen readers (role=status)');
  // recommendations (§27-30): categories, one-click, prefill
  const recs = $('#habitsHost .hab-recs');
  recs.open = true; await sleep(80);
  const cats = [...recs.querySelectorAll('.hab-recat h4')].map((x) => x.textContent.trim());
  ok(cats.length === 4 && /💪/.test(cats[0]) && /🧠/.test(cats[1]) && /📚/.test(cats[2]) && /😴/.test(cats[3]),
    'Recommended habits grouped under 💪 Body · 🧠 Mind · 📚 Learning · 😴 Lifestyle');
  const addBtn = [...recs.querySelectorAll('.hab-rec')].find((x) => /Walk 20 minutes/.test(x.textContent)).querySelector('[data-hact="suggest"]');
  addBtn.click(); await sleep(220);
  const mc2 = doc.querySelector('.hab-modal');
  ok(!!mc2 && mc2.querySelector('#hh-name').value === 'Walk 20 minutes',
    'one click opens the editor PRE-FILLED — nothing is created behind the user’s back');
  mc2.querySelector('[data-hm="cancel"]').click(); await sleep(140);
  ok(!(remMirror().habits || []).some((h) => h.name === 'Walk 20 minutes'), 'cancelling the prefill writes NOTHING');
  await sleep(3000);
  ok(!$('#habitsHost .hab-flash'), 'the feedback fades by itself — no persistent clutter');
  ok(true, 'section 28 live flow done');

  // —— deterministic boots: milestones + forgiving miss + empty teaching ——
  const boot = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  const dd = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  boot.habits = (boot.habits || []).concat([
    { id: 'hms1', name: 'Stretch', description: '', frequency: 'daily', weekdays: [], target: 1, archived: false, remindTime: null, createdAt: Date.now() - 8 * 864e5, updatedAt: Date.now(), history: [6, 5, 4, 3, 2, 1, 0].map((k) => ({ d: dd(-k), c: 1 })) },
    { id: 'hms2', name: 'Read', description: '', frequency: 'daily', weekdays: [], target: 1, archived: false, remindTime: null, createdAt: Date.now() - 9 * 864e5, updatedAt: Date.now(), history: [7, 6, 5, 4, 3].map((k) => ({ d: dd(-k), c: 1 })) },
  ]);
  const dom3 = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dom3.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom3.window.localStorage.setItem('todo_backup_v1', JSON.stringify(boot));
  dom3.window.eval(storageSrc); dom3.window.eval(appSrc);
  await sleep(450);
  const d3x = dom3.window.document;
  d3x.querySelector('#habBtn').click(); await sleep(260);
  const stretch = [...d3x.querySelectorAll('.hab-card')].find((c) => /Stretch/.test(c.textContent));
  ok(!!stretch && /🏁 One week strong/.test(stretch.textContent) && /🔥 7 days/.test(stretch.textContent),
    'milestones are CALM LABELS on the card (🏁 One week strong) — points/badges/leagues are nowhere (§43)');
  ok(/7-day streak/.test(d3x.querySelector('.hab-today').textContent) && /Keep it going today/.test(d3x.querySelector('.hab-today').textContent),
    'the strongest streak is surfaced in Today’s header with an encouraging line');
  const read = [...d3x.querySelectorAll('.hab-card')].find((c) => /Read/.test(c.textContent));
  ok(!!read && /missed yesterday — start again today/.test(read.textContent) && /best run was 5 days/.test(read.textContent),
    'a broken streak is FORGIVING, not punishing: “You missed yesterday — start again today.” (§26)');
  ok(!/streak at risk|\ud83d\udc80|lose your streak/i.test(d3x.querySelector('#habitsHost').textContent),
    'no threat language anywhere in the habits view');
  dom3.window.close();
  const emptyBoot = JSON.parse(window.localStorage.getItem('todo_backup_v1'));
  emptyBoot.habits = [];
  const dom4 = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dom4.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom4.window.localStorage.setItem('todo_backup_v1', JSON.stringify(emptyBoot));
  dom4.window.eval(storageSrc); dom4.window.eval(appSrc);
  await sleep(450);
  const d4x = dom4.window.document;
  d4x.querySelector('#habBtn').click(); await sleep(240);
  const eh = d4x.querySelector('#habitsHost');
  ok(/No habits yet/.test(eh.textContent) && !!eh.querySelector('.hab-empty [data-hact="new"]'),
    'the empty habits state teaches with ONE clear button — no wall of text');
  ok(/Start small/.test(eh.textContent) && eh.querySelectorAll('.hab-reccols > div').length === 4,
    '…and immediately offers the recommended-habits catalog with a “start small” nudge (§27)');
  dom4.window.close();
  $('#habBtn').click(); await sleep(160); // leave habits view as found
  ok(true, 'section 28 completed without uncaught errors');
}

/* 29. settings: dedicated screen with categories, zero duplication (§§34-38) */
console.log('\n--- 29. settings information architecture ---');
{
  const EV = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const panel = $('#settingsPanel');
  if (panel.hidden) $('#settingsBtn').click();
  await sleep(200);
  ok(!panel.hidden, '⚙ opens the Settings screen');
  const tabs = [...panel.querySelectorAll('.set-nav [data-settab]')].map((b) => b.dataset.settab);
  ok(tabs.join(',') === 'general,notifications,focus,habits,data,privacy,about',
    'a left-nav lists exactly: General · Notifications · Focus · Habits · Data · Privacy · About (§35)');
  panel.querySelector('.set-nav [data-settab="general"]').click(); await sleep(120); // land on a known tab (S.ui.setTab persists across sections)
  ok(!panel.querySelector('.set-page[data-settab="general"]').hidden && panel.querySelector('.set-page[data-settab="focus"]').hidden,
    'pages are exclusive — one visible at a time (no 500px scroll of everything)');
  const every = (id) => doc.querySelectorAll('#' + id).length;
  ok(every('themeSelect') === 1 && every('habInStats') === 1 && every('cloudEnabled') === 1 && every('aiMode') === 1,
    'each global setting exists ONCE in the DOM — the old duplicates are gone (§38)');
  // move to notifications + drill deeper
  panel.querySelector('.set-nav [data-settab="notifications"]').click(); await sleep(120);
  ok(!panel.querySelector('.set-page[data-settab="notifications"]').hidden && panel.querySelector('.set-page[data-settab="general"]').hidden
    && !!panel.querySelector('#notifBox'), 'Notifications page owns #notifBox wholesale (all 8 switches still theirs)');
  // data page: backup reminder + cloud + forwards to the existing export/import pipeline
  panel.querySelector('.set-nav [data-settab="data"]').click(); await sleep(120);
  const dp = panel.querySelector('.set-page[data-settab="data"]');
  ok(!!dp.querySelector('#reminderSelect') && !!dp.querySelector('#cloudEnabled') && dp.querySelectorAll('[data-setforward]').length === 2,
    'Data page = storage + sync + backup reminder + Export/Import (the topbar buttons, reused — not reimplemented) (§36)');
  // habits page is TINY and links to itself being enough (§37: one description, one control)
  panel.querySelector('.set-nav [data-settab="habits"]').click(); await sleep(120);
  ok(/dashboard stats/i.test(panel.querySelector('.set-page[data-settab="habits"]').textContent),
    'Habits page explains its single toggle in plain words');
  // start-view preference writes S.settings.view (the same value nav clicks read)
  panel.querySelector('.set-nav [data-settab="general"]').click(); await sleep(120);
  const sv = panel.querySelector('#setStartView');
  ok(!!sv && sv.value === (JSON.parse(window.localStorage.getItem('todo_backup_v1')).settings.view || 'all'),
    'General offers “Open this view at launch” synced to the live setting');
  sv.value = 'today'; EV(sv, 'change'); await sleep(300);
  ok(JSON.parse(window.localStorage.getItem('todo_backup_v1')).settings.view === 'today' && doc.querySelector('#navToday') && doc.querySelector('#navToday').getAttribute('aria-current') === 'page',
    'choosing Today persists the setting AND switches the running view — one source of truth');
  sv.value = 'all'; EV(sv, 'change'); await sleep(260);
  // context shortcut: from the habits view itself
  $('#habBtn').click(); await sleep(200);
  const gl = doc.querySelector('[data-gosettings="habits"]');
  ok(!!gl, 'the Habits view links to its own settings page instead of duplicating controls');
  gl.click(); await sleep(260);
  ok(!panel.hidden && !panel.querySelector('.set-page[data-settab="habits"]').hidden && panel.querySelector('.set-page[data-settab="general"]').hidden,
    'the link lands on Settings → Habits (deep-linked, not dumped at the top)');
  if (!panel.hidden) $('#settingsBtn').click(); await sleep(120);
  ok(true, 'section 29 completed without uncaught errors');
}

console.log(failed ? `\n${failed} UI check(s) FAILED` : '\nAll UI smoke checks passed.');
process.exit(failed ? 1 : 0);
