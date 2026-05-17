import type { DocumentState, RemoteSnapshot } from "@conduit/shared";
import { readRemoteTextWithSnapshot, statRemoteFile, writeRemoteText } from "../ssh/remoteFile.js";

const DOC_IDLE_TTL_MS = 30 * 60 * 1000;
const EVICT_INTERVAL_MS = 60 * 1000;

type StoredDocument = {
  connectionId: string;
  path: string;
  content: string;
  dirty: boolean;
  revision: number;
  remote: RemoteSnapshot;
  lastLoadedAt: number;
  lastSavedAt: number | null;
  lastTouchedAt: number;
  refCount: number;
};

const documents = new Map<string, StoredDocument>();

function docKey(connectionId: string, path: string): string {
  return `${connectionId}\0${path}`;
}

function toState(doc: StoredDocument): DocumentState {
  return {
    path: doc.path,
    content: doc.content,
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

/**
 * Opens a document: increments refCount; loads from SFTP on first open for this key.
 */
export async function openDocument(connectionId: string, path: string): Promise<DocumentState> {
  const key = docKey(connectionId, path);
  const existing = documents.get(key);
  if (existing) {
    existing.refCount += 1;
    touch(existing);
    return toState(existing);
  }

  const { content, remote } = await readRemoteTextWithSnapshot(connectionId, path);
  const now = Date.now();
  const doc: StoredDocument = {
    connectionId,
    path,
    content,
    dirty: false,
    revision: 1,
    remote,
    lastLoadedAt: now,
    lastSavedAt: null,
    lastTouchedAt: now,
    refCount: 1,
  };
  documents.set(key, doc);
  return toState(doc);
}

export function patchDocument(connectionId: string, path: string, content: string): DocumentState {
  const doc = documents.get(docKey(connectionId, path));
  if (!doc) {
    throw new Error("document_not_open");
  }
  doc.content = content;
  doc.dirty = true;
  doc.revision += 1;
  touch(doc);
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

  const remote = await writeRemoteText(connectionId, path, doc.content);
  const now = Date.now();
  doc.remote = remote;
  doc.dirty = false;
  doc.revision += 1;
  doc.lastSavedAt = now;
  touch(doc);
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
  doc.content = content;
  doc.remote = remote;
  doc.dirty = false;
  doc.revision += 1;
  doc.lastLoadedAt = now;
  touch(doc);
  return toState(doc);
}

export function closeDocument(connectionId: string, path: string): boolean {
  const key = docKey(connectionId, path);
  const doc = documents.get(key);
  if (!doc) {
    return false;
  }
  doc.refCount = Math.max(0, doc.refCount - 1);
  if (doc.refCount === 0) {
    documents.delete(key);
  }
  return true;
}

export function evictAllForConnection(connectionId: string): void {
  for (const [key, doc] of documents) {
    if (doc.connectionId === connectionId) {
      documents.delete(key);
    }
  }
}

function remoteChangedOnDisk(saved: RemoteSnapshot, current: RemoteSnapshot): boolean {
  return saved.mtimeMs !== current.mtimeMs || saved.size !== current.size;
}

function evictIdleDocuments(): void {
  const now = Date.now();
  for (const [key, doc] of documents) {
    if (doc.dirty) {
      continue;
    }
    if (doc.refCount > 0) {
      continue;
    }
    if (now - doc.lastTouchedAt > DOC_IDLE_TTL_MS) {
      documents.delete(key);
    }
  }
}

const evictTimer = setInterval(evictIdleDocuments, EVICT_INTERVAL_MS);
evictTimer.unref?.();
