import path from "node:path/posix";
import type { FastifyPluginAsync } from "fastify";
import { requireConnectionAccess } from "../auth/connectionAccess.js";
import { resolvePrincipal, type Principal } from "../auth/principal.js";
import { sealSecret, secretsConfigured, unsealSecret } from "../auth/secrets.js";
import {
  addMember,
  createConnectionRow,
  deleteConnectionRow,
  findConnectionById,
  listConnectionsForUser,
  listMembers,
  removeMember,
} from "../db/connections.js";
import type { Db } from "../db/index.js";
import { findUserByEmail, findUserById } from "../db/users.js";
import { recordAudit } from "../db/audit.js";
import { agentLog } from "../debugAgentLog.js";
import { evictAllForConnection, evictDocument } from "../documents/registry.js";
import {
  closeConnection,
  createRemoteEmptyFile,
  createSftpConnection,
  deleteRemoteFile,
  getConnection,
  listTree,
  readRemoteTextFile,
  registerExistingConnection,
  renameRemoteFile,
  writeRemoteTextFile,
} from "../ssh/registry.js";
import {
  getSshAuthSession,
  sessionOwner,
  startSshAuthSession,
  submitSshAuthResponses,
} from "../ssh/pendingAuth.js";
import { broadcastWsMessage } from "../ws/handler.js";

function parentDirOf(rel: string): string {
  const parent = path.dirname(rel);
  return parent === "." ? "" : parent;
}

function ownerUserId(principal: Principal): string | null {
  if (!principal) return null;
  if (principal.kind === "admin_token") return null;
  return principal.userId;
}

type Deps = {
  db: Db | null;
  apiToken: string | undefined;
  /**
   * When set (`CONDUIT_SECRET_KEY` env), the create flow seals the SSH
   * password/private-key into the DB so a subsequent `reopen` can revive the
   * SSH session without prompting the user again.
   */
  secretsKey?: string;
};

export function makeConnectionsApi(deps: Deps): FastifyPluginAsync {
  const { db, apiToken, secretsKey } = deps;
  const canSealSecrets = secretsConfigured(secretsKey);

  return async (app) => {
    /** List the caller's workspaces (DB-backed; admin sees none from here). */
    app.get("/api/connections", async (request, reply) => {
      if (!db) {
        return reply.send({ connections: [] });
      }
      const principal = await resolvePrincipal(db, request, apiToken);
      if (!principal) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      if (principal.kind === "admin_token") {
        return reply.send({ connections: [] });
      }
      const rows = listConnectionsForUser(db, principal.userId);
      return reply.send({
        connections: rows.map((r) => ({
          id: r.id,
          label: r.label,
          host: r.host,
          port: r.port,
          username: r.username,
          remotePath: r.remote_path,
          createdAt: r.created_at,
          isOwner: r.owner_user_id === principal.userId,
          isOpen: Boolean(getConnection(r.id)),
          // Owner can revive a closed workspace without a password when (a)
          // the server has a key configured and (b) a secret was stored at
          // create-time. Members can't (would need owner's secret).
          canRevive:
            canSealSecrets &&
            r.owner_user_id === principal.userId &&
            r.secret_kind !== "none" &&
            r.encrypted_secret != null,
        })),
      });
    });

    /** Reopen the SSH session for an existing DB row using the at-rest secret. */
    app.post<{ Params: { connectionId: string } }>(
      "/api/connections/:connectionId/reopen",
      async (request, reply) => {
        if (!db) return reply.status(400).send({ error: "no_database" });
        const { connectionId } = request.params;
        const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
        if (!access.ok) return;
        if (!access.row) return reply.status(404).send({ error: "unknown_connection" });
        // Only the owner can revive (the secret was sealed with their permission).
        if (
          access.principal &&
          access.principal.kind === "session" &&
          access.row.owner_user_id !== access.principal.userId
        ) {
          return reply.status(403).send({ error: "forbidden", message: "only the owner can reopen the SSH session" });
        }
        if (getConnection(connectionId)) {
          return reply.send({ ok: true, id: connectionId, alreadyOpen: true });
        }
        if (!canSealSecrets || access.row.secret_kind === "none" || !access.row.encrypted_secret) {
          return reply.status(400).send({
            error: "no_stored_secret",
            message: "this workspace has no stored secret; recreate it with a password to enable reopen",
          });
        }
        try {
          const plaintext = unsealSecret(access.row.encrypted_secret, secretsKey ?? "");
          if (!plaintext) {
            return reply.status(500).send({ error: "secret_unseal_failed" });
          }
          await createSftpConnection({
            label: access.row.label,
            host: access.row.host,
            port: access.row.port,
            username: access.row.username,
            remotePath: access.row.remote_path,
            password: access.row.secret_kind === "password" ? plaintext : undefined,
            privateKey: access.row.secret_kind === "private_key" ? plaintext : undefined,
            forceId: connectionId,
          });
          recordAudit(db, {
            userId: ownerUserId(access.principal),
            action: "connection.reopen",
            targetKind: "connection",
            targetId: connectionId,
          });
          return reply.send({ ok: true, id: connectionId, remoteRoot: access.row.remote_path });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.status(502).send({ error: "ssh_connection_failed", message });
        }
      },
    );

    app.post<{
      Body: {
        label?: string;
        host?: string;
        port?: number;
        username?: string;
        remotePath?: string;
        password?: string;
        privateKey?: string;
        /** When true, pause for keyboard-interactive prompts (Duo, OTP, etc.). */
        interactiveAuth?: boolean;
      };
    }>("/api/connections", async (request, reply) => {
      const principal = await resolvePrincipal(db, request, apiToken);
      // When the DB is wired up but no principal, refuse. (When db is null,
      // pre-Phase-2 behavior allows anyone in.)
      if (db && !principal) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const ownerId = ownerUserId(principal);
      // Admin token without a user → connection isn't owned by anybody and
      // won't appear in any user's list; that's fine for ops/dev.
      if (db && !ownerId) {
        // Admin path with DB: only allow if explicitly noted; otherwise just
        // make it in-memory without DB persistence.
      }

      const b = request.body ?? {};
      const label = typeof b.label === "string" && b.label.trim() !== "" ? b.label.trim() : "Untitled";
      const host = typeof b.host === "string" ? b.host.trim() : "";
      const username = typeof b.username === "string" ? b.username.trim() : "";
      const remotePath = typeof b.remotePath === "string" ? b.remotePath.trim() : "";
      const port = typeof b.port === "number" && Number.isFinite(b.port) ? Math.trunc(b.port) : 22;
      if (!host || !username || !remotePath) {
        return reply.status(400).send({ error: "host, username, and remotePath are required" });
      }
      if (port <= 0 || port > 65535) {
        return reply.status(400).send({ error: "invalid port" });
      }

      const connectInput = {
        label,
        host,
        port,
        username,
        remotePath,
        password: typeof b.password === "string" ? b.password : undefined,
        privateKey: typeof b.privateKey === "string" ? b.privateKey : undefined,
      };

      if (b.interactiveAuth) {
        const authSessionId = startSshAuthSession({
          input: connectInput,
          userId: ownerId,
          db,
          secretsKey,
        });
        return reply.status(202).send({ authSessionId, status: "connecting" });
      }

      try {
        const created = await createSftpConnection(connectInput);

        // Persist a DB row so the user can list / invite. When the server has
        // CONDUIT_SECRET_KEY configured, we also seal the password / private
        // key so a future restart can re-establish the SSH session via
        // POST /api/connections/:id/reopen.
        if (db && ownerId) {
          const password = typeof b.password === "string" ? b.password : "";
          const privateKey = typeof b.privateKey === "string" ? b.privateKey : "";
          let secretKind: "password" | "private_key" | "none" = "none";
          let sealed: Uint8Array | null = null;
          if (canSealSecrets) {
            if (privateKey.trim() !== "") {
              secretKind = "private_key";
              sealed = sealSecret(privateKey, secretsKey ?? "");
            } else if (password !== "") {
              secretKind = "password";
              sealed = sealSecret(password, secretsKey ?? "");
            }
          }
          const now = Date.now();
          db.prepare(
            `INSERT INTO connections
               (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(created.id, ownerId, label, host, port, username, remotePath, secretKind, sealed, now);
          db.prepare(
            "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
          ).run(created.id, ownerId, now);
          recordAudit(db, {
            userId: ownerId,
            action: "connection.create",
            targetKind: "connection",
            targetId: created.id,
            detail: { host, port, username, label, sealedSecret: sealed != null },
          });
        }

        return reply.send({
          id: created.id,
          label,
          remoteRoot: created.remoteRoot,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.warn({ err }, "createSftpConnection failed");
        return reply.status(502).send({ error: "ssh_connection_failed", message });
      }
    });

    /** Poll an in-progress interactive SSH auth session. */
    app.get<{ Params: { authSessionId: string } }>(
      "/api/connections/ssh-auth/:authSessionId",
      async (request, reply) => {
        const principal = await resolvePrincipal(db, request, apiToken);
        if (db && !principal) {
          return reply.status(401).send({ error: "unauthorized" });
        }
        const { authSessionId } = request.params;
        const owner = sessionOwner(authSessionId);
        if (owner === undefined) {
          return reply.status(404).send({ error: "not_found" });
        }
        const callerId = ownerUserId(principal);
        if (owner !== null && callerId !== owner && principal?.kind !== "admin_token") {
          return reply.status(403).send({ error: "forbidden" });
        }
        const status = getSshAuthSession(authSessionId);
        if (!status) {
          return reply.status(404).send({ error: "not_found" });
        }
        return reply.send(status);
      },
    );

    /** Submit keyboard-interactive responses (Duo option, OTP, etc.). */
    app.post<{ Params: { authSessionId: string }; Body: { answer?: string; responses?: string[] } }>(
      "/api/connections/ssh-auth/:authSessionId",
      async (request, reply) => {
        const principal = await resolvePrincipal(db, request, apiToken);
        if (db && !principal) {
          return reply.status(401).send({ error: "unauthorized" });
        }
        const { authSessionId } = request.params;
        const owner = sessionOwner(authSessionId);
        if (owner === undefined) {
          return reply.status(404).send({ error: "not_found" });
        }
        const callerId = ownerUserId(principal);
        if (owner !== null && callerId !== owner && principal?.kind !== "admin_token") {
          return reply.status(403).send({ error: "forbidden" });
        }
        const legacy = request.body?.responses;
        let answer = typeof request.body?.answer === "string" ? request.body.answer : "";
        if (!answer.trim() && Array.isArray(legacy)) {
          for (let i = legacy.length - 1; i >= 0; i--) {
            const v = String(legacy[i] ?? "").trim();
            if (v) {
              answer = v;
              break;
            }
          }
        }
        if (!String(answer).trim()) {
          return reply.status(400).send({ error: "bad_request", message: "answer is required" });
        }
        const result = submitSshAuthResponses(authSessionId, String(answer));
        if (!result.ok) {
          return reply.status(409).send({ error: result.reason, message: "session is not awaiting input" });
        }
        request.log.info(
          { authSessionId, answer: String(answer).trim(), responses: result.responses },
          "ssh keyboard-interactive response submitted",
        );
        return reply.send({ ok: true, responses: result.responses });
      },
    );

    app.get<{
      Params: { connectionId: string };
      Querystring: { path?: string };
    }>("/api/connections/:connectionId/tree", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      const known = Boolean(getConnection(connectionId));
      agentLog(
        "connections.ts:tree",
        "tree request",
        { connectionId, known },
        "H1",
      );
      if (!known) {
        return reply.status(404).send({ error: "unknown_connection", message: "the SSH session for this workspace is not open; please reconnect" });
      }
      const rel = typeof request.query.path === "string" ? request.query.path : "";
      try {
        const entries = await listTree(connectionId, rel);
        return reply.send({ path: rel, entries });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "not_a_directory") {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: "list_failed", message });
      }
    });

    app.get<{
      Params: { connectionId: string };
      Querystring: { path?: string };
    }>("/api/connections/:connectionId/file", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      const rel = typeof request.query.path === "string" ? request.query.path : "";
      if (rel === "") {
        return reply.status(400).send({ error: "path is required" });
      }
      try {
        const text = await readRemoteTextFile(connectionId, rel);
        return reply.send({ path: rel, text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "is_directory") {
          return reply.status(400).send({ error: message });
        }
        if (message === "file_too_large") {
          return reply.status(413).send({ error: message });
        }
        return reply.status(500).send({ error: "read_failed", message });
      }
    });

    app.put<{
      Params: { connectionId: string };
      Body: { path?: string; text?: string };
    }>("/api/connections/:connectionId/file", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      const b = request.body ?? {};
      const rel = typeof b.path === "string" ? b.path : "";
      const text = typeof b.text === "string" ? b.text : "";
      if (rel === "") {
        return reply.status(400).send({ error: "path is required" });
      }
      try {
        await writeRemoteTextFile(connectionId, rel, text);
        return reply.send({ ok: true, path: rel, bytes: text.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: "write_failed", message });
      }
    });

    app.post<{
      Params: { connectionId: string };
      Body: { path?: string };
    }>("/api/connections/:connectionId/files", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      const rel = typeof request.body?.path === "string" ? request.body.path.trim() : "";
      if (rel === "") {
        return reply.status(400).send({ error: "path is required" });
      }
      try {
        await createRemoteEmptyFile(connectionId, rel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "file_exists") {
          return reply.status(409).send({ error: message });
        }
        if (message === "unknown_connection") {
          return reply.status(404).send({ error: message });
        }
        return reply.status(500).send({ error: "create_failed", message });
      }
      if (db && access.principal && access.principal.kind !== "admin_token") {
        recordAudit(db, {
          userId: access.principal.userId,
          action: "file.create",
          targetKind: "file",
          targetId: rel,
          detail: { connectionId },
        });
      }
      broadcastWsMessage({ type: "tree_changed", connectionId, dir: parentDirOf(rel) });
      return reply.send({ ok: true, path: rel });
    });

    app.delete<{
      Params: { connectionId: string };
      Body: { path?: string };
    }>("/api/connections/:connectionId/files", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      const rel = typeof request.body?.path === "string" ? request.body.path.trim() : "";
      if (rel === "") {
        return reply.status(400).send({ error: "path is required" });
      }
      try {
        await deleteRemoteFile(connectionId, rel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "file_not_found") {
          return reply.status(404).send({ error: message });
        }
        if (message === "is_directory") {
          return reply.status(400).send({ error: message });
        }
        if (message === "unknown_connection") {
          return reply.status(404).send({ error: message });
        }
        return reply.status(500).send({ error: "delete_failed", message });
      }
      if (db && access.principal && access.principal.kind !== "admin_token") {
        recordAudit(db, {
          userId: access.principal.userId,
          action: "file.delete",
          targetKind: "file",
          targetId: rel,
          detail: { connectionId },
        });
      }
      evictDocument(connectionId, rel, "deleted");
      broadcastWsMessage({ type: "tree_changed", connectionId, dir: parentDirOf(rel) });
      return reply.send({ ok: true, path: rel });
    });

    app.post<{
      Params: { connectionId: string };
      Body: { from?: string; to?: string };
    }>("/api/connections/:connectionId/files/rename", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      const from = typeof request.body?.from === "string" ? request.body.from.trim() : "";
      const to = typeof request.body?.to === "string" ? request.body.to.trim() : "";
      if (from === "" || to === "") {
        return reply.status(400).send({ error: "from and to are required" });
      }
      if (from === to) {
        return reply.status(400).send({ error: "same_path" });
      }
      try {
        await renameRemoteFile(connectionId, from, to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "file_not_found") {
          return reply.status(404).send({ error: message });
        }
        if (message === "target_exists") {
          return reply.status(409).send({ error: message });
        }
        if (message === "is_directory" || message === "same_path") {
          return reply.status(400).send({ error: message });
        }
        if (message === "unknown_connection") {
          return reply.status(404).send({ error: message });
        }
        return reply.status(500).send({ error: "rename_failed", message });
      }
      if (db && access.principal && access.principal.kind !== "admin_token") {
        recordAudit(db, {
          userId: access.principal.userId,
          action: "file.rename",
          targetKind: "file",
          targetId: from,
          detail: { connectionId, to },
        });
      }
      evictDocument(connectionId, from, "renamed");
      const fromDir = parentDirOf(from);
      const toDir = parentDirOf(to);
      broadcastWsMessage({ type: "tree_changed", connectionId, dir: fromDir });
      if (toDir !== fromDir) {
        broadcastWsMessage({ type: "tree_changed", connectionId, dir: toDir });
      }
      return reply.send({ ok: true, from, to });
    });

    app.delete<{
      Params: { connectionId: string };
    }>("/api/connections/:connectionId", async (request, reply) => {
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      // Only the owner (or admin) may delete the connection outright.
      if (db && access.row && access.principal && access.principal.kind === "session") {
        if (access.row.owner_user_id !== access.principal.userId) {
          return reply.status(403).send({ error: "forbidden", message: "only the owner can delete this workspace" });
        }
      }
      evictAllForConnection(connectionId);
      const closed = await closeConnection(connectionId);
      if (db && access.row) {
        deleteConnectionRow(db, connectionId);
        recordAudit(db, {
          userId: ownerUserId(access.principal),
          action: "connection.delete",
          targetKind: "connection",
          targetId: connectionId,
        });
      }
      if (!closed && !access.row) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      return reply.send({ ok: true });
    });

    /* ----- member management (invite flow) ------------------------------ */

    app.get<{ Params: { connectionId: string } }>(
      "/api/connections/:connectionId/members",
      async (request, reply) => {
        if (!db) return reply.send({ members: [] });
        const { connectionId } = request.params;
        const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
        if (!access.ok) return;
        const rows = listMembers(db, connectionId);
        const enriched = rows.map((m) => {
          const user = findUserById(db, m.user_id);
          return {
            userId: m.user_id,
            email: user?.email ?? "(deleted)",
            role: m.role,
          };
        });
        return reply.send({ members: enriched });
      },
    );

    app.post<{
      Params: { connectionId: string };
      Body: { email?: string };
    }>("/api/connections/:connectionId/members", async (request, reply) => {
      if (!db) return reply.status(400).send({ error: "no_database" });
      const { connectionId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      // Only owner can invite.
      if (access.row && access.principal && access.principal.kind === "session" && access.row.owner_user_id !== access.principal.userId) {
        return reply.status(403).send({ error: "forbidden", message: "only the owner can invite members" });
      }
      const email = (request.body?.email ?? "").trim();
      if (!email) {
        return reply.status(400).send({ error: "bad_request", message: "email is required" });
      }
      const user = findUserByEmail(db, email);
      if (!user) {
        return reply.status(404).send({ error: "user_not_found", message: "no Conduit user with that email; ask them to register first" });
      }
      addMember(db, connectionId, user.id, "member");
      recordAudit(db, {
        userId: ownerUserId(access.principal),
        action: "member.add",
        targetKind: "connection",
        targetId: connectionId,
        detail: { invitedUserId: user.id, email },
      });
      return reply.send({ ok: true, member: { userId: user.id, email: user.email, role: "member" } });
    });

    app.delete<{
      Params: { connectionId: string; userId: string };
    }>("/api/connections/:connectionId/members/:userId", async (request, reply) => {
      if (!db) return reply.status(400).send({ error: "no_database" });
      const { connectionId, userId } = request.params;
      const access = await requireConnectionAccess(db, request, reply, apiToken, connectionId);
      if (!access.ok) return;
      // Owner can remove anyone, members can remove themselves (leave).
      if (
        access.row &&
        access.principal &&
        access.principal.kind === "session" &&
        access.row.owner_user_id !== access.principal.userId &&
        access.principal.userId !== userId
      ) {
        return reply.status(403).send({ error: "forbidden" });
      }
      // Refuse to remove the owner via this endpoint.
      const row = findConnectionById(db, connectionId);
      if (row && row.owner_user_id === userId) {
        return reply.status(400).send({ error: "cannot_remove_owner", message: "delete the workspace instead" });
      }
      removeMember(db, connectionId, userId);
      recordAudit(db, {
        userId: ownerUserId(access.principal),
        action: "member.remove",
        targetKind: "connection",
        targetId: connectionId,
        detail: { removedUserId: userId },
      });
      return reply.send({ ok: true });
    });
  };
}

// Back-compat default export for tests that import without deps (no DB / no auth).
const noopApi: FastifyPluginAsync = makeConnectionsApi({ db: null, apiToken: undefined });
export default noopApi;
