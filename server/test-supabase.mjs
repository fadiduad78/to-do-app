/* ============================================================================
 * test-supabase.mjs — verifies remote persistence against a mock PostgREST
 * server (the exact REST shape Supabase/Postgres exposes). Proves:
 *   startup restore from remote when local disk is gone (= Render free-plan
 *   redeploy), API never blocks on a slow/failing remote, retries with
 *   backoff, and file-only mode still works when env vars are unset.
 * Run: node server/test-supabase.mjs
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18102;        // app server
const SB_PORT = 18103;     // mock PostgREST
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'sb-test-key';

let failed = 0;
const ok = (c, n) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ mock PostgREST ----------------------------- */

let sbRow = null;
let sbFailures = 0;
let sbVisible = true;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!sbVisible) { res.writeHead(503); return res.end('mock offline'); }
    if (sbFailures > 0) { sbFailures--; res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"mock transient failure"}'); }
    if (req.method === 'POST' && req.url.startsWith('/rest/v1/zerotodo_state')) {
      const parsed = JSON.parse(body);
      if (parsed.id !== 1 || !parsed.doc) { res.writeHead(400); return res.end('{"message":"bad row"}'); }
      sbRow = parsed;
      res.writeHead(201); res.end();
    } else if (req.method === 'GET' && req.url.startsWith('/rest/v1/zerotodo_state')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sbRow ? [{ doc: sbRow.doc }] : []));
    } else { res.writeHead(404); res.end('{"message":"not found"}'); }
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
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 4000); });
}
const A = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const getState = async () => (await fetch(BASE + '/api/state', A('GET'))).json();
const push = async (title, id, rev) => fetch(BASE + '/api/sync', A('POST', {
  clientId: 'test', baseRev: rev ?? null, mode: 'merge',
  state: { savedAt: Date.now(), settings: {}, tasks: [{ id, title, updatedAt: Date.now(), createdAt: Date.now() - 1000, priority: 'med', status: 'active', tags: [], description: '', dueDate: null, sortOrder: 0 }], trash: [] },
  tombstones: {},
}));
const poll = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); }
  return false;
};

let app = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), 'zt-sb-'));

  console.log('1. boot with Supabase configured');
  app = await startApp(dir); await app.ready;
  let conf = await (await fetch(BASE + '/api/config')).json();
  ok(/supabase/.test(conf.storage), 'config reports storage: ' + conf.storage);

  console.log('2. commits flow to the remote row');
  let r = await push('task one', 'p1');
  ok(r.status === 200, 'sync accepted (rev ' + (await getState()).rev + ')');
  await push('task two', 'p2', (await getState()).rev);
  const sawTwo = await poll(async () => sbRow && sbRow.doc.tasks.length === 2);
  ok(sawTwo, 'remote row contains both tasks');

  console.log('3. RENDER-FREE-PLAN SCENARIO: local disk wiped, service restarted');
  await stopApp(app.child);
  rmSync(dir + '/state.json', { force: true }); // ephemeral FS is gone after a redeploy
  app = await startApp(dir); await app.ready;
  let st = await getState();
  ok(st.tasks.length === 2 && st.tasks.some((t) => t.title === 'task one'), 'state restored from Supabase (rev ' + st.rev + ')');

  console.log('4. remote flaky → API keeps answering, retries land it');
  sbFailures = 3; // next ~3 writes 500 (server backs off 4s→8s→16s)
  r = await push('task three', 'p3', (await getState()).rev);
  ok(r.status === 200, 'sync NOT blocked by failing remote');
  const landed = await poll(async () => sbRow && sbRow.doc.tasks.length === 3, 45000); // backoff 4s+8s+16s
  ok(landed, 'retry loop uploaded task three after transient failures');

  console.log('5. remote fully down → still functional (file cache), no crash');
  sbVisible = false;
  r = await push('task four', 'p4', (await getState()).rev);
  ok(r.status === 200 && (await getState()).tasks.length === 4, '4 tasks live while remote is down');
  st = await getState();
  ok(st.tasks.some((t) => t.title === 'task four'), 'recent edit served from memory/file cache');
  sbVisible = true;
  const caughtUp = await poll(async () => sbRow && sbRow.doc.tasks.length === 4, 30000);
  ok(caughtUp, 'queued write flushed to remote once it came back');

  console.log('6. restart with EMPTY disk + down-then-up remote ordering');
  await stopApp(app.child);
  rmSync(dir + '/state.json', { force: true });
  app = await startApp(dir); await app.ready;
  st = await getState();
  ok(st.tasks.length === 4, 'all 4 tasks restored from remote row');

  console.log('7. no env vars → file-only mode unaffected');
  await stopApp(app.child);
  app = await startApp(dir, false); await app.ready;
  conf = await (await fetch(BASE + '/api/config')).json();
  ok(conf.storage === 'local file only', 'storage: ' + conf.storage);
  r = await push('offline mode', 'p9', (await getState()).rev);
  ok(r.status === 200 && (await getState()).tasks.length === 5, 'file-only mode works');

  await stopApp(app.child);
} catch (e) {
  console.error('TEST CRASH:', e);
  failed++;
} finally {
  if (app && !app.child.killed) app.child.kill('SIGKILL');
  mock.close();
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll Supabase-persistence tests passed.');
process.exit(failed ? 1 : 0);
