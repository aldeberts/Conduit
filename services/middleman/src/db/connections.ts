import { randomUUID } from "node:crypto";
import type { Db } from "./index.js";

export type SecretKind = "password" | "private_key" | "none";

export type ConnectionRow = {
  id: string;
  owner_user_id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remote_path: string;
  secret_kind: SecretKind;
  /** sqlite returns BLOB columns as Uint8Array; NULL when secret_kind='none'. */
  encrypted_secret: Uint8Array | null;
  created_at: number;
};

export type CreateConnectionInput = {
  ownerUserId: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  secretKind: SecretKind;
  encryptedSecret: Uint8Array | null;
};

export function createConnectionRow(db: Db, input: CreateConnectionInput): ConnectionRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO connections
       (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerUserId,
    input.label,
    input.host,
    input.port,
    input.username,
    input.remotePath,
    input.secretKind,
    input.encryptedSecret ?? null,
    now,
  );
  // The owner is implicitly a member with role=owner.
  db.prepare(
    "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
  ).run(id, input.ownerUserId, now);
  return {
    id,
    owner_user_id: input.ownerUserId,
    label: input.label,
    host: input.host,
    port: input.port,
    username: input.username,
    remote_path: input.remotePath,
    secret_kind: input.secretKind,
    encrypted_secret: input.encryptedSecret,
    created_at: now,
  };
}

export function findConnectionById(db: Db, id: string): ConnectionRow | null {
  const row = db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
  return row ?? null;
}

/** Returns true if `userId` is a member (any role) of the connection. */
export function isMember(db: Db, connectionId: string, userId: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS x FROM workspace_members WHERE connection_id = ? AND user_id = ?",
  ).get(connectionId, userId) as { x: number } | undefined;
  return !!row;
}

export function listConnectionsForUser(db: Db, userId: string): ConnectionRow[] {
  return db.prepare(
    `SELECT c.* FROM connections c
       JOIN workspace_members m ON m.connection_id = c.id
      WHERE m.user_id = ?
      ORDER BY c.created_at DESC`,
  ).all(userId) as ConnectionRow[];
}

export function listMembers(db: Db, connectionId: string): { user_id: string; role: string }[] {
  return db.prepare(
    "SELECT user_id, role FROM workspace_members WHERE connection_id = ?",
  ).all(connectionId) as { user_id: string; role: string }[];
}

export function addMember(
  db: Db,
  connectionId: string,
  userId: string,
  role: "owner" | "member" = "member",
): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, ?, ?)",
  ).run(connectionId, userId, role, Date.now());
}

export function removeMember(db: Db, connectionId: string, userId: string): void {
  db.prepare(
    "DELETE FROM workspace_members WHERE connection_id = ? AND user_id = ?",
  ).run(connectionId, userId);
}

export function deleteConnectionRow(db: Db, id: string): void {
  db.prepare("DELETE FROM connections WHERE id = ?").run(id);
}
