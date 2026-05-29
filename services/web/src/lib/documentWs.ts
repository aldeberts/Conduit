import type { WsServerMessage } from "@conduit/shared";
import { DocumentSyncCore, type DocumentSyncCallbacks } from "./documentSyncCore.js";
import { sendWsSync, subscribeWsPath } from "./wsPool.js";

export type { DocumentSyncCallbacks };

/**
 * Syncs a local Y.Doc with the middleman's canonical document over a shared WebSocket pool.
 */
export class DocumentWsSync {
  private readonly core: DocumentSyncCore;
  private readonly connectionId: string;
  private readonly token?: string;
  private unsubWs: (() => void) | null = null;

  constructor(connectionId: string, path: string, callbacks: DocumentSyncCallbacks = {}, token?: string) {
    this.connectionId = connectionId;
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
}
