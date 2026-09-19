# ZeroTodo — now ONLINE ☁

Your local-first app keeps its zero-data-loss guarantees, and every change is now
**also saved to a server** (your own). What that buys you:

- ✅ Data survives **clearing browser data / private mode / reinstalling the browser**
- ✅ Open the same list from **your phone, laptop, any browser** — it syncs live
- ✅ **Your own account** (username + password) — data is private per user, and
  there are no passkeys to paste: server secrets live only in the server's env
- ✅ Two devices open at once? Changes converge in ~1 second (server-sent events)
- ✅ **Works offline too**: it's local-first — if the server is unreachable the app
  keeps working on this browser's storage and re-syncs when the connection returns

## What changed (files)

| File | Role |
|---|---|
| `public/storage.js` | **unchanged** — the local engine (IndexedDB + backup mirror) is still the primary, crash-proof store |
| `public/cloud.js` | **NEW** — sync layer: pushes every commit to the server, merges on load, listens for live updates. Never blocks the app; on any network failure it just keeps working locally |
| `public/app.js` | +1 hook (`ZTCloud.attach(...)`), +`updatedAt` bump on restore/delete so sync ordering is correct |
| `public/index.html`, `styles.css` | ☁ status pill + Settings → Cloud sync fields + `cloud.js` script tag |
| `server/server.js` | **NEW** — zero-dependency Node server: hosts the app + a small JSON state API with last-write-wins merge + SSE. Data lives in `data/state.json` (atomic writes) |
| `Dockerfile`, `render.yaml` | one-command deploy options |

Sync rules (simple on purpose): **per-record last-write-wins**. Deletes are
remembered as store-scoped tombstones for 30 days, so a deleted task can't be
resurrected by an old device pushing its stale copy.

---

## Get it online permanently (pick one)

> The URL in this sandbox is a **temporary demo** — use one of these for real.

### Option 1 — Render free + Supabase free (no card, ~10 minutes) ⭐ recommended

Render's **free plan has no persistent disk** (disks are paid), so on free the
durable copy of your data lives in a free **Supabase Postgres** row instead —
the server talks to it over plain HTTPS, still zero npm dependencies.

**Step A — create the free database (2 min):**
1. [supabase.com](https://supabase.com) → **Start your project** (log in with GitHub) → new project, any name, strong DB password, region near you — **free plan**
2. Open **SQL Editor** → paste & run (one shot, safe to re-run):
   ```sql
   create table if not exists public.zerotodo_state (
     id int primary key default 1,
     doc jsonb not null,
     updated_at timestamptz default now()
   );
   create table if not exists public.zerotodo_state_by_user (
     owner text primary key,
     doc jsonb not null,
     updated_at timestamptz default now()
   );
   create table if not exists public.zerotodo_users (
     username text primary key,
     pass_hash text not null,
     salt text not null,
     created_at timestamptz default now()
   );
   alter table public.zerotodo_state enable row level security;
   alter table public.zerotodo_state_by_user enable row level security;
   alter table public.zerotodo_users enable row level security;
   notify pgrst, 'reload schema';
   ```
   `zerotodo_state` is the legacy single-user row — after the update, the
   **first account you create automatically adopts its contents**, then that
   table keeps serving only the `admin` backdoor bucket. RLS with no policies
   = anon/browser keys can read nothing; only the service key below can touch
   the rows. Your tasks are never public.
   (Already have the first table from the earlier setup? Only run the two new
   `create table` blocks + their `alter` lines + the `notify`.)
3. **Settings → Data API** (or “API” in older UI): copy the **Project URL**
   (`https://xxxx.supabase.co`) and the **`service_role` secret key**.
   ⚠️ The service_role key goes on the SERVER only (env var) — never paste it
   into a browser or share it.

**Step B — deploy on Render:**
1. Push this folder to a GitHub repo, then [render.com](https://render.com) →
   **New → Blueprint** → pick the repo. It reads `render.yaml`: free web
   service, health check on `/api/config`, and it will **ask you for two
   secret values** during Apply.
2. Enter `ZT_SUPABASE_URL` = your Project URL, `ZT_SUPABASE_KEY` = the
   `service_role` key. (Leave `ZT_TOKEN` to Render's auto-generated value.)
3. Deploy → open the new URL → a **sign-in card appears** → **Create account**
   (pick a username + a password of 8+ chars). That's the whole setup — no
   passkey anywhere. The account is created once, on the server; each device
   only logs in.
4. Phone: same URL → **sign in** with the same username + password. Done —
   data now survives restarts, redeploys and cleared browsers, and each
   account sees only its own list.

Verify it’s really persistent (30 s): add a task → Render dashboard → your
service → **Options → Trigger manual deploy** → when it comes back up, the
task is still there (restored from Postgres), and `/api/config` shows
`"storage": "supabase (Postgres) + local cache"`.

Skipped step 2 (no Supabase vars)? The app still works, but the filesystem is
**ephemeral on the free plan** — data can vanish at any redeploy. Configure
Supabase before you start adding real tasks.
Prefer paying $7/mo instead of the Supabase setup? Switch `plan: free` to
`plan: starter` in `render.yaml` and add a `disk:` block back
(`disk: { name: zerotodo-data, mountPath: /var/data, sizeGB: 1 }`) — disks work
on paid plans, and then `ZT_DATA_DIR=/var/data/zerotodo` does the whole job.


### Option 2 — Docker (any host: Fly.io, Hetzner, a Raspberry Pi at home…)

```bash
docker run -d --name zerotodo -p 8080:8080 \
  -e ZT_TOKEN="change-me-to-something-long" \
  -v zerotodo-data:/data \
  your-registry/zerotodo   # build from this folder first: docker build -t … .
```
Put it behind any HTTPS reverse proxy (Caddy: `reverse_proxy localhost:8080`).

### Option 3 — Plain VPS / shared box with Node 18+

```bash
# on the server
git clone <your-repo> && cd zerotodo
ZT_TOKEN="pick-a-long-secret" PORT=8080 node server/server.js   # test once
```
Then keep it running with systemd:

```ini
# /etc/systemd/system/zerotodo.service
[Unit]
Description=ZeroTodo
After=network.target
[Service]
ExecStart=/usr/bin/node server/server.js
WorkingDirectory=/opt/zerotodo
Environment=PORT=8080 ZT_TOKEN=pick-a-long-secret
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
```
…plus any HTTPS proxy in front (Caddy/nginx). Caddy handles free certs automatically.

### Just run it on your own computer (LAN between phone + laptop)

```bash
cd zerotodo
ZT_TOKEN="whatever-you-like" node server/server.js
# open http://<your-computer's-LAN-ip>:8080 on both devices
```

---

## Moving your existing tasks to the online version

IndexedDB is per-site (per *origin*), so a new URL starts with an empty local
store — the cloud sync can only pull what the **server** has. If your current
tasks only live in the old local app:

1. Open the old app → header **Export** (downloads `zerotodo-backup-….json`)
2. Open the new online app → **Import** → pick that file

(If you already added tasks on the new URL, Import asks first and downloads a
safety copy — nothing is silently overwritten.)

## Security notes (please read)

- Your **account password** is now the lock on your data — pick a real one.
  Passwords are stored scrypt-hashed + salted; sessions are signed with
  `ZT_TOKEN` (Render's generated value) which never leaves the server.
- `ZT_TOKEN` also remains a hidden **admin backdoor** bearer (legacy bucket).
  If you want it fully closed, remove the row — but sessions then stop
  validating across secret changes, so leave it alone unless you know why.
- **Never deploy with `ZT_OPEN=1` on the public internet** — it disables all auth.
- Always use the `https://` URL so passwords and tasks aren't sent in clear text.
- **Accounts:** each username gets a private bucket (own row in
  `zerotodo_state_by_user`). Signup is open to anyone who can reach the URL —
  if you want it invite-only, the simplest control is keeping the URL to
  yourself (nothing links to it publicly) or later adding a signup allowlist.
- Logging out clears the session on that device; your data stays on the server
  and in that browser's local cache until the next sign-in replaces it.

## How sync behaves (FAQ)

- **Edit on two devices at once** → per-record last-write-wins (the freshest edit
  of that exact task wins; other tasks are unaffected).
- **Deleted task came back?** Only if another device edited it *after* the delete —
  then the edit wins. Tombstones expire after 30 days.
- **Offline** → everything works locally; the ☁ pill shows *Offline — saved
  locally*; it re-syncs automatically when the connection returns.
- **Server restarts / redeploys** → with Supabase configured, state is restored
  from the Postgres row (that's the whole point of it); file-only mode reloads
  `data/state.json`. The app's Export button still gives you a portable copy
  of everything at any time.
- **Multiple browser tabs** → the original BroadcastChannel cross-tab sync still
  works; the server event stream keeps tabs from different devices in step.
- **Projects** → tasks optionally belong to a project (`📂 Projects` bar, detail
  header with progress/due/overdue stats, per-project filter). Projects sync with
  the *same* state document and merge rules as tasks — there is no second store.
  Deleting a project moves it to Trash **without touching its tasks**; emptying
  the trash detaches them back to the Inbox. Old data (schemaVersion 1) migrates
  automatically on first load — existing tasks simply get `projectId: null`.
- **Subtasks** → any task can hold an ordered checklist (`▸ n/m subtasks · %` under the
  row: add, rename, tick, delete with 8 s undo, ↑↓ reorder). Subtasks are flat records
  in the same state document (per-record sync like everything else). Trashing a task
  leaves its subtasks attached (restore brings the checklist back); only a permanent
  delete cascades them. Project progress % counts subtask completion; search matches
  subtask titles too. Settings has an optional "automatically complete parent when all
  subtasks are completed" — off by default. One nesting level is supported (the data
  model is ready for more); old v1/v2 data and backups migrate on load.

## Test it (dev)

```bash
node server/test.mjs          # 51 checks: accounts, sessions, merge, tombstones, replace, projects+subtasks, persistence, SSE
node server/test-storage.mjs  # 63 checks: the real public/storage.js in Node — v1→v3 migration, coercion, backups, retention
node server/test-supabase.mjs # 22 checks: mock PostgREST — free-plan restart survival, per-user rows, adoption
node server/test-client.mjs   # 29 checks: the real public/cloud.js against a live server (project + subtask sync semantics)
npm i --no-save jsdom && node server/test-ui.mjs
                              # 48 checks: the real index.html + storage.js + app.js in a headless DOM —
                              # every subtask + project UI behavior (dialogs, cards, archive, undo, refresh)
```
