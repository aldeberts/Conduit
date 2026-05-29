import type { DocumentState, RemoteSnapshot, WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import { metrics } from "../metrics.js";
import { readRemoteTextWithSnapshot, statRemoteFile, writeRemoteText } from "../ssh/remoteFile.js";
import { agentLog } from "../debugAgentLog.js";
import { loadPersistedDocument, persistDocument } from "./persistence.js";
import {
  applyDocUpdate,
  createDocumentYDoc,
  encodeDocUpdate,
  readYTextContent,
  setYTextContent,
} from "./yjs.js";

const DOC_IDLE_TTL_MS = 30 * 60 * 1000;
const EVICT_INTERVAL_MS = 60 * 1000;
const PERSIST_DEBOUNCE_MS = 2000;

export type DocumentSubscriber = {
  id: string;
  send: (msg: WsServerMessage) => void;
};

type StoredDocument = {
  connectionId: string;
  path: string;
  ydoc: Y.Doc;
  dirty: boolean;
  revision: number;
  remote: RemoteSnapshot;
  lastLoadedAt: number;
  lastSavedAt: number | null;
  lastTouchedAt: number;
  refCount: number;
  subscribers: Map<string, DocumentSubscriber>;
  persistTimer: ReturnType<typeof setTimeout> | null;
};

let dataDir = "";

const documents = new Map<string, StoredDocument>();

export function configureDocumentStore(dir: string): void {
  dataDir = dir;
}

/** In-memory document for unit tests (no SSH). */
export function registerTestDocument(
  connectionId: string,
  path: string,
  content: string,
): DocumentState {
  const key = docKey(connectionId, path);
  const ydoc = createDocumentYDoc();
  setYTextContent(ydoc, content);
  const now = Date.now();
  const stored: StoredDocument = {
    connectionId,
    path,
    ydoc,
    dirty: false,
    revision: 1,
    remote: { mtimeMs: 0, size: 0 },
    lastLoadedAt: now,
    lastSavedAt: null,
    lastTouchedAt: now,
    refCount: 1,
    subscribers: new Map(),
    persistTimer: null,
  };
  attachYDocListener(stored);
  documents.set(key, stored);
  return toState(stored);
}

function docKey(connectionId: string, path: string): string {
  return `${connectionId}\0${path}`;
}

function toState(doc: StoredDocument): DocumentState {
  return {
    path: doc.path,
    content: readYTextContent(doc.ydoc),
    dirty: doc.dirty,
    revision: doc.revision,
    remote: doc.remote,
    lastLoadedAt: new Date(doc.lastLoadedAt).toISOString(),
    lastSavedAt: doc.lastSavedAt === null ? null : new Date(doc.lastSavedAt).toISOString(),
  };
}

function touch(doc: StoredDocument): void {
  doc.lastTouchedAt = Date.now();
}

function schedulePersist(doc: StoredDocument): void {
  if (!dataDir) {
    return;
  }
  if (doc.persistTimer) {
    clearTimeout(doc.persistTimer);
  }
  doc.persistTimer = setTimeout(() => {
    doc.persistTimer = null;
    void flushPersist(doc);
  }, PERSIST_DEBOUNCE_MS);
  doc.persistTimer.unref?.();
}

async function flushPersist(doc: StoredDocument): Promise<void> {
  if (!dataDir) {
    return;
  }
  try {
    const update = encodeDocUpdate(doc.ydoc);
    await persistDocument(dataDir, doc.connectionId, doc.path, update, {
      connectionId: doc.connectionId,
      path: doc.path,
      remote: doc.remote,
      lastSavedAt: doc.lastSavedAt === null ? null : new Date(doc.lastSavedAt).toISOString(),
      revision: doc.revision,
    });
    metrics.persistWrites += 1;
  } catch {
    /* logged by caller if needed */
  }
}

function broadcastDocumentState(doc: StoredDocument): void {
  const payload: WsServerMessage = {
    type: "state",
    connectionId: doc.connectionId,
    path: doc.path,
    revision: doc.revision,
    dirty: doc.dirty,
  };
  for (const sub of doc.subscribers.values()) {
    sub.send(payload);
  }
}

/** Full Yjs snapshot for every subscriber (e.g. after server-side replace). */
function broadcastDocumentSnapshot(doc: StoredDocument): void {
  const state = toState(doc);
  const payload: WsServerMessage = {
    type: "subscribed",
    connectionId: doc.connectionId,
    path: doc.path,
    update: Buffer.from(encodeDocUpdate(doc.ydoc)).toString("base64"),
    revision: state.revision,
    dirty: state.dirty,
  };
  for (const sub of doc.subscribers.values()) {
    sub.send(payload);
  }
}

function onYDocUpdate(doc: StoredDocument, update: Uint8Array, origin: unknown): void {
  const originStr = typeof origin === "string" ? origin : null;
  // Server-driven reloads should not mark the document dirty.
  doc.dirty = originStr === "reopen-empty" || originStr === "refresh" ? false : true;
  doc.revision += 1;
  touch(doc);
  schedulePersist(doc);

  const originId = typeof origin === "string" ? origin : undefined;
  if (origin === "reopen-empty" || origin === "refresh" || origin === "http-patch") {
    broadcastDocumentSnapshot(doc);
    return;
  }

  const payload: WsServerMessage = {
    type: "update",
    connectionId: doc.connectionId,
    path: doc.path,
    update: Buffer.from(update).toString("base64"),
    revision: doc.revision,
    dirty: doc.dirty,
  };
  for (const [id, sub] of doc.subscribers) {
    if (id !== originId) {
      sub.send(payload);
    }
  }
}

function attachYDocListener(doc: StoredDocument): void {
  doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    metrics.yjsUpdatesApplied += 1;
    onYDocUpdate(doc, update, origin);
  });
}

/** Clears dirty when buffer still matches the remote file (e.g. after spurious client sync). */
async function clearDirtyIfMatchesRemote(doc: StoredDocument): Promise<void> {
  if (!doc.dirty) {
    return;
  }
  try {
    const { content, remote } = await readRemoteTextWithSnapshot(doc.connectionId, doc.path);
    if (
      !remoteChangedOnDisk(doc.remote, remote) &&
      readYTextContent(doc.ydoc) === content
    ) {
      doc.dirty = false;
    }
  } catch {
    /* keep dirty if SFTP check fails */
  }
}

async function hydrateNewDocument(connectionId: string, path: string): Promise<StoredDocument> {
  const ydoc = createDocumentYDoc();
  const now = Date.now();
  let remote: RemoteSnapshot = { mtimeMs: 0, size: 0 };
  let lastSavedAt: number | null = null;

  const persisted = dataDir ? await loadPersistedDocument(dataDir, connectionId, path) : null;
  if (persisted) {
    applyDocUpdate(ydoc, persisted.update, "persist");
    remote = persisted.meta.remote;
    lastSavedAt = persisted.meta.lastSavedAt ? Date.parse(persisted.meta.lastSavedAt) : null;
    if (readYTextContent(ydoc).length === 0) {
      const loaded = await readRemoteTextWithSnapshot(connectionId, path);
      setYTextContent(ydoc, loaded.content);
      remote = loaded.remote;
    }
  } else {
    const loaded = await readRemoteTextWithSnapshot(connectionId, path);
    setYTextContent(ydoc, loaded.content);
    remote = loaded.remote;
  }

  const stored: StoredDocument = {
    connectionId,
    path,
    ydoc,
    dirty: false,
    revision: 1,
    remote,
    lastLoadedAt: now,
    lastSavedAt,
    lastTouchedAt: now,
    refCount: 0,
    subscribers: new Map(),
    persistTimer: null,
  };
  attachYDocListener(stored);
  return stored;
}

export function listOpenDocuments(connectionId: string): DocumentState[] {
  const out: DocumentState[] = [];
  for (const doc of documents.values()) {
    if (doc.connectionId === connectionId) {
      out.push(toState(doc));
    }
  }
  return out;
}

export function getOpenDocument(connectionId: string, path: string): DocumentState | undefined {
  const doc = documents.get(docKey(connectionId, path));
  if (!doc) {
    return undefined;
  }
  touch(doc);
  return toState(doc);
}

export async function openDocument(connectionId: string, path: string): Promise<DocumentState> {
  const key = docKey(connectionId, path);
  let doc = documents.get(key);
  if (doc) {
    const open = doc;
    open.refCount += 1;
    touch(open);
    const existingLen = readYTextContent(open.ydoc).length;
    if (existingLen === 0) {
      const loaded = await readRemoteTextWithSnapshot(connectionId, path);
      open.ydoc.transact(() => setYTextContent(open.ydoc, loaded.content), "reopen-empty");
      open.remote = loaded.remote;
      open.lastLoadedAt = Date.now();
    }
    metrics.documentOpens += 1;
    await clearDirtyIfMatchesRemote(open);
    // #region agent log
    agentLog("registry.ts:openDocument", "document reopened", { connectionId, path, refCount: open.refCount }, "H2");
    // #endregion
    return toState(open);
  }

  doc = await hydrateNewDocument(connectionId, path);
  doc.refCount = 1;
  documents.set(key, doc);
  metrics.documentOpens += 1;
  schedulePersist(doc);
  await clearDirtyIfMatchesRemote(doc);
  // #region agent log
  agentLog(
    "registry.ts:openDocument",
    "document opened",
    { connectionId, path, refCount: doc.refCount },
    "H2",
  );
  // #endregion
  return toState(doc);
}

export function patchDocument(connectionId: string, path: string, content: string): DocumentState {
  const doc = documents.get(docKey(connectionId, path));
  if (!doc) {
    throw new Error("document_not_open");
  }
  doc.ydoc.transact(() => setYTextContent(doc.ydoc, content), "http-patch");
  return toState(doc);
}

export async function saveDocument(connectionId: string, path: string): Promise<DocumentState> {
  const doc = documents.get(docKey(connectionId, path));
  if (!doc) {
    throw new Error("document_not_open");
  }

  const current = await statRemoteFile(connectionId, path);
  if (current.isDirectory) {
    throw new Error("is_directory");
  }
  if (remoteChangedOnDisk(doc.remote, current)) {
    throw new Error("remote_conflict");
  }

  const content = readYTextContent(doc.ydoc);
  const remote = await writeRemoteText(connectionId, path, content);
  const now = Date.now();
  doc.remote = remote;
  doc.dirty = false;
  doc.revision += 1;
  doc.lastSavedAt = now;
  touch(doc);
  metrics.documentSaves += 1;
  await flushPersist(doc);
  broadcastDocumentState(doc);
  return toState(doc);
}

export async function refreshDocument(
  connectionId: string,
  path: string,
  force: boolean,
): Promise<DocumentState> {
  const doc = documents.get(docKey(connectionId, path));
  if (!doc) {
    throw new Error("document_not_open");
  }
  if (doc.dirty && !force) {
    throw new Error("dirty_document");
  }

  const { content, remote } = await readRemoteTextWithSnapshot(connectionId, path);
  const now = Date.now();
  doc.ydoc.transact(() => setYTextContent(doc.ydoc, content), "refresh");
  doc.remote = remote;
  doc.dirty = false;
  doc.revision += 1;
  doc.lastLoadedAt = now;
  touch(doc);
  await flushPersist(doc);
  broadcastDocumentState(doc);
  return toState(doc);
}

export function closeDocument(connectionId: string, path: string): boolean {
  const key = docKey(connectionId, path);
  const doc = documents.get(key);
  if (!doc) {
    return false;
  }
  doc.refCount = Math.max(0, doc.refCount - 1);
  if (doc.refCount === 0 && doc.subscribers.size === 0) {
    if (doc.persistTimer) {
      clearTimeout(doc.persistTimer);
      void flushPersist(doc);
    }
    documents.delete(key);
  }
  return true;
}

export function evictAllForConnection(connectionId: string): void {
  for (const [key, doc] of documents) {
    if (doc.connectionId === connectionId) {
      if (doc.persistTimer) {
        clearTimeout(doc.persistTimer);
      }
      documents.delete(key);
    }
  }
}

/** Loads or creates the in-memory Yjs document (used by HTTP open and WS subscribe). */
async function ensureDocumentLoaded(connectionId: string, path: string): Promise<StoredDocument> {
  const key = docKey(connectionId, path);
  const existing = documents.get(key);
  if (existing) {
    touch(existing);
    return existing;
  }
  const doc = await hydrateNewDocument(connectionId, path);
  doc.refCount = 0;
  documents.set(key, doc);
  metrics.documentOpens += 1;
  schedulePersist(doc);
  return doc;
}

export async function subscribeDocument(
  connectionId: string,
  path: string,
  subscriber: DocumentSubscriber,
): Promise<DocumentState> {
  const doc = await ensureDocumentLoaded(connectionId, path);
  doc.subscribers.set(subscriber.id, subscriber);
  touch(doc);
  const state = toState(doc);
  const contentLen = state.content.length;
  subscriber.send({
    type: "subscribed",
    connectionId,
    path,
    update: Buffer.from(encodeDocUpdate(doc.ydoc)).toString("base64"),
    revision: state.revision,
    dirty: state.dirty,
  });
  if (contentLen === 0) {
    console.warn(`[conduit] subscribe ${path}: document text is empty after hydrate`);
  }
  return state;
}

export function unsubscribeDocument(connectionId: string, path: string, subscriberId: string): void {
  const doc = documents.get(docKey(connectionId, path));
  if (doc) {
    doc.subscribers.delete(subscriberId);
  }
}

export async function applyDocumentSync(
  connectionId: string,
  path: string,
  update: Uint8Array,
  origin: string,
): Promise<DocumentState> {
  const doc = await ensureDocumentLoaded(connectionId, path);
  applyDocUpdate(doc.ydoc, update, origin);
  return toState(doc);
}

function remoteChangedOnDisk(saved: RemoteSnapshot, current: RemoteSnapshot): boolean {
  return saved.mtimeMs !== current.mtimeMs || saved.size !== current.size;
}

function evictIdleDocuments(): void {
  const now = Date.now();
  for (const [key, doc] of documents) {
    if (doc.dirty || doc.refCount > 0 || doc.subscribers.size > 0) {
      continue;
    }
    if (now - doc.lastTouchedAt > DOC_IDLE_TTL_MS) {
      if (doc.persistTimer) {
        clearTimeout(doc.persistTimer);
      }
      documents.delete(key);
    }
  }
}

const evictTimer = setInterval(evictIdleDocuments, EVICT_INTERVAL_MS);
evictTimer.unref?.();
