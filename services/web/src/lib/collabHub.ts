import type { WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import { DocumentSyncCore, uint8ToBase64 } from "@conduit/client";

/**
 * In-memory hub simulating the middleman for two browser tabs (two WS connections).
 * Used by unit tests only.
 */
export class CollabHub {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly subscribers = new Map<string, Map<string, (msg: WsServerMessage) => void>>();

  private docKey(connectionId: string, path: string): string {
    return `${connectionId}\0${path}`;
  }

  private ensureDoc(connectionId: string, path: string, initial: string): Y.Doc {
    const key = this.docKey(connectionId, path);
    let doc = this.docs.get(key);
    if (!doc) {
      doc = new Y.Doc();
      doc.getText("content").insert(0, initial);
      this.docs.set(key, doc);
      this.subscribers.set(key, new Map());
    }
    return doc;
  }

  openDocument(connectionId: string, path: string, initial: string): string {
    return this.ensureDoc(connectionId, path, initial).getText("content").toString();
  }

  connectTab(
    tabId: string,
    connectionId: string,
    path: string,
    initial: string,
  ): DocumentSyncCore {
    const doc = this.ensureDoc(connectionId, path, initial);
    const key = this.docKey(connectionId, path);
    const subs = this.subscribers.get(key)!;

    const core = new DocumentSyncCore(path, {}, (updateB64) => {
      Y.applyUpdate(doc, Buffer.from(updateB64, "base64"), tabId);
      const payload: WsServerMessage = {
        type: "update",
        connectionId,
        path,
        update: updateB64,
        revision: 0,
        dirty: true,
      };
      for (const [id, send] of subs) {
        if (id !== tabId) {
          send(payload);
        }
      }
    });

    subs.set(tabId, (msg) => core.handleServerMessage(msg));

    core.handleServerMessage({
      type: "subscribed",
      connectionId,
      path,
      update: uint8ToBase64(Y.encodeStateAsUpdate(doc)),
      revision: 1,
      dirty: false,
    });
    core.enableSync();
    return core;
  }

  disconnectTab(tabId: string, connectionId: string, path: string): void {
    this.subscribers.get(this.docKey(connectionId, path))?.delete(tabId);
  }
}
