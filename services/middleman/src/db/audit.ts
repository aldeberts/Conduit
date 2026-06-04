import type { Db } from "./index.js";

export type AuditEvent = {
  userId: string | null;
  action: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
};

export type AuditRow = {
  id: number;
  ts: number;
  user_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  detail: string | null;
};

/**
 * Append-only audit log. Never throws to the caller -- if logging fails (e.g.
 * sqlite locked) we still want the underlying request to succeed.
 */
export function recordAudit(db: Db, event: AuditEvent): void {
  try {
    db.prepare(
      "INSERT INTO audit_log (ts, user_id, action, target_kind, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      Date.now(),
      event.userId,
      event.action,
      event.targetKind ?? null,
      event.targetId ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("audit log write failed", err);
  }
}

export function listAuditForUser(db: Db, userId: string, limit = 100): AuditRow[] {
  // Order by id DESC as the tiebreaker because two events can land in the same
  // millisecond (very common in tests).
  return db.prepare(
    "SELECT * FROM audit_log WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
  ).all(userId, limit) as AuditRow[];
}
