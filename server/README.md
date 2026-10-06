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

## Guest accounts

`POST /api/auth/guest` creates a throwaway account (`guest-xxxxxx@guest.invalid`,
no usable password) and returns a 1-day token, so visitors can try the app
without signing up. A daily Cron Trigger (`triggers.crons` in `wrangler.jsonc`,
free plan) deletes guests older than 2 days along with the rooms they host
(D1 rows and each room's Durable Object storage). Guest sign-ups are rate
limited per IP, and nobody can register an `@guest.invalid` email.

## Google Drive setup (free, optional)

Drive import/save runs entirely in the browser (the `drive.file` scope plus the
Google Picker), so the Worker only hands out two **public** values from
`GET /api/config`: an OAuth client id and a browser API key. They are not
secrets, so they live in `wrangler.jsonc` `vars` and ship with every deploy (CI
or manual) without a rebuild. While they're empty the Drive buttons are hidden.

Neither Google API costs anything and no billing account is needed:

1. https://console.cloud.google.com → create a project (skip billing).
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **Google Auth Platform → Branding**: app name + support email.
   **Audience**: External, then **Publish app** (In production). The app only
   asks for `drive.file`, a non-sensitive scope, so publishing needs no Google
   verification and anyone can sign in (Testing mode limits you to listed test
   users).
4. **Clients → Create client → Web application**. Authorised JavaScript origins:
   `https://collab-code-editor.<account>.workers.dev`, plus `http://127.0.0.1:1420`
   and `http://127.0.0.1:8787` for local dev. Copy the client id.
5. **APIs & Services → Credentials → Create credentials → API key**. Restrict it:
   *Websites* → `https://collab-code-editor.<account>.workers.dev/*` (and the
   local origins), *API restrictions* → Google Picker API. Then a copied key is
   useless on any other site.
6. Paste both into `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY`,
   commit, deploy. For local dev you can put the same two lines in `.dev.vars`.

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` | `wrangler.jsonc` vars (public) | Served by `/api/config`; enables Google Drive |
| `triggers.crons` | `wrangler.jsonc` | Daily guest-account cleanup |
| `assets.directory` | `wrangler.jsonc` | Points at `../web/dist` (build first) |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `wrangler dev` — Worker + API + WebSockets on `:8787` |
| `npm run deploy` | Build already done in `web/`; deploy the Worker |
| `npm run db:migrate:local` | Apply migrations to the local D1 |
| `npm run db:migrate:remote` | Apply migrations to the production D1 |
| `npm run typecheck` | `tsc --noEmit` |
