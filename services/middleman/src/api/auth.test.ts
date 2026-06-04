import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { getDb, resetDbForTests } from "../db/index.js";
import { makeAuthApi } from "./auth.js";
import { resolvePrincipal } from "../auth/principal.js";
import { unauthorized } from "../auth.js";

async function buildApp(opts: {
  apiToken?: string;
  allowSelfSignup?: boolean;
} = {}): Promise<FastifyInstance> {
  resetDbForTests();
  const db = getDb(":memory:");
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(
    makeAuthApi({
      db,
      apiToken: opts.apiToken,
      secureCookies: false,
      allowSelfSignup: opts.allowSelfSignup ?? true,
    }),
  );
  // Mirror the production onRequest gate so tests exercise the same flow.
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;
    const PUBLIC = new Set([
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/logout",
    ]);
    if (PUBLIC.has(url)) return;
    const p = await resolvePrincipal(db, request, opts.apiToken);
    if (p) return;
    if (!opts.apiToken) return; // no auth configured at all
    return unauthorized(reply);
  });
  return app;
}

function getSessionCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const found = list.find((c) => c.startsWith("conduit_session="));
  if (!found) return null;
  return found.split(";")[0]; // "conduit_session=value"
}

test("register creates a user and logs them in", async () => {
  const app = await buildApp({ apiToken: "admin" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "alice@example.com", password: "longenoughpw" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { user: { email: string } };
    assert.equal(body.user.email, "alice@example.com");
    const sessionCookie = getSessionCookie(res.headers["set-cookie"]);
    assert.ok(sessionCookie, "expected set-cookie on register");

    // /me with the session cookie should resolve back to alice.
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: sessionCookie! },
    });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as { user: { email: string } };
    assert.equal(meBody.user.email, "alice@example.com");
  } finally {
    await app.close();
  }
});

test("register rejects weak passwords + bad emails", async () => {
  const app = await buildApp({ apiToken: "admin" });
  try {
    const r1 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", password: "longenoughpw" },
    });
    assert.equal(r1.statusCode, 400);
    const r2 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "ok@example.com", password: "short" },
    });
    assert.equal(r2.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("login with wrong password returns 401", async () => {
  const app = await buildApp({ apiToken: "admin" });
  try {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "alice@example.com", password: "longenoughpw" },
    });
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "wrongguess" },
    });
    assert.equal(bad.statusCode, 401);
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "noone@example.com", password: "whatever" },
    });
    assert.equal(missing.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("logout deletes the session", async () => {
  const app = await buildApp({ apiToken: "admin" });
  try {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@x.com", password: "longenoughpw" },
    });
    const sessionCookie = getSessionCookie(reg.headers["set-cookie"])!;
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: sessionCookie },
    });
    assert.equal(logout.statusCode, 200);
    // The cookie value is now invalid in the DB; /me should 401.
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: sessionCookie },
    });
    assert.equal(me.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("admin token grants access without a session", async () => {
  const app = await buildApp({ apiToken: "letmein" });
  try {
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer letmein" },
    });
    assert.equal(me.statusCode, 200);
    const body = me.json() as { principal: string };
    assert.equal(body.principal, "admin_token");

    // Wrong token: 401 from the onRequest hook.
    const denied = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("personal access tokens can authenticate subsequent requests", async () => {
  const app = await buildApp({ apiToken: "admin" });
  try {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "b@x.com", password: "longenoughpw" },
    });
    const sessionCookie = getSessionCookie(reg.headers["set-cookie"])!;
    const issue = await app.inject({
      method: "POST",
      url: "/api/auth/personal-tokens",
      headers: { cookie: sessionCookie },
      payload: { label: "vs code on laptop" },
    });
    assert.equal(issue.statusCode, 200);
    const token = (issue.json() as { token: string }).token;
    assert.ok(token.startsWith("conduit_pat_"));

    const meWithPat = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(meWithPat.statusCode, 200);
    const meBody = meWithPat.json() as { principal: string; user: { email: string } };
    assert.equal(meBody.principal, "personal_token");
    assert.equal(meBody.user.email, "b@x.com");

    // List + revoke.
    const list = await app.inject({
      method: "GET",
      url: "/api/auth/personal-tokens",
      headers: { cookie: sessionCookie },
    });
    const items = (list.json() as { tokens: { id: string }[] }).tokens;
    assert.equal(items.length, 1);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/auth/personal-tokens/${items[0].id}`,
      headers: { cookie: sessionCookie },
    });
    assert.equal(del.statusCode, 200);

    // Token should no longer work.
    const denied = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await app.close();
  }
});
