/**
 * `@conduit/client` -- transport-agnostic Conduit protocol library.
 *
 * Two layers:
 *   - `core/`: pure state machines (Yjs sync, message routing). These have no
 *     transport or DOM dependencies and are covered by the package's own unit
 *     tests. The browser app and IDE clients both wrap them.
 *   - `ConduitClient`: a higher-level convenience built on top, with HTTP and
 *     WebSocket helpers. Both transports are pluggable so the same class works
 *     in browsers (DOM `fetch` + `WebSocket`), in Node (e.g. `ws` package),
 *     and in VS Code (Node host).
 */

export {
  DocumentSyncCore,
  YTEXT_KEY,
  base64ToUint8,
  incrementalInsertAfterSnapshot,
  uint8ToBase64,
  type DocumentSyncCallbacks,
  type OutboundSync,
} from "./core/documentSync.js";

export {
  WS_CONNECTING,
  WS_OPEN,
  dispatchMessage,
  pathsNeedingSubscribe,
  queueSubscribe,
  socketBusy,
  type DispatchTargets,
  type PoolLike,
} from "./core/wsPool.js";

export type { WsClientMessage, WsServerMessage } from "@conduit/shared";

export {
  ConduitClient,
  type ConduitClientOptions,
  type ConduitDocument,
  type ConduitDocumentOptions,
  type ConnectionsListItem,
  type FetchLike,
  type WebSocketFactory,
  type WebSocketLike,
} from "./ConduitClient.js";
