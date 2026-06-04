import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { migrations } from "./migrations.js";

/**
 * Thin wrapper over `node:sqlite` that:
 * - opens (creating dirs as needed),
 * - runs pending migrations in order, idempotently,
 * - exposes prepared-statement helpers used by the user/connection layers,
 * - is fully synchronous (node:sqlite is sync; that's fine for an embedded
 *   per-request store inside Fastify handlers, and keeps tests trivial).
 *
 * Phase 2 uses sqlite for users / connections / workspace members / sessions /
 * personal-access-tokens / audit. The existing on-disk Yjs snapshot directory
 * (`DATA_DIR`) is unaffected -- those binaries stay on the filesystem.
 */

export type Db = DatabaseSync;

let singleton: Db | null = null;
let singletonPath: string | null = null;

/**
 * Opens (or returns the already-open) singleton DB. Pass `:memory:` for tests.
 * The first call applies any pending migrations.
 */
export function getDb(dbPath: string): Db {
  if (singleton && singletonPath === dbPath) {
    return singleton;
  }
  if (singleton && singletonPath !== dbPath) {
    // Tests can opt into a new in-memory DB by calling resetDbForTests() first.
    throw new Error(`db already opened at ${singletonPath}, refusing to open at ${dbPath}`);
  }
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // Pragmas: WAL gives us concurrent readers; foreign_keys must be on for our
  // cascading deletes (workspace_members -> connections, sessions -> users).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  runMigrations(db);
  singleton = db;
  singletonPath = dbPath;
  return db;
}

/** Tests only -- closes the singleton and lets the next `getDb(...)` reopen. */
export function resetDbForTests(): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      /* ignore */
    }
  }
  singleton = null;
  singletonPath = null;
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function appliedMigrationIds(db: Db): Set<string> {
  ensureMigrationsTable(db);
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function runMigrations(db: Db): void {
  ensureMigrationsTable(db);
  const applied = appliedMigrationIds(db);
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Convenience: prepare and cache (per-DB) so call sites don't re-prepare. */
export function prepare(db: Db, sql: string): StatementSync {
  return db.prepare(sql);
}
