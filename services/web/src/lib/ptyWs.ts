import type { WsServerMessage } from "@conduit/shared";
import { sendPtyInput, sendPtyResize, subscribePty } from "./wsPool.js";

export type PtyCallbacks = {
  onSubscribed?: () => void;
  onOutput?: (data: Uint8Array) => void;
  onError?: (message: string) => void;
};

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Multiplexed remote PTY over the shared WebSocket pool. */
export class PtyWsClient {
  private readonly connectionId: string;
  private readonly token?: string;
  private readonly callbacks: PtyCallbacks;
  private unsub: (() => void) | null = null;

  constructor(connectionId: string, callbacks: PtyCallbacks = {}, token?: string) {
    this.connectionId = connectionId;
    this.token = token;
    this.callbacks = callbacks;
  }

  connect(): void {
    if (this.unsub) {
      return;
    }
    this.unsub = subscribePty(
      this.connectionId,
      (msg: WsServerMessage) => this.onMessage(msg),
      this.token,
    );
  }

  disconnect(): void {
    this.unsub?.();
    this.unsub = null;
  }

  sendInput(data: Uint8Array): void {
    sendPtyInput(this.connectionId, uint8ToBase64(data), this.token);
  }

  resize(cols: number, rows: number): void {
    sendPtyResize(this.connectionId, cols, rows, this.token);
  }

  private onMessage(msg: WsServerMessage): void {
    if (msg.type === "error") {
      this.callbacks.onError?.(msg.message);
      return;
    }
    if (msg.connectionId !== this.connectionId) {
      return;
    }
    if (msg.type === "pty_subscribed") {
      this.callbacks.onSubscribed?.();
      return;
    }
    if (msg.type === "pty_output") {
      this.callbacks.onOutput?.(base64ToUint8(msg.data));
    }
  }
}
