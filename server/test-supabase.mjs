/* ============================================================================
 * test-supabase.mjs — remote persistence + multi-user isolation against a mock
 * PostgREST server (exact REST shape Supabase exposes). Proves: free-plan
 * survival (disk wiped, restart, restored from Postgres), non-blocking retry
 * under failures, per-user rows (owner column), legacy-row adoption by the
 * FIRST account, cross-user isolation, and file-only mode fallback.
 * Run: node server/test-supabase.mjs
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18102;
const SB_PORT = 18103;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'sb-test-key';

let failed = 0;
const ok = (c, n) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ mock PostgREST ----------------------------- */

const db = {
  legacy: {},            // id → doc            (zerotodo_state, admin bucket)
  byuser: {},            // owner → doc         (zerotodo_state_by_user)
  users: {},             // username → row      (zerotodo_users)
};
let sbFailures = 0;
let sbVisible = true;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!sbVisible) { res.writeHead(503); return res.end('mock offline'); }
    if (sbFailures > 0) { sbFailures--; res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"mock transient failure"}'); }
    const u = new URL(req.url, 'http://x');
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = [];
    if (table === 'zerotodo_state') {
      if (req.method === 'POST') { db.legacy[1] = JSON.parse(body).doc; res.writeHead(201); return res.end(); }
      if (u.searchParams.get('id') === 'eq.1' && db.legacy[1]) rows.push({ doc: db.legacy[1] });
    } else if (table === 'zerotodo_state_by_user') {
      if (req.method === 'POST') { const p = JSON.parse(body); db.byuser[p.owner] = p.doc; res.writeHead(201); return res.end(); }
      const owner = (u.searchParams.get('owner') || '').replace('eq.', '');
      if (db.byuser[owner]) rows.push({ doc: db.byuser[owner] });
    } else if (table === 'zerotodo_users') {
      if (req.method === 'POST') { const p = JSON.parse(body); db.users[p.username] = p; res.writeHead(201); return res.end(); }
      rows.push(...Object.values(db.users));
    } else { res.writeHead(404); return res.end('{"message":"unknown table"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
});
await new Promise((r) => mock.listen(SB_PORT, '127.0.0.1', r));

/* -------------------------------- app server -------------------------------- */

function startApp(dataDir, withSb = true) {
  const env = { ...process.env, PORT: String(PORT), ZT_HOST: '127.0.0.1', ZT_DATA_DIR: dataDir, ZT_TOKEN: TOKEN };
  if (withSb) {
    env.ZT_SUPABASE_URL = `http://127.0.0.1:${SB_PORT}`;
    env.ZT_SUPABASE_KEY = 'fake-service-role-key';
  } else {
    delete env.ZT_SUPABASE_URL; delete env.ZT_SUPABASE_KEY;
  }
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.__log = '';
  child.stdout.on('data', (d) => { child.__log += d; });
  child.stderr.on('data', (d) => { child.__log += d; });
  return { child, ready: pollUp() };
}
async function pollUp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) return; } catch (_) {}
    await sleep(120);
  }
  throw new Error('app server did not start');
}
async function stopApp(child) {
  child.kill('SIGTERM');
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
}
const bearer = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const getState = async (t) => (await fetch(BASE + '/api/state', { headers: bearer(t || TOKEN) })).json();
const push = async (t, title, id, rev) => fetch(BASE + '/api/sync', {
  method: 'POST', headers: bearer(t || TOKEN),
  body: JSON.stringify({
    clientId: 'test', baseRev: rev ?? null, mode: 'merge',
    state: { savedAt: Date.now(), settings: {}, tasks: [{ id, title, updatedAt: Date.now(), createdAt: Date.now() - 1000, priority: 'med', status: 'active', tags: [], description: '', dueDate: null, sortOrder: 0 }], trash: [] },
    tombstones: {},
  }),
});
const poll = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(300); }
  return false;
};

let app = null;
try {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zt-sb-'));

  console.log('1. boot with Supabase configured');
  app = await startApp(dir); await app.ready;
  let conf = await (await fetch(BASE + '/api/config')).json();
  ok(/supabase/.test(conf.storage), 'config reports storage: ' + conf.storage);

  console.log('2. admin commits flow to the legacy row');
  let r = await push(TOKEN, 'task one', 'p1');
  ok(r.status === 200, 'sync accepted via legacy admin bearer');
  await push(TOKEN, 'task two', 'p2', (await getState(TOKEN)).rev);
  ok(await poll(() => db.legacy[1] && db.legacy[1].tasks.length === 2), 'remote legacy row has both tasks');

  console.log('3. RENDER-FREE-PLAN SCENARIO: local disk wiped, service restarted');
  await stopApp(app.child);
  rmSync(path.join(dir, 'state.json'), { force: true });
  app = await startApp(dir); await app.ready;
  let st = await getState(TOKEN);
  ok(st.tasks.length === 2 && st.tasks.some((t) => t.id === 'p2'), 'state restored from Supabase (rev ' + st.rev + ')');

  console.log('4. remote flaky → API keeps answering, retries land it');
  sbFailures = 3;
  r = await push(TOKEN, 'task three', 'p3', (await getState(TOKEN)).rev);
  ok(r.status === 200, 'sync NOT blocked by failing remote');
  ok(await poll(() => db.legacy[1] && db.legacy[1].tasks.length === 3, 45000), 'retry loop uploaded task three');

  console.log('5. remote fully down → still functional, no crash, catches up');
  sbVisible = false;
  r = await push(TOKEN, 'task four', 'p4', (await getState(TOKEN)).rev);
  ok(r.status === 200 && (await getState(TOKEN)).tasks.length === 4, '4 tasks live while remote is down');
  sbVisible = true;
  ok(await poll(() => db.legacy[1] && db.legacy[1].tasks.length === 4, 30000), 'queued write flushed once remote returned');

  console.log('6. restart with EMPTY disk restores from legacy row');
  await stopApp(app.child);
  rmSync(path.join(dir, 'state.json'), { force: true });
  app = await startApp(dir); await app.ready;
  st = await getState(TOKEN);
  ok(st.tasks.length === 4, 'all 4 admin tasks restored');

  console.log('7. first account adopts legacy; second does not; isolation holds');
  let sr = await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wonderland-42' }) });
  const alice = (await sr.json()).token;
  ok(sr.status === 200 && !!alice, 'alice signed up (first account)');
  ok(!!db.users.alice, 'alice persisted in the users table');
  let aState = await getState(alice);
  ok(aState.tasks.length === 4, 'alice adopted the legacy dataset (' + aState.tasks.length + ' tasks)');
  ok(await poll(() => db.byuser.alice && db.byuser.alice.tasks.length === 4), 'adoption written to alice\'s own row');
  sr = await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'builder-777' }) });
  const bob = (await sr.json()).token;
  let bState = await getState(bob);
  ok(bState.tasks.length === 0, 'bob (second account) starts EMPTY — no adoption');
  // v5: reminders are records inside the same state doc — no second store.
  aState = await getState(alice);
  const srem = { id: 'sr1', taskId: aState.tasks[0].id, triggerAt: Date.now() + 3600e3, reminderType: 'onTime', status: 'pending', enabled: true, delivered: false, dismissed: false, createdAt: Date.now(), updatedAt: Date.now() };
  const sod = { id: 'sod1', taskId: aState.tasks[0].id, triggerAt: Date.now() - 60000, reminderType: 'overdue', status: 'pending', enabled: true, delivered: false, dismissed: false, forDue: '2026-09-18', pinned: false, createdAt: Date.now(), updatedAt: Date.now() };
  const rpush = await (await fetch(BASE + '/api/sync', { method: 'POST', headers: bearer(alice), body: JSON.stringify({ clientId: 'test', baseRev: aState.rev, mode: 'merge', state: { savedAt: Date.now(), settings: {}, tasks: [], trash: [], reminders: [srem, sod] }, tombstones: {} }) })).json();
  ok(rpush.reminders && rpush.reminders.length === 2, 'reminders synced into alice\'s state doc (no new table)');
  ok((rpush.reminders || []).some((x) => x.id === 'sod1' && x.reminderType === 'overdue'), 'server keeps the “overdue” reminder type (not degraded to custom)');
  ok(await poll(() => db.byuser.alice && (db.byuser.alice.reminders || []).some((x) => x.id === 'sr1'), 45000), 'reminder persisted to the Postgres row');
  await stopApp(app.child);
  rmSync(path.join(dir, 'state.json'), { force: true });
  app = await startApp(dir); await app.ready;
  const afterR = await getState(alice);
  ok(afterR.reminders.length === 2 && afterR.reminders.some((x) => x.id === 'sr1') && afterR.tasks.length === aState.tasks.length,
    'restart with empty disk: reminders restored from Postgres still attached to their task');

  r = await push(alice, 'alice secret', 'a1', (await getState(alice)).rev);
  ok(r.status === 200, 'alice push ok');
  ok((await getState(bob)).tasks.length === 0, 'bob still sees nothing of alice\'s data');
  ok((await getState(TOKEN)).tasks.length === 4, 'admin bucket untouched by alice');
  await poll(() => db.byuser.alice && db.byuser.alice.tasks.some((t) => t.id === 'a1'), 15000);
  ok(db.byuser.alice.tasks.length === 5 && db.byuser.bob === undefined, 'per-user remote rows isolated');

  console.log('8. persistence of accounts across wipe+restart (remote users table)');
  await stopApp(app.child);
  rmSync(path.join(dir, 'accounts.json'), { force: true });
  rmSync(path.join(dir, 'users', 'alice.json'), { force: true });
  app = await startApp(dir); await app.ready;
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wonderland-42' }) });
  ok(r.status === 200, 'alice can still log in (accounts live in Postgres)');
  const a2 = (await r.json()).token;
  aState = await getState(a2);
  ok(aState.tasks.length === 5, 'alice\'s data intact after instance destruction');

  console.log('9. no env vars → file-only mode unaffected');
  await stopApp(app.child);
  app = await startApp(dir, false); await app.ready;
  conf = await (await fetch(BASE + '/api/config')).json();
  ok(conf.storage === 'local file only', 'storage: ' + conf.storage);
  r = await push(TOKEN, 'offline mode', 'p9', (await getState(TOKEN)).rev);
  ok(r.status === 200 && (await getState(TOKEN)).tasks.length === 5, 'file-only mode works (admin bucket: ' + (await getState(TOKEN)).tasks.length + ' tasks)');

  await stopApp(app.child);
} catch (e) {
  console.error('TEST CRASH:', e);
  failed++;
} finally {
  if (app && app.child && !app.child.killed) app.child.kill('SIGKILL');
  mock.close();
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll Supabase + multi-user tests passed.');
process.exit(failed ? 1 : 0);
