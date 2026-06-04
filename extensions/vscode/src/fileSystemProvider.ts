import * as vscode from "vscode";
import type { ConduitClient, ConduitDocument } from "@conduit/client";

/**
 * Maps `conduit://<connectionId>/<path>` URIs into the Conduit middleman.
 *
 * VS Code calls `stat`, `readDirectory`, `readFile`, `writeFile`, etc; we
 * translate those into HTTP calls for tree/listing operations and into
 * `ConduitClient.openDocument` for live editing.
 *
 * The interesting design choice is the writeFile path: VS Code's "Save"
 * gesture flows through here, but in collaborative mode the canonical state
 * lives in the server's Y.Doc — not in the local TextDocument. We therefore
 * use writeFile as the trigger for `doc.save()` (persist current Y.Doc to
 * SFTP) without overwriting the Y.Doc itself.
 */

const SCHEME = "conduit";

export type ParsedUri = {
  connectionId: string;
  /** POSIX path inside the workspace, no leading slash. */
  path: string;
};

export function parseUri(uri: vscode.Uri): ParsedUri {
  if (uri.scheme !== SCHEME) {
    throw new Error(`expected conduit:// uri, got ${uri.scheme}`);
  }
  const path = uri.path.replace(/^\/+/, "");
  return { connectionId: uri.authority, path };
}

export function uriFor(connectionId: string, path: string): vscode.Uri {
  return vscode.Uri.parse(`${SCHEME}://${connectionId}/${path}`);
}

type LiveDoc = {
  doc: ConduitDocument;
  /** Last known content snapshot; used to compute diffs for VS Code edits. */
  lastSnapshot: string;
};

export class ConduitFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  /** Live Yjs-backed docs keyed by `connectionId\0path`. */
  private readonly liveDocs = new Map<string, LiveDoc>();

  /**
   * Resolve fresh URIs in the bound text editor against this provider.
   * `getClient` is a factory because the user can sign out / change tokens
   * and we need a new ConduitClient transparently.
   */
  constructor(private readonly getClient: () => ConduitClient) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { connectionId, path } = parseUri(uri);
    if (path === "" || path === "/") {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      };
    }
    const c = this.getClient();
    const data = await this.fetchTree(c, connectionId, parentOf(path));
    const name = path.split("/").pop()!;
    const entry = data.entries.find((e) => e.name === name);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: entry.type === "dir" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { connectionId, path } = parseUri(uri);
    const c = this.getClient();
    const data = await this.fetchTree(c, connectionId, path);
    return data.entries.map((e) => [e.name, e.type === "dir" ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { connectionId, path } = parseUri(uri);
    const c = this.getClient();
    const key = liveKey(connectionId, path);
    let live = this.liveDocs.get(key);
    if (!live) {
      const doc = await c.openDocument(connectionId, path);
      await doc.ready();
      live = { doc, lastSnapshot: doc.ydoc.getText("content").toString() };
      this.liveDocs.set(key, live);

      // Push remote edits into VS Code by reporting the file as changed.
      // VS Code will call readFile again to pick up the new content.
      doc.ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
        if (origin === "remote" || origin === "vscode-edit") return;
        // Local Y.Doc transaction we initiated -- already in sync with editor.
      });
      doc.ydoc.getText("content").observe(() => {
        const fresh = doc.ydoc.getText("content").toString();
        if (live!.lastSnapshot === fresh) return;
        live!.lastSnapshot = fresh;
        this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      });
      doc.onEvicted(() => {
        this.liveDocs.delete(key);
        this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        try {
          doc.close();
        } catch {
          /* already gone */
        }
      });
    }
    return Buffer.from(live.doc.ydoc.getText("content").toString(), "utf8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { connectionId, path } = parseUri(uri);
    const c = this.getClient();
    const key = liveKey(connectionId, path);
    let live = this.liveDocs.get(key);
    if (!live) {
      // First write for a fresh file: open the doc to seed it.
      const doc = await c.openDocument(connectionId, path);
      await doc.ready();
      live = { doc, lastSnapshot: doc.ydoc.getText("content").toString() };
      this.liveDocs.set(key, live);
    }
    const next = Buffer.from(content).toString("utf8");
    if (next !== live.lastSnapshot) {
      // Apply as a single Yjs transaction so remote peers see it as one op.
      live.doc.ydoc.transact(() => {
        const ytext = live!.doc.ydoc.getText("content");
        ytext.delete(0, ytext.length);
        ytext.insert(0, next);
      }, "vscode-edit");
      live.lastSnapshot = next;
    }
    // Persist to SFTP via the protocol's `save` op.
    live.doc.save();
  }

  /** Triggered by `conduit.refreshActive` (Ctrl+Alt+R from the menu). */
  async refresh(connectionId: string, path: string): Promise<void> {
    const key = liveKey(connectionId, path);
    const live = this.liveDocs.get(key);
    if (!live) return;
    live.doc.refresh(true);
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions("rename via VS Code is not yet supported");
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions("delete via VS Code is not yet supported");
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions("creating directories is not yet supported");
  }

  /** Looks up a live Y.Doc for the editor binding. */
  getLiveDoc(connectionId: string, path: string): ConduitDocument | null {
    return this.liveDocs.get(liveKey(connectionId, path))?.doc ?? null;
  }

  /** REST helper to fetch directory listing -- no live doc needed. */
  private async fetchTree(
    c: ConduitClient,
    connectionId: string,
    path: string,
  ): Promise<{ entries: { name: string; path: string; type: "file" | "dir" }[] }> {
    const url = `/api/connections/${encodeURIComponent(connectionId)}/tree?path=${encodeURIComponent(path)}`;
    // ConduitClient's `get` is private; do the fetch directly.
    const res = await fetch(`${(c as unknown as { baseUrl: string }).baseUrl}${url}`, {
      headers: { authorization: `Bearer ${(c as unknown as { token?: string }).token ?? ""}` },
    });
    if (!res.ok) {
      throw vscode.FileSystemError.FileNotFound(uriFor(connectionId, path));
    }
    return (await res.json()) as { entries: { name: string; path: string; type: "file" | "dir" }[] };
  }
}

function liveKey(connectionId: string, path: string): string {
  return `${connectionId}\0${path}`;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}
