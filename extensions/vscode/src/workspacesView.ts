import * as vscode from "vscode";
import type { ConduitClient, ConnectionsListItem } from "@conduit/client";

/**
 * Tree view in the explorer sidebar listing the user's Conduit workspaces.
 * Single-level (no nested files yet); clicking an item runs
 * `conduit.openConnection` which mounts the workspace folder.
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<ConnectionsListItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getClient: () => ConduitClient) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: ConnectionsListItem): vscode.TreeItem {
    const t = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    t.description = `${item.username}@${item.host}${item.isOpen ? "" : item.canRevive ? " · click to reopen" : " · closed"}`;
    t.iconPath = new vscode.ThemeIcon(item.isOpen ? "globe" : "circle-slash");
    t.command = {
      command: "conduit.openConnection",
      title: "Open",
      arguments: [{ connectionId: item.id }],
    };
    t.contextValue = "conduitWorkspace";
    return t;
  }

  async getChildren(): Promise<ConnectionsListItem[]> {
    try {
      const c = this.getClient();
      return await c.listConnections();
    } catch {
      return [];
    }
  }
}
