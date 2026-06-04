import { useEffect, useState, type ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { hasAnyToken, probeServerHealth, probeSession } from "../lib/authToken";

type Status = "checking" | "ok" | "needs-login";

/**
 * Gate every authenticated route. Shows nothing while we ask the server
 * whether auth is even required (during local dev with no `API_TOKEN`, we
 * skip the prompt entirely).
 */
export function RequireAuth({ children }: { children: ReactElement }): ReactElement {
  const location = useLocation();
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const health = await probeServerHealth();
      if (cancelled) return;
      if (!health.authRequired) {
        setStatus("ok");
        return;
      }
      // Token users (admin/personal token flow) can proceed immediately.
      if (hasAnyToken()) {
        setStatus("ok");
        return;
      }
      // Email/password flow uses an HTTP-only session cookie.
      const session = await probeSession();
      if (cancelled) return;
      setStatus(session.authenticated ? "ok" : "needs-login");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    // Render nothing rather than flashing the login page; the probe is fast.
    return <div className="connection-page" />;
  }
  if (status === "needs-login") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
