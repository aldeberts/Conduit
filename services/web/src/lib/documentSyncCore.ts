import type { WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";

export const YTEXT_KEY = "content";

export type DocumentSyncCallbacks = {
  onSubscribed?: () => void;
  onState?: (revision: number, dirty: boolean) => void;
  onRemoteContentChange?: () => void;
  onLocalEdit?: () => void;
  onError?: (message: string) => void;
};

export type OutboundSync = (updateB64: string) => void;

/**
 * Client-side Yjs sync state machine (transport-agnostic; covered by unit tests).
 */
export class DocumentSyncCore {
  readonly ydoc = new Y.Doc();
  readonly ytext = this.ydoc.getText(YTEXT_KEY);
  readonly path: string;
  private readonly callbacks: DocumentSyncCallbacks;
  private readonly sendUpdate: OutboundSync;
  private syncReady = false;
  private subscribed = false;
  private editorMounted = false;
  private readonly bufferedUpdates: Extract<WsServerMessage, { type: "update" }>[] = [];

  constructor(
    path: string,
    callbacks: DocumentSyncCallbacks,
    sendUpdate: OutboundSync,
  ) {
    this.path = path;
    this.callbacks = callbacks;
    this.sendUpdate = sendUpdate;

    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || !this.syncReady) {
        return;
      }
      this.sendUpdate(uint8ToBase64(update));
      this.callbacks.onLocalEdit?.();
    });
  }

  resetSession(): void {
    this.syncReady = false;
    this.subscribed = false;
    this.editorMounted = false;
    this.bufferedUpdates.length = 0;
  }

  disableSync(): void {
    this.syncReady = false;
    this.editorMounted = false;
  }

  enableSync(): void {
    this.editorMounted = true;
    this.syncReady = this.subscribed;
  }

  /** Apply a local edit in tests (simulates CodeMirror / yCollab). */
  simulateLocalInsert(index: number, text: string): void {
    this.ytext.insert(index, text);
  }

  handleServerMessage(msg: WsServerMessage): void {
    if (msg.type === "error") {
      this.callbacks.onError?.(msg.message);
      return;
    }
    if (msg.type === "pty_subscribed" || msg.type === "pty_output") {
      return;
    }
    if ("path" in msg && msg.path !== this.path) {
      return;
    }

    if (msg.type === "subscribed") {
      this.subscribed = true;
      if (this.editorMounted) {
        this.syncReady = true;
      }
      this.applyAuthoritativeSnapshot(msg.update);
      this.flushBufferedUpdates();
      this.callbacks.onSubscribed?.();
      this.callbacks.onRemoteContentChange?.();
      this.callbacks.onState?.(msg.revision, msg.dirty);
      return;
    }

    if (!this.subscribed) {
      if (msg.type === "update") {
        this.bufferedUpdates.push(msg);
      }
      return;
    }

    if (msg.type === "state") {
      this.callbacks.onState?.(msg.revision, msg.dirty);
      return;
    }

    if (msg.type === "update") {
      Y.applyUpdate(this.ydoc, base64ToUint8(msg.update), "remote");
      this.callbacks.onRemoteContentChange?.();
      this.callbacks.onState?.(msg.revision, msg.dirty);
    }
  }

  /**
   * Merge the server snapshot into our Y.Doc using proper Yjs state-vector diffs.
   *
   * This is intentionally a CRDT merge, not a replace. A `subscribed` snapshot can
   * arrive at any time (initial connect, reconnect, re-subscribe), and we must never
   * wipe local in-flight edits or react to a transiently empty snapshot. If both
   * sides have valid Yjs state, Yjs converges them.
   */
  private applyAuthoritativeSnapshot(updateB64: string): void {
    const update = base64ToUint8(updateB64);
    if (update.length === 0) {
      return;
    }
    Y.applyUpdate(this.ydoc, update, "remote");
  }

  private flushBufferedUpdates(): void {
    const pending = this.bufferedUpdates.splice(0);
    for (const msg of pending) {
      Y.applyUpdate(this.ydoc, base64ToUint8(msg.update), "remote");
    }
    if (pending.length > 0) {
      const last = pending[pending.length - 1]!;
      this.callbacks.onState?.(last.revision, last.dirty);
    }
  }
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Build incremental Yjs update after applying server snapshot to a client doc. */
export function incrementalInsertAfterSnapshot(
  snapshotUpdateB64: string,
  index: number,
  text: string,
): string {
  const client = new Y.Doc();
  Y.applyUpdate(client, base64ToUint8(snapshotUpdateB64));
  const baseVector = Y.encodeStateVector(client);
  client.getText(YTEXT_KEY).insert(index, text);
  return uint8ToBase64(Y.encodeStateAsUpdate(client, baseVector));
}
