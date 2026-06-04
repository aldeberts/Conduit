import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  pollSshAuthSession,
  startInteractiveConnection,
  submitSshAuthResponses,
} from "../lib/api";
import { SshAuthModal } from "../components/SshAuthModal";
import { parseSshCommand } from "../lib/parseSsh";
import {
  forgetConnection,
  listRecentConnections,
  rememberConnection,
  type RecentConnection,
} from "../lib/recentConnections";

type PrefillState = {
  prefill?: {
    label: string;
    host: string;
    port: number;
    username: string;
    remotePath: string;
  };
} | null;

export function ConnectionPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as PrefillState)?.prefill;

  const [label, setLabel] = useState(prefill?.label ?? "");
  const [sshCommand, setSshCommand] = useState(() => {
    if (prefill) {
      const portPart = prefill.port === 22 ? "" : `-p ${prefill.port} `;
      return `ssh ${portPart}${prefill.username}@${prefill.host}`;
    }
    return "ssh user@example.com";
  });
  const [remotePath, setRemotePath] = useState(prefill?.remotePath ?? "/home/user/project");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    prefill ? "Re-enter your password to reconnect this workspace." : null,
  );
  const [recents, setRecents] = useState<RecentConnection[]>(() => listRecentConnections());
  const [sshAuthSessionId, setSshAuthSessionId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<{
    label: string;
    host: string;
    port: number;
    username: string;
    remotePath: string;
  } | null>(null);

  useEffect(() => {
    if (!prefill) return;
    setLabel(prefill.label);
    const portPart = prefill.port === 22 ? "" : `-p ${prefill.port} `;
    setSshCommand(`ssh ${portPart}${prefill.username}@${prefill.host}`);
    setRemotePath(prefill.remotePath);
  }, [prefill]);

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

  return (
    <div className="connection-page">
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          <Link to="/" className="ghost dashboard-back">
            ← Back to dashboard
          </Link>
        </p>
        <h1 style={{ marginTop: "0.5rem", fontSize: "1.25rem" }}>New connection</h1>
        <p className="hint" style={{ marginTop: "-0.25rem" }}>
          Open an SFTP session over SSH to edit files on a remote host. Password logins support Duo / 2FA.
        </p>

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
                    title="Fill the form with these details (re-enter password below)"
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
