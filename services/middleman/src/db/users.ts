import { randomUUID } from "node:crypto";
import type { Db } from "./index.js";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
};

export function createUser(db: Db, email: string, passwordHash: string): UserRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(id, email, passwordHash, now);
  return { id, email, password_hash: passwordHash, created_at: now };
}

export function findUserByEmail(db: Db, email: string): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  return row ?? null;
}

export function findUserById(db: Db, id: string): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ?? null;
}

export function countUsers(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  return row.c;
}
