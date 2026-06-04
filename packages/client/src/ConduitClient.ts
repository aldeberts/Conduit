/**
 * `ConduitClient` is the IDE-friendly entry point for talking to a Conduit
 * server. It hides the WebSocket lifecycle, exposes typed methods for the
 * HTTP endpoints, and returns Yjs-backed document objects from `openDocument`.
 *
 * Transports are injected so the same class works in browsers (default fetch
 * + WebSocket) and in Node hosts like VS Code (`ws` package).
 */

import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate as yApplyAwarenessUpdate,
  encodeAwarenessUpdate as yEncodeAwarenessUpdate,
} from "y-protocols/awareness";
import { DocumentSyncCore, base64ToUint8 as coreBase64ToUint8, uint8ToBase64 } from "./core/documentSync.js";

/** Subset of `globalThis.fetch` we actually use. */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: "include" | "omit" | "same-origin";
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Subset of the browser WebSocket interface we use. */
export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "close", listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(event: "error", listener: (ev: unknown) => void): void;
  addEventListener(event: "message", listener: (ev: { data: unknown }) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ConduitClientOptions = {
  /** Base URL of the Conduit server, e.g. `https://conduit.example.com`. */
  baseUrl: string;
  /** Personal access token (preferred for IDE clients) OR admin token. */
  token?: string;
  /** Override the HTTP transport (Node fetch / VS Code's). Defaults to global fetch. */
  fetch?: FetchLike;
  /**
   * Override the WebSocket factory. In a browser leave undefined to use the
   * built-in WebSocket. In Node:
   *   import WS from "ws";
   *   new ConduitClient({ baseUrl, token, webSocketFactory: (url) => new WS(url) as any })
   */
  webSocketFactory?: WebSocketFactory;
};

export type ConnectionsListItem = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  createdAt: number;
  isOwner: boolean;
  isOpen: boolean;
  canRevive: boolean;
};

export type ConduitDocumentOptions = {
  /** Awareness state to advertise to other clients (`{user: {name, color}}`). */
  initialAwareness?: Record<string, unknown>;
};

/**
 * A live, server-synced Y.Doc plus the controls callers most often want
 * (save, refresh, close). The underlying y-protocols Awareness lives on
 * `awareness` and is automatically relayed to/from the server.
 */
export type ConduitDocument = {
  readonly connectionId: string;
  readonly path: string;
  /** Editable Yjs document; bind to your editor with y-monaco / y-codemirror.next / etc. */
  readonly ydoc: Y.Doc;
  /** The y-protocols Awareness instance for presence (cursors, selections). */
  readonly awareness: import("y-protocols/awareness").Awareness;
  /** Persist the current Y.Doc buffer to the remote host via SFTP. */
  save(): void;
  /** Reload from remote disk. `force=true` discards any local dirty edits. */
  refresh(force?: boolean): void;
  /** Unsubscribe and stop syncing this document. */
  close(): void;
  /** Wait until the initial sync (subscribed message) has arrived. */
  ready(): Promise<void>;
  /** Listen for save/refresh completion. */
  onOpResult(handler: (op: "save" | "refresh", ok: boolean, error?: string) => void): () => void;
  /** Notified when the doc was deleted/renamed server-side; the editor should close. */
  onEvicted(handler: (reason: "deleted" | "renamed" | "evicted") => void): () => void;
};

/* ---------- implementation ---------------------------------------------- */

const WS_OPEN_STATE = 1;

export class ConduitClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private ws: WebSocketLike | null = null;
  private wsReady: Promise<void> | null = null;
  /** docs keyed by `connectionId\0path` */
  private docs = new Map<string, InternalDoc>();

  constructor(opts: ConduitClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(this.baseUrl + url, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.wsFactory =
      opts.webSocketFactory ??
      ((url: string) =>
        // The DOM WebSocket isn't typed as WebSocketLike but it's a structural superset.
        new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url));
  }

  /* ----- HTTP --------------------------------------------------------- */

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) {
      h.authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : path;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async listConnections(): Promise<ConnectionsListItem[]> {
    const data = await this.get<{ connections: ConnectionsListItem[] }>("/api/connections");
    return data.connections;
  }

  async ping(): Promise<{ ok: true; principal: string | null }> {
    return this.get("/api/auth/ping");
  }

  /* ----- WebSocket ---------------------------------------------------- */

  private wsUrl(): string {
    const base = this.baseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${base}/api/ws${q}`;
  }

  /** Lazily open the shared WS. Multiple `openDocument` calls share one socket. */
  private ensureSocket(): Promise<WebSocketLike> {
    if (this.ws && this.ws.readyState === WS_OPEN_STATE) {
      return Promise.resolve(this.ws);
    }
    if (this.wsReady) {
      return this.wsReady.then(() => this.ws!);
    }
    this.wsReady = new Promise<void>((resolve, reject) => {
      const socket = this.wsFactory(this.wsUrl());
      this.ws = socket;
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", (ev) => reject(ev));
      socket.addEventListener("close", () => {
        this.ws = null;
        this.wsReady = null;
        // Best-effort tear-down so callers know the docs are dead.
        for (const doc of this.docs.values()) {
          doc.handleSocketClosed();
        }
      });
      socket.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage;
          this.dispatch(msg);
        } catch {
          /* ignore non-JSON */
        }
      });
    });
    return this.wsReady.then(() => this.ws!);
  }

  private send(msg: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN_STATE) {
      throw new Error("websocket not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private dispatch(msg: WsServerMessage): void {
    // Error messages: fan out to every open doc; the underlying core decides
    // whether to surface to its callback.
    if (msg.type === "error") {
      for (const d of this.docs.values()) d.core.handleServerMessage(msg);
      return;
    }
    if (msg.type === "tree_changed" || msg.type === "pty_subscribed" || msg.type === "pty_output") {
      return;
    }
    if (!("path" in msg) || typeof msg.path !== "string") return;
    if (!("connectionId" in msg) || typeof msg.connectionId !== "string") return;
    const doc = this.docs.get(docKey(msg.connectionId, msg.path));
    if (!doc) return;
    doc.core.handleServerMessage(msg);
  }

  /* ----- documents ---------------------------------------------------- */

  async openDocument(
    connectionId: string,
    path: string,
    opts: ConduitDocumentOptions = {},
  ): Promise<ConduitDocument> {
    await this.ensureSocket();
    const existing = this.docs.get(docKey(connectionId, path));
    if (existing) {
      return existing.handle;
    }
    const internal = new InternalDoc(this, connectionId, path);
    this.docs.set(docKey(connectionId, path), internal);

    // Subscribe. The core's `onSubscribed` callback resolves the `ready()` promise.
    this.send({ type: "subscribe", connectionId, path });

    if (opts.initialAwareness) {
      for (const [k, v] of Object.entries(opts.initialAwareness)) {
        internal.awareness.setLocalStateField(k, v);
      }
    }

    return internal.handle;
  }

  closeDocument(connectionId: string, path: string): void {
    const key = docKey(connectionId, path);
    const doc = this.docs.get(key);
    if (!doc) return;
    try {
      this.send({ type: "unsubscribe", connectionId, path });
    } catch {
      /* socket gone */
    }
    doc.destroy();
    this.docs.delete(key);
  }

  /** Called by InternalDoc when it needs to send. Kept private-by-friend. */
  sendForDoc(msg: WsClientMessage): void {
    this.send(msg);
  }

  destroy(): void {
    for (const [, d] of this.docs) d.destroy();
    this.docs.clear();
    if (this.ws) {
      try {
        this.ws.close(1000, "client_destroyed");
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.wsReady = null;
    }
  }
}

function docKey(connectionId: string, path: string): string {
  return `${connectionId}\0${path}`;
}

class InternalDoc {
  readonly client: ConduitClient;
  readonly connectionId: string;
  readonly path: string;
  readonly core: DocumentSyncCore;
  readonly awareness: Awareness;
  readonly handle: ConduitDocument;
  private readyResolvers: Array<() => void> = [];
  private opResultHandlers = new Set<(op: "save" | "refresh", ok: boolean, error?: string) => void>();
  private evictedHandlers = new Set<(reason: "deleted" | "renamed" | "evicted") => void>();
  private subscribed = false;

  constructor(client: ConduitClient, connectionId: string, path: string) {
    this.client = client;
    this.connectionId = connectionId;
    this.path = path;
    // Build core first so `ydoc` exists.
    this.core = new DocumentSyncCore(
      path,
      {
        onSubscribed: () => {
          this.subscribed = true;
          for (const r of this.readyResolvers.splice(0)) r();
        },
        onAwarenessUpdate: (updateB64) => {
          const update = coreBase64ToUint8(updateB64);
          yApplyAwarenessUpdate(this.awareness, update, this.core);
        },
        onOpResult: (op, ok, error) => {
          for (const h of this.opResultHandlers) h(op, ok, error);
        },
        onDocEvicted: (reason) => {
          for (const h of this.evictedHandlers) h(reason);
        },
      },
      (updateB64) => {
        client.sendForDoc({ type: "sync", connectionId, path, update: updateB64 });
      },
    );

    this.awareness = new Awareness(this.core.ydoc);
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = added.concat(updated, removed);
        if (changed.length === 0) return;
        const update = yEncodeAwarenessUpdate(this.awareness, changed);
        client.sendForDoc({
          type: "awareness",
          connectionId,
          path,
          update: uint8ToBase64(update),
        });
      },
    );

    // After construction so closures above can capture `this`.
    this.core.enableSync();

    this.handle = {
      connectionId,
      path,
      ydoc: this.core.ydoc,
      awareness: this.awareness,
      save: () => client.sendForDoc({ type: "save", connectionId, path }),
      refresh: (force = false) => client.sendForDoc({ type: "refresh", connectionId, path, force }),
      close: () => client.closeDocument(connectionId, path),
      ready: () =>
        this.subscribed
          ? Promise.resolve()
          : new Promise<void>((res) => this.readyResolvers.push(res)),
      onOpResult: (handler) => {
        this.opResultHandlers.add(handler);
        return () => this.opResultHandlers.delete(handler);
      },
      onEvicted: (handler) => {
        this.evictedHandlers.add(handler);
        return () => this.evictedHandlers.delete(handler);
      },
    };
  }

  handleSocketClosed(): void {
    this.core.resetSession();
  }

  destroy(): void {
    this.awareness.destroy();
    this.core.ydoc.destroy();
    this.readyResolvers.length = 0;
    this.opResultHandlers.clear();
    this.evictedHandlers.clear();
  }
}

// Re-export the Y namespace so SDK callers don't need a separate yjs install.
export { Y };
