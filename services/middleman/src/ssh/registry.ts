import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path/posix";
import { Client, type Channel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { resolveUnderRemoteRoot } from "./paths.js";

const MAX_READ_BYTES = 1_500_000;
const MAX_TREE_ENTRIES = 500;

export type TreeEntry = {
  name: string;
  /** Path relative to the connection workspace root (POSIX). */
  path: string;
  type: "file" | "dir";
};

type Stored = {
  id: string;
  label: string;
  remoteRoot: string;
  client: Client;
  sftp: SFTPWrapper;
};

const connections = new Map<string, Stored>();

function sftpReaddir(sftp: SFTPWrapper, remotePath: string): Promise<import("ssh2").FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(list ?? []);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<import("ssh2").Stats> {
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

function sftpReadFile(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
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

function sftpWriteFile(sftp: SFTPWrapper, remotePath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, "utf8", (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Opens SSH then SFTP. Optional `beforeConnect` registers listeners (e.g. keyboard-interactive)
 * before `connect()` runs.
 */
function openSftpSession(
  config: ConnectConfig,
  beforeConnect?: (client: Client) => void,
): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const onError = (err: Error): void => {
      client.end();
      reject(err);
    };
    client.once("error", onError);
    beforeConnect?.(client);
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        client.off("error", onError);
        if (err) {
          client.end();
          reject(err);
          return;
        }
        resolve({ client, sftp });
      });
    });
    client.connect(config);
  });
}

export type CreateConnectionInput = {
  label: string;
  host: string;
  port: number;
  username: string;
  /** Absolute POSIX path on the remote host (e.g. `/home/ubuntu/app`). */
  remotePath: string;
  password?: string;
  /** PEM private key material (dev / lab use only). */
  privateKey?: string;
};

export async function createSftpConnection(input: CreateConnectionInput): Promise<{ id: string; remoteRoot: string }> {
  const remoteRoot = path.normalize(input.remotePath.trim());
  if (!remoteRoot.startsWith("/")) {
    throw new Error("remotePath must be an absolute POSIX path (e.g. /home/ubuntu/project)");
  }

  const keyMaterial = input.privateKey?.trim() ?? "";
  const hasKey = keyMaterial !== "";
  const password = input.password ?? "";
  const hasPassword = password !== "";

  const connect: ConnectConfig = {
    host: input.host,
    port: input.port,
    username: input.username,
    readyTimeout: 20_000,
  };

  if (hasKey) {
    connect.privateKey = keyMaterial;
    if (hasPassword) {
      connect.passphrase = password;
    }
  } else if (hasPassword) {
    connect.password = password;
    connect.tryKeyboard = true;
  } else if (process.env.SSH_AUTH_SOCK) {
    connect.agent = process.env.SSH_AUTH_SOCK;
  }

  const { client, sftp } = await openSftpSession(connect, (clientInstance) => {
    if (!hasKey && hasPassword) {
      clientInstance.on("keyboard-interactive", (_name, _instr, _instrLang, prompts, finish) => {
        finish(prompts.map(() => password));
      });
    }
  });
  await sftpStat(sftp, remoteRoot);

  const id = randomUUID();
  connections.set(id, {
    id,
    label: input.label,
    remoteRoot,
    client,
    sftp,
  });

  return { id, remoteRoot };
}

export function getConnection(id: string): Stored | undefined {
  return connections.get(id);
}

/** Stub SSH connection for WebSocket / collab tests (no real SFTP). */
export function registerTestConnection(
  id: string,
  remoteRoot = "/",
  sftp: Partial<SFTPWrapper> = {},
): void {
  connections.set(id, {
    id,
    label: "test",
    remoteRoot,
    client: {} as Client,
    sftp: sftp as SFTPWrapper,
  });
}

/** Returns an in-memory SFTPWrapper stub that satisfies just enough of the
 * surface (`stat` and `writeFile`) for the file-create flow. Files are stored
 * by absolute remote path in `files`. */
export function makeInMemorySftp(files: Map<string, string>): Partial<SFTPWrapper> {
  const stub = {
    stat(remotePath: string, cb: (err: Error | null, stats?: import("ssh2").Stats) => void): boolean {
      const content = files.get(remotePath);
      if (content !== undefined) {
        cb(null, { isDirectory: () => false, size: content.length } as import("ssh2").Stats);
      } else {
        cb(new Error("ENOENT"));
      }
      return false;
    },
    writeFile(
      remotePath: string,
      data: Buffer | string,
      _opts: unknown,
      cb: (err: Error | null) => void,
    ): void {
      files.set(remotePath, typeof data === "string" ? data : data.toString("utf8"));
      cb(null);
    },
  };
  return stub as unknown as Partial<SFTPWrapper>;
}

export async function closeConnection(id: string): Promise<boolean> {
  const stored = connections.get(id);
  if (!stored) {
    return false;
  }
  connections.delete(id);
  const { destroyPtySession } = await import("../pty/registry.js");
  destroyPtySession(id);
  stored.sftp.end();
  stored.client.end();
  return true;
}

function shellQuotePosix(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Interactive shell on the remote host (shared by PTY subscribers). */
export function openShell(connectionId: string, cols: number, rows: number): Promise<Channel> {
  const stored = connections.get(connectionId);
  if (!stored) {
    return Promise.reject(new Error("unknown_connection"));
  }
  const remoteRoot = stored.remoteRoot;
  const startCmd = `cd ${shellQuotePosix(remoteRoot)} && exec $SHELL -l`;
  return new Promise((resolve, reject) => {
    stored.client.exec(
      startCmd,
      { pty: { term: "xterm-256color", cols, rows, width: 0, height: 0 } },
      (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream);
      },
    );
  });
}

export async function listTree(connectionId: string, relativeDir: string): Promise<TreeEntry[]> {
  const stored = connections.get(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const absDir = resolveUnderRemoteRoot(stored.remoteRoot, relativeDir);
  const stats = await sftpStat(stored.sftp, absDir);
  if (!stats.isDirectory()) {
    throw new Error("not_a_directory");
  }
  const entries = await sftpReaddir(stored.sftp, absDir);

  const mapped: TreeEntry[] = [];
  for (const ent of entries) {
    if (mapped.length >= MAX_TREE_ENTRIES) {
      break;
    }
    const name = ent.filename;
    if (name === "." || name === "..") {
      continue;
    }
    const childAbs = path.join(absDir, name);
    const relToRoot = path.relative(stored.remoteRoot, childAbs);
    const isDir = (ent.attrs.mode & fsConstants.S_IFMT) === fsConstants.S_IFDIR;
    mapped.push({
      name,
      path: relToRoot,
      type: isDir ? "dir" : "file",
    });
  }
  mapped.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return mapped;
}

export async function readRemoteTextFile(connectionId: string, relativePath: string): Promise<string> {
  const stored = connections.get(connectionId);
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
  return buf.toString("utf8");
}

export async function writeRemoteTextFile(connectionId: string, relativePath: string, contents: string): Promise<void> {
  const stored = connections.get(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const abs = resolveUnderRemoteRoot(stored.remoteRoot, relativePath);
  await sftpWriteFile(stored.sftp, abs, contents);
}

/**
 * Creates an empty file at `relativePath`. Fails with `file_exists` if the path
 * already resolves to anything (file or dir) on the remote host. Used by the
 * "New file" action so two tabs can never silently clobber each other.
 */
export async function createRemoteEmptyFile(
  connectionId: string,
  relativePath: string,
): Promise<void> {
  const stored = connections.get(connectionId);
  if (!stored) {
    throw new Error("unknown_connection");
  }
  const abs = resolveUnderRemoteRoot(stored.remoteRoot, relativePath);
  let exists = false;
  try {
    await sftpStat(stored.sftp, abs);
    exists = true;
  } catch {
    /* not found: good, fall through to write */
  }
  if (exists) {
    throw new Error("file_exists");
  }
  await sftpWriteFile(stored.sftp, abs, "");
}
