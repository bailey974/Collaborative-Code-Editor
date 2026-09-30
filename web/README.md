# Collaborative Code Editor — web client

React 19 + TypeScript + Vite. Monaco editor with real-time collaboration over
Yjs (`y-partyserver` client → the `server/` Cloudflare Worker).

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server on http://127.0.0.1:1420 (proxies `/api` and `/parties` to the Worker on :8787) |
| `npm run build` | Typecheck + build the static site into `dist/` (served by the Worker) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Preview the production build |

## Local development

Run the Worker first (`cd ../server && npm run dev`), then `npm run dev` here.
See [`../server/README.md`](../server/README.md) for the full setup and the
free Cloudflare deploy.

## Environment

Same-origin by default — no config needed. Overrides (mainly for pointing at a
Worker on another origin):

- `VITE_API_BASE_URL` — REST API base (default: same origin)
- `VITE_COLLAB_URL` — collaboration WebSocket origin (default: same origin)

All `VITE_*` values are baked into the public bundle, so never put secrets here.

## Structure

```
src/App.tsx            Routing (HashRouter), auth pages, API client, editor layout
src/collab/            Yjs session, presence, roles/permissions (CollabProvider.tsx)
src/components/        CodeEditor, FileExplorer, ChatPanel, PeoplePanel, TerminalPanel
src/runner/            In-browser JS/Python execution (replaces the desktop PTY)
```
