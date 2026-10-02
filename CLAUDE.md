# CLAUDE.md

Collaborative Code Editor: a real-time, multi-user code editor (Monaco + Yjs) with rooms, chat, a shared file explorer and an in-browser code runner. Originally a **Tauri desktop app** for a third-year university project (DCU CSC1049), now **a website that runs fully in the browser** and deploys free on Cloudflare.

The live app is **`web/` (client) + `server/` (Cloudflare Worker)**. Don't add Tauri or Rust code, and don't bring back the old Django `backend/`, `desktop/` shell or `collab-server/` (y-websocket) — they were the previous desktop/Render architecture and have been removed (they're only in git history).

## Repository layout

```
web/                React 19 + TypeScript + Vite client (was desktop/src)
  src/App.tsx         Routing (HashRouter), auth pages, API client, main editor layout
  src/collab/         Yjs session, presence, roles/permissions (CollabProvider.tsx is the core)
  src/components/     CodeEditor (Monaco + y-monaco), FileExplorer, TerminalPanel, ChatPanel, PeoplePanel
  src/runner/         In-browser code execution: JS in a Worker, Python via Pyodide (WASM)
server/             One Cloudflare Worker = the whole backend (free plan)
  src/index.ts        Hono REST API (auth + rooms) + routes /parties/* to the Room DO
  src/room.ts         Room Durable Object: holds, syncs and persists each room's Y.Doc
  src/auth.ts         PBKDF2 password hashing + HS256 JWTs (jose)
  migrations/         D1 (SQLite) schema: users, rooms, room_members, rate_limits
  wrangler.jsonc      Bindings: DB (D1), Room (Durable Object), static assets (../web/dist)
functional_requirements/, technical_specification/, user_manual/   Coursework PDFs, don't edit
```

## Commands

Client (`cd web`):
- `npm install`
- `npm run dev`: Vite dev server on http://127.0.0.1:1420 (proxies `/api` and `/parties` to the Worker on :8787)
- `npm run build`: typecheck + Vite build into `web/dist/` (the static site the Worker serves)
- `npm run typecheck`: `tsc --noEmit`

Server (`cd server`, Cloudflare Worker via Wrangler):
- `npm install`
- `cp .dev.vars.example .dev.vars` (sets `JWT_SECRET` for local dev)
- `npm run db:migrate:local`: apply D1 migrations to the local database
- `npm run dev`: `wrangler dev` — API + collaboration WebSockets on http://127.0.0.1:8787
- `npm run typecheck`: `tsc --noEmit`
- Deploy (free): see `server/README.md` — `wrangler login` → `wrangler d1 create` → `wrangler secret put JWT_SECRET` → `db:migrate:remote` → build `web/` → `npm run deploy`

## Architecture

One origin serves everything: the Worker hosts the built site (`web/dist`), the `/api/*` REST endpoints and the `/parties/*` collaboration sockets. No CORS, no Render, nothing to keep awake.

- **Auth:** the client POSTs to `/api/auth/login` or `/api/auth/register` (Hono, in `server/src/index.ts`) and stores the returned JWT access token in `localStorage`. Requests send `Authorization: Bearer <token>`. Passwords are PBKDF2-SHA256; tokens are HS256 signed with `JWT_SECRET` (`server/src/auth.ts`).
- **Rooms:** stored in **D1** (SQLite). `/api/rooms*` creates/lists/joins/leaves rooms and issues join codes; the host (`rooms.created_by`) can rename (`PATCH /api/rooms/:id`) or delete (`DELETE /api/rooms/:id`) a room. Both then call RPC methods on the Room DO (`rename` pushes the name into `room:meta`; `destroy` closes sockets with `room-deleted` and wipes its storage). The Yjs room name is the room's D1 id.
- **Real-time state:** a single `Y.Doc` per room lives in a **Durable Object** (`server/src/room.ts`, built on `y-partyserver`), which syncs it to every client and persists it to the DO's own SQLite storage. The doc holds file contents, room metadata, roles, visibility rules, per-doc permissions, edit and terminal requests, terminal policy and chat. Presence and cursors use awareness (`presenceStyles.ts`). Y.Doc key names are shared between `web/src/collab/CollabProvider.tsx` and `server/src/room.ts` — keep them in sync.
- **Collaboration auth:** the client opens `wss://<origin>/parties/room/<roomId>?token=<jwt>`. `authorizeSocket` in `index.ts` verifies the JWT **and** D1 room membership before the socket reaches the DO, strips any client-sent `x-collab-*` headers and injects trusted identity headers. The DO reverts host-only state from a trusted snapshot if a non-host touches it. (Verified: member→101, missing/bad token→401, non-member→403.)
- **Files:** per-room, stored in the Y.Doc (no host filesystem access). FileExplorer reads/writes through the shared doc.
- **Code runner (replaces the desktop PTY):** `web/src/runner/` runs the active file in the browser — JavaScript in a Web Worker, Python via Pyodide (CPython on WebAssembly, loaded from the jsDelivr CDN on first run). No server shell is ever spawned.

### Environment / config
Client (`web/`, all `VITE_*` are public in the bundle — no secrets): same-origin by default. `VITE_API_BASE_URL` and `VITE_COLLAB_URL` override the API and collaboration origins (mainly to point at a Worker on another host).

Server (`server/`): `JWT_SECRET` — from `.dev.vars` locally, `wrangler secret put JWT_SECRET` in production. Bindings `DB` (D1) and `Room` (Durable Object) are declared in `wrangler.jsonc`; replace the placeholder `database_id` there with the id from `wrangler d1 create`.

## Conventions

- TypeScript strict mode, React function components and hooks. Match the existing style in the file you edit.
- Shared/collaborative state goes in the Y.Doc (use the existing `Y_*` key constants in `CollabProvider.tsx` / `room.ts`), not in React state or `localStorage`.
- Server routes live under `/api/...` in `server/src/index.ts`; protect them with `requireAuth` unless a public endpoint is intended.
- Change the D1 schema by adding a numbered file under `server/migrations/`, then `db:migrate:local` / `:remote`. Never commit `.dev.vars` (real secrets) or `.wrangler/` local state.
- Don't commit `.venv/`, `node_modules/`, `dist/`, `__pycache__/`, `.dev.vars`, `.wrangler/` (see `.gitignore`).
- Remote: https://github.com/bailey974/Collaborative-Code-Editor (branch `main`; migration work on `web`).
