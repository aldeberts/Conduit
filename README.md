# Conduit

Durable **middleman** for collaborative remote dev: merged edits with **save → flush** to a real filesystem, plus a shared terminal on the remote host.

This repo is a **TypeScript monorepo** (`npm` workspaces).

See **[ROADMAP.md](ROADMAP.md)** for the phased plan.

## AI-assisted development

A majority of this codebase was **generated with [Cursor](https://cursor.com)** (AI-assisted editing and agents), then **reviewed and tested** by hand—local dev, SSH/Duo flows, deploy scripts, and production smoke checks on [conduit.aldeneberts.com](https://conduit.aldeneberts.com). Treat generated code like any other contribution: run tests, try critical paths, and fix what breaks before you rely on it.

## Using Conduit at [conduit.aldeneberts.com](https://conduit.aldeneberts.com)

The hosted instance is a browser workspace backed by SSH/SFTP on your remote machines.

### Sign in

1. Open **https://conduit.aldeneberts.com**
2. **Register** the first time (one account per email), or **Sign in** if you already have an account.
3. You land on the **Dashboard** — your saved workspaces and whether each SSH session is active or closed.

Use **Log out** in the top bar when you are done.

### Open a remote workspace

1. On the dashboard, click **New connection** (or **Create your first connection** if the list is empty).
2. Fill in:
   - **SSH command** — e.g. `ssh ...` (optional `-p 2222` for a non-default port)
   - **Remote folder** — absolute path on the server, e.g. `/home/ajeberts/project`
   - **Password** — required for password + Duo hosts; not stored in the browser after connect
3. Click **Connect**.
4. If the host uses **Duo / 2FA**, a modal shows the same prompts as Terminal. Click **1. Duo Push** (or type the option number) and approve on your phone.
5. When connected, you are taken to the **workspace**: file tree, collaborative editor, terminal, and members panel.

### Dashboard actions

| Status | What to do |
|--------|------------|
| **Active** | Click the row to open the editor (SSH session is already open on the server). |
| **Closed · can reopen** | Click to reopen using credentials saved on the server (no password prompt). |
| **Closed** | Click to **Reconnect** — the form is pre-filled; enter your password (and Duo again if needed). |

In a workspace, **Disconnect** ends the SSH session and returns you to the dashboard; the workspace stays listed under **Past sessions** (use **Reopen** if credentials were saved). **Delete** on the dashboard removes the workspace entirely (owners only).

Owners can **Delete** a workspace from the server; that removes it for all members.

### Tips

- Passwords and private keys are sent only to the Conduit server for the SSH handshake; they are not kept in browser localStorage.
- If a workspace shows as closed after a server restart, use **Reconnect** or **Reopen** from the dashboard.
- For Stanford/Rice-style logins, use your normal SSH password; Duo is handled in the connect modal.

Server operators: see **[deploy/README.md](deploy/README.md)** for DigitalOcean/Caddy/systemd setup.

---

## Local development

### Prerequisites

- Node.js **20+**

### Install

```bash
npm install
```

### Run locally

Middleman (API + WebSocket) and the web UI together — the UI proxies `/api` to port **3333**:

```bash
npm run dev:all
```

Open **http://127.0.0.1:5174/**. Without `API_TOKEN` in the environment, auth is off and you go straight to the dashboard.

Optional env (see [`.env.example`](.env.example)):

```bash
PORT=3333 DATA_DIR=./data CONDUIT_SECRET_KEY=... npm run dev
```

With auth enabled (`API_TOKEN` set on the server), register/sign in at `/login` the same way as production.

### Local connect flow

1. **New connection** — SSH command, remote path, password or PEM key.
2. Browse the remote tree; open files to edit; **Save** writes over SFTP.
3. Edits sync over **WebSocket** (`/api/ws`) via **Yjs** when collaboration is active.

**Security:** do not expose an unauthenticated middleman to the public internet.

## Document API

Open files are owned by the middleman (buffer, dirty flag, revision, remote mtime/size):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/connections/:id/documents/open` | Load from SFTP |
| `GET` | `/api/connections/:id/documents/one?path=` | Read document |
| `PATCH` | `/api/connections/:id/documents` | Update buffer |
| `POST` | `/api/connections/:id/documents/save` | Flush to SFTP |
| `POST` | `/api/connections/:id/documents/refresh` | Reload from SFTP |
| `POST` | `/api/connections/:id/documents/close` | Release document |
| `GET` | `/api/connections/:id/documents` | List open documents |

WebSocket contract: [`docs/protocol.md`](docs/protocol.md).

## Smoke test

```bash
curl -s http://127.0.0.1:3333/health
```

## Packages

| Package | Role |
|--------|------|
| [`@conduit/shared`](packages/shared) | Cross-service types and constants |
| [`@conduit/client`](packages/client) | Browser/IDE client library |
| [`@conduit/middleman`](services/middleman) | HTTP API, SSH/SFTP, documents, auth, WebSocket |
| [`@conduit/web`](services/web) | Vite + React UI |

## Layout

- `services/middleman` — collaboration gateway (REST + SFTP over SSH)
- `services/web` — browser client
- `packages/shared`, `packages/client` — shared libraries
- `deploy/` — production deploy scripts and Caddy config
- `extensions/vscode/` — VS Code extension (dev install from folder)
