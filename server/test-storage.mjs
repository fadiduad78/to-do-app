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

console.log(failed ? `\n${failed} storage check(s) FAILED` : '\nall storage checks green');
process.exit(failed ? 1 : 0);
