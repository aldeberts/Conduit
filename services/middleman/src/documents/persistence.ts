import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteSnapshot } from "@conduit/shared";

export type PersistedMeta = {
  connectionId: string;
  path: string;
  remote: RemoteSnapshot;
  lastSavedAt: string | null;
  revision: number;
  persistedAt: string;
};

function safePathSegment(relPath: string): string {
  return relPath.replace(/[/\\:]/g, "__");
}

export function persistencePaths(dataDir: string, connectionId: string, relPath: string): {
  updateFile: string;
  metaFile: string;
} {
  const dir = path.join(dataDir, "documents", connectionId);
  const base = safePathSegment(relPath);
  return {
    updateFile: path.join(dir, `${base}.yjs`),
    metaFile: path.join(dir, `${base}.meta.json`),
  };
}

export async function loadPersistedDocument(
  dataDir: string,
  connectionId: string,
  relPath: string,
): Promise<{ update: Uint8Array; meta: PersistedMeta } | null> {
  const { updateFile, metaFile } = persistencePaths(dataDir, connectionId, relPath);
  try {
    const [updateBuf, metaRaw] = await Promise.all([fs.readFile(updateFile), fs.readFile(metaFile, "utf8")]);
    const meta = JSON.parse(metaRaw) as PersistedMeta;
    return { update: new Uint8Array(updateBuf), meta };
  } catch {
    return null;
  }
}

export async function persistDocument(
  dataDir: string,
  connectionId: string,
  relPath: string,
  update: Uint8Array,
  meta: Omit<PersistedMeta, "persistedAt">,
): Promise<void> {
  const { updateFile, metaFile } = persistencePaths(dataDir, connectionId, relPath);
  await fs.mkdir(path.dirname(updateFile), { recursive: true });
  const fullMeta: PersistedMeta = { ...meta, persistedAt: new Date().toISOString() };
  await Promise.all([
    fs.writeFile(updateFile, Buffer.from(update)),
    fs.writeFile(metaFile, JSON.stringify(fullMeta, null, 2), "utf8"),
  ]);
}

export async function deletePersistedForConnection(dataDir: string, connectionId: string): Promise<void> {
  const dir = path.join(dataDir, "documents", connectionId);
  await fs.rm(dir, { recursive: true, force: true });
}
