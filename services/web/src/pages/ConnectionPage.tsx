import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createConnection } from "../lib/api";
import { parseSshCommand } from "../lib/parseSsh";

export function ConnectionPage(): JSX.Element {
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [sshCommand, setSshCommand] = useState("ssh user@example.com");
  const [remotePath, setRemotePath] = useState("/home/user/project");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseSshCommand(sshCommand), [sshCommand]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!parsed) {
      setError('Enter a command starting with `ssh`, ending with `user@host` (optional `-p 2222`).');
      return;
    }
    setBusy(true);
    try {
      const res = await createConnection({
        label: label.trim() || `${parsed.username}@${parsed.host}`,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        remotePath: remotePath.trim(),
        password: password || undefined,
        privateKey: privateKey.trim() || undefined,
      });
      navigate(`/workspace/${res.id}`, { state: { label: res.label, remoteRoot: res.remoteRoot } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
              Auth tips: with a password, the server is offered both <code>password</code> and <strong>keyboard-interactive</strong>{" "}
              (common on university hosts). With no password/key, the middleman uses your OpenSSH agent if{" "}
              <code>SSH_AUTH_SOCK</code> is set. Kerberos-only logins are not supported in this prototype—use an SSH key the host
              accepts for SFTP.
            </div>
          </div>
          {error ? <div className="error">{error}</div> : null}
          <button type="submit" className="primary" disabled={busy || !parsed} style={{ marginTop: "0.75rem" }}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
