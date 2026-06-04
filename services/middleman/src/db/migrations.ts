/**
 * Schema migrations. Append-only and ID-ordered (each ID starts with the
 * date written ISO-style so `sort()` matches application order). Never
 * rewrite an applied migration in-place -- add a new one.
 *
 * Each migration is a single SQL string. Multi-statement is fine; the runner
 * wraps the whole string in a transaction.
 */

export type Migration = {
  id: string;
  sql: string;
};

export const migrations: Migration[] = [
  {
    // 2026-05 — initial Phase 2 schema.
    id: "20260529-0001-init",
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE connections (
        id               TEXT PRIMARY KEY,
        owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label            TEXT NOT NULL,
        host             TEXT NOT NULL,
        port             INTEGER NOT NULL,
        username         TEXT NOT NULL,
        remote_path      TEXT NOT NULL,
        secret_kind      TEXT NOT NULL,  -- 'password' | 'private_key' | 'none'
        encrypted_secret BLOB,           -- libsodium secretbox; NULL when secret_kind='none'
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX connections_by_owner ON connections(owner_user_id);

      CREATE TABLE workspace_members (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,  -- 'owner' | 'member'
        added_at      INTEGER NOT NULL,
        PRIMARY KEY (connection_id, user_id)
      );

      CREATE TABLE sessions (
        id         TEXT PRIMARY KEY,           -- random opaque cookie value
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used  INTEGER NOT NULL
      );
      CREATE INDEX sessions_by_expiry ON sessions(expires_at);

      CREATE TABLE personal_tokens (
        id          TEXT PRIMARY KEY,            -- the secret (long random; stored hashed)
        token_hash  TEXT NOT NULL UNIQUE,        -- sha256 hex of the raw token
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_used   INTEGER
      );

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        user_id     TEXT,                       -- nullable for anonymous/system events
        action      TEXT NOT NULL,
        target_kind TEXT,
        target_id   TEXT,
        detail      TEXT                        -- free-form JSON for context
      );
      CREATE INDEX audit_by_user_ts ON audit_log(user_id, ts DESC);
    `,
  },
];
