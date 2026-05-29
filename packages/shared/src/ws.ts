/** Client → server WebSocket messages (documents + PTY). */
export type WsClientMessage =
  | { type: "subscribe"; connectionId: string; path: string }
  | { type: "unsubscribe"; connectionId: string; path: string }
  | { type: "sync"; connectionId: string; path: string; update: string }
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
