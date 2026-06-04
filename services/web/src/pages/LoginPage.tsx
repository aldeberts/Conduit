import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearApiToken,
  getApiToken,
  probeServerHealth,
  probeSession,
  setApiToken,
  verifyApiToken,
} from "../lib/authToken";

type LocationState = { from?: string } | null;
type Mode = "email" | "token";

/**
 * Phase 2 login: prefers email/password (cookie session). Falls back to a
 * "paste your API token" panel for the admin-token recovery flow. If the
 * server hasn't registered any users yet AND self-signup is enabled, we show
 * the registration form by default.
 */
export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState)?.from ?? "/";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("email");
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const health = await probeServerHealth();
      if (cancelled) return;
      setAuthRequired(health.authRequired);
      if (!health.authRequired) {
        navigate(from, { replace: true });
        return;
      }
      // First-run UX: if no users, default to register so the first visitor
      // bootstraps an account.
      if (!health.hasUsers) {
        setRegister(true);
      }
      // If we already have a valid session cookie, skip the login screen.
      const session = await probeSession();
      if (cancelled) return;
      if (session.authenticated) {
        navigate(from, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, from]);

  const submitEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    if (register && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const url = register ? "/api/auth/register" : "/api/auth/login";
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      // Cookie is set; clear any stale localStorage token to avoid auth header collisions.
      clearApiToken();
      const session = await probeSession();
      if (!session.authenticated) {
        setError(
          "Signed in, but the session cookie was not saved. Check that Caddy proxies all /api/... routes (not just /api/*).",
        );
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Paste your API token to continue.");
      return;
    }
    setBusy(true);
    try {
      const ok = await verifyApiToken(trimmed);
      if (!ok) {
        setError("That token was rejected by the server.");
        return;
      }
      setApiToken(trimmed);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cached = getApiToken();

  if (authRequired === null) {
    return (
      <div className="connection-page">
        <div className="panel">
          <p className="hint">Checking server…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="connection-page">
      <div className="panel">
        <h1 style={{ marginTop: 0, fontSize: "1.25rem" }}>
          {mode === "email" ? (register ? "Create your Conduit account" : "Sign in to Conduit") : "Admin token"}
        </h1>

        <div className="tabbar" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "email"}
            className={mode === "email" ? "tab active" : "tab"}
            onClick={() => {
              setMode("email");
              setError(null);
            }}
          >
            Email + password
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "token"}
            className={mode === "token" ? "tab active" : "tab"}
            onClick={() => {
              setMode("token");
              setError(null);
            }}
          >
            Admin token
          </button>
        </div>

        {mode === "email" ? (
          <form onSubmit={(e) => void submitEmail(e)}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
              />
            </div>
            {error ? <div className="error">{error}</div> : null}
            <button type="submit" className="primary" disabled={busy} style={{ marginTop: "0.5rem" }}>
              {busy ? (register ? "Creating…" : "Signing in…") : register ? "Create account" : "Sign in"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setRegister((r) => !r);
                setError(null);
              }}
              style={{ marginTop: "0.5rem", marginLeft: "0.5rem" }}
            >
              {register ? "Have an account? Sign in" : "Need an account? Register"}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void submitToken(e)}>
            <p className="hint" style={{ marginTop: 0 }}>
              Paste the shared <code>API_TOKEN</code> from <code>/etc/conduit/env</code>. This is
              kept as an escape hatch for ops -- prefer email + password for daily use.
            </p>
            <div className="field">
              <label htmlFor="token">API token</label>
              <input
                id="token"
                type="password"
                value={token}
                onChange={(ev) => setToken(ev.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {error ? <div className="error">{error}</div> : null}
            <button type="submit" className="primary" disabled={busy} style={{ marginTop: "0.5rem" }}>
              {busy ? "Verifying…" : "Continue"}
            </button>
            {cached ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  clearApiToken();
                  setToken("");
                  setError("Cleared the cached token.");
                }}
                style={{ marginTop: "0.5rem", marginLeft: "0.5rem" }}
              >
                Forget cached token
              </button>
            ) : null}
          </form>
        )}
      </div>
    </div>
  );
}
