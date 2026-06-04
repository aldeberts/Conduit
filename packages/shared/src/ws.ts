/** Client → server WebSocket messages (documents + PTY). */
export type WsClientMessage =
  | { type: "subscribe"; connectionId: string; path: string }
  | { type: "unsubscribe"; connectionId: string; path: string }
  | { type: "sync"; connectionId: string; path: string; update: string }
  /**
   * Relayed presence/cursor data for a document. `update` is base64 of a
   * y-protocols `encodeAwarenessUpdate` payload. Server fans out to other
   * subscribers of the same (connectionId, path).
   */
  | { type: "awareness"; connectionId: string; path: string; update: string }
  /** Persist current Y.Doc buffer to remote storage via SFTP. */
  | { type: "save"; connectionId: string; path: string }
  /** Reload from disk; `force` discards local dirty edits. */
  | { type: "refresh"; connectionId: string; path: string; force: boolean }
  | { type: "pty_subscribe"; connectionId: string }
  | { type: "pty_unsubscribe"; connectionId: string }
  | { type: "pty_input"; connectionId: string; data: string }
  | { type: "pty_resize"; connectionId: string; cols: number; rows: number };

/** Server → client WebSocket messages (documents + PTY). */
export type WsServerMessage =
  | {
      type: "subscribed";
      connectionId: string;
      path: string;
      update: string;
      revision: number;
      dirty: boolean;
    }
  | { type: "update"; connectionId: string; path: string; update: string; revision: number; dirty: boolean }
  | { type: "state"; connectionId: string; path: string; revision: number; dirty: boolean }
  /** Relayed presence/cursor update from another subscriber on the same path. */
  | { type: "awareness"; connectionId: string; path: string; update: string }
  /** Result of a `save` or `refresh` request, sent only to the originator. */
  | {
      type: "op_result";
      connectionId: string;
      path: string;
      op: "save" | "refresh";
      ok: boolean;
      error?: string;
    }
  /**
   * Document was removed server-side (deleted, renamed, or evicted). Clients
   * with this file open should close it locally.
   */
  | { type: "doc_evicted"; connectionId: string; path: string; reason: "deleted" | "renamed" | "evicted" }
  | { type: "pty_subscribed"; connectionId: string }
  | { type: "pty_output"; connectionId: string; data: string }
  /**
   * Server-pushed notification that the file tree changed (e.g. someone created
   * a file). `dir` is the relative directory whose entries should be re-fetched
   * ("" for the workspace root). Broadcast to every WebSocket; clients filter
   * by `connectionId`.
   */
  | { type: "tree_changed"; connectionId: string; dir: string }
  | { type: "error"; message: string };
