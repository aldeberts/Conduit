import type { RemoteSnapshot } from "@conduit/shared";
import { getConnection } from "./registry.js";
import { resolveUnderRemoteRoot } from "./paths.js";

const MAX_READ_BYTES = 1_500_000;

function sftpStat(sftp: import("ssh2").SFTPWrapper, remotePath: string): Promise<import("ssh2").Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stats);
    });
  });
}

function sftpReadFile(sftp: import("ssh2").SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
}

function mtimeToMs(mtime: number | Date | undefined): number {
  if (mtime === undefined) {
    return 0;
  }
  if (typeof mtime === "number") {
    return mtime * 1000;
  }
  return mtime.getTime();
}

export function snapshotFromStats(stats: import("ssh2").Stats): RemoteSnapshot {
  return {
    mtimeMs: mtimeToMs(stats.mtime),
    size: typeof stats.size === "number" ? stats.size : 0,
  };
}

export async function statRemoteFile(
  connectionId: string,
  relativePath: string,
): Promise<RemoteSnapshot & { isDirectory: boolean }> {
  const stored = getConnection(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const abs = resolveUnderRemoteRoot(stored.remoteRoot, relativePath);
  const stats = await sftpStat(stored.sftp, abs);
  return { ...snapshotFromStats(stats), isDirectory: stats.isDirectory() };
}

export async function readRemoteTextWithSnapshot(
  connectionId: string,
  relativePath: string,
): Promise<{ content: string; remote: RemoteSnapshot }> {
  const stored = getConnection(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const abs = resolveUnderRemoteRoot(stored.remoteRoot, relativePath);
  const stats = await sftpStat(stored.sftp, abs);
  if (stats.isDirectory()) {
    throw new Error("is_directory");
  }
  if (typeof stats.size === "number" && stats.size > MAX_READ_BYTES) {
    throw new Error("file_too_large");
  }
  const buf = await sftpReadFile(stored.sftp, abs);
  if (buf.length > MAX_READ_BYTES) {
    throw new Error("file_too_large");
  }
  return {
    content: buf.toString("utf8"),
    remote: snapshotFromStats(stats),
  };
}

export async function writeRemoteText(
  connectionId: string,
  relativePath: string,
  contents: string,
): Promise<RemoteSnapshot> {
  const stored = getConnection(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const abs = resolveUnderRemoteRoot(stored.remoteRoot, relativePath);
  await new Promise<void>((resolve, reject) => {
    stored.sftp.writeFile(abs, contents, "utf8", (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  const stats = await sftpStat(stored.sftp, abs);
  return snapshotFromStats(stats);
}
