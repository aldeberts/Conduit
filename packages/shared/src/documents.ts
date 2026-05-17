/** Snapshot of the remote file as last seen on load or save (SFTP stat). */
export type RemoteSnapshot = {
  mtimeMs: number;
  size: number;
};

/** Server-owned open document (Phase A). */
export type DocumentState = {
  path: string;
  content: string;
  dirty: boolean;
  revision: number;
  remote: RemoteSnapshot;
  lastLoadedAt: string;
  lastSavedAt: string | null;
};
