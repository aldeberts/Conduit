import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb, resetDbForTests, runMigrations } from "./index.js";
import { createUser, findUserByEmail, findUserById, countUsers } from "./users.js";
import {
  addMember,
  createConnectionRow,
  findConnectionById,
  isMember,
  listConnectionsForUser,
  listMembers,
  removeMember,
} from "./connections.js";
import {
  createPersonalToken,
  createSession,
  deleteSession,
  findUserByPersonalToken,
  findValidSession,
  listPersonalTokens,
  purgeExpiredSessions,
  revokePersonalToken,
} from "./sessions.js";
import { listAuditForUser, recordAudit } from "./audit.js";

function fresh(): ReturnType<typeof getDb> {
  resetDbForTests();
  return getDb(":memory:");
}

test("migrations are idempotent", () => {
  const db = fresh();
  runMigrations(db);
  runMigrations(db); // second time should be a noop, not a duplicate error
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[];
  assert.equal(rows.length, 1);
});

test("createUser + findUserByEmail roundtrip", () => {
  const db = fresh();
  const u = createUser(db, "alice@example.com", "hash:xyz");
  assert.ok(u.id);
  assert.equal(u.email, "alice@example.com");
  const found = findUserByEmail(db, "alice@example.com");
  assert.ok(found);
  assert.equal(found!.id, u.id);
  assert.equal(found!.email, u.email);
  assert.equal(found!.password_hash, u.password_hash);
  assert.equal(found!.created_at, u.created_at);
  assert.equal(findUserByEmail(db, "bob@example.com"), null);
  assert.equal(findUserById(db, u.id)?.email, "alice@example.com");
  assert.equal(countUsers(db), 1);
});

test("duplicate email rejected", () => {
  const db = fresh();
  createUser(db, "a@x.com", "h1");
  assert.throws(() => createUser(db, "a@x.com", "h2"));
});

test("createConnectionRow + member listing", () => {
  const db = fresh();
  const alice = createUser(db, "alice@x.com", "h");
  const bob = createUser(db, "bob@x.com", "h");
  const c = createConnectionRow(db, {
    ownerUserId: alice.id,
    label: "dev box",
    host: "dev.local",
    port: 22,
    username: "ubuntu",
    remotePath: "/srv",
    secretKind: "password",
    encryptedSecret: new Uint8Array([1, 2, 3]),
  });
  assert.equal(c.owner_user_id, alice.id);
  assert.equal(Array.from(c.encrypted_secret ?? []).join(","), "1,2,3");
  // owner is auto-added as a member
  assert.ok(isMember(db, c.id, alice.id));
  assert.equal(isMember(db, c.id, bob.id), false);
  assert.equal(listConnectionsForUser(db, alice.id).length, 1);
  assert.equal(listConnectionsForUser(db, bob.id).length, 0);

  addMember(db, c.id, bob.id, "member");
  assert.ok(isMember(db, c.id, bob.id));
  assert.equal(listConnectionsForUser(db, bob.id).length, 1);
  const members = listMembers(db, c.id);
  assert.equal(members.length, 2);
  assert.ok(members.find((m) => m.user_id === alice.id && m.role === "owner"));
  assert.ok(members.find((m) => m.user_id === bob.id && m.role === "member"));

  removeMember(db, c.id, bob.id);
  assert.equal(isMember(db, c.id, bob.id), false);
});

test("connection cascade: deleting the owner removes the connection and members", () => {
  const db = fresh();
  const alice = createUser(db, "a@x.com", "h");
  const c = createConnectionRow(db, {
    ownerUserId: alice.id,
    label: "x",
    host: "x",
    port: 22,
    username: "x",
    remotePath: "/",
    secretKind: "none",
    encryptedSecret: null,
  });
  db.prepare("DELETE FROM users WHERE id = ?").run(alice.id);
  assert.equal(findConnectionById(db, c.id), null);
  assert.equal(listMembers(db, c.id).length, 0);
});

test("sessions: create, find, expire, delete", () => {
  const db = fresh();
  const u = createUser(db, "a@x.com", "h");
  const s = createSession(db, u.id, 1000);
  assert.equal(findValidSession(db, s.id)?.user_id, u.id);

  // Force expiry.
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, s.id);
  assert.equal(findValidSession(db, s.id), null);
  // Lookup after expiry deleted it.
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
  assert.equal(countRow.c, 0);

  const s2 = createSession(db, u.id, 500);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, s2.id);
  assert.equal(purgeExpiredSessions(db), 1);

  const s3 = createSession(db, u.id);
  deleteSession(db, s3.id);
  assert.equal(findValidSession(db, s3.id), null);
});

test("personal tokens: create, lookup, revoke", () => {
  const db = fresh();
  const u = createUser(db, "a@x.com", "h");
  const { raw, row } = createPersonalToken(db, u.id, "my laptop");
  assert.ok(raw.startsWith("conduit_pat_"));
  assert.equal(row.user_id, u.id);

  assert.equal(findUserByPersonalToken(db, raw), u.id);
  assert.equal(findUserByPersonalToken(db, "not-a-token"), null);
  assert.equal(findUserByPersonalToken(db, "conduit_pat_garbage"), null);

  const list = listPersonalTokens(db, u.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "my laptop");

  assert.ok(revokePersonalToken(db, u.id, row.id));
  assert.equal(findUserByPersonalToken(db, raw), null);
  assert.equal(revokePersonalToken(db, u.id, row.id), false);
});

test("audit log: append + list newest-first", () => {
  const db = fresh();
  const u = createUser(db, "a@x.com", "h");
  recordAudit(db, { userId: u.id, action: "login" });
  recordAudit(db, { userId: u.id, action: "open_doc", targetKind: "file", targetId: "/src/x.ts" });
  recordAudit(db, { userId: null, action: "boot" });

  const rows = listAuditForUser(db, u.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "open_doc");
  assert.equal(rows[1].action, "login");
});
