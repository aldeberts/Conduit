import type { FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { findValidSession } from "../db/sessions.js";
import { findUserByPersonalToken } from "../db/sessions.js";
import { extractToken, extractTokenFromQuery } from "../auth.js";

export type Principal =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "personal_token"; userId: string }
  | { kind: "admin_token" } // shared `API_TOKEN` env -- bypasses tenancy checks; used for ops + dev
  | null;

export const SESSION_COOKIE = "conduit_session";

/**
 * Resolves the caller in priority order:
 *   1. Session cookie (browser)
 *   2. Bearer token / `?token=` -> personal access token (IDE)
 *   3. Bearer token / `?token=` -> matches `API_TOKEN` -> admin
 *
 * The web client always uses (1) after login. The Phase 1 paste-the-token UX
 * still works via (3).
 */
export async function resolvePrincipal(
  db: Db | null,
  request: FastifyRequest,
  apiToken: string | undefined,
): Promise<Principal> {
  // (1) session cookie
  const cookie =
    typeof request.cookies === "object"
      ? request.cookies?.[SESSION_COOKIE]
      : undefined;
  if (cookie && db) {
    const session = findValidSession(db, cookie);
    if (session) {
      return { kind: "session", userId: session.user_id, sessionId: session.id };
    }
  }

  // (2) + (3) header / query token
  const raw =
    extractToken(request) ?? extractTokenFromQuery(request.query as Record<string, unknown>);
  if (raw) {
    if (db) {
      const userId = findUserByPersonalToken(db, raw);
      if (userId) {
        return { kind: "personal_token", userId };
      }
    }
    if (apiToken && raw === apiToken) {
      return { kind: "admin_token" };
    }
  }

  return null;
}

/** Convenience: extracts the userId for a principal, or null for admin/none. */
export function userIdOf(p: Principal): string | null {
  if (!p) return null;
  if (p.kind === "admin_token") return null;
  return p.userId;
}

/** True when the principal can do tenancy-scoped work (member of a workspace). */
export function isAuthenticatedUser(p: Principal): p is
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "personal_token"; userId: string } {
  return !!p && (p.kind === "session" || p.kind === "personal_token");
}
