import type { WsServerMessage } from "@conduit/shared";
import { DocumentSyncCore, type DocumentSyncCallbacks } from "@conduit/client";
import {
  sendWsAwareness,
  sendWsRefresh,
  sendWsSave,
  sendWsSync,
  subscribeWsPath,
} from "./wsPool.js";

export type { DocumentSyncCallbacks };

/**
 * Syncs a local Y.Doc with the middleman's canonical document over a shared WebSocket pool.
 */
export class DocumentWsSync {
  private readonly core: DocumentSyncCore;
  private readonly connectionId: string;
  private readonly path: string;
  private readonly token?: string;
  private unsubWs: (() => void) | null = null;

  constructor(connectionId: string, path: string, callbacks: DocumentSyncCallbacks = {}, token?: string) {
    this.connectionId = connectionId;
    this.path = path;
    this.token = token;
    this.core = new DocumentSyncCore(path, callbacks, (update) => {
      sendWsSync(connectionId, path, update, token);
    });
  }

  get ydoc(): DocumentSyncCore["ydoc"] {
    return this.core.ydoc;
  }

  get ytext(): DocumentSyncCore["ytext"] {
    return this.core.ytext;
  }

  connect(): void {
    if (this.unsubWs) {
      return;
    }
    this.core.resetSession();
    this.unsubWs = subscribeWsPath(
      this.connectionId,
      this.core.path,
      (msg: WsServerMessage) => this.core.handleServerMessage(msg),
      this.token,
    );
  }

  disconnect(): void {
    this.disableSync();
    this.unsubWs?.();
    this.unsubWs = null;
  }

  disableSync(): void {
    this.core.disableSync();
  }

  enableSync(): void {
    this.core.enableSync();
  }

  /** Relays a y-protocols awareness payload to other subscribers on the same path. */
  sendAwareness(updateB64: string): void {
    sendWsAwareness(this.connectionId, this.path, updateB64, this.token);
  }

  /** Asks the server to flush the current buffer to remote storage.
   * Returns false if the socket isn't open right now. */
  save(): boolean {
    return sendWsSave(this.connectionId, this.path, this.token);
  }

  /** Asks the server to reload the document from remote storage. */
  refresh(force: boolean): boolean {
    return sendWsRefresh(this.connectionId, this.path, force, this.token);
  }
}
