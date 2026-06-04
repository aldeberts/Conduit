import { randomBytes, createHash } from "node:crypto";
import type { Db } from "./index.js";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  last_used: number;
};

export function createSession(db: Db, userId: string, ttlMs: number = DEFAULT_TTL_MS): SessionRow {
  // 32 bytes of random → ~256 bits of entropy. The cookie value IS the id;
  // sqlite is a private store on the server, so we don't bother hashing it.
  const id = randomBytes(32).toString("hex");
  const now = Date.now();
  const row: SessionRow = {
    id,
    user_id: userId,
    expires_at: now + ttlMs,
    created_at: now,
    last_used: now,
  };
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at, last_used) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, row.user_id, row.expires_at, row.created_at, row.last_used);
  return row;
}

export function findValidSession(db: Db, id: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  db.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").run(Date.now(), id);
  return row;
}

export function deleteSession(db: Db, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function purgeExpiredSessions(db: Db): number {
  const res = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  return Number(res.changes ?? 0);
}

/* ----- personal access tokens (IDE clients) -------------------------- */

export type PersonalTokenRow = {
  id: string;
  token_hash: string;
  user_id: string;
  label: string;
  created_at: number;
  last_used: number | null;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Generates a token, stores its sha256, and returns the *raw* value to show
 *  to the user exactly once. */
export function createPersonalToken(
  db: Db,
  userId: string,
  label: string,
): { raw: string; row: PersonalTokenRow } {
  const id = randomBytes(8).toString("hex");
  // Prefix makes it greppable in logs ("hey that's a Conduit token!").
  const raw = `conduit_pat_${randomBytes(24).toString("hex")}`;
  const tokenHash = sha256Hex(raw);
  const now = Date.now();
  db.prepare(
    "INSERT INTO personal_tokens (id, token_hash, user_id, label, created_at, last_used) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(id, tokenHash, userId, label, now);
  return {
    raw,
    row: { id, token_hash: tokenHash, user_id: userId, label, created_at: now, last_used: null },
  };
}

export function findUserByPersonalToken(db: Db, raw: string): string | null {
  if (!raw.startsWith("conduit_pat_")) return null;
  const hash = sha256Hex(raw);
  const row = db.prepare(
    "SELECT user_id, id FROM personal_tokens WHERE token_hash = ?",
  ).get(hash) as { user_id: string; id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE personal_tokens SET last_used = ? WHERE id = ?").run(Date.now(), row.id);
  return row.user_id;
}

export function listPersonalTokens(db: Db, userId: string): Omit<PersonalTokenRow, "token_hash">[] {
  return db.prepare(
    "SELECT id, user_id, label, created_at, last_used FROM personal_tokens WHERE user_id = ? ORDER BY created_at DESC",
  ).all(userId) as Omit<PersonalTokenRow, "token_hash">[];
}

export function revokePersonalToken(db: Db, userId: string, id: string): boolean {
  const res = db.prepare("DELETE FROM personal_tokens WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(res.changes ?? 0) > 0;
}
