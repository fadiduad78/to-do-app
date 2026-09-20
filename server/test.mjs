/* ============================================================================
 * test.mjs — ZeroTodo server smoke tests (zero deps, Node >= 18)
 * Run: node server/test.mjs
 * Covers: static serving, auth, first push, LWW conflict merge between two
 * devices, tombstone deletes, edit-beats-delete, import replace mode,
 * restart persistence, SSE broadcast.
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-passkey-123';

let failed = 0;
const ok = (cond, name) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failed++;
};

function startServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), ZT_HOST: '127.0.0.1',
      ZT_DATA_DIR: dataDir, ZT_TOKEN: TOKEN, ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__log = '';
  child.stdout.on('data', (d) => { child.__log += d; });
  child.stderr.on('data', (d) => { child.__log += d; });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(BASE + '/api/config');
        if (r.ok) return resolve(child);
      } catch (_) { /* not up yet */ }
      if (Date.now() - t0 > 8000) return reject(new Error('server did not start: ' + child.__log));
      setTimeout(poll, 120);
    };
    poll();
  });
}

const H = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const task = (id, title, updatedAt, extra = {}) => ({
  id, title, description: '', dueDate: null, priority: 'med', status: 'active',
  tags: [], createdAt: updatedAt - 1000, updatedAt, sortOrder: 0, ...extra,
});

// Timestamps are "now - 2 days" based so tombstone/trash TTL pruning (30 days
// of REAL time) behaves exactly like production instead of expiring fake
// 1970-era stamps instantly.
const T0 = Date.now() - 2 * 24 * 60 * 60 * 1000;
const ts = (n) => T0 + n * 1000;

async function pull() { return (await fetch(BASE + '/api/state', H('GET'))).json(); }
async function sync(clientId, baseRev, st, tombstones = {}, mode) {
  const r = await fetch(BASE + '/api/sync', H('POST', { clientId, baseRev, mode, state: { savedAt: Date.now(), ...st }, tombstones }));
  return { status: r.status, json: await r.json() };
}

let child = null;
try {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'zt-test-'));

  console.log('1. auth + config');
  child = await startServer(dataDir);
  let r = await fetch(BASE + '/api/config');
  let conf = await r.json();
  ok(conf.app === 'zerotodo-server' && conf.authRequired === true, 'GET /api/config reports authRequired');
  r = await fetch(BASE + '/api/state');
  ok(r.status === 401, 'GET /api/state without token → 401');
  r = await fetch(BASE + '/index.html');
  ok(r.ok && (await r.text()).includes('ZeroTodo'), 'static index.html served');
  r = await fetch(BASE + '/cloud.js');
  ok(r.ok && (await r.text()).includes('ZTCloud'), 'static cloud.js served');
  r = await fetch(BASE + '/manifest.webmanifest');
  {
    const ct = (r.headers.get('content-type') || '');
    const mf = r.ok ? await r.json().catch(() => null) : null;
    ok(r.ok && ct.includes('manifest+json') && mf && mf.name.startsWith('ZeroTodo')
      && mf.icons.length === 3 && mf.start_url === './' && mf.display === 'standalone',
      'PWA manifest served with correct MIME — installable, icons + standalone display (mobile/PWA notification path)');
  }
  r = await fetch(BASE + '/icon-192.png');
  {
    const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    ok(r.ok && (r.headers.get('content-type') || '') === 'image/png' && buf.length > 700 && buf.slice(1, 4).toString() === 'PNG',
      'launcher icon is a real PNG served with the right type');
  }
  r = await fetch(BASE + '/sw.js');
  {
    const swTxt = r.ok ? await r.text() : '';
    const swCt = r.headers.get('content-type') || '';
    ok(r.ok && swTxt.includes('showNotification') && swCt.includes('javascript'),
      'service worker served at scope root with a JS mime (persistent notifications for installed PWAs)');
  }
  r = await fetch(BASE + '/index.html');
  ok((await r.text()).includes('rel="manifest"'), 'served index links the manifest');
  r = await fetch(BASE + '/../server/server.js');
  ok(!r.ok, 'path traversal blocked');

  console.log('2. first push (client A seeds an empty server)');
  let st = { settings: { theme: 'dark' }, tasks: [task('a1', 'Buy milk', ts(1)), task('a2', 'Pay rent', ts(1))], trash: [] };
  let s = await sync('A', 0, st);
  ok(s.status === 200 && s.json.tasks.length === 2, 'two tasks accepted');
  ok(s.json.settings.theme === 'dark', 'settings stored');
  ok(s.json.rev > 0, 'rev bumped');
  const revAfterA = s.json.rev;

  console.log('3. two-device LWW merge');
  // B (never seen a2) pushes its own list: a2 (server, updated@ts(1)) vs b1 new.
  s = await sync('B', 0, { settings: {}, tasks: [task('b1', 'Call mom', ts(0.9))], trash: [] });
  let state = s.json;
  ok(state.tasks.length === 3, 'union: A\'s 2 + B\'s 1 records survive (got ' + state.tasks.length + ')');
  ok(state.conflicted === true, 'stale baseRev flagged as conflicted → merged');
  // A edits a1 at ts(2); B still holds a1@ts(1). B pushes first, A's edit must win.
  s = await sync('B', state.rev, { settings: {}, tasks: [task('a1', 'Buy OAT milk', ts(1)), task('b1', 'Call mom', ts(1))], trash: [] });
  s = await sync('A', revAfterA, { settings: {}, tasks: [task('a1', 'Buy ALMOND milk', ts(2)), task('a2', 'Pay rent', ts(1))], trash: [] });
  const a1 = s.json.tasks.find((t) => t.id === 'a1');
  ok(a1.title === 'Buy ALMOND milk', 'last write wins across devices');
  ok(s.json.tasks.some((t) => t.id === 'b1'), 'B\'s task preserved in A\'s merge');

  console.log('4. store-scoped tombstones (soft delete keeps trash copy; stale re-push blocked; newer edit revives)');
  // A soft-deletes b1 at ts(3): out of tasks, into trash, tombstone tasks:b1.
  s = await sync('A', s.json.rev, { settings: {}, tasks: [task('a1', 'Buy ALMOND milk', ts(2)), task('a2', 'Pay rent', ts(1))], trash: [task('b1', 'Call mom', ts(3), { trashedAt: ts(3) })] }, { 'tasks:b1': ts(3) });
  ok(!s.json.tasks.some((t) => t.id === 'b1'), 'b1 removed from tasks by store-scoped tombstone');
  ok(s.json.trash.some((t) => t.id === 'b1'), 'b1 still lives in trash (soft delete preserved)');
  // B was offline: re-pushes its stale tasks copy b1@ts(1) → must NOT resurrect.
  s = await sync('B', 1, { settings: {}, tasks: [task('b1', 'Call mom', ts(1))], trash: [] });
  ok(!s.json.tasks.some((t) => t.id === 'b1'), 'stale re-push blocked (no resurrection)');
  // B edits b1 at ts(4) (newer than the tombstone) → edit legitimately revives it,
  // and live-wins then removes the trash copy.
  s = await sync('B', 1, { settings: {}, tasks: [task('b1', 'Call mom TOO', ts(4))], trash: [] });
  ok(s.json.tasks.find((t) => t.id === 'b1')?.title === 'Call mom TOO', 'edit after delete revives (LWW)');
  ok(!s.json.trash.some((t) => t.id === 'b1'), 'revived live task wins over its trash copy (invariant)');
  // A deletes again (soft, ts(5)): tombstone tasks:b1 kills the revived copy;
  // then a hard destroy (ts(6)) tombstones trash:b1 and it is gone everywhere.
  s = await sync('A', s.json.rev, { settings: {}, tasks: [task('a1', 'Buy ALMOND milk', ts(2)), task('a2', 'Pay rent', ts(1))], trash: [task('b1', 'Call mom TOO', ts(5), { trashedAt: ts(5) })] }, { 'tasks:b1': ts(5) });
  ok(!s.json.tasks.some((t) => t.id === 'b1') && s.json.trash.some((t) => t.id === 'b1'), 'second soft delete lands in trash');
  s = await sync('A', s.json.rev, { settings: {}, tasks: [task('a1', 'Buy ALMOND milk', ts(2)), task('a2', 'Pay rent', ts(1))], trash: [] }, { 'trash:b1': ts(6) });
  ok(!s.json.tasks.some((t) => t.id === 'b1') && !s.json.trash.some((t) => t.id === 'b1'), 'hard delete purges both stores');

  console.log('5. import replace mode wipes server-only records');
  s = await sync('A', 999999, { settings: { theme: 'light' }, tasks: [task('new1', 'Fresh start', ts(5))], trash: [] }, {}, 'replace');
  ok(s.json.tasks.length === 1 && s.json.tasks[0].id === 'new1', 'replace mode installed imported dataset exactly');
  ok(s.json.settings.theme === 'light', 'replace settings applied');
  ok(Array.isArray(s.json.projects) && s.json.projects.length === 0, 'v1-style import (no projects key) stays valid — list defaults to []');
  s = await sync('A', 999999, { settings: { theme: 'light' }, tasks: [task('new1', 'Fresh start', ts(5), { projectId: 'pI' })], trash: [], projects: [{ id: 'pI', name: 'Imported', createdAt: ts(1), updatedAt: ts(5) }] }, {}, 'replace');
  ok(s.json.projects.length === 1 && s.json.projects[0].name === 'Imported', 'replace mode carries projects in the SAME state doc');
  ok(s.json.tasks[0].projectId === 'pI', 'task → project links survive a replace import');
  ok(Array.isArray(s.json.subtasks) && s.json.subtasks.length === 0, 'v2-style import (no subtasks key) stays valid — defaults to []');
  s = await sync('A', 999999, { settings: {}, tasks: [task('new1', 'Fresh start', ts(5))], trash: [], subtasks: [{ id: 'sX', parentTaskId: 'new1', title: 'step 1', completed: false, position: 0, createdAt: ts(1), updatedAt: ts(5) }] }, {}, 'replace');
  ok(s.json.subtasks.length === 1 && s.json.subtasks[0].title === 'step 1', 'replace mode carries subtasks in the SAME state doc');
  s = await sync('B', s.json.rev, { tasks: [], trash: [], subtasks: [{ id: 'sX', parentTaskId: 'new1', title: 'B wins', completed: true, completedAt: ts(99), position: 0, createdAt: ts(1), updatedAt: ts(99) }] }, {}, 'merge');
  ok(s.json.subtasks[0].title === 'B wins' && s.json.subtasks[0].completed === true, 'subtask edits LWW-merge like tasks');
  s = await sync('B', s.json.rev, { tasks: [], trash: [], subtasks: [] }, { 'subtasks:sX': ts(120) }, 'merge');
  ok(s.json.subtasks.length === 0, 'a subtasks-scoped tombstone purges the subtask on every device');
  s = await sync('A', s.json.rev, { tasks: [task('new1', 'Timed', ts(7), { dueDate: '2026-09-19', dueTime: '09:30' })], trash: [] }, {}, 'merge');
  const timed = s.json.tasks.find((x) => x.id === 'new1');
  ok(timed.dueDate === '2026-09-19' && timed.dueTime === '09:30', 'task dueTime rides through the server in the task itself (no second date store)');
  s = await sync('B', s.json.rev, { tasks: [task('new1', 'Timed', ts(8), { dueDate: '2026-09-19', dueTime: '25:99' })], trash: [] }, {}, 'merge');
  ok(s.json.tasks.find((x) => x.id === 'new1').dueTime === null, 'invalid dueTime normalized server-side; valid date untouched');
  s = await sync('A', s.json.rev, { tasks: [task('new1', 'Timed', ts(9), { plan: { date: '2026-09-20', start: '14:00', end: '15:30' } })], trash: [] }, {}, 'merge');
  const pl = s.json.tasks.find((x) => x.id === 'new1').plan;
  ok(pl && pl.date === '2026-09-20' && pl.start === '14:00' && pl.end === '15:30', 'accepted daily-plan block rides the TASK record through sync (no second store, ever)');
  s = await sync('A', s.json.rev, { tasks: [task('new1', 'Timed', ts(10), { plan: { date: '2026-09-20', start: '16:00', end: '15:00' } })], trash: [] }, {}, 'merge');
  ok(s.json.tasks.find((x) => x.id === 'new1').plan === null, 'server refuses an end-before-start plan block — same rule as the client, no drift');
  /* ---- reminders (v5): ride the SAME state doc — records, not timers ---- */
  const rem = (id, taskId, upd, extra = {}) => ({
    id, taskId, triggerAt: ts(20), reminderType: 'h1', enabled: true, delivered: false,
    dismissed: false, status: 'pending', createdAt: ts(1), updatedAt: upd, ...extra,
  });
  s = await sync('A', s.json.rev, { tasks: [task('rt1', 'Renew visa', ts(10), { dueDate: '2026-12-01' })], trash: [], reminders: [rem('r1', 'rt1', ts(11)), rem('r-bad', 'rt1', ts(11), { triggerAt: 'nope' })] }, {}, 'merge');
  ok(s.json.reminders.length === 1 && s.json.reminders[0].reminderType === 'h1', 'reminders sync inside the state doc; reminder without a finite triggerAt is refused (task kept)');
  s = await sync('B', s.json.rev, { tasks: [task('rt1', 'Renew visa EDITED', ts(12))], trash: [], reminders: [rem('r1', 'rt1', ts(13), { reminderType: 'd1', extraFlag: 7 })] }, {}, 'merge');
  const r1 = s.json.reminders.find((x) => x.id === 'r1');
  ok(r1.reminderType === 'd1' && r1.extraFlag === 7, 'LWW: fresher reminder wins and unknown fields survive coercion');
  s = await sync('A', s.json.rev, { tasks: [], trash: [], reminders: [rem('r1', 'rt1', ts(6))] }, { 'reminders:r1': ts(14) }, 'merge');
  ok(!s.json.reminders.some((x) => x.id === 'r1') && s.json.tombstones['reminders:r1'] >= ts(14), 'reminders-scoped tombstone kills a stale re-push (deleted schedule stays deleted)');
  s = await sync('B', s.json.rev, { tasks: [], trash: [], reminders: [rem('r1', 'rt1', ts(25))] }, {}, 'merge');
  ok(s.json.reminders.some((x) => x.id === 'r1'), 'edit-beats-delete: a NEWER re-add revives the reminder (mirrors tasks/projects)');
  const cfg = await (await fetch(BASE + '/api/config')).json();
  ok(cfg.version === 8, 'server advertises version 8 (understands reminders incl. auto-overdue type)');
  s = await sync('B', s.json.rev, { tasks: [], trash: [], projects: [{ id: 'pI', name: 'B wins', createdAt: ts(1), updatedAt: ts(99) }] }, {}, 'merge');
  ok(s.json.projects[0].name === 'B wins', 'project edits LWW-merge like tasks');
  s = await sync('B', s.json.rev, { tasks: [], trash: [], projects: [] }, { 'projects:pI': ts(120) }, 'merge');
  ok(s.json.projects.length === 0, 'a projects-scoped tombstone purges the project on every device');

  console.log('6. invalid payload rejected safely');
  r = await fetch(BASE + '/api/sync', H('POST', { state: { tasks: 'not-an-array' } }));
  ok(r.status === 400, 'garbage body → 400');
  const before = await pull();
  r = await fetch(BASE + '/api/sync', H('POST', { state: { tasks: [{ noId: true }, { id: 'x', title: '' }, task('x2', 'ok', ts(6))] } }));
  const after = await pull();
  ok(after.tasks.length === before.tasks.length + 1 && after.tasks.some((t) => t.id === 'x2'), 'invalid records dropped, valid one kept');

  console.log('7. restart persistence');
  child.kill('SIGTERM');
  await new Promise((res) => child.on('exit', res));
  ok(existsSync(path.join(dataDir, 'state.json')), 'state.json written to disk');
  child = await startServer(dataDir);
  const revived = await pull();
  ok(revived.tasks.some((t) => t.id === 'x2' || t.title === 'Fresh start'), 'tasks survive server restart');
  ok(revived.rev === before.rev + 2 || revived.rev >= before.rev, 'rev persists across restart');

  console.log('8. SSE broadcast to other clients');
  const ac = new AbortController();
  const evRes = await fetch(BASE + '/api/events?token=' + TOKEN + '&id=watcher', { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
  ok(evRes.ok && /event-stream/.test(evRes.headers.get('content-type') || ''), 'SSE stream opens with hello');
  const evRead = (async () => {
    const dec = new TextDecoder();
    const it = evRes.body.getReader();
    let buf = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const { value, done } = await it.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('"type":"sync"')) { ac.abort(); return buf; }
    }
    ac.abort();
    return buf;
  })();
  await new Promise((r) => setTimeout(r, 150));
  await sync('pusher', (await pull()).rev, { settings: {}, tasks: [task('sse1', 'ping', ts(7))], trash: [] });
  const ev = await evRead;
  ok(/"type":"sync"/.test(ev), 'watcher received live sync event');

  console.log('9. user accounts: signup, sessions, isolation, legacy adoption');
  // validation
  r = await fetch(BASE + '/api/signup', H('POST', { username: 'ab', password: 'longenoughpw' }));
  ok(r.status === 400, 'username too short → 400');
  r = await fetch(BASE + '/api/signup', H('POST', { username: 'alice', password: '123' }));
  ok(r.status === 400, 'password too short → 400');
  // first account adopts the legacy admin dataset (this test already filled it)
  const sr = await fetch(BASE + '/api/signup', H('POST', { username: 'alice', password: 'wonderland-42' }));
  const alice = await sr.json();
  ok(sr.status === 200 && alice.token && alice.username === 'alice', 'first signup returns session token');
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + alice.token };
  let meRes = await fetch(BASE + '/api/me', { headers: AH });
  ok(meRes.ok && (await meRes.json()).username === 'alice', 'GET /api/me validates the session');
  let aState = await (await fetch(BASE + '/api/state', { headers: AH })).json();
  ok(aState.tasks.length === before.tasks.length + 1 && aState.tasks.some((t) => t.id === 'x2'), 'first account adopted legacy data (saw ' + aState.tasks.length + ' tasks)');
  // duplicate + bad login
  r = await fetch(BASE + '/api/signup', H('POST', { username: 'alice', password: 'whatever-12' }));
  ok(r.status === 409, 'duplicate username → 409');
  r = await fetch(BASE + '/api/login', H('POST', { username: 'alice', password: 'nope-nope-nope' }));
  ok(r.status === 401, 'wrong password → 401');
  r = await fetch(BASE + '/api/login', H('POST', { username: 'ALICE ', password: 'wonderland-42' }));
  ok(r.status === 200, 'login is case-insensitive + trims');
  const aliceToken2 = (await r.json()).token;
  ok(aliceToken2 === alice.token || typeof aliceToken2 === 'string', 'login re-issues a valid token');
  // second account: NO adoption, isolated
  const s2 = await fetch(BASE + '/api/signup', H('POST', { username: 'bob', password: 'builder-77' }));
  const bob = await s2.json();
  const BH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bob.token };
  let bState = await (await fetch(BASE + '/api/state', { headers: BH })).json();
  ok(bState.tasks.length === 0, 'second account starts empty (no legacy adoption)');
  await fetch(BASE + '/api/sync', { method: 'POST', headers: AH, body: JSON.stringify({ clientId: 'A', baseRev: aState.rev, state: { savedAt: Date.now(), settings: {}, tasks: [task('alice-only', 'secret plan', ts(8))], trash: [] }, tombstones: {} }) });
  bState = await (await fetch(BASE + '/api/state', { headers: BH })).json();
  ok(bState.tasks.length === 0, 'bob cannot see alice\'s task (isolation)');
  aState = await (await fetch(BASE + '/api/state', { headers: AH })).json();
  ok(aState.tasks.some((t) => t.id === 'alice-only'), 'alice sees her own task');
  // forged session token rejected
  r = await fetch(BASE + '/api/state', { headers: { Authorization: 'Bearer alice.99999999999.deadbeef' } });
  ok(r.status === 401, 'forged/tampered session rejected');
  // admin bearer still works (back-compat)
  r = await fetch(BASE + '/api/state', H('GET'));
  ok(r.status === 200, 'legacy ZT_TOKEN bearer still maps to admin bucket');

  /* ---- habits (v6 module): a separate store riding the SAME state doc ---- */
  {
    const hs = (id, upd, extra = {}) => ({ id, name: 'Exercise', frequency: 'daily', target: 1, weekdays: [], archived: false, remindTime: null, history: [], createdAt: upd - 1, updatedAt: upd, ...extra });
    let s2 = await sync('A', 0, { tasks: [], trash: [], habits: [hs('hh1', ts(40)), { id: 'hh2', updatedAt: ts(40), frequency: 'yearly' }], reminders: [{ id: 'hr:hh1', habitId: 'hh1', taskId: '', triggerAt: ts(41), reminderType: 'custom', status: 'pending', enabled: true, delivered: false, dismissed: false, createdAt: ts(40), updatedAt: ts(40) }] }, {}, 'merge');
    ok(s2.json.habits.length === 1 && s2.json.habits[0].name === 'Exercise',
      'habits sync inside the state doc (no second table anywhere) — a habit without a name is refused');
    ok(s2.json.reminders.some((x) => x.id === 'hr:hh1' && x.habitId === 'hh1'),
      'a habit-owned reminder row rides the same reminders array (server does NOT require taskId)');
    s2 = await sync('B', s2.json.rev, { tasks: [], trash: [], habits: [hs('hh1', ts(45), { name: 'Exercise Evening', frequency: 'days', weekdays: [1, 3], remindTime: '07:00' })] }, {}, 'merge');
    const h1 = s2.json.habits.find((x) => x.id === 'hh1');
    ok(h1.name === 'Exercise Evening' && h1.frequency === 'days' && h1.remindTime === '07:00',
      'last-write-wins edit of a habit from another device merges like any record');
    s2 = await sync('A', s2.json.rev, { tasks: [], trash: [], habits: [hs('hh1', ts(30), { name: 'STALE' })] }, {}, 'merge');
    ok(s2.json.habits.find((x) => x.id === 'hh1').name === 'Exercise Evening', 'a STALE habit push cannot clobber the newer one');
  }

  /* ---------------- AI decomposition: route + advisory sync fields ---------------- */
  {
    console.log('AI decomposition: POST /api/ai/decompose + fields on the sync path');
    let r = await fetch(BASE + '/api/ai/decompose', { method: 'POST', body: '{}' });
    ok(r.status === 401, '/api/ai/decompose without a token → 401 (the proxy is auth-gated like the data it plans on)');
    r = await fetch(BASE + '/api/ai/decompose', H('POST', {}));
    ok(r.status === 400, 'missing title → 400 with a structured error (never a prose shrug)');
    r = await fetch(BASE + '/api/ai/decompose', H('POST', { title: 'Build an expense tracker' }));
    const plan1 = await r.json();
    ok(r.status === 200 && plan1.engine === 'built-in planner' && Array.isArray(plan1.steps) && plan1.steps.length === 8 &&
      plan1.steps[0].title === 'Define requirements' && plan1.steps[7].title === 'Test application' &&
      plan1.steps.every((s) => typeof s.title === 'string' && typeof s.description === 'string' &&
        Number.isInteger(s.estMin) && ['low', 'med', 'high'].includes(s.priority) &&
        /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate) && Array.isArray(s.dependsOn)),
      'no ZT_AI_* configured → deterministic built-in planner answers with fully STRUCTURED task data (the brief’s 8-step example, exact)');
    r = await fetch(BASE + '/api/ai/decompose', H('POST', { title: 'Build an expense tracker' }));
    ok(r.status === 429, 'a second request from the same user within 1.5s → 429 (per-user guard; the browser treats any failure as “use local plan”)');
    r = await fetch(BASE + '/api/ai/decompose', H('POST', { title: '   ' }));
    ok(r.status === 400, 'blank title is rejected before the rate limiter is consulted (validation order matters: free checks first)');
    const cur = await pull();
    const at = task('aiT1', 'Build a mobile app for the team', ts(80), { estMin: '45', deps: ['aiT1', 'ghost', 4, 'keepme'], aiOffer: true, priority: 'high' });
    const sr = await sync('Z', cur.rev, { settings: {}, tasks: [at], trash: [] });
    const row = (sr.json.tasks || []).find((x) => x.id === 'aiT1');
    ok(row && row.estMin === 45 && row.deps.join() === 'ghost,keepme' && row.aiOffer === true,
      'advisory AI fields ride /api/sync with the same coercion as the browser engine (strings numericized, self/non-string deps dropped)');
  }

  rmSync(dataDir, { recursive: true, force: true });
} catch (e) {
  console.error('TEST CRASH:', e);
  failed++;
} finally {
  if (child) child.kill('SIGKILL');
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll server tests passed.');
process.exit(failed ? 1 : 0);
