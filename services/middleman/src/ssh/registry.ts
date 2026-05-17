import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path/posix";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
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

export async function closeConnection(id: string): Promise<boolean> {
  const stored = connections.get(id);
  if (!stored) {
    return false;
  }
  connections.delete(id);
  stored.sftp.end();
  stored.client.end();
  return true;
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
