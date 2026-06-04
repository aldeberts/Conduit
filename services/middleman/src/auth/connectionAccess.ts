import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { findConnectionById, isMember, type ConnectionRow } from "../db/connections.js";
import { resolvePrincipal, type Principal } from "./principal.js";

export type AccessOk = {
  ok: true;
  principal: Principal;
  /**
   * Null when the caller is the admin token AND the connection row predates DB
   * persistence (i.e. created in pure-Phase-1 mode); the in-memory connection
   * is still usable, just without a member list.
   */
  row: ConnectionRow | null;
};

export type AccessDenied = {
  ok: false;
  status: number;
  error: string;
  message?: string;
};

/**
 * Returns `{ ok: true, principal, row }` when the caller may operate on
 * `connectionId`. Otherwise writes the appropriate 401/403/404 to `reply`
 * and returns `{ ok: false }`. Admin tokens always pass, even when the
 * connection has no DB row (graceful upgrade from Phase 1).
 */
export async function requireConnectionAccess(
  db: Db | null,
  request: FastifyRequest,
  reply: FastifyReply,
  apiToken: string | undefined,
  connectionId: string,
): Promise<AccessOk | AccessDenied> {
  const principal = await resolvePrincipal(db, request, apiToken);

  // No DB → no tenancy enforcement (Phase 1 mode).
  if (!db) {
    return { ok: true, principal, row: null };
  }

  if (!principal) {
    reply.status(401).send({ error: "unauthorized" });
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const row = findConnectionById(db, connectionId);

  // Admin token: allow regardless of row presence/membership.
  if (principal.kind === "admin_token") {
    return { ok: true, principal, row };
  }

  if (!row) {
    // No row in the DB at all. Either the connection id is bogus, or it was
    // created in Phase 1 mode (no DB). Either way, a non-admin user shouldn't
    // be able to use it.
    reply.status(404).send({ error: "unknown_connection" });
    return { ok: false, status: 404, error: "unknown_connection" };
  }

  if (!isMember(db, connectionId, principal.userId)) {
    reply.status(403).send({ error: "forbidden", message: "you are not a member of this workspace" });
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, principal, row };
}
