# ZeroTodo — now ONLINE ☁

Your local-first app keeps its zero-data-loss guarantees, and every change is now
**also saved to a server** (your own). What that buys you:

- ✅ Data survives **clearing browser data / private mode / reinstalling the browser**
- ✅ Open the same list from **your phone, laptop, any browser** — it syncs live
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
2. Open **SQL Editor** → paste & run:
   ```sql
   create table public.zerotodo_state (
     id int primary key default 1,
     doc jsonb not null,
     updated_at timestamptz default now()
   );
   alter table public.zerotodo_state enable row level security;
   ```
   (RLS with no policies = anon/browser keys can read nothing; only the
   service key below can touch the row. Your tasks are never public.)
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
3. Deploy → open the new URL → ⚙ Settings → Cloud sync → paste `ZT_TOKEN`’s
   value (service → **Environment** tab) → **Apply & sync now**.
4. Phone: same URL + passkey. Done — data now survives restarts, redeploys and
   cleared browsers.

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

- The passkey (`ZT_TOKEN`) is the only lock on your data. Make it long and random,
  and **never deploy with `ZT_OPEN=1` on the public internet** — that disables auth.
- Always use the `https://` URL so the passkey and tasks aren't sent in clear text.
- This is one shared list (no per-user accounts). Easy to extend later if you want
  multiple rooms/users.

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

## Test it (dev)

```bash
node server/test.mjs         # server: auth, merge, tombstones, replace, persistence, SSE
node server/test-client.mjs  # runs the real public/cloud.js against a live server
```
