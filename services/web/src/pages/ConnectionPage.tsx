import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deleteConnection,
  listMyConnections,
  pollSshAuthSession,
  reopenConnection,
  startInteractiveConnection,
  submitSshAuthResponses,
  type ServerConnection,
} from "../lib/api";
import { SshAuthModal } from "../components/SshAuthModal";
import { parseSshCommand } from "../lib/parseSsh";
import {
  forgetConnection,
  listRecentConnections,
  rememberConnection,
  type RecentConnection,
} from "../lib/recentConnections";

export function ConnectionPage(): JSX.Element {
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [sshCommand, setSshCommand] = useState("ssh user@example.com");
  const [remotePath, setRemotePath] = useState("/home/user/project");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentConnection[]>(() => listRecentConnections());
  const [myConnections, setMyConnections] = useState<ServerConnection[]>([]);
  const [loadingMine, setLoadingMine] = useState(true);
  const [sshAuthSessionId, setSshAuthSessionId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<{
    label: string;
    host: string;
    port: number;
    username: string;
    remotePath: string;
  } | null>(null);

  const pollSshAuth = useCallback(async () => {
    if (!sshAuthSessionId) throw new Error("no auth session");
    return pollSshAuthSession(sshAuthSessionId);
  }, [sshAuthSessionId]);

  const submitSshAuth = useCallback(
    async (answer: string) => {
      if (!sshAuthSessionId) throw new Error("no auth session");
      return submitSshAuthResponses(sshAuthSessionId, answer);
    },
    [sshAuthSessionId],
  );

  // Pull the server-side list of workspaces the caller belongs to. Quietly
  // tolerates the Phase 1 case where the endpoint returns an empty list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listMyConnections();
        if (!cancelled) setMyConnections(list);
      } catch {
        if (!cancelled) setMyConnections([]);
      } finally {
        if (!cancelled) setLoadingMine(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = useMemo(() => parseSshCommand(sshCommand), [sshCommand]);

  const onReuse = (entry: RecentConnection): void => {
    setLabel(entry.label);
    const portPart = entry.port === 22 ? "" : `-p ${entry.port} `;
    setSshCommand(`ssh ${portPart}${entry.username}@${entry.host}`);
    setRemotePath(entry.remotePath);
    setPassword("");
    setPrivateKey("");
    setError(null);
  };

  const onForget = (entry: RecentConnection): void => {
    setRecents(
      forgetConnection({
        host: entry.host,
        port: entry.port,
        username: entry.username,
        remotePath: entry.remotePath,
      }),
    );
  };

  const finishConnect = (res: { id: string; label: string; remoteRoot: string }, meta: {
    label: string;
    host: string;
    port: number;
    username: string;
    remotePath: string;
  }): void => {
    setRecents(
      rememberConnection({
        label: meta.label,
        host: meta.host,
        port: meta.port,
        username: meta.username,
        remotePath: meta.remotePath,
      }),
    );
    navigate(`/workspace/${res.id}`, { state: { label: res.label, remoteRoot: res.remoteRoot } });
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!parsed) {
      setError('Enter a command starting with `ssh`, ending with `user@host` (optional `-p 2222`).');
      return;
    }
    const finalLabel = label.trim() || `${parsed.username}@${parsed.host}`;
    const finalRemotePath = remotePath.trim();
    const body = {
      label: finalLabel,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      remotePath: finalRemotePath,
      password: password || undefined,
      privateKey: privateKey.trim() || undefined,
    };
    const meta = {
      label: finalLabel,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      remotePath: finalRemotePath,
    };
    setBusy(true);
    try {
      const { authSessionId } = await startInteractiveConnection(body);
      setPendingConnect(meta);
      setSshAuthSessionId(authSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onOpenExisting = async (entry: ServerConnection): Promise<void> => {
    if (entry.isOpen) {
      navigate(`/workspace/${entry.id}`, {
        state: { label: entry.label, remoteRoot: entry.remotePath },
      });
      return;
    }
    if (entry.canRevive) {
      try {
        setBusy(true);
        const res = await reopenConnection(entry.id);
        navigate(`/workspace/${entry.id}`, {
          state: { label: entry.label, remoteRoot: res.remoteRoot ?? entry.remotePath },
        });
        return;
      } catch (err) {
        setError(`Could not reopen: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    }
    // Either secret-at-rest isn't configured or we don't own the secret —
    // pre-fill the form so the user can re-enter the password and rebuild.
    setLabel(entry.label);
    const portPart = entry.port === 22 ? "" : `-p ${entry.port} `;
    setSshCommand(`ssh ${portPart}${entry.username}@${entry.host}`);
    setRemotePath(entry.remotePath);
    setPassword("");
    setPrivateKey("");
    setError("Workspace is not open on the server. Re-enter your password and click Connect.");
  };

  const onForgetServer = async (entry: ServerConnection): Promise<void> => {
    if (!confirm(`Delete the "${entry.label}" workspace from the server? Members will lose access.`)) {
      return;
    }
    try {
      await deleteConnection(entry.id);
      setMyConnections((list) => list.filter((c) => c.id !== entry.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="connection-page">
      <div className="panel">
        <h1 style={{ marginTop: 0, fontSize: "1.25rem" }}>New remote connection</h1>
        <p className="hint" style={{ marginTop: "-0.25rem" }}>
          The middleman opens an SFTP session over SSH to list and edit files under the remote folder you choose. Use only on
          trusted networks; credentials are sent to your local Conduit process (not stored on disk in this prototype).
        </p>

        {loadingMine ? null : myConnections.length > 0 ? (
          <div className="field">
            <label>My workspaces</label>
            <ul className="recent-connections">
              {myConnections.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="recent-reuse"
                    onClick={() => void onOpenExisting(entry)}
                    title={
                      entry.isOpen
                        ? "Open this workspace"
                        : entry.canRevive
                          ? "Reopen using the stored SSH credentials"
                          : "Pre-fill the form to reconnect"
                    }
                  >
                    <span className="recent-label">
                      {entry.label} {entry.isOwner ? <small style={{ color: "var(--muted)" }}>(owner)</small> : null}
                      {entry.isOpen ? null : (
                        <small style={{ color: entry.canRevive ? "var(--ctp-green)" : "var(--ctp-peach)" }}>
                          {entry.canRevive ? " · click to revive" : " · closed"}
                        </small>
                      )}
                    </span>
                    <span className="recent-target">
                      {entry.username}@{entry.host}
                      {entry.port === 22 ? "" : `:${entry.port}`} • {entry.remotePath}
                    </span>
                  </button>
                  {entry.isOwner ? (
                    <button
                      type="button"
                      className="ghost recent-forget"
                      onClick={() => void onForgetServer(entry)}
                      title="Delete this workspace (cannot be undone)"
                    >
                      Delete
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="hint">
              Workspaces you own or have been invited to. Closed ones need a fresh SSH connect to reopen.
            </div>
          </div>
        ) : null}
        {recents.length > 0 ? (
          <div className="field">
            <label>Recent connections</label>
            <ul className="recent-connections">
              {recents.map((entry) => (
                <li key={`${entry.username}@${entry.host}:${entry.port}|${entry.remotePath}`}>
                  <button
                    type="button"
                    className="recent-reuse"
                    onClick={() => onReuse(entry)}
                    title="Fill the form below with these details (you'll still need to re-enter the password)"
                  >
                    <span className="recent-label">{entry.label}</span>
                    <span className="recent-target">
                      {entry.username}@{entry.host}
                      {entry.port === 22 ? "" : `:${entry.port}`} • {entry.remotePath}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ghost recent-forget"
                    onClick={() => onForget(entry)}
                    title="Remove this entry from the list"
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
            <div className="hint">
              Passwords and private keys are never saved. Click an entry to pre-fill the form, then enter your secret below.
            </div>
          </div>
        ) : null}
        <form onSubmit={(e) => void onSubmit(e)}>
          <div className="field">
            <label htmlFor="label">Connection name (optional)</label>
            <input
              id="label"
              value={label}
              onChange={(ev) => setLabel(ev.target.value)}
              placeholder="Staging server"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="ssh">SSH command</label>
            <textarea
              id="ssh"
              value={sshCommand}
              onChange={(ev) => setSshCommand(ev.target.value)}
              spellCheck={false}
            />
            <div className="hint">Example: <code>ssh -p 22 ubuntu@203.0.113.10</code></div>
            {parsed ? (
              <div className="ok" style={{ marginTop: "0.35rem" }}>
                Parsed as <code>{`${parsed.username}@${parsed.host}:${parsed.port}`}</code>
              </div>
            ) : (
              <div className="error" style={{ marginTop: "0.35rem" }}>
                Could not parse SSH user/host from this line.
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="remotePath">Remote folder (absolute path on the server)</label>
            <input
              id="remotePath"
              value={remotePath}
              onChange={(ev) => setRemotePath(ev.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password (optional if key below or agent-backed auth)</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="pk">Private key PEM (optional)</label>
            <textarea
              id="pk"
              value={privateKey}
              onChange={(ev) => setPrivateKey(ev.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
            <div className="hint" style={{ marginTop: "0.5rem" }}>
              Auth tips: password logins support <strong>Duo / 2FA</strong> via keyboard-interactive prompts.
              With no password/key, the middleman uses your OpenSSH agent if <code>SSH_AUTH_SOCK</code> is set.
            </div>
          </div>
          {error ? <div className="error">{error}</div> : null}
          <button type="submit" className="primary" disabled={busy || !parsed} style={{ marginTop: "0.75rem" }}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        {sshAuthSessionId && pendingConnect ? (
          <SshAuthModal
            authSessionId={sshAuthSessionId}
            pollStatus={pollSshAuth}
            submitResponses={submitSshAuth}
            onConnected={(res) => {
              setSshAuthSessionId(null);
              finishConnect(res, pendingConnect);
              setPendingConnect(null);
            }}
            onCancel={() => {
              setSshAuthSessionId(null);
              setPendingConnect(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
