# Collaborative Code Editor

A real-time, multi-user code editor that runs entirely in the browser — no
install. Open a room, share the join code, and everyone edits the same files
together with live cursors, chat, a shared file explorer, roles/permissions and
an in-browser code runner (JavaScript & Python).

Built with **Monaco + Yjs** on the front end and a single **Cloudflare Worker**
on the back end, so the collaboration works on Cloudflare's **free plan** — no
Render, no always-on server.

## Stack

```
web/       React 19 + TypeScript + Vite client (Monaco editor, Yjs collab)
server/    Cloudflare Worker: web hosting + REST API + realtime WebSockets
             - Hono API (auth + rooms), D1 (SQLite) for users/rooms
             - one Durable Object per room holds & persists the shared Y.Doc
```

Everything is served from one origin: the Worker hosts the built site
(`web/dist`), the `/api/*` endpoints and the `/parties/*` collaboration sockets.

> This started as a Tauri desktop app with a Django backend and a y-websocket
> server. That code has been removed; it's still in the git history (before
> commit `1acbbd23`). The app is now just **`web/` + `server/`**.

## Quick start (local)

```bash
# Worker (API + WebSockets) on http://127.0.0.1:8787
cd server
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev

# In a second terminal: the client with hot reload on http://127.0.0.1:1420
cd web
npm install
npm run dev
```

## Deploy free on Cloudflare

See **[`server/README.md`](server/README.md)** for the full walkthrough
(`wrangler login` → create D1 → set `JWT_SECRET` → `wrangler deploy`). One deploy
puts the site, the API and the realtime collaboration on a single free
`*.workers.dev` URL.
