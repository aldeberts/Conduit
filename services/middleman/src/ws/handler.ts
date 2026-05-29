import { randomUUID } from "node:crypto";
import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { assertToken, extractTokenFromQuery } from "../auth.js";
import { agentLog } from "../debugAgentLog.js";
import {
  applyDocumentSync,
  subscribeDocument,
  unsubscribeDocument,
} from "../documents/registry.js";
import { metrics } from "../metrics.js";
import { resizePty, subscribePty, unsubscribePty, writePtyInput } from "../pty/registry.js";
import { getConnection } from "../ssh/registry.js";

type WsDeps = {
  apiToken?: string;
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

  app.get("/api/ws", { websocket: true }, (socket, request) => {
    const token = extractTokenFromQuery(request.query as Record<string, unknown>);
    if (!assertToken(token, deps.apiToken)) {
      send(socket, { type: "error", message: "unauthorized" });
      socket.close(4401, "unauthorized");
      return;
    }

    const clientId = randomUUID();
    /** Maps `connectionId\0path` → per-path subscription id used for Yjs echo exclusion. */
    const docSubscriptions = new Map<string, string>();
    const ptyConnections = new Set<string>();
    metrics.wsConnections += 1;
    openSockets.add(socket);

    socket.on("message", (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) {
        send(socket, { type: "error", message: "invalid_message" });
        return;
      }

      if (msg.type === "subscribe") {
        const connKnown = Boolean(getConnection(msg.connectionId));
        if (!connKnown) {
          // #region agent log
          agentLog("ws/handler.ts:subscribe", "subscribe unknown_connection", { connectionId: msg.connectionId, path: msg.path }, "H1");
          // #endregion
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        const subKey = `${msg.connectionId}\0${msg.path}`;
        void (async () => {
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
        })();
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
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        void (async () => {
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
        })();
        return;
      }

      if (msg.type === "pty_subscribe") {
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
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        writePtyInput(msg.connectionId, msg.data);
        return;
      }

      if (msg.type === "pty_resize") {
        if (!getConnection(msg.connectionId)) {
          send(socket, { type: "error", message: "unknown_connection" });
          return;
        }
        resizePty(msg.connectionId, msg.cols, msg.rows);
      }
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
  });
}
