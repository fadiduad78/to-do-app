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
ok(mirror.schemaVersion === 3 && mirror.subtasks.length === 5, 'localStorage mirror carries 5 subtasks at schema v3');
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

console.log(failed ? `\n${failed} UI check(s) FAILED` : '\nAll UI smoke checks passed.');
process.exit(failed ? 1 : 0);
