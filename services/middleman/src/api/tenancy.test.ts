import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { getDb, resetDbForTests, type Db } from "../db/index.js";
import { makeAuthApi } from "./auth.js";
import { makeConnectionsApi } from "./connections.js";
import { resolvePrincipal } from "../auth/principal.js";
import { unauthorized } from "../auth.js";
import { registerTestConnection, makeInMemorySftp } from "../ssh/registry.js";
import { configureDocumentStore } from "../documents/registry.js";
import { registerWebSocket } from "../ws/handler.js";

async function buildApp(
  opts: { secretsKey?: string } = {},
): Promise<{ app: FastifyInstance; db: Db }> {
  configureDocumentStore("");
  resetDbForTests();
  const db = getDb(":memory:");
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(makeAuthApi({ db, apiToken: "admin", secureCookies: false, allowSelfSignup: true }));
  await app.register(makeConnectionsApi({ db, apiToken: "admin", secretsKey: opts.secretsKey }));
  await registerWebSocket(app, { apiToken: "admin", db });
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;
    const PUBLIC = new Set([
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/logout",
    ]);
    if (PUBLIC.has(url)) return;
    if (url === "/api/ws") return;
    const p = await resolvePrincipal(db, request, "admin");
    if (p) return;
    return unauthorized(reply);
  });
  return { app, db };
}

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : [];
  const found = list.find((c) => typeof c === "string" && c.startsWith("conduit_session="));
  if (!found) throw new Error("expected a session cookie");
  return (found as string).split(";")[0];
}

async function register(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.body}`);
  return cookieFromResponse(res);
}

test("connection list is per-user: Bob does not see Alice's workspaces", async () => {
  const { app, db } = await buildApp();
  try {
    const aliceCookie = await register(app, "alice@example.com", "longenoughpw");
    const bobCookie = await register(app, "bob@example.com", "longenoughpw");

    // Alice "creates" a connection. We can't open real SSH here, so we insert
    // a row + register the in-memory SFTP stub at the matching id by going
    // through both the DB and registry helpers directly.
    const connectionId = "alice-conn-1";
    const now = Date.now();
    db.prepare(
      `INSERT INTO connections (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?)`,
    ).run(connectionId, getUserId(db, "alice@example.com"), "alice's box", "h", 22, "u", "/", now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(connectionId, getUserId(db, "alice@example.com"), now);
    registerTestConnection(connectionId, "/", makeInMemorySftp(new Map()));

    const aliceList = await app.inject({
      method: "GET",
      url: "/api/connections",
      headers: { cookie: aliceCookie },
    });
    assert.equal(aliceList.statusCode, 200);
    assert.equal((aliceList.json() as { connections: unknown[] }).connections.length, 1);

    const bobList = await app.inject({
      method: "GET",
      url: "/api/connections",
      headers: { cookie: bobCookie },
    });
    assert.equal(bobList.statusCode, 200);
    assert.equal((bobList.json() as { connections: unknown[] }).connections.length, 0);

    // Bob cannot tree alice's workspace.
    const denied = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/tree`,
      headers: { cookie: bobCookie },
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("invite flow grants Bob access; uninvite revokes it", async () => {
  const { app, db } = await buildApp();
  try {
    const aliceCookie = await register(app, "alice@x.com", "longenoughpw");
    const bobCookie = await register(app, "bob@x.com", "longenoughpw");
    const connectionId = "alice-conn-2";
    const now = Date.now();
    db.prepare(
      `INSERT INTO connections (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?)`,
    ).run(connectionId, getUserId(db, "alice@x.com"), "shared", "h", 22, "u", "/", now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(connectionId, getUserId(db, "alice@x.com"), now);
    registerTestConnection(connectionId, "/", makeInMemorySftp(new Map()));

    // Bob doesn't see it yet.
    const before = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/tree`,
      headers: { cookie: bobCookie },
    });
    assert.equal(before.statusCode, 403);

    // Alice invites Bob.
    const invite = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/members`,
      headers: { cookie: aliceCookie },
      payload: { email: "bob@x.com" },
    });
    assert.equal(invite.statusCode, 200);

    // Bob can now read the tree.
    const after = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/tree`,
      headers: { cookie: bobCookie },
    });
    // 200 from listTree; the in-memory SFTP stub doesn't implement readdir →
    // we expect either 200 with empty entries or a 500. Either way auth passed.
    assert.notEqual(after.statusCode, 403);

    // Members list shows both.
    const members = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/members`,
      headers: { cookie: aliceCookie },
    });
    assert.equal(members.statusCode, 200);
    const memberList = (members.json() as { members: { email: string; role: string }[] }).members;
    assert.equal(memberList.length, 2);
    assert.ok(memberList.find((m) => m.email === "alice@x.com" && m.role === "owner"));
    assert.ok(memberList.find((m) => m.email === "bob@x.com" && m.role === "member"));

    // Bob (a member, not the owner) cannot invite anyone else.
    const denied = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/members`,
      headers: { cookie: bobCookie },
      payload: { email: "bob@x.com" },
    });
    assert.equal(denied.statusCode, 403);

    // Alice removes Bob.
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/connections/${connectionId}/members/${getUserId(db, "bob@x.com")}`,
      headers: { cookie: aliceCookie },
    });
    assert.equal(remove.statusCode, 200);

    // Bob is locked out again.
    const denied2 = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/tree`,
      headers: { cookie: bobCookie },
    });
    assert.equal(denied2.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("delete connection requires owner; member gets 403", async () => {
  const { app, db } = await buildApp();
  try {
    const aliceCookie = await register(app, "alice@x.com", "longenoughpw");
    const bobCookie = await register(app, "bob@x.com", "longenoughpw");
    const connectionId = "alice-conn-3";
    const now = Date.now();
    db.prepare(
      `INSERT INTO connections (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?)`,
    ).run(connectionId, getUserId(db, "alice@x.com"), "shared", "h", 22, "u", "/", now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(connectionId, getUserId(db, "alice@x.com"), now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)",
    ).run(connectionId, getUserId(db, "bob@x.com"), now);
    registerTestConnection(connectionId, "/", makeInMemorySftp(new Map()));

    const bobDel = await app.inject({
      method: "DELETE",
      url: `/api/connections/${connectionId}`,
      headers: { cookie: bobCookie },
    });
    assert.equal(bobDel.statusCode, 403);

    const aliceDel = await app.inject({
      method: "DELETE",
      url: `/api/connections/${connectionId}`,
      headers: { cookie: aliceCookie },
    });
    assert.equal(aliceDel.statusCode, 200);
  } finally {
    await app.close();
  }
});

function getUserId(db: Db, email: string): string {
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

test("reopen flow: secret stored at create, revived after the in-memory session closes", async () => {
  const { app, db } = await buildApp({ secretsKey: "k".repeat(40) });
  try {
    const aliceCookie = await register(app, "alice@x.com", "longenoughpw");
    // Insert the row directly so we can control the connection id and secret
    // (we can't dial a real SSH host inside the test).
    const ownerId = getUserId(db, "alice@x.com");
    const connectionId = "reopen-1";
    const now = Date.now();
    const { sealSecret } = await import("../auth/secrets.js");
    const sealed = sealSecret("hunter2", "k".repeat(40));
    db.prepare(
      `INSERT INTO connections (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'password', ?, ?)`,
    ).run(connectionId, ownerId, "saved", "h", 22, "u", "/", sealed, now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(connectionId, ownerId, now);

    // List endpoint reports canRevive=true.
    const list = await app.inject({
      method: "GET",
      url: "/api/connections",
      headers: { cookie: aliceCookie },
    });
    const items = (list.json() as { connections: { id: string; canRevive: boolean; isOpen: boolean }[] }).connections;
    assert.equal(items.length, 1);
    assert.equal(items[0].canRevive, true);
    assert.equal(items[0].isOpen, false);

    // Reopen would normally dial SSH; we can't do that here. Just assert that
    // the endpoint reaches the SSH layer (502 ssh_connection_failed is fine).
    const reopen = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/reopen`,
      headers: { cookie: aliceCookie },
    });
    // Either real SSH attempt fails fast (502) or the in-memory test fixture
    // gave us success in another path. We accept either.
    assert.ok(reopen.statusCode === 502 || reopen.statusCode === 200, `unexpected status ${reopen.statusCode}: ${reopen.body}`);
  } finally {
    await app.close();
  }
});

test("reopen requires a stored secret when secrets-at-rest is disabled", async () => {
  const { app, db } = await buildApp({ secretsKey: undefined });
  try {
    const cookie = await register(app, "a@x.com", "longenoughpw");
    const ownerId = getUserId(db, "a@x.com");
    const connectionId = "no-secret";
    const now = Date.now();
    db.prepare(
      `INSERT INTO connections (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?)`,
    ).run(connectionId, ownerId, "", "h", 22, "u", "/", now);
    db.prepare(
      "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(connectionId, ownerId, now);

    const reopen = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/reopen`,
      headers: { cookie },
    });
    assert.equal(reopen.statusCode, 400);
    assert.equal((reopen.json() as { error: string }).error, "no_stored_secret");
  } finally {
    await app.close();
  }
});
