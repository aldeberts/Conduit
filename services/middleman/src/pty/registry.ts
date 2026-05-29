import type { WsServerMessage } from "@conduit/shared";
import type { Channel } from "ssh2";
import { getConnection, openShell } from "../ssh/registry.js";

export type PtySubscriber = {
  id: string;
  send: (msg: WsServerMessage) => void;
};

type PtySession = {
  connectionId: string;
  stream: Channel | null;
  subscribers: Map<string, PtySubscriber>;
  cols: number;
  rows: number;
  starting: boolean;
};

const sessions = new Map<string, PtySession>();

function getOrCreateSession(connectionId: string): PtySession {
  let session = sessions.get(connectionId);
  if (!session) {
    session = {
      connectionId,
      stream: null,
      subscribers: new Map(),
      cols: 80,
      rows: 24,
      starting: false,
    };
    sessions.set(connectionId, session);
  }
  return session;
}

function broadcast(session: PtySession, msg: WsServerMessage): void {
  for (const sub of session.subscribers.values()) {
    sub.send(msg);
  }
}

function attachStreamHandlers(session: PtySession, stream: Channel): void {
  stream.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    broadcast(session, {
      type: "pty_output",
      connectionId: session.connectionId,
      data: buf.toString("base64"),
    });
  });
  stream.stderr?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    broadcast(session, {
      type: "pty_output",
      connectionId: session.connectionId,
      data: buf.toString("base64"),
    });
  });
  stream.on("close", () => {
    session.stream = null;
    broadcast(session, { type: "error", message: "pty_closed" });
  });
}

async function ensureShell(session: PtySession): Promise<void> {
  if (session.stream || session.starting) {
    return;
  }
  if (!getConnection(session.connectionId)) {
    throw new Error("unknown_connection");
  }
  session.starting = true;
  try {
    const stream = await openShell(session.connectionId, session.cols, session.rows);
    session.stream = stream;
    attachStreamHandlers(session, stream);
  } finally {
    session.starting = false;
  }
}

export function subscribePty(connectionId: string, subscriber: PtySubscriber): void {
  const session = getOrCreateSession(connectionId);
  session.subscribers.set(subscriber.id, subscriber);
  void ensureShell(session)
    .then(() => {
      session.stream?.setWindow(session.rows, session.cols, 0, 0);
      subscriber.send({ type: "pty_subscribed", connectionId });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      subscriber.send({ type: "error", message });
    });
}

export function unsubscribePty(connectionId: string, subscriberId: string): void {
  const session = sessions.get(connectionId);
  if (!session) {
    return;
  }
  session.subscribers.delete(subscriberId);
  if (session.subscribers.size === 0) {
    destroyPtySession(connectionId);
  }
}

export function writePtyInput(connectionId: string, dataB64: string): void {
  const session = sessions.get(connectionId);
  if (!session?.stream) {
    return;
  }
  session.stream.write(Buffer.from(dataB64, "base64"));
}

export function resizePty(connectionId: string, cols: number, rows: number): void {
  const session = getOrCreateSession(connectionId);
  session.cols = cols;
  session.rows = rows;
  session.stream?.setWindow(rows, cols, 0, 0);
}

export function destroyPtySession(connectionId: string): void {
  const session = sessions.get(connectionId);
  if (!session) {
    return;
  }
  sessions.delete(connectionId);
  session.subscribers.clear();
  session.stream?.close();
  session.stream = null;
}

