import { randomUUID } from "node:crypto";
import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { assertToken, extractTokenFromQuery } from "../auth.js";
import { resolvePrincipal, type Principal } from "../auth/principal.js";
import { isMember } from "../db/connections.js";
import type { Db } from "../db/index.js";
import { agentLog } from "../debugAgentLog.js";
import {
  applyDocumentSync,
  awarenessSnapshotsForNewSubscriber,
  relayAwareness,
  refreshDocument,
  saveDocument,
  subscribeDocument,
  unsubscribeDocument,
} from "../documents/registry.js";
import { metrics } from "../metrics.js";
import { resizePty, subscribePty, unsubscribePty, writePtyInput } from "../pty/registry.js";
import { getConnection } from "../ssh/registry.js";

type WsDeps = {
  apiToken?: string;
  /**
   * When provided, the WS handler accepts session cookies and personal access
   * tokens in addition to the shared `apiToken`. Pass null in tests that just
   * exercise the document protocol with no auth at all.
   */
  db?: Db | null;
};

/**
 * All open WebSockets across every Fastify instance in this process. Used by
 * `broadcastWsMessage` for low-volume server-pushed events (e.g. tree changes).
 * Connections are added on upgrade and removed on close.
 */
const openSockets = new Set<WebSocket>();

function send(socket: WebSocket, msg: WsServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/**
 * Sends `msg` to every currently-open WebSocket. Clients are responsible for
 * filtering by `connectionId` (see `wsPool.ts`); we don't track per-connection
 * subscriptions for these broadcast-style events because they're rare.
 */
export function broadcastWsMessage(msg: WsServerMessage): void {
  const json = JSON.stringify(msg);
  for (const socket of openSockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(json);
    }
  }
}

function parseMessage(raw: unknown): WsClientMessage | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as WsClientMessage;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function registerWebSocket(app: FastifyInstance, deps: WsDeps): Promise<void> {
  await app.register(websocket);

  /** Returns true when the principal may operate on `connectionId`. When no
   *  DB is configured (Phase 1 / tests), tenancy is not enforced. */
  const canTouchConnection = (principal: Principal, connectionId: string): boolean => {
    if (!deps.db) return true;
    if (!principal) return false;
    if (principal.kind === "admin_token") return true;
    return isMember(deps.db, connectionId, principal.userId);
  };

  const runSession = (socket: WebSocket, principal: Principal): void => {
    const clientId = randomUUID();
    /** Maps `connectionId\0path` → per-path subscription id used for Yjs echo exclusion. */
    const docSubscriptions = new Map<string, string>();
    const ptyConnections = new Set<string>();
    metrics.wsConnections += 1;
    openSockets.add(socket);

    // Per-socket serial queue. Each message's async work runs to completion
    // before the next one starts, so a `save` issued after `sync` observes the
    // synced state, etc. This is a no-op for purely synchronous handlers.
    let processChain: Promise<void> = Promise.resolve();

    const handleMessageBody = async (msg: WsClientMessage): Promise<void> => {
      // Per-connection tenancy: enforce that this socket's principal is a
      // member of the connection it's trying to touch.
      const guardConn = (connectionId: string): boolean => {
        if (canTouchConnection(principal, connectionId)) return true;
        send(socket, { type: "error", message: "forbidden" });
        return false;
      };
      if (msg.type === "subscribe") {
        if (!guardConn(msg.connectionId)) return;
        const connKnown = Boolean(getConnection(msg.connectionId));
        if (!connKnown) {
          // #region agent log
          agentLog("ws/handler.ts:subscribe", "subscribe unknown_connection", { connectionId: msg.connectionId, path: msg.path }, "H1");
          // #endregion
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        const subKey = `${msg.connectionId}\0${msg.path}`;
        try {
          const priorId = docSubscriptions.get(subKey);
          if (priorId) {
            unsubscribeDocument(msg.connectionId, msg.path, priorId);
          }
          const subscriptionId = randomUUID();
          await subscribeDocument(msg.connectionId, msg.path, {
            id: subscriptionId,
            send: (payload) => send(socket, payload),
          });
          docSubscriptions.set(subKey, subscriptionId);
          // Replay cached awareness states so the joiner sees existing cursors
          // without waiting for the y-protocols 30s self-renew.
          for (const update of awarenessSnapshotsForNewSubscriber(
            msg.connectionId,
            msg.path,
            subscriptionId,
          )) {
            send(socket, {
              type: "awareness",
              connectionId: msg.connectionId,
              path: msg.path,
              update,
            });
          }
          // #region agent log
          agentLog("ws/handler.ts:subscribe", "subscribe ok", { connectionId: msg.connectionId, path: msg.path }, "H2");
          // #endregion
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // #region agent log
          agentLog("ws/handler.ts:subscribe", "subscribe failed", { connectionId: msg.connectionId, path: msg.path, message }, "H2");
          // #endregion
          send(socket, { type: "error", message });
        }
        return;
      }

      if (msg.type === "unsubscribe") {
        const subKey = `${msg.connectionId}\0${msg.path}`;
        const subscriptionId = docSubscriptions.get(subKey);
        if (subscriptionId) {
          unsubscribeDocument(msg.connectionId, msg.path, subscriptionId);
        }
        docSubscriptions.delete(subKey);
        return;
      }

      if (msg.type === "sync") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        try {
          const subKey = `${msg.connectionId}\0${msg.path}`;
          const subscriptionId = docSubscriptions.get(subKey) ?? clientId;
          const update = Buffer.from(msg.update, "base64");
          await applyDocumentSync(msg.connectionId, msg.path, update, subscriptionId);
          // #region agent log
          agentLog("ws/handler.ts:sync", "sync applied", { connectionId: msg.connectionId, path: msg.path, bytes: update.length }, "H5");
          // #endregion
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // #region agent log
          agentLog("ws/handler.ts:sync", "sync failed", { connectionId: msg.connectionId, path: msg.path, message }, "H5");
          // #endregion
          send(socket, { type: "error", message });
        }
        return;
      }

      if (msg.type === "awareness") {
        if (!guardConn(msg.connectionId)) return;
        const subKey = `${msg.connectionId}\0${msg.path}`;
        const subscriptionId = docSubscriptions.get(subKey);
        if (!subscriptionId) {
          // Awareness from a client that hasn't subscribed yet: drop silently.
          // (Subscribing replays the cache, so they'll catch up on subscribe.)
          return;
        }
        relayAwareness(msg.connectionId, msg.path, subscriptionId, msg.update);
        return;
      }

      if (msg.type === "save") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        try {
          await saveDocument(msg.connectionId, msg.path);
          send(socket, {
            type: "op_result",
            connectionId: msg.connectionId,
            path: msg.path,
            op: "save",
            ok: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(socket, {
            type: "op_result",
            connectionId: msg.connectionId,
            path: msg.path,
            op: "save",
            ok: false,
            error: message,
          });
        }
        return;
      }

      if (msg.type === "refresh") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        try {
          await refreshDocument(msg.connectionId, msg.path, msg.force);
          send(socket, {
            type: "op_result",
            connectionId: msg.connectionId,
            path: msg.path,
            op: "refresh",
            ok: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(socket, {
            type: "op_result",
            connectionId: msg.connectionId,
            path: msg.path,
            op: "refresh",
            ok: false,
            error: message,
          });
        }
        return;
      }

      if (msg.type === "pty_subscribe") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        try {
          subscribePty(msg.connectionId, {
            id: clientId,
            send: (payload) => send(socket, payload),
          });
          ptyConnections.add(msg.connectionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(socket, { type: "error", message });
        }
        return;
      }

      if (msg.type === "pty_unsubscribe") {
        unsubscribePty(msg.connectionId, clientId);
        ptyConnections.delete(msg.connectionId);
        return;
      }

      if (msg.type === "pty_input") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        writePtyInput(msg.connectionId, msg.data);
        return;
      }

      if (msg.type === "pty_resize") {
        if (!guardConn(msg.connectionId)) return;
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        resizePty(msg.connectionId, msg.cols, msg.rows);
      }
    };

    socket.on("message", (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) {
        send(socket, { type: "error", message: "invalid_message" });
        return;
      }
      // Chain so the next message starts only after this one finishes its
      // async work. Errors are isolated; one failure can't block the queue.
      processChain = processChain
        .catch(() => undefined)
        .then(() => handleMessageBody(msg));
    });

    socket.on("close", () => {
      metrics.wsConnections = Math.max(0, metrics.wsConnections - 1);
      openSockets.delete(socket);
      for (const [key, subscriptionId] of docSubscriptions) {
        const [connectionId, path] = key.split("\0");
        if (connectionId && path) {
          unsubscribeDocument(connectionId, path, subscriptionId);
        }
      }
      docSubscriptions.clear();
      for (const connectionId of ptyConnections) {
        unsubscribePty(connectionId, clientId);
      }
      ptyConnections.clear();
    });
  };

  app.get("/api/ws", { websocket: true }, (socket, request) => {
    // Accept any of: session cookie, personal access token (header/query),
    // shared admin token. The two-step keeps Phase 0 behavior (just ?token=)
    // working when no DB is wired up.
    void (async () => {
      let principal: Principal = null;
      if (deps.db) {
        try {
          principal = await resolvePrincipal(deps.db, request, deps.apiToken);
        } catch {
          principal = null;
        }
      }
      if (!principal) {
        const token = extractTokenFromQuery(request.query as Record<string, unknown>);
        if (!assertToken(token, deps.apiToken)) {
          send(socket, { type: "error", message: "unauthorized" });
          socket.close(4401, "unauthorized");
          return;
        }
      }
      runSession(socket, principal);
    })();
  });
}
