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
const memory = { tasks: [], trash: [], settings: {}, lastSavedAt: Date.now() };
const store = {
  state: memory,
  async commit() { return true; },
  async resync() { return true; },
  replaceMemory(t, r) { memory.tasks = t; memory.trash = r; },
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

child.kill('SIGKILL');
console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll client integration tests passed.');
process.exit(failed ? 1 : 0);
