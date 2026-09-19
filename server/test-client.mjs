/* ============================================================================
 * test-client.mjs — integration test: run the REAL cloud.js against the REAL
 * server in Node with a minimal browser shim. Verifies the wire protocol,
 * the Bearer token, tombstone capture, and — critically — that soft-deletes
 * (tasks→trash) do NOT tombstone, while hard deletes do.
 * Run: node server/test-client.mjs
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18100;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'client-test-key';

let failed = 0;
const ok = (c, n) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) failed++; };

const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), ZT_HOST: '127.0.0.1', ZT_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'zt-ct-')), ZT_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not start');
};
await waitUp();

/* ------------------------- minimal browser shim ------------------------- */

const LS = new Map();
LS.setItem = (k, v) => { LS.set(k, String(v)); };
LS.getItem = (k) => (LS.has(k) ? LS.get(k) : null);
LS.removeItem = (k) => { LS.delete(k); };
// Pre-configure cloud like a user who pasted URL+token in Settings:
LS.setItem('zt_cloud_v1', JSON.stringify({ enabled: true, endpoint: BASE, token: TOKEN }));

globalThis.localStorage = LS;
globalThis.location = { protocol: 'http:', origin: BASE };
globalThis.document = {
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, append() {}, querySelector: () => null }),
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};

/* ------------------------ fake local storage engine ---------------------- */
/* Mimics ZTStorage semantics: commit(ops) mutates nothing here — the test
 * mutates `memory` directly like app.js does — and returns true. */
const memory = { tasks: [], trash: [], projects: [], subtasks: [], settings: {}, lastSavedAt: Date.now() };
const store = {
  state: memory,
  async commit() { return true; },
  async resync() { return true; },
  replaceMemory(t, r, p, s) { memory.tasks = t; memory.trash = r; memory.projects = p || []; memory.subtasks = s || []; },
};

/* --------------------------- load real cloud.js -------------------------- */
const src = readFileSync(path.join(DIR, '..', 'public', 'cloud.js'), 'utf8');
new Function(src)(); // executes the IIFE against globalThis
if (!globalThis.ZTCloud) { console.error('ZTCloud missing'); process.exit(1); }

const T0 = Date.now() - 2 * 86400000;
const rec = (id, title, upd, extra) => ({
  id, title, description: '', dueDate: null, priority: 'med', status: 'active',
  tags: [], createdAt: T0, updatedAt: upd, sortOrder: 0, ...extra,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const serverState = async () => (await fetch(BASE + '/api/state', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();

await globalThis.ZTCloud.attach({ store, getState: () => memory, onChange: () => {} });

console.log('1. initial connect + push of live state');
const t1 = rec('t1', 'milk', T0 + 1000);
memory.tasks.push(t1);
await store.commit([{ store: 'tasks', op: 'put', value: t1 }]); // wrapped by cloud.js
await wait(1400);
let st = await serverState();
ok(st.tasks.length === 1 && st.tasks[0].id === 't1', 'task reached server through cloud.js');

console.log('2. soft delete (mirrors patched app.deleteTask): trash copy survives, stale live copies die');
memory.tasks.pop();
const t1Trash = { ...t1, trashedAt: Date.now(), updatedAt: Date.now() };
memory.trash.push(t1Trash);
await store.commit([
  { store: 'trash', op: 'put', value: t1Trash },
  { store: 'tasks', op: 'delete', key: 't1' },
]);
await wait(1400);
st = await serverState();
ok(st.trash.some((t) => t.id === 't1'), 'soft-deleted task lives in server trash');
ok(st.tombstones['tasks:t1'] > 0, 'tasks-scoped tombstone created (kills other devices\' stale live copies)');
ok(!st.tombstones['trash:t1'], 'trash side NOT tombstoned by a soft delete');
ok(!st.tasks.some((t) => t.id === 't1'), 'removed from server tasks');

console.log('3. undo (trash→tasks, updatedAt bumped) revives live copy');
memory.trash.pop();
t1Trash.updatedAt = Date.now() + 5;
memory.tasks.push({ ...t1Trash });
delete t1Trash.trashedAt;
await store.commit([
  { store: 'tasks', op: 'put', value: t1Trash },
  { store: 'trash', op: 'delete', key: 't1' },
]);
await wait(1400);
st = await serverState();
ok(st.tasks.some((t) => t.id === 't1') && st.trash.length === 0, 'undone task is back live on server');
ok(memory.tasks.some((t) => t.id === 't1'), 'local memory kept the restore (newer than the tombstone)');

console.log('4. hard path: delete → destroy removes it everywhere');
memory.tasks.pop();
const t1Trash2 = { ...t1Trash, trashedAt: Date.now(), updatedAt: Date.now() + 10 };
memory.trash.push(t1Trash2);
await store.commit([
  { store: 'trash', op: 'put', value: t1Trash2 },
  { store: 'tasks', op: 'delete', key: 't1' },
]);
await wait(1400);
memory.trash.pop();
await store.commit([{ store: 'trash', op: 'delete', key: 't1' }]); // destroyTask
await wait(1400);
st = await serverState();
ok(st.tasks.length === 0 && st.trash.length === 0, 'destroyed task gone from both stores');
ok(st.tombstones['trash:t1'] > 0, 'trash-scoped tombstone recorded on server');

console.log('5. tombstone beats an old device re-push');
memory.tasks.push(rec('t1', 'zombie', T0 + 500)); // older than the tombstones
await store.commit([{ store: 'tasks', op: 'put', value: memory.tasks[0] }]);
await wait(1400);
st = await serverState();
ok(!st.tasks.some((t) => t.id === 't1'), 'stale resurrection rejected');
ok(memory.tasks.length === 0, 'cloud.js adopted server verdict back into local memory (tombstone filter)');

console.log('6. plain edits keep flowing after all that');
const t2 = rec('t2', 'groceries', Date.now() + 60000);
memory.tasks.push(t2);
await store.commit([{ store: 'tasks', op: 'put', value: t2 }]);
await wait(1400);
st = await serverState();
ok(st.tasks.length === 1 && st.tasks[0].title === 'groceries', 'new task syncs after tombstone drama');

console.log('7. projects: sync semantics end to end (create / LWW / soft delete / purge)');
const proj = (name, upd, extra) => ({
  id: 'pA', name, description: '', icon: '🚀', color: '#ff0044', status: 'active',
  archived: false, dueDate: '2030-12-31', createdAt: T0, updatedAt: upd, sortOrder: T0,
  deletedAt: null, ...extra,
});
memory.projects.push(proj('Launch', Date.now()));
const t3 = rec('t3', 'site banner', Date.now() + 500, { projectId: 'pA' });
memory.tasks.push(t3);
await store.commit([
  { store: 'projects', op: 'put', value: memory.projects[0] },
  { store: 'tasks', op: 'put', value: t3 },
]);
await wait(1400);
st = await serverState();
ok(st.projects.length === 1 && st.projects[0].name === 'Launch', 'project synced to server (in the SAME state doc — no second store)');
ok(st.tasks.find((x) => x.id === 't3').projectId === 'pA', 'task keeps its projectId through cloud.js');

// other device pushes an OLDER rename → LWW keeps ours
const otherPush = (state, tombstones) => fetch(BASE + '/api/sync', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify({ clientId: 'other', baseRev: st.rev, mode: 'merge', state, tombstones }),
}).then((r) => r.json());
await otherPush({ tasks: [], trash: [], projects: [proj('Stale name', T0 + 100)] }, {});
st = await serverState();
ok(st.projects[0].name === 'Launch', 'older remote rename loses to newer local project edit (LWW)');

// soft delete of a project = put with deletedAt — NO tombstone (undo stays possible)
memory.projects[0] = proj('Launch', Date.now(), { deletedAt: Date.now() });
await store.commit([{ store: 'projects', op: 'put', value: memory.projects[0] }]);
await wait(1400);
st = await serverState();
ok(st.projects.length === 1 && st.projects[0].deletedAt > 0, 'trashed project stays in the projects list with deletedAt (like trash records)');
ok(!st.tombstones['projects:pA'], 'soft delete does NOT tombstone the project');
ok(st.tasks.find((x) => x.id === 't3'), 'deleting a project never touches its tasks');

// purge (empty-trash / delete-forever path): delete op + task detach in ONE commit
memory.projects = [];
// Re-query the row: every echo replaces st.tasks with the server's canonical
// objects (they now carry dueTime), so a reference captured before a sync is
// an orphan — mutate what the state ACTUALLY holds (CONVENTIONS.md rule).
const t3row = memory.tasks.find((x) => x.id === 't3');
t3row.projectId = null;
t3row.updatedAt = Date.now() + 700;
await store.commit([
  { store: 'projects', op: 'delete', key: 'pA' },
  { store: 'tasks', op: 'put', value: t3row },
]);
await wait(1400);
st = await serverState();
ok(st.projects.length === 0, 'purged project gone from server');
ok(st.tombstones['projects:pA'] > 0, 'purge writes a projects-scoped tombstone');
ok(st.tasks.find((x) => x.id === 't3').projectId === null, 'detach of the orphaned task synced with the same commit');

// stale device re-push of the purged project (old updatedAt) must be rejected
await otherPush({ tasks: [], trash: [], projects: [proj('Zombie', T0 + 100)] }, {});
st = await serverState();
ok(st.projects.length === 0, 'tombstone beats a stale project re-push');
// ...while a FRESH one (newer than tombstone — a real recreate with same id) survives
await otherPush({ tasks: [], trash: [], projects: [proj('Recreated', Date.now() + 900000)] }, {});
st = await serverState();
ok(st.projects.length === 1 && st.projects[0].name === 'Recreated', 'edit-beats-delete works for projects too');
// keep task count consistent for any later runs
await otherPush({ tasks: st.tasks, trash: [], projects: [] }, st.tombstones);

console.log('8. subtasks: sync, parent soft-delete keeps them, purge cascades');
const tP = rec('tP', 'Build Expense Tracker', Date.now());
memory.tasks.push(tP);
const sA = { id: 'sA', parentTaskId: 'tP', title: 'Design database', completed: false, completedAt: null, position: 0, createdAt: Date.now(), updatedAt: Date.now() };
memory.subtasks.push(sA);
await store.commit([
  { store: 'tasks', op: 'put', value: tP },
  { store: 'subtasks', op: 'put', value: sA },
]);
await wait(1400);
st = await serverState();
ok(st.subtasks.length === 1 && st.subtasks[0].parentTaskId === 'tP', 'subtask syncs as a flat record of the same state doc');
// re-read from live memory before mutating (adoptRemote may have replaced the
// array after the previous push — exactly like app.js always does via find())
const curS = memory.subtasks.find((x) => x.id === 'sA');
curS.completed = true; curS.completedAt = Date.now(); curS.updatedAt = Date.now();
await store.commit([{ store: 'subtasks', op: 'put', value: curS }]);
await wait(1400);
st = await serverState();
ok(st.subtasks[0].completed === true, 'subtask completion syncs');
// soft-delete the PARENT: subtask must stay untouched (restore re-attaches it)
const liveP = memory.tasks.find((x) => x.id === 'tP');
memory.tasks = memory.tasks.filter((x) => x.id !== 'tP');
const tPTrash = { ...liveP, trashedAt: Date.now(), updatedAt: Date.now() + 5 };
memory.trash.push(tPTrash);
await store.commit([
  { store: 'trash', op: 'put', value: tPTrash },
  { store: 'tasks', op: 'delete', key: 'tP' },
]);
await wait(1400);
st = await serverState();
ok(st.trash.some((x) => x.id === 'tP') && st.subtasks.length === 1, 'trashing the parent leaves its subtasks intact on the server');
// purge forever: cascade delete ops for the subtree in the SAME commit
memory.trash = memory.trash.filter((x) => x.id !== 'tP');
memory.subtasks = [];
await store.commit([
  { store: 'trash', op: 'delete', key: 'tP' },
  { store: 'subtasks', op: 'delete', key: 'sA' },
]);
await wait(1400);
st = await serverState();
ok(st.subtasks.length === 0 && st.tombstones['subtasks:sA'] > 0, 'purge cascades: subtask deleted + tombstoned with its parent');
// stale re-push of the old subtask is rejected…
await otherPush({ tasks: [], trash: [], subtasks: [{ ...sA, updatedAt: T0 + 100 }] }, {});
st = await serverState();
ok(st.subtasks.length === 0, 'tombstone beats a stale subtask re-push');
// …an undo (same id, newer updatedAt) revives it
memory.subtasks.push({ ...sA, updatedAt: Date.now() + 500000 });
await store.commit([{ store: 'subtasks', op: 'put', value: memory.subtasks[0] }]);
await wait(1400);
st = await serverState();
ok(st.subtasks.length === 1, 'subtask undo (newer record) beats its own tombstone');
memory.subtasks = [];
await store.commit([{ store: 'subtasks', op: 'delete', key: 'sA' }]);
await wait(1400);

console.log('10. reminders (v5): the schedule IS a record — synced, tombstoned, adopted');
{
  const tR = rec('tR', 'renew visa', Date.now() + 900, { dueDate: '2026-12-01' });
  memory.tasks.push(tR);
  const rem1 = { id: 'rem1', taskId: 'tR', triggerAt: Date.now() + 3600e3, reminderType: 'h1',
    enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() + 400 };
  memory.reminders = (memory.reminders || []).concat([rem1]);
  await store.commit([{ store: 'tasks', op: 'put', value: tR }, { store: 'reminders', op: 'put', value: rem1 }]);
  await wait(1400);
  let stR = await serverState();
  ok(stR.reminders.length === 1 && stR.reminders[0].reminderType === 'h1' && stR.reminders[0].taskId === 'tR',
    'reminder pushed in the SAME commit as its task (one state doc — no second store, no timer dependency)');
  ok(memory.reminders.length === 1 && memory.reminders[0].id === 'rem1', 'echo adoption keeps exactly ONE reminder record (no duplication)');
  const cur = memory.reminders.find((x) => x.id === 'rem1');
  cur.delivered = true; cur.status = 'triggered'; cur.updatedAt = Date.now() + 800;
  await store.commit([{ store: 'reminders', op: 'put', value: cur }]);
  await wait(1400);
  stR = await serverState();
  ok(stR.reminders[0].status === 'triggered' && stR.reminders[0].delivered === true, 'fired-state rides the wire (a re-booted device never re-notifies)');
  memory.reminders = memory.reminders.filter((x) => x.id !== 'rem1'); // like app.js: mutate state, then commit
  await store.commit([{ store: 'reminders', op: 'delete', key: 'rem1' }]);
  await wait(1400);
  stR = await serverState();
  ok(stR.reminders.length === 0 && stR.tombstones['reminders:rem1'] > 0, 'reminder deletion = store-scoped tombstone on the server (all devices drop it)');
}

console.log('11. habits: a separate store on the client, the same state doc on the wire');
{
  const hh = { id: 'hc1', name: 'Read', frequency: 'weekly', target: 3, weekdays: [], archived: false, remindTime: '08:00', history: [{ d: '2026-09-14', c: 2 }], createdAt: Date.now() - 5000, updatedAt: Date.now() };
  memory.habits = (memory.habits || []).concat([hh]);
  await store.commit([{ store: 'habits', op: 'put', value: hh }]);
  await wait(1400);
  st = await serverState();
  ok(st.habits.length === 1 && st.habits[0].frequency === 'weekly' && st.habits[0].history.length === 1,
    'habit pushed through the ordinary commit→sync path lands on the server with its history intact');
  const hr = { id: 'hr:hc1', habitId: 'hc1', taskId: '', reminderType: 'custom', triggerAt: Date.now() + 3600e3, enabled: true, delivered: false, dismissed: false, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
  memory.reminders = (memory.reminders || []).concat([hr]);
  await store.commit([{ store: 'reminders', op: 'put', value: hr }]);
  await wait(1400);
  st = await serverState();
  ok(st.reminders.some((x) => x.id === 'hr:hc1' && x.habitId === 'hc1'),
    'the habit nudge syncs as a REMINDER record — one pipeline, one dedup ledger, no new plumbing');
  ok((memory.habits || []).length === 1, 'echo adoption keeps exactly ONE habit record (no duplication)');
  await store.commit([{ store: 'habits', op: 'delete', key: 'hc1' }, { store: 'reminders', op: 'delete', key: 'hr:hc1' }]);
  memory.habits = []; memory.reminders = memory.reminders.filter((x) => x.id !== 'hr:hc1');
  await wait(1400);
}

child.kill('SIGKILL');
console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll client integration tests passed.');
process.exit(failed ? 1 : 0);
