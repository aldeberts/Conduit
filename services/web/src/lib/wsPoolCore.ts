import type { WsClientMessage, WsServerMessage } from "@conduit/shared";

/** WebSocket readyState: CONNECTING */
export const WS_CONNECTING = 0;
/** WebSocket readyState: OPEN */
export const WS_OPEN = 1;

export type PoolLike = {
  connectionId: string;
  ws: { readyState: number } | null;
  paths: Map<string, Set<unknown>>;
  connecting: boolean;
  shuttingDown: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pendingSubscribes: Extract<WsClientMessage, { type: "subscribe" }>[];
};

export function socketBusy(pool: PoolLike): boolean {
  if (pool.connecting || pool.shuttingDown || pool.reconnectTimer) {
    return true;
  }
  const ws = pool.ws;
  if (!ws) {
    return false;
  }
  return ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING;
}

export function queueSubscribe(pool: PoolLike, path: string): void {
  const exists = pool.pendingSubscribes.some(
    (m) => m.connectionId === pool.connectionId && m.path === path,
  );
  if (!exists) {
    pool.pendingSubscribes.push({
      type: "subscribe",
      connectionId: pool.connectionId,
      path,
    });
  }
}

export function pathsNeedingSubscribe(pool: PoolLike): string[] {
  return [...pool.paths.keys()];
}

export type DispatchTargets = {
  paths: Map<string, Set<(msg: WsServerMessage) => void>>;
  ptyHandlers: Set<(msg: WsServerMessage) => void>;
  treeHandlers: Set<(msg: Extract<WsServerMessage, { type: "tree_changed" }>) => void>;
};

/**
 * Routes a server message to the right handler set.
 *
 * - `error`: fans out to every path handler + every PTY handler (callers usually
 *   surface it as a session error).
 * - `pty_*`: PTY handlers only.
 * - `tree_changed`: tree handlers only (no per-path matching; broadcast event).
 * - everything else: handlers registered for `msg.path` (silently dropped if
 *   no handler exists, since paths can unsubscribe at any time).
 */
export function dispatchMessage(targets: DispatchTargets, msg: WsServerMessage): void {
  if (msg.type === "error") {
    for (const handlers of targets.paths.values()) {
      for (const h of handlers) {
        h(msg);
      }
    }
    for (const h of targets.ptyHandlers) {
      h(msg);
    }
    return;
  }
  if (msg.type === "pty_subscribed" || msg.type === "pty_output") {
    for (const h of targets.ptyHandlers) {
      h(msg);
    }
    return;
  }
  if (msg.type === "tree_changed") {
    for (const h of targets.treeHandlers) {
      h(msg);
    }
    return;
  }
  const handlers = targets.paths.get(msg.path);
  if (!handlers) {
    return;
  }
  for (const h of handlers) {
    h(msg);
  }
}
