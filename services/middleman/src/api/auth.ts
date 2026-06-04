import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Db } from "../db/index.js";
import { countUsers, createUser, findUserByEmail, findUserById } from "../db/users.js";
import {
  createPersonalToken,
  createSession,
  deleteSession,
  listPersonalTokens,
  revokePersonalToken,
} from "../db/sessions.js";
import { recordAudit } from "../db/audit.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { SESSION_COOKIE, resolvePrincipal, isAuthenticatedUser } from "../auth/principal.js";

type Options = {
  db: Db;
  apiToken: string | undefined;
  /**
   * Set true in production (over HTTPS). In dev (vite proxy) cookies need
   * Secure off so the browser sends them on http://localhost.
   */
  secureCookies: boolean;
  /**
   * If true, allow `POST /api/auth/register` to create a user without an
   * existing admin. Use for bootstrapping the first user. After the first
   * signup, only admins (admin_token) can create further users.
   * Default: true (since teams are tiny and self-registration matches the
   * "trusted team" trust model).
   */
  allowSelfSignup: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSessionCookie(reply: FastifyReply, id: string, secure: boolean, maxAgeMs: number): void {
  reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  });
}

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function makeAuthApi(opts: Options): FastifyPluginAsync {
  const { db, apiToken, secureCookies, allowSelfSignup } = opts;

  return async (app) => {
    /** Probe used by the web client to verify a token. Reaches this handler
     *  only when the global `onRequest` hook accepted the request. */
    app.get("/api/auth/ping", async (request) => {
      const p = await resolvePrincipal(db, request, apiToken);
      return { ok: true, principal: p ? p.kind : null };
    });

    /** Bootstrap signup (first user) or admin-invoked signup. */
    app.post<{ Body: { email?: string; password?: string } }>(
      "/api/auth/register",
      async (request, reply) => {
        const { email, password } = request.body ?? {};
        if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
          return reply.status(400).send({ error: "bad_request", message: "email is required and must look like an email" });
        }
        if (!password || typeof password !== "string" || password.length < 8) {
          return reply.status(400).send({ error: "bad_request", message: "password must be at least 8 characters" });
        }

        const principal = await resolvePrincipal(db, request, apiToken);
        const hasAnyUser = countUsers(db) > 0;
        const isAdmin = principal?.kind === "admin_token";
        if (hasAnyUser && !isAdmin && !allowSelfSignup) {
          return reply.status(403).send({ error: "forbidden", message: "registration is closed; ask an admin to invite you" });
        }

        if (findUserByEmail(db, email)) {
          return reply.status(409).send({ error: "conflict", message: "a user with that email already exists" });
        }
        const hash = await hashPassword(password);
        const user = createUser(db, email, hash);
        recordAudit(db, {
          userId: user.id,
          action: "auth.register",
          targetKind: "user",
          targetId: user.id,
          detail: { byAdmin: isAdmin },
        });

        // First-user signup auto-logs in for friendly UX.
        const session = createSession(db, user.id, SESSION_TTL_MS);
        setSessionCookie(reply, session.id, secureCookies, SESSION_TTL_MS);
        return { ok: true, user: { id: user.id, email: user.email } };
      },
    );

    app.post<{ Body: { email?: string; password?: string } }>(
      "/api/auth/login",
      async (request, reply) => {
        const { email, password } = request.body ?? {};
        if (!email || typeof email !== "string" || !password || typeof password !== "string") {
          return reply.status(400).send({ error: "bad_request", message: "email and password are required" });
        }
        const user = findUserByEmail(db, email);
        if (!user) {
          // Run a verify against a dummy hash to avoid timing leaks.
          await verifyPassword(password, "scrypt$16384$00$00");
          return reply.status(401).send({ error: "unauthorized", message: "invalid email or password" });
        }
        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
          return reply.status(401).send({ error: "unauthorized", message: "invalid email or password" });
        }
        const session = createSession(db, user.id, SESSION_TTL_MS);
        setSessionCookie(reply, session.id, secureCookies, SESSION_TTL_MS);
        recordAudit(db, { userId: user.id, action: "auth.login" });
        return { ok: true, user: { id: user.id, email: user.email } };
      },
    );

    app.post("/api/auth/logout", async (request, reply) => {
      const p = await resolvePrincipal(db, request, apiToken);
      if (p?.kind === "session") {
        deleteSession(db, p.sessionId);
        recordAudit(db, { userId: p.userId, action: "auth.logout" });
      }
      clearSessionCookie(reply, secureCookies);
      return { ok: true };
    });

    app.get("/api/auth/me", async (request, reply) => {
      const p = await resolvePrincipal(db, request, apiToken);
      if (!isAuthenticatedUser(p)) {
        if (p?.kind === "admin_token") {
          return { ok: true, principal: "admin_token" as const };
        }
        return reply.status(401).send({ error: "unauthorized" });
      }
      const user = findUserById(db, p.userId);
      if (!user) {
        return reply.status(404).send({ error: "not_found" });
      }
      return { ok: true, principal: p.kind, user: { id: user.id, email: user.email } };
    });

    /* ----- personal access tokens (IDE clients) ------------------------ */

    app.post<{ Body: { label?: string } }>("/api/auth/personal-tokens", async (request, reply) => {
      const p = await resolvePrincipal(db, request, apiToken);
      if (!isAuthenticatedUser(p)) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const label = (request.body?.label ?? "").trim() || "untitled";
      const result = createPersonalToken(db, p.userId, label);
      recordAudit(db, { userId: p.userId, action: "pat.create", targetKind: "personal_token", targetId: result.row.id, detail: { label } });
      return { ok: true, token: result.raw, id: result.row.id, label };
    });

    app.get("/api/auth/personal-tokens", async (request, reply) => {
      const p = await resolvePrincipal(db, request, apiToken);
      if (!isAuthenticatedUser(p)) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      return { ok: true, tokens: listPersonalTokens(db, p.userId) };
    });

    app.delete<{ Params: { id: string } }>("/api/auth/personal-tokens/:id", async (request, reply) => {
      const p = await resolvePrincipal(db, request, apiToken);
      if (!isAuthenticatedUser(p)) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const ok = revokePersonalToken(db, p.userId, request.params.id);
      if (!ok) {
        return reply.status(404).send({ error: "not_found" });
      }
      recordAudit(db, { userId: p.userId, action: "pat.revoke", targetKind: "personal_token", targetId: request.params.id });
      return { ok: true };
    });
  };
}
