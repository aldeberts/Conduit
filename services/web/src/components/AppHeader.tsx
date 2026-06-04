import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { clearApiToken, logoutSession, probeServerHealth, probeSession } from "../lib/authToken";

type AuthView =
  | { status: "loading" }
  | { status: "none" }
  | { status: "signed-in"; label: string };

export function AppHeader(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [auth, setAuth] = useState<AuthView>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const onLoginPage = location.pathname === "/login";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const health = await probeServerHealth();
      if (cancelled) return;
      if (!health.authRequired) {
        setAuth({ status: "signed-in", label: "open server" });
        return;
      }
      const session = await probeSession();
      if (cancelled) return;
      if (session.authenticated) {
        setAuth({
          status: "signed-in",
          label: session.email ?? "signed in",
        });
        return;
      }
      setAuth({ status: "none" });
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const onLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logoutSession();
      clearApiToken();
      setAuth({ status: "none" });
      navigate("/login", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <header className="app-header">
      <div className="app-header-left">
        <Link to="/" className="logo app-header-logo">
          Conduit
        </Link>
        {!onLoginPage && auth.status === "signed-in" ? (
          <nav className="app-header-nav" aria-label="Main">
            <Link to="/">Dashboard</Link>
            <Link to="/connect/new">New connection</Link>
          </nav>
        ) : null}
      </div>
      <div className="app-header-right">
        {auth.status === "loading" ? (
          <span className="hint app-header-user">…</span>
        ) : auth.status === "signed-in" ? (
          <>
            <span className="app-header-user" title="Signed in as">
              {auth.label}
            </span>
            <button type="button" className="ghost" disabled={loggingOut} onClick={() => void onLogout()}>
              {loggingOut ? "Signing out…" : "Log out"}
            </button>
          </>
        ) : onLoginPage ? null : (
          <Link to="/login" className="ghost app-header-login">
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
