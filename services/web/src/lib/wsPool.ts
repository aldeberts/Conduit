import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import { dispatchMessage, queueSubscribe, socketBusy, WS_OPEN } from "@conduit/client";

function wsUrl(token?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${host}/api/ws${q}`;
}

type PathHandler = (msg: WsServerMessage) => void;
type PtyHandler = (msg: WsServerMessage) => void;
type TreeHandler = (msg: Extract<WsServerMessage, { type: "tree_changed" }>) => void;

type Pool = {
  connectionId: string;
  token?: string;
  ws: WebSocket | null;
  paths: Map<string, Set<PathHandler>>;
  ptyHandlers: Set<PtyHandler>;
  treeHandlers: Set<TreeHandler>;
  ptySubscribed: boolean;
  connecting: boolean;
  shuttingDown: boolean;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  idleCloseTimer: ReturnType<typeof setTimeout> | null;
  pendingSync: Extract<WsClientMessage, { type: "sync" }>[];
  pendingSubscribes: Extract<WsClientMessage, { type: "subscribe" }>[];
};

const pools = new Map<string, Pool>();

function poolKey(connectionId: string, token?: string): string {
  return `${connectionId}\0${token ?? ""}`;
}

function getPool(connectionId: string, token?: string): Pool {
  const key = poolKey(connectionId, token);
  let pool = pools.get(key);
  if (!pool) {
    pool = {
      connectionId,
      token,
      ws: null,
      paths: new Map(),
      ptyHandlers: new Set(),
      treeHandlers: new Set(),
      ptySubscribed: false,
      connecting: false,
      shuttingDown: false,
      reconnectDelayMs: 50,
      reconnectTimer: null,
      idleCloseTimer: null,
      pendingSync: [],
      pendingSubscribes: [],
    };
    pools.set(key, pool);
  }
  return pool;
}

function poolInUse(pool: Pool): boolean {
  return pool.paths.size > 0 || pool.ptyHandlers.size > 0 || pool.treeHandlers.size > 0;
}

function flushPendingSubscribes(pool: Pool): void {
  for (const msg of pool.pendingSubscribes) {
    send(pool, msg);
  }
  pool.pendingSubscribes = [];
}

function requestSubscribe(pool: Pool, path: string): void {
  if (pool.ws?.readyState === WS_OPEN) {
    send(pool, { type: "subscribe", connectionId: pool.connectionId, path });
    return;
  }
  queueSubscribe(pool, path);
}

function resubscribeAll(pool: Pool): void {
  // Drop any queued subscribes: pool.paths is the authoritative set of subscriptions and
  // we're about to send one subscribe per path. Without this we'd double-subscribe on
  // first connect (queued during connect + emitted by this loop).
  pool.pendingSubscribes = [];
  for (const path of pool.paths.keys()) {
    send(pool, { type: "subscribe", connectionId: pool.connectionId, path });
  }
  if (pool.ptyHandlers.size > 0) {
    send(pool, { type: "pty_subscribe", connectionId: pool.connectionId });
    pool.ptySubscribed = true;
  }
}

function dispatch(pool: Pool, msg: WsServerMessage): void {
  dispatchMessage(
    {
      paths: pool.paths,
      ptyHandlers: pool.ptyHandlers,
      treeHandlers: pool.treeHandlers,
    },
    msg,
  );
}

function flushPendingSync(pool: Pool): void {
  if (pool.ws?.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const msg of pool.pendingSync) {
    pool.ws.send(JSON.stringify(msg));
  }
  pool.pendingSync = [];
}

function send(pool: Pool, msg: WsClientMessage): void {
  if (msg.type === "sync" && pool.ws?.readyState !== WebSocket.OPEN) {
    pool.pendingSync.push(msg);
    return;
  }
  if (pool.ws?.readyState === WebSocket.OPEN) {
    pool.ws.send(JSON.stringify(msg));
  }
}

function clearReconnectTimer(pool: Pool): void {
  if (pool.reconnectTimer) {
    clearTimeout(pool.reconnectTimer);
    pool.reconnectTimer = null;
  }
}

function scheduleReconnect(pool: Pool): void {
  if (pool.shuttingDown || !poolInUse(pool) || pool.reconnectTimer) {
    return;
  }
  const delay = pool.reconnectDelayMs;
  pool.reconnectTimer = setTimeout(() => {
    pool.reconnectTimer = null;
    ensureConnected(pool);
  }, delay);
  pool.reconnectDelayMs = Math.min(5000, Math.round(delay * 1.5));
}

function ensureConnected(pool: Pool): void {
  if (socketBusy(pool)) {
    return;
  }
  if (pool.ws) {
    pool.ws = null;
  }
  clearReconnectTimer(pool);
  pool.connecting = true;
  const socket = new WebSocket(wsUrl(pool.token));
  pool.ws = socket;

  socket.onopen = () => {
    pool.connecting = false;
    pool.reconnectDelayMs = 50;
    resubscribeAll(pool);
    flushPendingSync(pool);
  };

  socket.onmessage = (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    try {
      dispatch(pool, JSON.parse(raw) as WsServerMessage);
    } catch {
      /* ignore */
    }
  };

  socket.onclose = () => {
    const wasActive = pool.ws === socket;
    pool.ws = null;
    pool.connecting = false;
    pool.ptySubscribed = false;
    if (!wasActive) {
      return;
    }
    const shuttingDown = pool.shuttingDown;
    pool.shuttingDown = false;
    if (!shuttingDown && poolInUse(pool)) {
      scheduleReconnect(pool);
    }
  };

  socket.onerror = () => {
    dispatch(pool, { type: "error", message: "websocket_error" });
  };
}

function scheduleIdleClose(pool: Pool, connectionId: string, token?: string): void {
  if (poolInUse(pool)) {
    return;
  }
  if (pool.idleCloseTimer) {
    clearTimeout(pool.idleCloseTimer);
  }
  pool.idleCloseTimer = setTimeout(() => {
    pool.idleCloseTimer = null;
    if (poolInUse(pool)) {
      return;
    }
    clearReconnectTimer(pool);
    pool.shuttingDown = true;
    pool.ws?.close();
    pool.ws = null;
    pools.delete(poolKey(connectionId, token));
  }, 200);
}

export function subscribeWsPath(
  connectionId: string,
  path: string,
  handler: PathHandler,
  token?: string,
): () => void {
  const pool = getPool(connectionId, token);
  pool.shuttingDown = false;
  if (pool.idleCloseTimer) {
    clearTimeout(pool.idleCloseTimer);
    pool.idleCloseTimer = null;
  }
  let handlers = pool.paths.get(path);
  if (!handlers) {
    handlers = new Set();
    pool.paths.set(path, handlers);
  }
  handlers.add(handler);
  const isFirstHandler = handlers.size === 1;

  if (isFirstHandler) {
    requestSubscribe(pool, path);
    if (!socketBusy(pool)) {
      ensureConnected(pool);
    }
  }

  return () => {
    const set = pool.paths.get(path);
    if (!set) {
      return;
    }
    set.delete(handler);
    if (set.size === 0) {
      pool.paths.delete(path);
      if (pool.ws?.readyState === WebSocket.OPEN) {
        send(pool, { type: "unsubscribe", connectionId, path });
      }
    }
    scheduleIdleClose(pool, connectionId, token);
  };
}

export function subscribePty(
  connectionId: string,
  handler: PtyHandler,
  token?: string,
): () => void {
  const pool = getPool(connectionId, token);
  pool.shuttingDown = false;
  if (pool.idleCloseTimer) {
    clearTimeout(pool.idleCloseTimer);
    pool.idleCloseTimer = null;
  }
  pool.ptyHandlers.add(handler);

  if (pool.ws?.readyState === WebSocket.OPEN) {
    if (!pool.ptySubscribed) {
      send(pool, { type: "pty_subscribe", connectionId });
      pool.ptySubscribed = true;
    }
  } else if (!pool.connecting) {
    ensureConnected(pool);
  }

  return () => {
    pool.ptyHandlers.delete(handler);
    if (pool.ptyHandlers.size === 0 && pool.ws?.readyState === WebSocket.OPEN) {
      send(pool, { type: "pty_unsubscribe", connectionId });
      pool.ptySubscribed = false;
    }
    scheduleIdleClose(pool, connectionId, token);
  };
}

/**
 * Subscribes to broadcast `tree_changed` events. The handler is invoked for
 * events from ANY connectionId — call sites must filter by `msg.connectionId`
 * if they care. Returns an unsubscribe function.
 */
export function subscribeWsTree(
  connectionId: string,
  handler: TreeHandler,
  token?: string,
): () => void {
  const pool = getPool(connectionId, token);
  pool.shuttingDown = false;
  if (pool.idleCloseTimer) {
    clearTimeout(pool.idleCloseTimer);
    pool.idleCloseTimer = null;
  }
  pool.treeHandlers.add(handler);
  if (pool.ws?.readyState !== WebSocket.OPEN && !pool.connecting) {
    ensureConnected(pool);
  }
  return () => {
    pool.treeHandlers.delete(handler);
    scheduleIdleClose(pool, connectionId, token);
  };
}

export function sendWsSync(
  connectionId: string,
  path: string,
  update: string,
  token?: string,
): void {
  const pool = getPool(connectionId, token);
  if (pool.ws?.readyState !== WebSocket.OPEN) {
    if (!pool.connecting && !pool.shuttingDown) {
      ensureConnected(pool);
    }
  }
  send(pool, { type: "sync", connectionId, path, update });
}

export function sendWsAwareness(
  connectionId: string,
  path: string,
  update: string,
  token?: string,
): void {
  const pool = getPool(connectionId, token);
  // Awareness is intentionally fire-and-forget: if the socket is dead the
  // y-protocols 30s self-renew will re-emit once we reconnect.
  send(pool, { type: "awareness", connectionId, path, update });
}

export function sendWsSave(connectionId: string, path: string, token?: string): boolean {
  const pool = getPool(connectionId, token);
  if (pool.ws?.readyState !== WebSocket.OPEN) {
    return false;
  }
  send(pool, { type: "save", connectionId, path });
  return true;
}

export function sendWsRefresh(
  connectionId: string,
  path: string,
  force: boolean,
  token?: string,
): boolean {
  const pool = getPool(connectionId, token);
  if (pool.ws?.readyState !== WebSocket.OPEN) {
    return false;
  }
  send(pool, { type: "refresh", connectionId, path, force });
  return true;
}

export function sendPtyInput(connectionId: string, dataB64: string, token?: string): void {
  const pool = getPool(connectionId, token);
  if (pool.ws?.readyState !== WebSocket.OPEN) {
    if (!pool.connecting && !pool.shuttingDown) {
      ensureConnected(pool);
    }
  }
  send(pool, { type: "pty_input", connectionId, data: dataB64 });
}

export function sendPtyResize(
  connectionId: string,
  cols: number,
  rows: number,
  token?: string,
): void {
  const pool = getPool(connectionId, token);
  send(pool, { type: "pty_resize", connectionId, cols, rows });
}
