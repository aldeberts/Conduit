/**
 * Persists the *non-secret* parts of recently-used SSH connections to
 * localStorage so the user can re-enter just their password after the
 * middleman restarts (or after a browser refresh).
 *
 * NEVER stores password or privateKey. That's deliberate.
 */

const STORAGE_KEY = "conduit.recentConnections.v1";
const MAX_RECENTS = 8;

export type RecentConnection = {
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  /** Wall-clock ms when last used, for sorting. */
  lastUsedAt: number;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

function isRecent(entry: unknown): entry is RecentConnection {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return (
    typeof e.label === "string" &&
    typeof e.host === "string" &&
    typeof e.port === "number" &&
    typeof e.username === "string" &&
    typeof e.remotePath === "string" &&
    typeof e.lastUsedAt === "number"
  );
}

/** Returns the most-recently-used connections, newest first. */
export function listRecentConnections(storage: Storage | null = defaultStorage()): RecentConnection[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const list = parsed.filter(isRecent);
    list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return list;
  } catch {
    return [];
  }
}

/** Two recents are considered the same connection if user@host:port+remotePath
 *  match (label is decorative). */
function sameConnection(a: RecentConnection, b: RecentConnection): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.remotePath === b.remotePath
  );
}

/** Inserts (or updates) `entry`, dedupes by user@host:port+remotePath, keeps
 *  the newest MAX_RECENTS, and persists. */
export function rememberConnection(
  entry: Omit<RecentConnection, "lastUsedAt">,
  storage: Storage | null = defaultStorage(),
  now: () => number = Date.now,
): RecentConnection[] {
  const incoming: RecentConnection = { ...entry, lastUsedAt: now() };
  const current = listRecentConnections(storage);
  const merged = [incoming, ...current.filter((existing) => !sameConnection(existing, incoming))];
  const trimmed = merged.slice(0, MAX_RECENTS);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* ignore quota / unavailable */
    }
  }
  return trimmed;
}

/** Removes a recent matching the predicate keys. Returns the new list. */
export function forgetConnection(
  match: Pick<RecentConnection, "host" | "port" | "username" | "remotePath">,
  storage: Storage | null = defaultStorage(),
): RecentConnection[] {
  const current = listRecentConnections(storage);
  const next = current.filter(
    (entry) =>
      !(
        entry.host === match.host &&
        entry.port === match.port &&
        entry.username === match.username &&
        entry.remotePath === match.remotePath
      ),
  );
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  return next;
}
