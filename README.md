# Conduit

Durable **middleman** for collaborative remote dev: merged edits with **save → flush** to a real filesystem, and (later) a **shared PTY** on the real host.

This repo is a **TypeScript monorepo** (`npm` workspaces).

See **[ROADMAP.md](ROADMAP.md)** for the phased plan (document model → Yjs/WS → durability → IDE → PTY).

## Prerequisites

- Node.js **20+**

## Install

From the repo root:

```bash
npm install
```

## Browser workspace (SSH / SFTP lab UI)

Run **middleman** and the **web** dev server together. The web app proxies `/api` to middleman on **port 3333** (use the default `PORT` or adjust `services/web/vite.config.ts`).

```bash
npm run dev:all
```

Open `http://127.0.0.1:5174/`: enter an SSH command (e.g. `ssh ubuntu@your-host`), an **absolute remote path** to that folder, optional password or PEM key, then **Connect**. The sidebar lists the remote tree; open a file to edit and **Save** writes back over SFTP.

**Security:** credentials go to your **local** middleman only; sessions are in-memory until disconnect or server restart. Do not expose the middleman to the public internet without auth and TLS.

## Run the middleman (dev)

```bash
npm run dev
```

Optional env (see [`.env.example`](.env.example)):

```bash
PORT=3333 REAL_ROOT=./real_shadow npm run dev
```

## Document API (Phase A)

Open files are **owned by the middleman** (buffer, dirty flag, revision, remote mtime/size snapshot):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/connections/:id/documents/open` | Load from SFTP (or bump ref if already open) |
| `GET` | `/api/connections/:id/documents/one?path=` | Read current server document |
| `PATCH` | `/api/connections/:id/documents` | Update buffer (`{ path, content }`) |
| `POST` | `/api/connections/:id/documents/save` | Flush to SFTP (409 if disk changed) |
| `POST` | `/api/connections/:id/documents/refresh` | Reload from SFTP (`force` discards dirty) |
| `POST` | `/api/connections/:id/documents/close` | Release document |
| `GET` | `/api/connections/:id/documents` | List open documents |

The web UI opens documents over HTTP, then syncs edits over **WebSocket** (`/api/ws`) via **Yjs**. Legacy `GET/PUT .../file` still exists for scripts.

### WebSocket (Phase B)

Connect to `ws://127.0.0.1:3333/api/ws` (optional `?token=` if `API_TOKEN` is set). Messages: `subscribe`, `unsubscribe`, `sync` — see `@conduit/shared` types in `packages/shared/src/ws.ts`.

### Persistence & auth (Phase C)

- `DATA_DIR` — Yjs snapshots written under `./data/conduit` (default).
- `API_TOKEN` — when set, require `Authorization: Bearer <token>` (or `X-Conduit-Token`) on HTTP APIs; WebSocket uses **`?token=`** on the socket URL (the web app passes this automatically when `VITE_API_TOKEN` is set).
- Web: set `VITE_API_TOKEN` in `.env` (same value as `API_TOKEN`) so REST calls send `Authorization` and document sync adds `?token=` to `/api/ws`.

## Smoke test

Health:

```bash
curl -s http://127.0.0.1:3333/health
```

Dev flush (writes under `REAL_ROOT`):

```bash
curl -s -X POST http://127.0.0.1:3333/dev/flush \
  -H 'content-type: application/json' \
  -d '{"path":"demo/hello.txt","text":"hello from conduit"}'
```

## Packages

| Package | Role |
|--------|------|
| [`@conduit/shared`](packages/shared) | Cross-service types and constants. |
| [`@conduit/middleman`](services/middleman) | HTTP API: health, dev flush, SSH/SFTP, **server-owned documents** (`/api/connections/:id/documents/*`). |
| [`@conduit/web`](services/web) | Vite + React lab UI: connect over SSH, browse remote tree, edit text files. |

## Layout

- `services/middleman` — collaboration gateway process (REST + SFTP over SSH for the web UI).
- `services/web` — browser lab client (Vite + React).
- `packages/shared` — shared TypeScript surface between services.
- `real_shadow/` — default local target for on-save flushes (Phase 0).
