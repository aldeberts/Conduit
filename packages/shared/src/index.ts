/**
 * Opaque workspace identifier issued by the control plane (future).
 * Phase 0 uses a single implicit workspace on one machine.
 */
export type WorkspaceId = string;

export type { DocumentState, RemoteSnapshot } from "./documents.js";
export type { WsClientMessage, WsServerMessage } from "./ws.js";
