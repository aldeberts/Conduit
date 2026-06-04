import { useEffect, useState } from "react";
import {
  inviteMember,
  listMembers,
  removeMember,
  type ConnectionMember,
} from "../lib/api";

type Props = {
  connectionId: string;
  onClose: () => void;
};

/**
 * Phase 2 workspace members panel. Shown as a modal over the editor. The
 * owner can invite new members by email or revoke existing ones. Non-owners
 * see the list read-only and can leave the workspace.
 *
 * The server is the source of truth for permissions; this UI just surfaces
 * the affordances. If the user isn't allowed to invite, the API returns 403
 * and we surface it as an inline error.
 */
export function MembersPanel({ connectionId, onClose }: Props): JSX.Element {
  const [members, setMembers] = useState<ConnectionMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listMembers(connectionId);
        if (!cancelled) setMembers(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const onInvite = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const email = inviteEmail.trim();
    if (!email) {
      setError("Email is required.");
      return;
    }
    setBusy(true);
    try {
      const m = await inviteMember(connectionId, email);
      setMembers((prev) => (prev.find((x) => x.userId === m.userId) ? prev : [...prev, m]));
      setInviteEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (m: ConnectionMember): Promise<void> => {
    if (m.role === "owner") return;
    if (!confirm(`Remove ${m.email} from this workspace?`)) return;
    setError(null);
    try {
      await removeMember(connectionId, m.userId);
      setMembers((prev) => prev.filter((x) => x.userId !== m.userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="panel modal-panel" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Workspace members</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint" style={{ marginTop: "0.4rem" }}>
          Anyone here can read and edit files in this workspace. The owner can invite or remove
          members.
        </p>

        {loading ? (
          <p className="hint">Loading…</p>
        ) : (
          <ul className="recent-connections" style={{ marginTop: "0.6rem" }}>
            {members.map((m) => (
              <li key={m.userId}>
                <div className="recent-reuse" style={{ cursor: "default" }}>
                  <span className="recent-label">
                    {m.email}{" "}
                    <small style={{ color: m.role === "owner" ? "var(--ctp-yellow)" : "var(--muted)" }}>
                      {m.role}
                    </small>
                  </span>
                </div>
                {m.role === "member" ? (
                  <button
                    type="button"
                    className="ghost recent-forget"
                    onClick={() => void onRemove(m)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(e) => void onInvite(e)} style={{ marginTop: "0.75rem" }}>
          <div className="field">
            <label htmlFor="invite-email">Invite by email</label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(ev) => setInviteEmail(ev.target.value)}
              placeholder="teammate@example.com"
              autoComplete="off"
            />
            <div className="hint">The user must already have a Conduit account.</div>
          </div>
          {error ? <div className="error">{error}</div> : null}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </form>
      </div>
    </div>
  );
}
