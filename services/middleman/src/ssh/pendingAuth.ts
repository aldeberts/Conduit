import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { recordAudit } from "../db/audit.js";
import { sealSecret, secretsConfigured } from "../auth/secrets.js";
import { createSftpConnectionInteractive, type CreateConnectionInput } from "./registry.js";
import {
  tryAutoFillKeyboardResponses,
  buildKeyboardResponses,
  duoInputPromptIndex,
  formatSshAuthTranscript,
  type SshAuthPrompt,
} from "./keyboardInteractive.js";

export type { SshAuthPrompt };

export type SshAuthSessionPublic =
  | { status: "connecting"; phase?: "dialing" | "password_sent" | "duo_pending" }
  | { status: "awaiting_input"; prompts: SshAuthPrompt[]; instructions: string }
  | { status: "connected"; id: string; remoteRoot: string; label: string }
  | { status: "failed"; message: string; transcript?: string };

type PendingSession = {
  id: string;
  userId: string | null;
  input: CreateConnectionInput;
  status: SshAuthSessionPublic["status"];
  connectPhase?: "dialing" | "password_sent" | "duo_pending";
  prompts: SshAuthPrompt[];
  instructions: string;
  lastTranscript?: string;
  message?: string;
  result?: { id: string; remoteRoot: string };
  resolveResponses?: (responses: string[]) => void;
  expiresAt: number;
  db: Db | null;
  secretsKey?: string;
};

const sessions = new Map<string, PendingSession>();
const TTL_MS = 10 * 60 * 1000;

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) {
      s.resolveResponses?.([]);
      sessions.delete(id);
    }
  }
}

type StartSessionOpts = {
  input: CreateConnectionInput;
  userId: string | null;
  db: Db | null;
  secretsKey?: string;
};

/** Kick off an SSH+SFTP dial that can pause for keyboard-interactive (Duo, OTP, etc.). */
export function startSshAuthSession(opts: StartSessionOpts): string {
  purgeExpired();
  const id = randomUUID();
  const session: PendingSession = {
    id,
    userId: opts.userId,
    input: opts.input,
    status: "connecting",
    prompts: [],
    instructions: "",
    expiresAt: Date.now() + TTL_MS,
    db: opts.db,
    secretsKey: opts.secretsKey,
  };
  sessions.set(id, session);
  void runConnect(session);
  return id;
}

async function runConnect(session: PendingSession): Promise<void> {
  try {
    const result = await createSftpConnectionInteractive(session.input, async (prompts, instructions) => {
      session.lastTranscript = formatSshAuthTranscript(prompts, instructions);
      process.stderr.write(
        `[conduit] ssh auth round: ${JSON.stringify({ sessionId: session.id, promptCount: prompts.length, instructions: instructions.slice(0, 80), firstPrompt: prompts[0]?.prompt.slice(0, 80) })}\n`,
      );
      const auto = tryAutoFillKeyboardResponses(prompts, instructions, session.input.password);
      if (auto) {
        session.connectPhase = "password_sent";
        process.stderr.write(`[conduit] ssh auth auto-filled password (${auto.length} response(s))\n`);
        return auto;
      }
      session.connectPhase = "duo_pending";
      session.status = "awaiting_input";
      session.prompts = prompts;
      session.instructions = instructions;
      process.stderr.write(`[conduit] ssh auth awaiting user input (${prompts.length} prompt(s))\n`);
      return new Promise<string[]>((resolve) => {
        session.resolveResponses = resolve;
      });
    });

    persistConnectionRow(session, result.id);
    session.status = "connected";
    session.result = result;
  } catch (err) {
    session.status = "failed";
    session.message = err instanceof Error ? err.message : String(err);
  } finally {
    session.resolveResponses = undefined;
  }
}

function persistConnectionRow(session: PendingSession, connectionId: string): void {
  const { db, userId, input, secretsKey } = session;
  if (!db || !userId) return;

  const canSeal = secretsConfigured(secretsKey);
  const password = input.password ?? "";
  const privateKey = input.privateKey?.trim() ?? "";
  let secretKind: "password" | "private_key" | "none" = "none";
  let sealed: Uint8Array | null = null;
  if (canSeal) {
    if (privateKey !== "") {
      secretKind = "private_key";
      sealed = sealSecret(privateKey, secretsKey ?? "");
    } else if (password !== "") {
      secretKind = "password";
      sealed = sealSecret(password, secretsKey ?? "");
    }
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO connections
       (id, owner_user_id, label, host, port, username, remote_path, secret_kind, encrypted_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectionId,
    userId,
    input.label,
    input.host,
    input.port,
    input.username,
    input.remotePath,
    secretKind,
    sealed,
    now,
  );
  db.prepare(
    "INSERT INTO workspace_members (connection_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
  ).run(connectionId, userId, now);
  recordAudit(db, {
    userId,
    action: "connection.create",
    targetKind: "connection",
    targetId: connectionId,
    detail: { host: input.host, port: input.port, username: input.username, label: input.label, sealedSecret: sealed != null },
  });
}

export function getSshAuthSession(id: string): SshAuthSessionPublic | null {
  purgeExpired();
  const s = sessions.get(id);
  if (!s) return null;
  switch (s.status) {
    case "connecting":
      return { status: "connecting", phase: s.connectPhase };
    case "awaiting_input":
      return { status: "awaiting_input", prompts: s.prompts, instructions: s.instructions };
    case "connected":
      return {
        status: "connected",
        id: s.result!.id,
        remoteRoot: s.result!.remoteRoot,
        label: s.input.label,
      };
    case "failed":
      return {
        status: "failed",
        message: s.message ?? "connection failed",
        transcript: s.lastTranscript,
      };
    default:
      return null;
  }
}

export function sessionOwner(id: string): string | null | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  return s.userId;
}

export function submitSshAuthResponses(id: string, answer: string): { ok: true; responses: string[] } | { ok: false; reason: string } {
  purgeExpired();
  const s = sessions.get(id);
  if (!s || s.status !== "awaiting_input" || !s.resolveResponses) {
    return { ok: false, reason: "not_waiting" };
  }
  const responses = buildKeyboardResponses(s.prompts, answer);
  if (s.prompts.length > 0 && responses.length !== s.prompts.length) {
    return { ok: false, reason: "response_length_mismatch" };
  }
  process.stderr.write(
    `[conduit] ssh auth submit: ${JSON.stringify({
      answer: answer.trim(),
      promptCount: s.prompts.length,
      targetIndex: s.prompts.length > 0 ? duoInputPromptIndex(s.prompts) : -1,
      prompts: s.prompts.map((p) => p.prompt.slice(0, 80)),
      responses,
    })}\n`,
  );
  s.status = "connecting";
  s.connectPhase = "duo_pending";
  s.prompts = [];
  s.instructions = "";
  const resolve = s.resolveResponses;
  s.resolveResponses = undefined;
  resolve(responses);
  return { ok: true, responses };
}

export function dropSshAuthSession(id: string): void {
  sessions.delete(id);
}

/** Tests only. */
export function resetSshAuthSessionsForTests(): void {
  for (const s of sessions.values()) {
    s.resolveResponses?.([]);
  }
  sessions.clear();
}
