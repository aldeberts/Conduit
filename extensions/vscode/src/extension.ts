import * as vscode from "vscode";
import WS from "ws";
import { ConduitClient, type ConnectionsListItem } from "@conduit/client";
import { ConduitFileSystemProvider, parseUri } from "./fileSystemProvider";
import { WorkspacesTreeProvider } from "./workspacesView";
import { bindDocumentToTextEditor, unbindDocument } from "./editorBinding";

const SCHEME = "conduit";

let client: ConduitClient | null = null;
let fsProvider: ConduitFileSystemProvider | null = null;
let workspacesView: WorkspacesTreeProvider | null = null;

function getConfig(): { serverUrl: string; token: string } {
  const cfg = vscode.workspace.getConfiguration("conduit");
  return {
    serverUrl: (cfg.get<string>("serverUrl") ?? "").trim(),
    token: (cfg.get<string>("token") ?? "").trim(),
  };
}

function ensureClient(): ConduitClient {
  if (client) return client;
  const { serverUrl, token } = getConfig();
  if (!serverUrl) {
    throw new Error("conduit.serverUrl is not configured (Settings → Extensions → Conduit)");
  }
  client = new ConduitClient({
    baseUrl: serverUrl,
    token: token || undefined,
    webSocketFactory: (url) => new WS(url) as unknown as WebSocket,
  });
  return client;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  fsProvider = new ConduitFileSystemProvider(ensureClient);
  workspacesView = new WorkspacesTreeProvider(ensureClient);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.window.registerTreeDataProvider("conduit.workspaces", workspacesView),
    vscode.commands.registerCommand("conduit.signIn", () => signInCommand()),
    vscode.commands.registerCommand("conduit.openConnection", (item?: { connectionId?: string }) =>
      openConnectionCommand(item?.connectionId),
    ),
    vscode.commands.registerCommand("conduit.openFile", () => openFileCommand()),
    vscode.commands.registerCommand("conduit.saveActive", () => saveActiveCommand()),
    vscode.commands.registerCommand("conduit.refreshActive", () => refreshActiveCommand()),
  );

  // Bind awareness + Yjs to any editor showing a conduit:// document.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document.uri.scheme === SCHEME && fsProvider && client) {
        void bindDocumentToTextEditor(client, fsProvider, ed);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) {
        unbindDocument(doc.uri);
      }
    }),
  );

  // Refresh tree when config changes (server URL / token).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("conduit")) {
        client?.destroy();
        client = null;
        workspacesView?.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  client?.destroy();
  client = null;
}

/* ----- commands -------------------------------------------------------- */

async function signInCommand(): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: "Conduit server URL",
    value: getConfig().serverUrl,
    placeHolder: "https://conduit.example.com",
    ignoreFocusOut: true,
  });
  if (!url) return;
  const token = await vscode.window.showInputBox({
    prompt: "Personal access token (issue one in the Conduit web UI under Settings)",
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) return;
  await vscode.workspace.getConfiguration("conduit").update("serverUrl", url, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("conduit").update("token", token, vscode.ConfigurationTarget.Global);
  client?.destroy();
  client = null;
  workspacesView?.refresh();
  vscode.window.showInformationMessage("Signed in to Conduit.");
}

async function openConnectionCommand(connectionId?: string): Promise<void> {
  const c = ensureClient();
  let conn: ConnectionsListItem | undefined;
  if (connectionId) {
    const list = await c.listConnections();
    conn = list.find((x) => x.id === connectionId);
  } else {
    const list = await c.listConnections();
    if (list.length === 0) {
      vscode.window.showWarningMessage("No Conduit workspaces. Create one from the web UI first.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      list.map((x) => ({
        label: x.label,
        description: `${x.username}@${x.host} • ${x.remotePath}`,
        detail: x.isOpen ? "open" : x.canRevive ? "closed (click to reopen)" : "closed (re-open from web)",
        connectionId: x.id,
      })),
      { placeHolder: "Pick a Conduit workspace" },
    );
    if (!pick) return;
    conn = list.find((x) => x.id === pick.connectionId);
  }
  if (!conn) return;
  // VS Code treats each conduit://connId/ URI as a workspace root.
  const folderUri = vscode.Uri.parse(`${SCHEME}://${conn.id}/`);
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
    uri: folderUri,
    name: `Conduit · ${conn.label}`,
  });
}

async function openFileCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
  if (!folder) {
    vscode.window.showWarningMessage("Open a Conduit workspace first (Conduit: Open Workspace).");
    return;
  }
  const rel = await vscode.window.showInputBox({
    prompt: "File path inside the workspace",
    placeHolder: "src/main.ts",
    ignoreFocusOut: true,
  });
  if (!rel) return;
  const uri = vscode.Uri.parse(`${folder.uri.toString()}${rel}`);
  await vscode.window.showTextDocument(uri);
}

async function saveActiveCommand(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== SCHEME) {
    vscode.window.showInformationMessage("Active document is not a Conduit document.");
    return;
  }
  // VS Code's built-in save calls our FileSystemProvider.writeFile, which
  // forwards to the Yjs save mechanism. Trigger it here for explicitness.
  await ed.document.save();
}

async function refreshActiveCommand(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== SCHEME || !fsProvider) return;
  const { connectionId, path } = parseUri(ed.document.uri);
  await fsProvider.refresh(connectionId, path);
}
