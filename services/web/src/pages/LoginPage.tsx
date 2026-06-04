import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { clearApiToken, probeServerHealth, probeSession } from "../lib/authToken";

type LocationState = { from?: string } | null;

/**
 * Email/password login with an HTTP-only session cookie. On first deploy with
 * no users yet, defaults to the registration form.
 */
export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState)?.from ?? "/";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      if (!health.hasUsers) {
        setRegister(true);
      }
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
      clearApiToken();
      const session = await probeSession();
      if (!session.authenticated) {
        setError(
          "Signed in, but the session cookie was not saved. Check that the reverse proxy forwards all /api/ routes with cookies enabled.",
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
          {register ? "Create your Conduit account" : "Sign in to Conduit"}
        </h1>
        <p className="hint" style={{ marginTop: "-0.25rem" }}>
          Use the email and password for your account on this Conduit server.
        </p>

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
      </div>
    </div>
  );
}
