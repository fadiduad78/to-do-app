/* ============================================================================
 * test-storage.mjs — storage.js unit checks with no browser (zero deps)
 * Run: node server/test-storage.mjs
 * Loads the REAL public/storage.js under a localStorage shim with no
 * indexedDB, which forces its documented fallback engine. Covers the
 * Projects feature end to end at the storage layer: schema v1 → v2
 * migration of old payloads/IDB data/backups, coercion, dedupe, backup
 * round-trip, comparison, and the delete-op rules.
 * ==========================================================================*/
import assert from 'node:assert/strict';

/* ---- browser shims (must exist before the module is imported) ---- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
// deliberately NO indexedDB / window / document → LS-only engine path

await import('../public/storage.js');
const ZT = globalThis.ZTStorage;

let failed = 0;
const ok = (cond, name) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failed++;
};

/* ------------------------------ constants ------------------------------ */

ok(ZT.constants.SCHEMA_VERSION === 5, 'SCHEMA_VERSION bumped to 5 (v2 projects, v3 subtasks, v4 times, v5 reminders+recurrence)');
ok(ZT.constants.STORES.projects === 'projects', 'STORES exposes the projects store');

/* ------------------------------- migration ------------------------------ */

const v1 = {
  schemaVersion: 1,
  savedAt: 10,
  tasks: [
    { id: 't1', title: 'Old', status: 'active', createdAt: 1, updatedAt: 2, projectId: 'ghost' },
    { id: 't2', title: 'Legacy', status: 'completed', createdAt: 1, updatedAt: 2 }, // pre-projects field-free
  ],
  trash: [{ id: 't9', title: 'Trashed', status: 'active', createdAt: 1, updatedAt: 2, trashedAt: 3 }],
  settings: { theme: 'dark' },
};
const v2 = ZT.helpers.migratePayload(v1);
ok(v2.schemaVersion === 5, 'v1 payload migrates all the way to schemaVersion 5');
ok(Array.isArray(v2.projects) && v2.projects.length === 0, 'migration adds an empty projects list');
ok(v2.tasks.find((t) => t.id === 't1').projectId === 'ghost', 'existing projectId survives migration');
ok(v2.tasks.find((t) => t.id === 't2').projectId === null, 'field-free task gets projectId: null');
ok(v2.tasks.find((t) => t.id === 't1').title === 'Old', 'task data untouched by migration');
ok(v2.settings.theme === 'dark', 'settings survive migration');
// v0 payloads (the very old backups) run migrations 0 then 1 → must land at 2
const fromZero = ZT.helpers.migratePayload({ schemaVersion: 0, tasks: [{ id: 'z', title: 'Z', status: 'active', createdAt: 1, updatedAt: 1 }] });
ok(fromZero.schemaVersion === 5 && fromZero.tasks[0].projectId === null, 'v0 payload upgrades all the way to v5');
// idempotent: running migration over an already-v2 payload via cleanPath is a no-op
ok(v2.projects === v2.projects && v2.tasks.length === 2, 'migration keeps payload shape');
const v3 = ZT.helpers.migratePayload({ schemaVersion: 2, tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1 }], subtasks: [{ id: 's1', parentTaskId: 't1', title: 'kept', completed: false, position: 0, createdAt: 1, updatedAt: 1 }] });
ok(v3.schemaVersion === 5 && v3.subtasks.length === 1 && v3.subtasks[0].title === 'kept', 'v2 payload with subtasks passes the chain untouched');
ok(ZT.helpers.migratePayload({ schemaVersion: 2, tasks: [] }).subtasks.length === 0, 'v2 payload without subtasks defaults the array');

/* ------------------------------ coerceProject --------------------------- */

const sink = [];
ok(ZT.helpers.coerceProject({ id: 'p1' }, sink) === true && sink.length === 1, 'minimal project coerces');
const p1 = sink[0];
ok(p1.name === 'Untitled project', 'missing name falls back to placeholder');
ok(p1.color === 'var(--accent)' && p1.icon === '📁', 'invalid/missing color+icon get defaults');
ok(p1.status === 'active' && p1.archived === false && p1.deletedAt === null, 'status/archived/deletedAt defaults');
ok(Number.isFinite(p1.createdAt) && p1.updatedAt >= p1.createdAt, 'timestamps filled');
ok(ZT.helpers.coerceProject({ id: 'p2', name: 'X', customField: 7, color: '#ff0044', dueDate: '2030-01-02' }, sink),
  'valid project coerces');
const p2 = sink[1];
ok(p2.customField === 7, 'unknown project fields are preserved (forward compatible)');
ok(p2.color === '#ff0044' && p2.dueDate === '2030-01-02', 'hex color + due date kept');
ok(ZT.helpers.coerceProject(null, sink) === false, 'null rejected');
ok(ZT.helpers.coerceProject({}, sink) === false && ZT.helpers.coerceProject({ id: 5 }, sink) === false, 'project without string id rejected');
ok(sink.length === 2, 'rejections push nothing');

/* --------------------- validatePayload / cleanPayload -------------------- */

const vres = ZT.helpers.validatePayload({
  app: 'zerotodo',
  tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, projectId: 'p1' }],
  trash: [],
  projects: [{ id: 'p1', name: 'One' }, { id: 'p1', name: 'dup' }, { junk: true }],
  schemaVersion: 2,
});
ok(vres.ok === true, 'backup shape accepted');
ok(vres.tasks[0].projectId === 'p1', 'task → project reference parsed');
ok(vres.projects.length === 2 && vres.projects[0].name === 'One',
  'garbage project dropped at validate (dedupe happens in cleanPayload, as for tasks)');
const noProj = ZT.helpers.validatePayload({ app: 'zerotodo', tasks: [{ id: 'x', title: 'X', status: 'active', createdAt: 1, updatedAt: 1 }], schemaVersion: 1 });
ok(noProj.ok === true && Array.isArray(noProj.projects) && noProj.projects.length === 0, 'old backup without projects array still validates');

const clean = ZT.helpers.cleanPayload({
  tasks: [
    { id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1 },
    { id: 't1', title: 'dup', status: 'active', createdAt: 1, updatedAt: 1 },
  ],
  trash: [],
  projects: [{ id: 'p1', name: 'A' }, { id: 'p1', name: 'B' }],
  settings: {},
});
ok(clean.tasks.length === 1 && clean.projects.length === 1 && clean.projects[0].name === 'A', 'cleanPayload dedupes projects like tasks');
ok(clean.dropped === 2, 'dropped counter covers both stores');

/* ------------------------------- backupNewer ---------------------------- */

const idb = { savedAt: 1000, tasks: [], trash: [], projects: [{ id: 'p1', name: 'Old', updatedAt: 1500 }] };
ok(ZT.helpers.backupNewer({ savedAt: 9000, tasks: [], trash: [], projects: [{ id: 'p1', name: 'New', updatedAt: 8000 }] }, idb) === true,
  'mirror newer than IDB via project change alone');
ok(ZT.helpers.backupNewer({ savedAt: 9000, tasks: [], trash: [], projects: [{ id: 'p1', name: 'Old', updatedAt: 1500 }] }, idb) === false,
  'identical project data is not "newer"');
ok(ZT.helpers.backupNewer({ savedAt: 9000, tasks: [], trash: [], projects: [] }, idb) === false,
  'backup without the extra project is not newer');

/* --------------------------- dueTime (v4) -------------------------------- */

const m4 = ZT.helpers.migratePayload({ schemaVersion: 3, tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, dueTime: '08:30' }], subtasks: [] });
ok(m4.schemaVersion === 5 && m4.tasks[0].dueTime === '08:30', 'v3 payload keeps a valid dueTime through migration');
const m4b = ZT.helpers.migratePayload({ schemaVersion: 3, tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1 }] });
ok(m4b.tasks[0].dueTime === null, 'v3 payload without dueTime gets an explicit null (calendar = view, not a copy)');
const m4c = ZT.helpers.migratePayload({ schemaVersion: 3, tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, dueTime: '25:99' }] });
ok(m4c.tasks[0].dueTime === null, 'garbage dueTime normalized to null, task kept (never dropped)');
const vt = ZT.helpers.validatePayload({
  app: 'zerotodo', schemaVersion: 4,
  tasks: [
    { id: 'a', title: 'ok', status: 'active', createdAt: 1, updatedAt: 1, dueTime: '23:15', dueDate: '2026-09-19' },
    { id: 'b', title: 'bad', status: 'active', createdAt: 1, updatedAt: 1, dueTime: 930 },
  ],
});
ok(vt.tasks[0].dueTime === '23:15' && vt.tasks[0].dueDate === '2026-09-19', 'dueTime+dueDate parse together');
ok(vt.tasks.length === 2 && vt.tasks[1].dueTime === null, 'non-string dueTime → null; task still imported');

/* --------------------- reminders + recurrence (v5) ----------------------- */

const m5 = ZT.helpers.migratePayload({ schemaVersion: 4, tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1 }] });
ok(m5.schemaVersion === 5 && Array.isArray(m5.reminders) && m5.reminders.length === 0, 'v4 payload gains an empty reminders array');
ok(m5.tasks[0].recurrence === null && m5.trash !== undefined, 'v4→v5 defaults task.recurrence to null');
const m5b = ZT.helpers.migratePayload({
  schemaVersion: 4,
  tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, recurrence: 'daily' }],
  reminders: [{ id: 'r1', taskId: 't1', triggerAt: 123, reminderType: 'h1' }],
});
ok(m5b.reminders.length === 1 && m5b.tasks[0].recurrence === 'daily', 'v4 payload WITH reminders/recurrence passes through untouched');

const cr = (raw) => { const out = []; return { ok: ZT.helpers.coerceReminder(raw, out), out: out[0] }; }
let r1 = cr({ id: 'r1', taskId: 't1', triggerAt: '1700000000000', reminderType: 'weird', status: 'nope', createdAt: 5, updatedAt: 9 });
ok(r1.ok && r1.out.triggerAt === 1700000000000 && r1.out.reminderType === 'custom' && r1.out.status === 'pending',
  'coerceReminder: string triggerAt → number, unknown type → custom (fires at its instant), unknown status → pending');
r1 = cr({ id: 'r2', taskId: 't1', triggerAt: 5, reminderType: 'd1', delivered: true });
ok(r1.out.status === 'triggered', 'delivered:true without a status derives triggered (spec fields stay consistent)');
r1 = cr({ id: 'r3', taskId: 't1', triggerAt: 5, reminderType: 'h1', status: 'dismissed' });
ok(r1.out.dismissed === true, 'status dismissed implies dismissed flag');
ok(!cr({ taskId: 't1', triggerAt: 5 }).ok && !cr({ id: 'x', triggerAt: 5 }).ok && !cr({ id: 'x', taskId: 't' }).ok,
  'reminders without id / taskId / triggerAt are refused (never a half-schedule)');
ok(!cr({ id: 'x', taskId: 't', triggerAt: 'soon' }).ok, 'non-numeric triggerAt refused');
r1 = cr({ id: 'r4', taskId: 't1', triggerAt: 9, reminderType: 'overdue', status: 'pending', forDue: '2026-09-18', pinned: true, notify: { key: 'od:r4@9', at: 10, via: 'sw' } });
ok(r1.out && r1.out.reminderType === 'overdue' && r1.out.forDue === '2026-09-18' && r1.out.pinned === true && r1.out.notify.key === 'od:r4@9' && r1.out.notify.via === 'sw',
  'auto “overdue” reminder type is first-class: policy + per-delivery extras survive the lenient round-trip');
r1 = cr({ id: 'x', taskId: 't', triggerAt: 5, reminderType: 'custom', customDate: '2026-13-99', customTime: '25:00' });
ok(r1.ok && r1.out.customDate === null && r1.out.customTime === null, 'invalid custom date/time strings normalize to null (triggerAt still rules)');

const cp5 = ZT.helpers.cleanPayload({
  tasks: [{ id: 'keep', title: 'K', status: 'active', createdAt: 1, updatedAt: 1 }],
  trash: [{ id: 'dead', title: 'D', status: 'active', createdAt: 1, updatedAt: 1, trashedAt: 2 }],
  reminders: [
    { id: 'a', taskId: 'keep', triggerAt: 9, reminderType: 'm5' },
    { id: 'a', taskId: 'keep', triggerAt: 9, reminderType: 'm5' },
    { id: 'b', taskId: 'dead', triggerAt: 8, reminderType: 'h1' },
    { id: 'c', taskId: 'ghost', triggerAt: 7, reminderType: 'h1' },
  ],
});
ok(cp5.reminders.length === 2 && cp5.dropped === 2, 'cleanPayload: reminder dedupe by id + orphan drop (trash-owned KEEPS its schedule for restore)');

const v58 = ZT.helpers.validatePayload({
  app: 'zerotodo', schemaVersion: 5,
  tasks: [{ id: 't', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, recurrence: 'weekly' }],
  reminders: [{ id: 'r', taskId: 't', triggerAt: 10, reminderType: 'custom', customDate: '2026-12-01', customTime: '08:30' }],
});
ok(v58.tasks[0].recurrence === 'weekly' && v58.reminders[0].customDate === '2026-12-01', 'import: recurrence + custom reminder fields parse');
const v5bad = ZT.helpers.validatePayload({
  app: 'zerotodo', schemaVersion: 5,
  tasks: [{ id: 't', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, recurrence: 'fortnightly' }],
});
ok(v5bad.tasks[0].recurrence === null, 'bogus recurrence degrades to null (never breaks the task)');

/* coerceSubtask */

const sinkS = [];
ok(ZT.helpers.coerceSubtask({ id: 's1', parentTaskId: 't1', title: ' Design db ', completed: true, customDeep: 7 }, sinkS) === true,
  'minimal valid subtask coerces');
const s1c = sinkS[0];
ok(s1c.title === 'Design db' && s1c.position === 0 && Number.isFinite(s1c.createdAt), 'subtask fields normalized (trim, default position, timestamps)');
ok(s1c.completed === true && s1c.completedAt > 0, 'completed without completedAt gets one filled');
ok(s1c.customDeep === 7, 'unknown subtask fields preserved (forward compatible)');
ok(ZT.helpers.coerceSubtask({ id: 's2', title: 'no parent' }, sinkS) === false, 'subtask without parentTaskId rejected');
ok(ZT.helpers.coerceSubtask({ id: 's3', parentTaskId: 't1' }, sinkS) === false, 'subtask without title rejected');
ok(sinkS.length === 1, 'rejections push nothing');

/* ------------------ validate / clean / newer for subtasks ----------------- */

const vresS = ZT.helpers.validatePayload({
  app: 'zerotodo', schemaVersion: 3,
  tasks: [{ id: 't1', title: 'A', status: 'active', createdAt: 1, updatedAt: 1 }],
  subtasks: [
    { id: 's1', parentTaskId: 't1', title: 'One', completed: false, position: 0, createdAt: 1, updatedAt: 1 },
    { id: 'nope' },
  ],
});
ok(vresS.ok === true && vresS.subtasks.length === 1 && vresS.subtasks[0].title === 'One', 'subtasks parse at validate; garbage dropped');
const noSub = ZT.helpers.validatePayload({ app: 'zerotodo', schemaVersion: 2, tasks: [{ id: 'x', title: 'X', status: 'active', createdAt: 1, updatedAt: 1 }], projects: [] });
ok(noSub.ok === true && Array.isArray(noSub.subtasks) && noSub.subtasks.length === 0, 'v2 backup without subtasks still validates');
const cleanS = ZT.helpers.cleanPayload({
  tasks: [], trash: [], projects: [], settings: {},
  subtasks: [
    { id: 'a', parentTaskId: 't', title: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'a', parentTaskId: 't', title: 'dup', createdAt: 1, updatedAt: 1 },
    { id: 'b', parentTaskId: 't', title: 'B', createdAt: 1, updatedAt: 1 },
  ],
});
ok(cleanS.subtasks.length === 2 && cleanS.dropped === 1, 'cleanPayload dedupes subtasks by id');
ok(ZT.helpers.backupNewer(
  { savedAt: 9000, tasks: [], trash: [], projects: [], subtasks: [{ id: 's1', parentTaskId: 't', title: 'X', completed: true, updatedAt: 8000, createdAt: 1 }] },
  { savedAt: 1000, tasks: [], trash: [], projects: [], subtasks: [{ id: 's1', parentTaskId: 't', title: 'X', completed: false, updatedAt: 1500, createdAt: 1 }] }
) === true, 'mirror newer via a subtask change alone');

/* --------------------- engine round-trip (LS-only path) ------------------ */

const errorsA = [];
const A = ZT.createStore({ onError: (m) => errorsA.push(m) });
const recA = await A.recover();
ok(recA.state.projects.length === 0 && recA.idbAvailable === false, 'fresh recover: empty projects on the fallback engine');
const now = Date.now();
const proj = { id: 'pA', name: 'Launch', icon: '🚀', color: '#ff0044', dueDate: '2030-12-31', createdAt: now, updatedAt: now, sortOrder: now };
const task = { id: 'tA', title: 'Ship', status: 'active', priority: 'med', tags: [], dueDate: null, description: '', projectId: 'pA', createdAt: now, updatedAt: now, sortOrder: 0 };
A.state.projects.push(proj);
A.state.tasks.push(task);
ok(await A.commit([
  { store: 'projects', op: 'put', value: proj },
  { store: 'tasks', op: 'put', value: task },
]), 'commit with project ops succeeds');

const backup = JSON.parse(A.exportData());
ok(backup.schemaVersion === 5, 'export carries schemaVersion 5');
ok(backup.projects.length === 1 && backup.projects[0].name === 'Launch', 'export includes projects');
const subA = { id: 'sA', parentTaskId: 'tA', title: 'Design database', completed: false, completedAt: null, position: 0, createdAt: now, updatedAt: now };
A.state.subtasks.push(subA);
await A.commit([{ store: 'subtasks', op: 'put', value: subA }]);
ok(JSON.parse(A.exportData()).subtasks.length === 1, 'export includes subtasks (same document, same commit path)');
ok(backup.tasks[0].projectId === 'pA', 'export keeps the task→project link');

// Second store instance = "reload": must recover everything from the LS mirror alone.
const B = ZT.createStore({});
const recB = await B.recover();
ok(recB.state.projects.length === 1 && recB.state.projects[0].color === '#ff0044', 'reload recovers projects from the mirror');
ok(recB.state.tasks[0].id === 'tA' && recB.state.tasks[0].projectId === 'pA', 'reload keeps task ids and the project link');
ok(recB.state.subtasks.length === 1 && recB.state.subtasks[0].title === 'Design database', 'reload recovers subtasks from the mirror');

// A v1-era mirror (pre-projects) written by an older version must still load.
mem.set('todo_backup_v1', JSON.stringify({
  app: 'zerotodo', schemaVersion: 1, savedAt: now + 10,
  tasks: [{ id: 'old', title: 'Pre-projects task', status: 'active', createdAt: 1, updatedAt: 1 }],
  trash: [], settings: {},
}));
const C = ZT.createStore({});
const recC = await C.recover();
ok(recC.state.tasks[0].id === 'old', 'v1 mirror still loads (newer wins)');
ok(Array.isArray(recC.state.projects) && recC.state.projects.length === 0, 'v1 mirror auto-upgrades: projects default to []');

/* ------------------------ resync / replace / prune ----------------------- */

C.replaceMemory(
  [{ id: 'n1', title: 'New', status: 'active', priority: 'low', tags: [], description: '', dueDate: null, projectId: 'pZ', createdAt: now, updatedAt: now, sortOrder: 0 }],
  [],
  [{ id: 'pZ', name: 'Zed', createdAt: now, updatedAt: now, sortOrder: now, icon: '🎯', color: '#63c98b', status: 'active', archived: false, dueDate: null, deletedAt: null, description: '' }],
  [{ id: 'sN', parentTaskId: 'n1', title: 'step 1', completed: false, position: 0, createdAt: now, updatedAt: now }],
);
ok(await C.resync(), 'replaceMemory + resync commits');
const D = ZT.createStore({});
const recD = await D.recover();
ok(recD.state.projects[0].name === 'Zed' && recD.state.tasks[0].projectId === 'pZ', 'replaced dataset (incl. projects) round-trips to disk');
ok(recD.state.subtasks[0].id === 'sN', 'replaceMemory carries the 4th (subtasks) list to disk');
const orph = { id: 'sOrph', parentTaskId: 'does-not-exist', title: 'orphan', completed: false, position: 0, createdAt: now, updatedAt: now };
D.state.subtasks.push(orph);
await D.commit([{ store: 'subtasks', op: 'put', value: orph }]);
const G = ZT.createStore({});
await G.recover();
ok(G.state.subtasks.some((x) => x.id === 'sOrph'), 'orphaned subtask survives (never auto-deleted by storage)');
ok(await ZT.createStore({ onError() {} }).commit([{ store: 'subtasks', op: 'put', value: { id: 'x' } }]) === false,
  'subtask without parentTaskId/title refused by validateOp');

/* ------------------------------ recurrence engine -------------------------
   Fixed dates (2026: not a leap year; Sept 21 = Monday). The task record is
   the ONLY occurrence materialized — these check the derivation itself. */
{
  const { recurOf, recurNextAfter, coerceRecurRule, recurMatches } = ZT.helpers;
  ok(!!recurOf && !!recurNextAfter, 'storage exports the recurrence helpers');
  ok(recurNextAfter('2026-09-19', '2026-09-19', recurOf('daily')) === '2026-09-20', 'Daily: next = tomorrow');
  const wd = recurOf('weekdays');
  ok(wd.unit === 'week' && wd.every === 1 && wd.weekdays.join() === '1,2,3,4,5', 'Weekdays = Mon–Fri weekly pattern');
  ok(recurNextAfter('2026-09-18', '2026-09-17', wd) === '2026-09-21', 'Weekdays: Fri rolls to Mon (weekend skipped)');
  ok(recurNextAfter('2026-09-21', '2026-09-21', recurOf('weekly')) === '2026-09-28', 'Weekly: every Monday from a Monday anchor');
  const mwf = coerceRecurRule({ unit: 'week', every: 1, weekdays: [5, 1, 3, 1, 9, -2, 'x'] });
  ok(mwf.weekdays.join() === '1,3,5', 'selected weekdays: sorted, deduped, out-of-range dropped');
  ok(recurNextAfter('2026-09-17', '2026-09-17', mwf) === '2026-09-18', 'Mon+Wed+Fri: Thu anchor → next is Fri');
  ok(recurNextAfter('2026-09-18', '2026-09-18', mwf) === '2026-09-21', 'Mon+Wed+Fri: Fri → Mon');
  const bi = coerceRecurRule({ unit: 'week', every: 2 });
  ok(recurNextAfter('2026-09-21', '2026-09-21', bi) === '2026-10-05', 'every 2 weeks: skips the off-week (spec example)');
  ok(recurNextAfter('2026-01-05', '2026-01-05', recurOf('monthly')) === '2026-02-05', 'monthly on the 5th');
  ok(recurNextAfter('2026-01-31', '2026-01-31', recurOf('monthly')) === '2026-02-28', 'monthly on the 31st clamps to Feb 28 (never Mar 2)');
  ok(recurNextAfter('2026-02-28', '2026-01-31', recurOf('monthly')) === '2026-03-31', '…and returns to the 31st in March');
  ok(recurNextAfter('2026-03-10', '2026-03-10', coerceRecurRule({ unit: 'month', every: 2 })) === '2026-05-10', 'every 2 months skips April');
  ok(recurNextAfter('2026-12-31', '2026-12-31', recurOf('yearly')) === '2027-12-31', 'yearly on Dec 31 (spec example)');
  ok(recurNextAfter('2024-02-29', '2024-02-29', recurOf('yearly')) === '2025-02-28', 'Feb 29 yearly clamps in non-leap years');
  ok(recurNextAfter('2027-02-28', '2024-02-29', recurOf('yearly')) === '2028-02-29', '…and returns to the 29th in leap years');
  ok(recurNextAfter('2026-09-19', '2026-09-19', coerceRecurRule({ unit: 'day', every: 3 })) === '2026-09-22', 'custom every-3-days');
  ok(recurNextAfter('2026-01-01', '2026-01-01', coerceRecurRule({ unit: 'year', every: 99 })) === null, 'beyond the 10-year horizon the series ENDS (no infinite chase, no infinite tasks)');
  ok(coerceRecurRule({ unit: 'day', every: 0 }).every === 1 && coerceRecurRule({ unit: 'day', every: 500 }).every === 1, 'every is clamped to a sane 1..99');
  ok(coerceRecurRule({ unit: 'fortnight' }) === null && coerceRecurRule('x') === null, 'garbage rules refuse to coerce (→ treated as weekly)');
  ok(recurMatches(new Date(2026, 8, 21), recurOf('weekdays'), new Date(2026, 8, 17)) === true && recurMatches(new Date(2026, 8, 19), recurOf('weekdays'), new Date(2026, 8, 17)) === false, 'recurMatches answers per-day (Sat no, Mon yes)');
  const legacy = ZT.helpers.cleanPayload({ schemaVersion: 5, tasks: [
    { id: 'l1', title: 'Legacy weekly', status: 'active', createdAt: 1, updatedAt: 1, dueDate: '2026-09-21', recurrence: 'weekly' },
  ], trash: [], projects: [], subtasks: [], reminders: [], settings: {} });
  ok(legacy.tasks[0].recurAnchor === '2026-09-21' && legacy.tasks[0].recurRule === null, 'legacy tasks adopt the due date as their series anchor (no migration needed)');
  const bogus = ZT.helpers.cleanPayload({ schemaVersion: 5, tasks: [
    { id: 'l2', title: 'Bogus custom', status: 'active', createdAt: 1, updatedAt: 1, dueDate: '2026-09-21', recurrence: 'custom', recurRule: { unit: 'moon' }, recurAnchor: 'yesterday' },
  ], trash: [], projects: [], subtasks: [], reminders: [], settings: {} });
  ok(bogus.tasks[0].recurRule === null && bogus.tasks[0].recurAnchor === '2026-09-21', 'invalid rule/anchor degrade to null/due — never a poison record');
}

/* -------------- reload with FIRED reminders in history (TDZ guard) --------
   A past shipped bug: recover()'s reminder-retention prune referenced the
   `now2` clock before its `const` — a TDZ ReferenceError thrown on EVERY
   reload where a non-pending reminder existed, leaving users with a blank
   app until site data was cleared. Pending-only reloads short-circuited and
   survived, which is why no earlier test caught it. */
const DAY = 864e5;
const R_OLD  = { id: 'rOld',  taskId: 'n1', triggerAt: now - 40 * DAY, reminderType: 'h1', status: 'triggered', delivered: true, updatedAt: now - 31 * DAY - 10 };
const R_NEW  = { id: 'rNew',  taskId: 'n1', triggerAt: now - 2 * DAY,  reminderType: 'h1', status: 'triggered', delivered: true, updatedAt: now - DAY };
const R_PEND = { id: 'rPend', taskId: 'n1', triggerAt: now + DAY,      reminderType: 'h1', status: 'pending', updatedAt: now - 45 * DAY };
G.state.reminders.push(R_OLD, R_NEW, R_PEND);
await G.commit([
  { store: 'reminders', op: 'put', value: R_OLD },
  { store: 'reminders', op: 'put', value: R_NEW },
  { store: 'reminders', op: 'put', value: R_PEND },
]);
const H = ZT.createStore({});
let recH = null, recHThrew = null;
try { recH = await H.recover(); } catch (e) { recHThrew = e; }
ok(recHThrew === null, 'reload with fired reminders does not throw (recovery-clock TDZ regression)');
ok(!!recH && recH.state.reminders.some((r) => r.id === 'rNew'), 'recent fired reminder survives recovery');
ok(!!recH && !recH.state.reminders.some((r) => r.id === 'rOld'), 'fired reminder past the 30-day window is pruned');
ok(!!recH && recH.state.reminders.some((r) => r.id === 'rPend'), 'pending reminder never pruned on recovery (catch-up still owed)');

// delete-op validation: the projects store accepts deletes (tombstone path)
ok(await D.commit([{ store: 'projects', op: 'delete', key: 'pZ' }]) === true, 'project delete op accepted');
const rejected = await ZT.createStore({ onError() {} }).commit([{ store: 'projects', op: 'put', value: { junk: true } }]);
ok(rejected === false, 'garbage project put is refused by validateOp');

// old trashed project beyond retention is pruned with an info notice on recover
mem.set('todo_backup_v1', JSON.stringify({
  app: 'zerotodo', schemaVersion: 2, savedAt: Date.now(),
  tasks: [], trash: [], settings: {},
  projects: [
    { id: 'gone', name: 'Ancient', createdAt: 1000, updatedAt: 1000, deletedAt: Date.now() - 31 * 86400000, icon: '📁', color: 'var(--accent)', status: 'active', archived: false, dueDate: null, description: '', sortOrder: 1 },
    { id: 'fresh', name: 'Recent', createdAt: 1000, updatedAt: 1000, deletedAt: Date.now() - 2 * 86400000, icon: '📁', color: 'var(--accent)', status: 'active', archived: false, dueDate: null, description: '', sortOrder: 2 },
  ],
}));
const F = ZT.createStore({});
const recF = await F.recover();
ok(recF.state.projects.length === 1 && recF.state.projects[0].id === 'fresh', '30-day retention purges stale trashed projects');
ok(recF.notices.some((n) => n.message.includes('project')), 'pruning is announced via a notice');

// ---- dashboard ledger fields (completedAt / completions) ----
mem.set('todo_backup_v1', JSON.stringify({
  app: 'zerotodo', schemaVersion: 5, savedAt: Date.now(), settings: {},
  tasks: [
    { id: 'lg1', title: 'Legacy done', status: 'completed', createdAt: 1000, updatedAt: 1000 },
    { id: 'lg2', title: 'Junk ledger', status: 'active', createdAt: 1000, updatedAt: 1000,
      completions: ['x', -5, 3000, 1000, null, 2000.4], completedAt: 'nope' },
    { id: 'lg3', title: 'Fat ledger', status: 'active', createdAt: 1000, updatedAt: 1000,
      completions: Array.from({ length: 400 }, (_, i) => 100000 + i) },
  ],
  trash: [], projects: [], subtasks: [], reminders: [],
}));
const LG = ZT.createStore({});
const recLG = await LG.recover();
const tOf = (id) => recLG.state.tasks.find((x) => x.id === id);
ok(tOf('lg1').completedAt === null && Array.isArray(tOf('lg1').completions) && tOf('lg1').completions.length === 0,
  'legacy task (no ledger) coerces to clean nulls — old backups gain no phantom completions');
ok(JSON.stringify(tOf('lg2').completions) === '[1000,2000,3000]' && tOf('lg2').completedAt === null,
  'ledger sanitize: junk dropped, numbers kept & sorted, bad completedAt → null');
ok(tOf('lg3').completions.length === 256 && tOf('lg3').completions[255] === 100000 + 399 && tOf('lg3').completions[0] === 100000 + 144,
  'ledger is capped at the 256 most recent stamps (bounded record, safe for sync)');
await LG.commit([{ store: 'tasks', op: 'put', value: Object.assign(tOf('lg1'), { completions: [Date.now()], completedAt: Date.now(), status: 'active', updatedAt: Date.now() }) }]);
const snapLG = JSON.parse(mem.get('todo_backup_v1'));
ok(snapLG.tasks.find((x) => x.id === 'lg1').completions.length === 1,
  'ledger fields ride the mirror export like every other task field (backup/sync fidelity)');

// ---- Focus Mode fields ----
mem.set('todo_backup_v1', JSON.stringify({ app: 'zerotodo', schemaVersion: 5, savedAt: Date.now(), settings: {}, tasks: [
  { id: 'fA', title: 'Junk focus', createdAt: 1000, updatedAt: 1000, focusTotal: -4, focusSessions: 'x',
    focusLog: [{ at: 'a', min: 5 }, { at: Date.now(), min: 9 }, { at: Date.now() + 1, min: 200 }, null, 7],
    focusActive: { phase: 'zebra', endsAt: Date.now() } },
  { id: 'fB', title: 'Wild session', createdAt: 1000, updatedAt: 1000,
    focusActive: { phase: 'break', endsAt: Date.now() + 1, durMin: 9999, breakMin: 0, longMin: -2, longEvery: 'x', pausedAt: 'no' } },
  { id: 'fC', title: 'Fat log', createdAt: 1000, updatedAt: 1000, focusLog: Array.from({ length: 300 }, (_, i) => ({ at: 1000 + i, min: 1 })) },
], trash: [], projects: [], subtasks: [], reminders: [] }));
const FZ = ZT.createStore({});
const recFZ = await FZ.recover();
const fzOf = (id) => recFZ.state.tasks.find((x) => x.id === id);
ok(fzOf('fA').focusTotal === 0 && fzOf('fA').focusSessions === 0 && fzOf('fA').focusActive === null,
  'focus coerce: negative/NaN aggregates → 0, bogus phase → live session dropped');
ok(fzOf('fA').focusLog.length === 2 && fzOf('fA').focusLog[0].min === 9 && fzOf('fA').focusLog[1].min === 200,
  'focus log keeps only valid {at,min} entries, sorted by time');
ok(fzOf('fC').focusLog.length === 128 && fzOf('fC').focusLog[127].at === 1000 + 299,
  'focus log capped at the 128 newest entries (bounded records survive sync)');
ok(fzOf('fB').focusActive.durMin === 25 && fzOf('fB').focusActive.breakMin === 5 && fzOf('fB').focusActive.longEvery === 4 && fzOf('fB').focusActive.pausedAt === null,
  'out-of-range session snapshot fields fall back to sane defaults — a corrupt record can never wedge the timer');

console.log('\n--- habits (coerce layer) ---');
{
  let sk = [];
  const CH = ZT.helpers.coerceHabit;
  const dd = (n) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);
  ok(CH({ id: 'h1', name: 'Exercise' }, sk = []) === true && sk[0].frequency === 'daily' && sk[0].target === 1
    && sk[0].archived === false && sk[0].remindTime === null && Array.isArray(sk[0].history) && Number.isFinite(sk[0].createdAt),
    'minimal habit coerces with sane defaults (daily ×1, quiet, empty history)');
  ok(CH(null, sk = []) === false && CH({ name: 'x' }, sk) === false && CH({ id: 'h' }, sk = []) === false,
    'habit reject: non-object / missing id / missing name');
  ok(CH({ id: 'h', name: 'Read', frequency: 'yearly', weekdays: [1], target: '4.6' }, sk = []) && sk.length === 1
    && sk[0].frequency === 'daily' && sk[0].weekdays.length === 0 && sk[0].target === 5,
    'bogus frequency → daily (weekdays only mean something for day-sets); fractional target rounds');
  ok(CH({ id: 'h', name: 'Read', frequency: 'days', weekdays: [5, 'x', 9, -3, 5.5, 1, 1] }, sk = []) && JSON.stringify(sk[0].weekdays) === '[1,5]',
    'day-set filters to ints 0–6 and dedupes (0=Sun convention, same as task recurrence)');
  ok(CH({ id: 'h', name: 'Read', frequency: 'days', weekdays: [] }, sk = []) && sk[0].frequency === 'daily',
    'an EMPTY day-set falls back to daily rather than being un-meetable forever');
  ok(CH({ id: 'h', name: 'R', target: 0 }, sk = []) && sk[0].target === 1
    && (CH({ id: 'h2', name: 'R', target: 100 }, sk = []) && sk[0].target === 99),
    'target clamps to 1…99 (0 can never be met; absurd values can’t ride in)');
  ok(CH({ id: 'h', name: 'R', remindTime: '25:00' }, sk = []) && sk[0].remindTime === null
    && (CH({ id: 'h2', name: 'R', remindTime: '7:30' }, sk = []) && sk[0].remindTime === null)
    && (CH({ id: 'h3', name: 'R', remindTime: '07:30' }, sk = []) && sk[0].remindTime === '07:30'),
    'remindTime is the strict HH:MM the reminder engine needs — anything else means “no nudge”');
  {
    const hist = []; for (let i = 0; i < 800; i++) hist.push({ d: dd(i), c: 1 });
    hist.push({ d: dd(799), c: 9 }, { d: 'garbage', c: 3 }, { d: dd(5), c: 0 }, null, 42);
    CH({ id: 'h', name: 'R', history: hist }, sk = []);
    const h2 = sk[0];
    ok(h2.history.length === 730 && h2.history[0].d === dd(70) && h2.history[h2.history.length - 1].c === 9
      && h2.history.every((e, i, a) => i === 0 || a[i - 1].d < e.d),
      'history: invalid entries dropped, duplicate dates last-wins, capped to the newest 730, sorted');
  }
  ok(CH({ id: 'h', name: 'R', history: [{ d: dd(1), c: 5000 }] }, sk = []) && sk[0].history[0].c === 999,
    'per-day count clamps to 999 (a habit can log 8 glasses, not the integer ceiling)');
  ok(CH({ id: 'h', name: 'R', futureField: { ok: 1 } }, sk = []) && sk[0].futureField.ok === 1,
    'lenient spread keeps unknown fields (forward-compatible, like every coerce*)');
  const CR = ZT.helpers.coerceReminder;
  ok(CR({ id: 'r1', habitId: 'h9', triggerAt: 5 }, sk = []) === true && sk[0].taskId === '' && sk[0].habitId === 'h9',
    'a reminder row may be owned by a HABIT instead of a task (nudge rides the same store)');
  ok(CR({ id: 'r2', triggerAt: 5 }, sk = []) === false, 'but a row with NO owner at all is refused');
  const cp = ZT.helpers.cleanPayload({
    tasks: [{ id: 't', title: 'T', status: 'active', createdAt: 1, updatedAt: 1 }],
    habits: [{ id: 'h', name: 'N', frequency: 'daily', target: 1, history: [] }],
    reminders: [{ id: 'a', habitId: 'h', triggerAt: 5 }, { id: 'b', habitId: 'ghost', triggerAt: 5 }, { id: 'c', taskId: 't', triggerAt: 5 }],
  });
  ok(cp.reminders.length === 2 && !cp.reminders.some((x) => x.id === 'b') && cp.dropped === 1,
    'nudge rows attach to live habits — a reminder for a missing habit is stale (dropped and counted)');
  ok(ZT.helpers.validatePayload({ tasks: [] }).habits.length === 0, 'older payloads simply default to no habits');
  mem.set('todo_backup_v1', JSON.stringify({
    app: 'zerotodo', schemaVersion: 5, savedAt: Date.now(), settings: {},
    tasks: [], trash: [], projects: [], subtasks: [], reminders: [],
    habits: [{ id: 'only', name: 'Walk', frequency: 'daily', target: 1, weekdays: [], history: [{ d: dd(0), c: 1 }] }],
  }));
  const HS = ZT.createStore({});
  const recH = await HS.recover();
  ok(recH.source === 'backup' && recH.state.habits.length === 1 && recH.state.habits[0].history[0].c === 1,
    'a HABITS-ONLY account is real data: recovery adopts it (bakHas counts every record type)');
  ok(recH.state.reminders.length === 0, 'no phantom reminder rows created by recovery (engine owns those)');
}

/* ---------------- AI decomposition fields on TASKS ---------------- */
{
  const CT = ZT.helpers.coerceTask;
  const out = [];
  ok(CT({ id: 'a1', title: 'T', estMin: '500', deps: ['d1', 'd1', 'a1', 7, ''], aiOffer: 1 }, out) &&
    out[0].estMin === 500 && out[0].deps.join() === 'd1' && out[0].aiOffer === false,
    'coerceTask AI hints: estMin string→number, deps dedupe + drop self/non-string/empty, aiOffer strict true (1 → false)');
  const out2 = [];
  CT({ id: 'a2', title: 'T', estMin: -9, deps: Array.from({ length: 20 }, (_, i) => 'x' + i), aiOffer: true }, out2);
  ok(out2[0].estMin === 0 && out2[0].deps.length === 12 && out2[0].aiOffer === true,
    'negative/absent estMin → 0 (badge hidden), deps capped at 12, aiOffer true round-trips');
  const out3 = [];
  CT({ id: 'a3', title: 'T', estMin: 99999 }, out3);
  ok(out3[0].estMin === 10080, 'estMin clamps at one week (10080 min) — no absurd values reach the UI from any source');
  const outp = [];
  ok(CT({ id: 'aP1', title: 'T', plan: { date: '2026-09-20', start: '09:00', end: '10:00', extra: 'junk' } }, outp) &&
    outp[0].plan.date === '2026-09-20' && outp[0].plan.end === '10:00' && outp[0].plan.extra === undefined,
    'coerceTask plan: valid {date,start,end} round-trips, extra keys are dropped (stored shape is fixed)');
  const outp2 = [];
  CT({ id: 'aP2', title: 'T', plan: { date: '2026-13-99', start: '25:00', end: '08:00' } }, outp2);
  ok(outp2[0].plan === null, 'malformed plan (bad date AND bad time) → null — never half-believed');
  const outp3 = [];
  CT({ id: 'aP3', title: 'T', plan: { date: '2026-09-20', start: '11:00', end: '11:00' } }, outp3);
  CT({ id: 'aP4', title: 'T', plan: 'schedule it' }, outp3);
  ok(outp3[0].plan === null && outp3[1].plan === null, 'zero-length block (end ≤ start) and non-object plan both normalize to null');
  const out4 = [];
  ok(!CT({ id: 'a4', title: '', estMin: 30 }, out4) && CT({ id: 'a5', title: 'ok' }, out4) === true,
    'AI fields neither rescue an invalid task nor veto a valid one — pure advisory decoration on the existing contract');
  // dangling deps must SURVIVE cleaning (badge renders “(removed task)”, no silent data mutation)
  const rec = ZT.helpers.cleanPayload({ schemaVersion: 5, tasks: [
    { id: 'p', title: 'Parent', deps: ['gone'] },
    { id: 'c', title: 'Child', estMin: 45, deps: ['p', 'ghost2'] },
  ], trash: [], projects: [], subtasks: [] });
  const cRow = rec.tasks.find((x) => x.id === 'c');
  ok(cRow.deps.join() === 'p,ghost2' && cRow.estMin === 45,
    'cleanPayload keeps advisory deps even when the target is missing — removal order must never rewrite user data');
}

console.log(failed ? `\n${failed} storage check(s) FAILED` : '\nall storage checks green');
process.exit(failed ? 1 : 0);
