/**
 * Per-browser API-token storage. Tokens are entered on the login screen and
 * persisted in localStorage so they survive reloads. The build-time
 * `VITE_API_TOKEN` is still honored as a fallback for local dev (where the
 * `.env.local` recipe keeps the old "no login" behavior).
 *
 * Phase 2 will replace this with cookie-based sessions and demote tokens to
 * "personal access tokens for IDE clients", but the storage API (get / set /
 * clear) can stay the same.
 */

const STORAGE_KEY = "conduit.apiToken.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): Storage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

function readEnvToken(): string | undefined {
  // Guard so node tests (no `import.meta.env`) don't blow up.
  if (typeof import.meta === "undefined") return undefined;
  const env = (import.meta as unknown as { env?: { VITE_API_TOKEN?: string } }).env;
  return env?.VITE_API_TOKEN;
}

const envToken = readEnvToken();

/**
 * Returns the active token, preferring an explicit user-entered token over the
 * build-time env. Returns undefined when neither is set.
 */
export function getApiToken(storage: Storage | null = defaultStorage()): string | undefined {
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw && raw.trim() !== "") {
        return raw.trim();
      }
    } catch {
      /* fall through */
    }
  }
  return envToken && envToken.trim() !== "" ? envToken.trim() : undefined;
}

/** Persists a token entered on the login screen. */
export function setApiToken(token: string, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, token.trim());
  } catch {
    /* ignore quota / unavailable */
  }
}

/** Forgets the user-entered token (env fallback may still apply). */
export function clearApiToken(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * `true` if the server reports authRequired=false OR we have a token cached
 * locally. Used by the router to decide whether to show the login screen.
 *
 * Network probe goes through `verifyApiToken()` separately because it requires
 * await.
 */
export function hasAnyToken(storage: Storage | null = defaultStorage()): boolean {
  return getApiToken(storage) !== undefined;
}

export type ServerHealth = {
  authRequired: boolean;
  hasUsers: boolean;
};

/**
 * Hits `/health` (no auth required) to discover whether the server is even
 * gating on a token, and whether any users exist (so we know to show a
 * "register" tab on first run).
 */
export async function probeServerHealth(): Promise<ServerHealth> {
  try {
    const res = await fetch("/health");
    if (!res.ok) return { authRequired: true, hasUsers: true };
    const data = (await res.json()) as { authRequired?: boolean; hasUsers?: boolean };
    return {
      authRequired: Boolean(data.authRequired),
      hasUsers: Boolean(data.hasUsers),
    };
  } catch {
    return { authRequired: true, hasUsers: true };
  }
}

/** Back-compat alias for the simpler probe. */
export async function probeAuthRequired(): Promise<boolean> {
  return (await probeServerHealth()).authRequired;
}

/**
 * Tries a tiny authenticated request to confirm the token works. Returns true
 * on 200, false on 401, throws on network failure.
 */
export async function verifyApiToken(token: string): Promise<boolean> {
  const res = await fetch("/api/auth/ping", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return false;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return true;
}

/**
 * Does a `/api/auth/me` round-trip to determine whether the browser already
 * has a valid session cookie. Returns the principal type, or null when
 * unauthenticated.
 */
export async function probeSession(): Promise<
  | { authenticated: true; kind: "session" | "personal_token" | "admin_token"; email?: string }
  | { authenticated: false }
> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (res.status === 401) return { authenticated: false };
    if (!res.ok) return { authenticated: false };
    const body = (await res.json()) as {
      principal: "session" | "personal_token" | "admin_token";
      user?: { email: string };
    };
    return { authenticated: true, kind: body.principal, email: body.user?.email };
  } catch {
    return { authenticated: false };
  }
}
