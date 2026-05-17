# Conduit roadmap

This document captures the planned path from the current prototype toward the long-term goal: a **durable middleman** for collaborative remote development—**merged edits** with explicit **save → flush** to a real tree (remote over SFTP today), plus **shared PTY** and **IDE-grade clients** later.

## Current baseline (what exists today)

- **Middleman**: Fastify HTTP API; SSH/SFTP sessions (in-memory) for list/read/write; optional local `real_shadow` + `/dev/flush` using Yjs as a trivial merge demo; PTY stub.
- **Web lab**: Connection UI, file tree, **multi-tab** editor (CodeMirror + Catppuccin), saves go to the **real remote** over SFTP.
- **Not yet**: WebSocket/Yjs sync, persistence across restarts, auth/tenancy, IDE plugin, real PTY.

---

## Phase A — Server-side document model (“source of truth”) ✅ (implemented)

**Goal:** The middleman owns each open file as a **document** (metadata + buffer + dirty/revision), not only as pass-through SFTP on every read/write from the client.

**Implemented:** `services/middleman/src/documents/registry.ts` + `/api/connections/:id/documents/*` (open, get, patch, save, refresh, close, list). Web workspace uses these endpoints with debounced PATCH; save checks remote mtime/size for conflicts.

**Typical additions**

- A **document registry** keyed by `(connectionId, path)` (later: workspace + path).
- **Load**: SFTP read when a document is first opened or explicitly refreshed.
- **Edit**: Mutations go through the middleman (HTTP patch today; WebSocket/Yjs in Phase B).
- **Save**: Serialize current buffer → SFTP write; update last-flushed snapshot; clear dirty (optional **mtime/size** check to detect external changes).
- **Close / eviction**: TTL or explicit close when no client holds the doc.

**Outcome:** One place to attach collaboration, locking, audit, and IDE sync—without the browser being the sole keeper of truth.

---

## Phase B — Real-time collaboration (Yjs + WebSocket)

**Goal:** Multiple participants editing the same logical file with **merged** text (CRDT), then **save** flushes merged state to SFTP.

**Typical additions**

- WebSocket endpoint; **Yjs** `Y.Text` (or equivalent) per open document; binary/coded sync between clients and middleman.
- Editor binding (e.g. y-codemirror / CM6) in the web client; same protocol for IDE later.
- **Save** = Yjs snapshot → SFTP `writeFile` (replacing the current “textarea string” path).

**Outcome:** The core “collaborative remote buffer” product works end-to-end before IDE polish.

---

## Phase C — Durability and operations

**Goal:** Survive restarts and be deployable as a service.

**Typical additions**

- Persist Yjs updates or periodic snapshots + last flushed revision (disk/Redis/DB—TBD).
- **Auth**, workspace tenancy, secrets handling (no long-lived passwords in browser APIs long term).
- SSH via **agent / keys / broker**; TLS for HTTP/WS; metrics, logging, rate limits.

**Outcome:** Safe multi-user operation, not only a trusted local lab.

---

## Phase D — IDE integration

**Goal:** Same middleman protocol from **VS Code / Cursor / JetBrains** (or similar): open file, subscribe to updates, save through middleman.

**Typical additions**

- Stable API contract (WS + save + tree/list as needed); extension or LSP-adjacent client as appropriate.

**Outcome:** Professional editor on the same collaboration plane as the web lab.

---

## Phase E — Shared PTY

**Goal:** Multiplexed **shared terminal** on the real host (policy and security model TBD).

**Typical additions**

- `node-pty` (or SSH exec channel) in the middleman; input routing + broadcast output; session ACLs.

**Outcome:** Full “pair on files + terminal” experience.

---

## Phase F — Hardening and product fit

- Binary/large-file policy, conflict UX when disk changes underfoot, quotas, audit.

---

## Suggested sequencing

1. **Phase A** — server document registry + explicit load/save/refresh semantics.  
2. **Phase B** — Yjs + WebSocket + editor binding.  
3. **Phase C** — auth, persistence, SSH/TLS hardening (overlap with B where sensible).  
4. **Phase D** — IDE client.  
5. **Phase E** — PTY once file sync + save are stable.  
6. **Phase F** — ongoing.

**North-star milestone after A + B:** two clients (e.g. two browser tabs or browser + script) edit the same remote file through the middleman over Yjs; **Save** writes the merged result over SFTP.

---

## Related docs

- [README.md](README.md) — install, dev servers, smoke tests, browser workspace overview.
