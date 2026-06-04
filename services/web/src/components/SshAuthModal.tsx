import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SshAuthPrompt, SshAuthSessionStatus } from "../lib/api";

type Props = {
  authSessionId: string;
  pollStatus: () => Promise<SshAuthSessionStatus>;
  submitResponses: (answer: string) => Promise<{ answer: string; responses: string[] }>;
  onConnected: (result: { id: string; label: string; remoteRoot: string }) => void;
  onCancel: () => void;
};

function parseNumberedOptions(prompts: SshAuthPrompt[], instructions: string): { num: string; label: string }[] {
  const out: { num: string; label: string }[] = [];
  const seen = new Set<string>();
  const lines = [instructions, ...prompts.map((p) => p.prompt)].join("\n").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ num: m[1]!, label: m[2]!.trim() });
    }
  }
  return out;
}

function formatTranscript(prompts: SshAuthPrompt[], instructions: string): string {
  const lines: string[] = [];
  if (instructions.trim()) lines.push(instructions.trim());
  for (const p of prompts) {
    if (p.prompt.trim()) lines.push(p.prompt);
  }
  return lines.join("\n");
}

function activePromptIndex(prompts: SshAuthPrompt[]): number {
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i]!.prompt.trim();
    if (/passcode or option|passcode\s*:|verification code|enter.*(?:passcode|option)/i.test(p)) {
      return i;
    }
  }
  for (let i = prompts.length - 1; i >= 0; i--) {
    if (prompts[i]!.echo) return i;
  }
  return prompts.length > 0 ? prompts.length - 1 : 0;
}

/**
 * Terminal-style 2FA modal. Password rounds are auto-filled on the server using
 * the password from the connect form — this only appears for Duo / OTP prompts.
 */
export function SshAuthModal({
  authSessionId,
  pollStatus,
  submitResponses,
  onConnected,
  onCancel,
}: Props): JSX.Element {
  const [status, setStatus] = useState<SshAuthSessionStatus>({ status: "connecting" });
  const [lastTranscript, setLastTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const [lastSent, setLastSent] = useState<{ answer: string; responses: string[] } | null>(null);
  const awaitingRoundKeyRef = useRef("");
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const awaiting = status.status === "awaiting_input" ? status : null;
  const failed = status.status === "failed" ? status : null;
  const options = useMemo(
    () => (awaiting ? parseNumberedOptions(awaiting.prompts, awaiting.instructions) : []),
    [awaiting],
  );
  const transcript = awaiting
    ? formatTranscript(awaiting.prompts, awaiting.instructions)
    : lastTranscript;
  const activeIdx = awaiting ? activePromptIndex(awaiting.prompts) : 0;
  const activeLabel =
    awaiting && awaiting.prompts[activeIdx]?.prompt
      ? awaiting.prompts[activeIdx]!.prompt
      : "Your response";

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await pollStatus();
        if (cancelled) return;
        setPollErrors(0);
        setStatus(next);
        if (next.status === "awaiting_input") {
          const roundKey = `${next.instructions}\0${next.prompts.map((p) => `${p.prompt}\x01${p.echo}`).join("\x02")}`;
          setLastTranscript(formatTranscript(next.prompts, next.instructions));
          if (roundKey !== awaitingRoundKeyRef.current) {
            awaitingRoundKeyRef.current = roundKey;
            setAnswer("");
            setError(null);
            setLastSent(null);
          }
        }
        if (next.status === "failed" && next.transcript) {
          setLastTranscript(next.transcript);
        }
        if (next.status === "connected") {
          onConnectedRef.current({
            id: next.id,
            label: next.label,
            remoteRoot: next.remoteRoot,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setPollErrors((n) => n + 1);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 400);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authSessionId, pollStatus]);

  const sendAnswer = async (value: string): Promise<void> => {
    if (busy || status.status !== "awaiting_input") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    setBusy(true);
    try {
      const sent = await submitResponses(trimmed);
      setLastSent(sent);
      setAnswer("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectingHint =
    status.status === "connecting" && status.phase === "password_sent"
      ? "Password sent — waiting for Duo prompts from the server…"
      : status.status === "connecting" && status.phase === "duo_pending"
        ? "Sent your choice to the SSH server — approve Duo on your phone if you chose push."
        : "Connecting to SSH server…\n(password from the form will be sent automatically)";

  const terminalBody =
    transcript.trim() !== ""
      ? transcript
      : status.status === "connecting"
        ? connectingHint
        : failed
          ? "(no output from server)"
          : "";

  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel panel ssh-auth-modal" role="dialog" aria-labelledby="ssh-auth-title">
        <h2 id="ssh-auth-title" style={{ marginTop: 0, fontSize: "1.1rem" }}>
          SSH verification (Duo / 2FA)
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Same prompts you would see in Terminal. Your SSH password was already sent from the connect form.
        </p>

        <pre className="ssh-auth-terminal" aria-label="SSH server output">
          {terminalBody}
        </pre>

        {failed ? (
          <div className="error" style={{ marginBottom: "0.75rem" }}>
            Connection failed: {failed.message}
          </div>
        ) : null}

        {lastSent ? (
          <p className="hint ok" style={{ marginBottom: "0.75rem" }}>
            Sent <code>{lastSent.answer}</code> to SSH
            {lastSent.responses.length > 0
              ? ` (${lastSent.responses.filter((r) => r.length > 0).length} non-empty slot${lastSent.responses.filter((r) => r.length > 0).length === 1 ? "" : "s"})`
              : null}
            . Waiting for the server…
          </p>
        ) : null}

        {status.status === "connecting" && !failed && !lastSent ? (
          <p className="hint">
            {status.phase === "password_sent"
              ? "Your password was accepted. Duo options should appear in a moment."
              : "Waiting for the SSH server…"}
          </p>
        ) : null}

        {awaiting ? (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void sendAnswer(answer);
            }}
          >
            {options.length > 0 ? (
              <div className="ssh-auth-options">
                {options.map((opt) => (
                  <button
                    key={opt.num}
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void sendAnswer(opt.num)}
                  >
                    {opt.num}. {opt.label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor="ssh-auth-answer">{activeLabel}</label>
              <input
                id="ssh-auth-answer"
                type="text"
                value={answer}
                autoFocus
                autoComplete="off"
                disabled={busy}
                placeholder={options.length ? "Or type an option number / passcode" : "Type your response"}
                onChange={(ev) => setAnswer(ev.target.value)}
              />
            </div>
            <button
              type="submit"
              className="primary"
              disabled={busy || !answer.trim()}
              style={{ marginTop: "0.5rem" }}
            >
              {busy ? "Sending…" : "Send response"}
            </button>
          </form>
        ) : null}

        {error ? (
          <div className="error">
            {error}
            {pollErrors > 0 ? ` (poll error ${pollErrors}; retrying…)` : null}
          </div>
        ) : null}

        <button type="button" className="ghost" disabled={busy} onClick={onCancel} style={{ marginTop: "0.75rem" }}>
          {failed ? "Close" : "Cancel"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
