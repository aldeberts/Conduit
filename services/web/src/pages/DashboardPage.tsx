import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  deleteConnection,
  listMyConnections,
  reopenConnection,
  type ServerConnection,
} from "../lib/api";

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function targetLine(entry: ServerConnection): string {
  const port = entry.port === 22 ? "" : `:${entry.port}`;
  return `${entry.username}@${entry.host}${port} · ${entry.remotePath}`;
}

export function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ServerConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      const list = await listMyConnections();
      setConnections(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const active = connections.filter((c) => c.isOpen);
  const past = connections.filter((c) => !c.isOpen);

  const onOpen = async (entry: ServerConnection): Promise<void> => {
    setError(null);
    if (entry.isOpen) {
      navigate(`/workspace/${entry.id}`, {
        state: { label: entry.label, remoteRoot: entry.remotePath },
      });
      return;
    }
    if (entry.canRevive) {
      setBusyId(entry.id);
      try {
        const res = await reopenConnection(entry.id);
        navigate(`/workspace/${entry.id}`, {
          state: { label: entry.label, remoteRoot: res.remoteRoot ?? entry.remotePath },
        });
      } catch (err) {
        setError(`Could not reopen: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
      return;
    }
    navigate("/connect/new", {
      state: {
        prefill: {
          label: entry.label,
          host: entry.host,
          port: entry.port,
          username: entry.username,
          remotePath: entry.remotePath,
        },
      },
    });
  };

  const onDelete = async (entry: ServerConnection): Promise<void> => {
    if (!confirm(`Delete the "${entry.label}" workspace from the server? Members will lose access.`)) {
      return;
    }
    setBusyId(entry.id);
    setError(null);
    try {
      await deleteConnection(entry.id);
      setConnections((list) => list.filter((c) => c.id !== entry.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = (entry: ServerConnection): JSX.Element => {
    const statusLabel = entry.isOpen
      ? "Active"
      : entry.canRevive
        ? "Closed · can reopen"
        : "Closed";
    return (
      <li key={entry.id}>
        <button
          type="button"
          className="recent-reuse"
          disabled={busyId === entry.id}
          onClick={() => void onOpen(entry)}
        >
          <span className="recent-label">
            {entry.label}
            {entry.isOwner ? <small style={{ color: "var(--muted)" }}> (owner)</small> : null}
            <small
              style={{
                color: entry.isOpen ? "var(--ctp-green)" : entry.canRevive ? "var(--ctp-yellow)" : "var(--ctp-peach)",
              }}
            >
              {" "}
              · {statusLabel}
            </small>
          </span>
          <span className="recent-target">{targetLine(entry)}</span>
          <span className="recent-meta">Created {formatWhen(entry.createdAt)}</span>
        </button>
        {entry.isOwner ? (
          <button
            type="button"
            className="ghost recent-forget"
            disabled={busyId === entry.id}
            onClick={() => void onDelete(entry)}
          >
            Delete
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="connection-page dashboard-page">
      <div className="panel">
        <div className="dashboard-header">
          <div>
            <h1 style={{ marginTop: 0, fontSize: "1.25rem" }}>Dashboard</h1>
            <p className="hint" style={{ marginTop: "-0.25rem", marginBottom: 0 }}>
              Your remote workspaces. Active sessions are open on the server; closed ones can be reopened or reconnected.
            </p>
          </div>
          <Link to="/connect/new" className="primary dashboard-new-btn">
            New connection
          </Link>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {loading ? (
          <p className="hint">Loading workspaces…</p>
        ) : connections.length === 0 ? (
          <div className="dashboard-empty">
            <p>No workspaces yet.</p>
            <Link to="/connect/new" className="primary">
              Create your first connection
            </Link>
          </div>
        ) : (
          <>
            <section className="dashboard-section">
              <h2 className="dashboard-section-title">Active sessions ({active.length})</h2>
              {active.length === 0 ? (
                <p className="hint">No open SSH sessions right now.</p>
              ) : (
                <ul className="recent-connections">{active.map(renderRow)}</ul>
              )}
            </section>

            <section className="dashboard-section">
              <h2 className="dashboard-section-title">Past sessions ({past.length})</h2>
              {past.length === 0 ? (
                <p className="hint">No closed workspaces.</p>
              ) : (
                <ul className="recent-connections">{past.map(renderRow)}</ul>
              )}
            </section>
          </>
        )}

        <p className="hint" style={{ marginTop: "1.25rem", marginBottom: 0 }}>
          Closed workspaces with saved credentials can be reopened in one click. Others need a fresh password on the
          reconnect form.
        </p>
      </div>
    </div>
  );
}
