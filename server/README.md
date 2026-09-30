# Collaborative Code Editor — server

One [Cloudflare Worker](https://developers.cloudflare.com/workers/) that runs the
**whole app on the free plan**: it serves the built web client, the REST API
(auth + rooms) and the real-time collaboration WebSockets from a single origin.
No Render, no separate Node collab server, no always-on VM.

| Concern | How it's handled | Free-tier fit |
| --- | --- | --- |
| Static site | Worker Assets serves `../web/dist` | Unlimited static requests |
| Auth + rooms API | Hono routes in `src/index.ts` | 100k Worker requests/day |
| Users / rooms data | **D1** (SQLite) — `migrations/` | 5 GB, 5M reads/day |
| Realtime collab | **Durable Object** per room (`src/room.ts`, `y-partyserver`) | SQLite-backed DO, included on free plan |
| Doc persistence | Each room's `Y.Doc` saved in its DO's own SQLite | — |

The client talks to `/api/*` and `/parties/*` on its own origin, so there is no
CORS config and nothing to keep awake.

## Layout

```
src/index.ts   Worker entry: Hono API + routes /parties/* to the Room DO
src/room.ts    Room Durable Object: holds the Y.Doc, syncs + persists it
src/auth.ts    PBKDF2 password hashing + HS256 JWTs (jose)
migrations/    D1 schema (users, rooms, room_members, rate_limits)
wrangler.jsonc Bindings: DB (D1), Room (Durable Object), static assets
```

## Local development

```bash
# 1. Install deps (once) in both packages
cd server && npm install
cd ../web && npm install

# 2. Local secret for the Worker
cd ../server
cp .dev.vars.example .dev.vars      # JWT_SECRET for `wrangler dev`

# 3. Create the local D1 tables
npm run db:migrate:local

# 4. Run the Worker (API + WebSockets) on :8787
npm run dev
```

Then in a second terminal run the client with hot reload:

```bash
cd web && npm run dev               # http://127.0.0.1:1420
```

`web/vite.config.ts` proxies `/api` and `/parties` to the Worker on `:8787`, so
the dev setup is same-origin exactly like production. (You can also skip Vite and
just open `http://127.0.0.1:8787` — the Worker serves the last `web/dist` build.)

## Deploy to Cloudflare (free)

You need a free Cloudflare account. One-time setup:

```bash
cd server
npx wrangler login

# 1. Create the production D1 database, then paste the printed id
#    into wrangler.jsonc -> d1_databases[0].database_id
npx wrangler d1 create collab-db

# 2. Apply the schema to the remote database
npm run db:migrate:remote

# 3. Set the production JWT signing secret (use a long random string)
npx wrangler secret put JWT_SECRET
```

Then, for every release:

```bash
# 4. Build the web client — wrangler.jsonc serves web/dist as static assets
cd ../web && npm run build

# 5. Ship the Worker + the freshly built site
cd ../server && npm run deploy
```

`wrangler deploy` prints the live URL (`https://collab-code-editor.<account>.workers.dev`).
That single URL serves the site, the API and the collaboration sockets. To use a
custom domain, add a route in the Cloudflare dashboard — no code change needed.

## How auth reaches the collaboration layer

1. Client logs in via `/api/auth/*` and stores the returned JWT.
2. It opens `wss://<origin>/parties/room/<roomId>?token=<jwt>`.
3. `authorizeSocket` (in `index.ts`) verifies the JWT **and** that the user is a
   member of that room in D1 before the socket reaches the Durable Object. It
   strips any client-supplied `x-collab-*` headers and injects trusted identity
   headers (user id, display name, host id) so a client can't impersonate anyone.
4. The `Room` DO enforces roles/permissions on the shared `Y.Doc`: viewers can't
   mutate protected room state, and host-only maps are reverted from a trusted
   snapshot if a non-host touches them.

Verified handshake behaviour: valid member → `101` upgrade; missing/bad token →
`401`; valid token but not a room member → `403`.

## Config reference

| Binding / var | Where | Purpose |
| --- | --- | --- |
| `DB` | `wrangler.jsonc` d1_databases | Users, rooms, membership, rate limits |
| `Room` | `wrangler.jsonc` durable_objects | One collaboration doc per room |
| `JWT_SECRET` | `.dev.vars` locally / `wrangler secret` in prod | Signs & verifies auth tokens |
| `assets.directory` | `wrangler.jsonc` | Points at `../web/dist` (build first) |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `wrangler dev` — Worker + API + WebSockets on `:8787` |
| `npm run deploy` | Build already done in `web/`; deploy the Worker |
| `npm run db:migrate:local` | Apply migrations to the local D1 |
| `npm run db:migrate:remote` | Apply migrations to the production D1 |
| `npm run typecheck` | `tsc --noEmit` |
