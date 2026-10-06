# Collaborative Code Editor

**▶ Live demo: https://collab-code-editor.bscanlan-scanlan8.workers.dev**
(click **Try it as a guest**, no sign-up) · **🎥 [Video walkthrough](https://youtu.be/J1WR-Pdam9M)**

A real-time, multi-user code editor that runs entirely in the browser. Create a
room, share the join code, and everyone edits the same files together. You get
live cursors, chat, a shared file explorer, roles and permissions, and a shared
terminal that **runs Python and JavaScript in the browser**.

> **Tip:** to see the collaboration on your own, open the room in two browser
> windows (or a normal and a private window) side by side.

<!-- Add a GIF of two windows editing together here: ![demo](docs/demo.gif) -->

## Features

- **Real-time co-editing**: Monaco (the VS Code editor) kept in sync with
  [Yjs](https://yjs.dev) CRDTs, so concurrent edits merge without conflicts and
  every collaborator's cursor and selection is shown in their own colour.
- **Rooms**: create a room, invite people with an 8-character join code. The
  host can rename or delete it. Rooms persist between sessions.
- **Roles & permissions**: host, editor and viewer roles; viewers can request
  edit access. Per-file and per-folder visibility rules, all enforced on the
  server as well as in the UI.
- **Shared terminal**: a small shell (`run main.py`, `python`, `node`, `ls`,
  `cat`). Python runs on [Pyodide](https://pyodide.org) (CPython compiled to
  WebAssembly) and JavaScript in a Web Worker, including interactive `input()`.
  Output is shared with the whole room, and no code ever runs on a server.
- **Shared file explorer**: create, rename, upload, download and delete files and
  folders, all stored in the room's shared document. Optional Google Drive
  import and save-back.
- **Chat and presence**: room chat plus a people panel showing who's online,
  their roles, and pending edit requests.
- **Accounts**: email/password sign-up, or one-click guest accounts that clean
  themselves up after 2 days.

## Architecture

```
 Browser (React 19 + TypeScript + Vite)            Cloudflare (free plan)
 ┌──────────────────────────────────┐     ┌──────────────────────────────────────┐
 │ Monaco ⇄ y-monaco ⇄ Y.Doc         │ wss │ Worker: authorizeSocket (JWT + D1    │
 │ awareness (cursors, presence)     │◄───►│   membership) → Room Durable Object  │
 │ Pyodide / Web Worker code runner  │     │   (one per room: syncs + persists    │
 │                                   │ /api│    the Y.Doc in its own SQLite)      │
 │ REST client (JWT in localStorage) │◄───►│ Hono REST API ⇄ D1 (users, rooms)    │
 └──────────────────────────────────┘     │ Static assets (the built site)       │
                                          └──────────────────────────────────────┘
```

One Cloudflare Worker serves the site, the REST API and the WebSockets from a
single origin, so there's no CORS and no server to keep awake. It all fits in
Cloudflare's free tier.

## Engineering highlights

- **Authorising WebSockets before they reach state.** The socket upgrade is
  checked in the Worker (JWT signature *and* room membership in D1). Any
  client-sent identity headers are stripped and trusted ones are injected, so a
  client can't pose as another user or as the host. Result: member → `101`,
  bad token → `401`, non-member → `403`.
- **Server-side permission enforcement on a CRDT.** A CRDT accepts any update by
  design, so the Room Durable Object keeps a trusted snapshot of host-only state
  (roles, visibility rules, policies) and reverts it if a non-host's update
  touches it.
- **No server-side code execution.** Running untrusted code on a shared server
  is expensive and risky. Instead, code runs in the browser of whoever types
  the command, and only the output is shared through the Y.Doc. Python
  `input()` works synchronously through Pyodide's JSPI support.
- **Free-tier, serverless deployment.** This replaced the original Tauri desktop
  app with a Django backend and a separate y-websocket server (see history
  below). CI builds and deploys on every push to `main`.
- **Security basics:** PBKDF2-SHA256 password hashing, HS256 JWTs with auto
  sign-out on expiry, and per-IP rate limiting on auth endpoints.

## Tech stack

**Frontend:** React 19, TypeScript (strict), Vite, Monaco Editor, Yjs, y-monaco,
Pyodide · **Backend:** Cloudflare Workers, Durable Objects (SQLite-backed), D1,
Hono, y-partyserver, jose · **Tooling:** Vitest, Wrangler, GitHub Actions

## Run it locally

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

Tests: `cd web && npm test`. Deploying your own copy for free is covered in
**[`server/README.md`](server/README.md)**, which also has the optional
Google Drive setup.

## Project history

Built as a third-year project for DCU (CSC1049) by Bailey Scanlan and Mai Hải,
originally as a Tauri desktop app with a Django backend and a y-websocket
server. I later rebuilt it as a browser app on Cloudflare so anyone can try it
from a link. The old desktop code is still in the git history (before commit
`1acbbd23`). The coursework documents are in `functional_requirements/`,
`technical_specification/` and `user_manual/`.
