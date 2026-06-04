# Conduit protocol

This document is the contract between Conduit clients (the web app, the VS Code
extension, future IDE plugins) and the Conduit middleman server. Anything not
documented here is an implementation detail and may change without notice.

The TypeScript source of truth for the message types lives in
[packages/shared/src/ws.ts](../packages/shared/src/ws.ts) — when in doubt, that
file wins.

---

## Versioning

There is no explicit version field today. Backwards-compatible additions are
landed by extending the union types in `packages/shared`. Breaking changes will
introduce a `protocolVersion` query parameter on the WebSocket upgrade.

The reference client lives in [packages/client](../packages/client/). If you
are writing a new client, `import { ConduitClient } from "@conduit/client"`
gets you a working transport without touching the wire format.

---

## Transports

### HTTP/REST

All endpoints are JSON. Base URL is the server origin (e.g.
`https://conduit.example.com`).

### WebSocket

A single WebSocket per browser tab / IDE process at `wss://<host>/api/ws`.
Messages are JSON strings; each carries a `type` discriminator.

Binary frames are not used. Large Yjs payloads are base64-encoded inside the
JSON `update` field.

---

## Authentication

Three accepted credentials, in priority order. The first one that resolves
wins.

| # | Credential                     | How sent (HTTP)                         | How sent (WS)            | Audience           |
| - | ------------------------------ | --------------------------------------- | ------------------------ | ------------------ |
| 1 | Session cookie                 | `Cookie: conduit_session=…`             | same (browser auto)      | Web browser tabs   |
| 2 | Personal access token (PAT)    | `Authorization: Bearer conduit_pat_…`   | `?token=conduit_pat_…`   | IDE / SDK clients  |
| 3 | Admin token (`API_TOKEN` env)  | `Authorization: Bearer <token>`         | `?token=<token>`         | Ops / recovery     |

Public endpoints (no auth required):

- `GET /health`
- `POST /api/auth/login`
- `POST /api/auth/register` (only when `ALLOW_SELF_SIGNUP=true` or no users yet)
- `POST /api/auth/logout`

Everything else returns `401 {"error":"unauthorized"}` if no principal matches.

### Auth API

```
POST /api/auth/register   { email, password }            -> 200 + Set-Cookie
POST /api/auth/login      { email, password }            -> 200 + Set-Cookie
POST /api/auth/logout                                    -> 200 + Clear-Cookie
GET  /api/auth/me                                        -> { principal, user? }
GET  /api/auth/ping                                      -> 200 (gated)
POST /api/auth/personal-tokens   { label }               -> { token, id, label }
GET  /api/auth/personal-tokens                           -> { tokens: [...] }
DELETE /api/auth/personal-tokens/:id                     -> 200
```

PATs are shown to the user **exactly once** at issuance time; only their
sha256 is stored.

---

## Connections (workspaces)

A "connection" is a workspace bound to one SFTP target on one remote host.

```
GET    /api/connections                        -> { connections: ServerConnection[] }
POST   /api/connections                        -> create + open SSH; { id, label, remoteRoot }
DELETE /api/connections/:id                    -> close + delete (owner only)
POST   /api/connections/:id/reopen             -> revive after middleman restart (needs sealed secret)
GET    /api/connections/:id/members            -> { members: ConnectionMember[] }
POST   /api/connections/:id/members  { email } -> invite (owner only)
DELETE /api/connections/:id/members/:userId    -> remove (owner can remove anyone; member can leave)
```

`ServerConnection`:

```ts
{
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  createdAt: number;        // unix ms
  isOwner: boolean;
  isOpen: boolean;          // true if the SFTP session is currently live in middleman memory
  canRevive: boolean;       // true if a sealed secret is on disk → reopen will work
}
```

Tenancy is enforced on every connection-scoped call: callers must be a member
of the workspace (or the admin token).

---

## File system

All paths are POSIX, relative to the workspace `remotePath` root. Absolute or
`..`-containing paths are rejected.

```
GET    /api/connections/:id/tree?path=...      -> { path, entries: TreeEntry[] }
GET    /api/connections/:id/file?path=...      -> { path, text }
PUT    /api/connections/:id/file               -> { path, text }
POST   /api/connections/:id/files              -> create empty file at path
DELETE /api/connections/:id/files              -> delete file at path
POST   /api/connections/:id/files/rename       -> { from, to }
```

Tree entries:

```ts
{ name: string; path: string; type: "file" | "dir" }
```

Editing flow:

```
POST /api/connections/:id/documents/open      { path }    -> DocumentState
POST /api/connections/:id/documents/close     { path }
```

`DocumentState` is the read-only HTTP shadow of the Y.Doc — fine for "show the
text once" UX, but most clients should drive edits over the WebSocket because
that's where presence + collab updates live.

---

## WebSocket protocol

Connect: `GET wss://host/api/ws[?token=…]`. The server emits binary close
codes:

| Code | Reason          | Meaning                                            |
| ---- | --------------- | -------------------------------------------------- |
| 4401 | `unauthorized`  | Neither cookie nor token matched a principal.      |
| 1000 | `client_destroyed` | Client called `ConduitClient.destroy()` gracefully. |

### Client → server

```ts
type WsClientMessage =
  | { type: "subscribe";   connectionId: string; path: string }
  | { type: "unsubscribe"; connectionId: string; path: string }
  | { type: "sync";        connectionId: string; path: string; update: string /* base64 Yjs */ }
  | { type: "awareness";   connectionId: string; path: string; update: string /* base64 y-protocols */ }
  | { type: "save";        connectionId: string; path: string }
  | { type: "refresh";     connectionId: string; path: string; force: boolean }
  | { type: "pty_subscribe";   connectionId: string }
  | { type: "pty_unsubscribe"; connectionId: string }
  | { type: "pty_input";       connectionId: string; data: string }
  | { type: "pty_resize";      connectionId: string; cols: number; rows: number };
```

### Server → client

```ts
type WsServerMessage =
  | { type: "subscribed";   connectionId: string; path: string; update: string; revision: number; dirty: boolean }
  | { type: "update";       connectionId: string; path: string; update: string; revision: number; dirty: boolean }
  | { type: "state";        connectionId: string; path: string; revision: number; dirty: boolean }
  | { type: "awareness";    connectionId: string; path: string; update: string }
  | { type: "op_result";    connectionId: string; path: string; op: "save"|"refresh"; ok: boolean; error?: string }
  | { type: "doc_evicted";  connectionId: string; path: string; reason: "deleted"|"renamed"|"evicted" }
  | { type: "pty_subscribed"; connectionId: string }
  | { type: "pty_output";   connectionId: string; data: string }
  | { type: "tree_changed"; connectionId: string; dir: string }
  | { type: "error";        message: string };
```

### Processing rules

- **Per-socket serial queue.** The server processes each socket's messages in
  arrival order; the *async* work for each message runs to completion before
  the next message starts. Clients can issue `sync` → `save` back-to-back and
  the save is guaranteed to see the post-sync state.
- **Subscriptions are per (connectionId, path).** Re-`subscribe`-ing for the
  same path replaces the prior subscription id and re-hydrates with a fresh
  snapshot. The new subscriber also receives any cached awareness states.
- **Awareness updates** are fanned out to other subscribers of the same
  `(connectionId, path)` and are cached server-side so late joiners see the
  current cursors without waiting for the y-protocols 30s self-renew.
- **`tree_changed`** is broadcast to *every* connected socket. Clients filter
  by `connectionId` themselves.
- **`error`** can arrive at any time. Treat it as a hint that the *current
  request* failed; the socket remains open.

---

## Example session (IDE client)

```ts
import { ConduitClient } from "@conduit/client";
import WS from "ws";

const client = new ConduitClient({
  baseUrl: "https://conduit.example.com",
  token: "conduit_pat_…",
  webSocketFactory: (url) => new WS(url) as any,
});

const conns = await client.listConnections();
const doc = await client.openDocument(conns[0].id, "src/main.ts", {
  initialAwareness: { user: { name: "alice", color: "#a6e3a1" } },
});
await doc.ready();

// Bind doc.ydoc to your editor (y-monaco, y-codemirror.next, ...).
// Bind doc.awareness for remote cursors.

doc.save();
doc.onOpResult((op, ok, err) => console.log(op, ok, err));

doc.close();
client.destroy();
```

---

## What's intentionally *not* in the protocol

- **File diffs.** Conduit is line-by-line CRDT, not patch-based; the server
  never asks "what changed" — it just relays Yjs updates.
- **Conflict resolution beyond Yjs.** When two tabs save the same dirty doc,
  the *last save wins* on disk. Yjs handles the in-memory merge.
- **Bulk transfers.** SFTP `put` of large binary files is not exposed; this
  is a text editing protocol.
- **Subscriptions for tree changes.** Right now `tree_changed` is broadcast
  to every connected socket; filtering is the client's job. A future version
  may introduce explicit per-workspace subscriptions if traffic gets noisy.
