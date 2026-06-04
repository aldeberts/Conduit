# Conduit for VS Code / Cursor

Live, multi-user editing of remote files via your Conduit server -- directly
inside VS Code or Cursor.

## Install (development)

This extension lives inside the Conduit monorepo and is not yet published to
the VS Code Marketplace. To try it locally:

```bash
cd extensions/vscode
npm install
npm run build
# Then in VS Code: F1 → "Developer: Install Extension from Location..." → pick this folder.
```

## First-time setup

1. Open Settings → Extensions → Conduit (or run **Conduit: Sign In**).
2. Fill in:
   - **Server URL**: `https://conduit.example.com`
   - **Token**: a personal access token issued from the web UI (Settings →
     Personal access tokens). The admin `API_TOKEN` from `/etc/conduit/env`
     also works.
3. The "Conduit Workspaces" view in the explorer sidebar should populate with
   your workspaces. Click one to mount it as a VS Code workspace folder
   (`conduit://<connectionId>/`).
4. Open a file -- live Yjs sync starts automatically. Use ⌘S (or the Conduit:
   Save Active Document command) to persist to the remote host via SFTP.

## What works in v0.1

- Listing workspaces from the Conduit server.
- Mounting a workspace as a VS Code folder via the `conduit://` URI scheme.
- Browsing the remote file tree (via SFTP through the middleman).
- Opening text files; live Yjs sync between every connected client (other VS
  Code instances, browser tabs).
- Remote cursor decorations colored per user (full y-monaco fidelity is a
  follow-up).
- `Save` triggers the server's SFTP write; `Refresh` reloads from disk
  (discarding local dirty edits).
- Personal access tokens for auth.

## Known limitations

- No file rename / delete from VS Code yet -- use the web UI.
- No PTY / terminal integration; use VS Code's built-in terminal against your
  remote host with SSH.
- Large binary files are not supported (this is a text editing protocol).
- The Yjs ↔ TextDocument bridge does a whole-document replace on each side;
  per-range deltas are a future optimization.

## Architecture

The extension is a thin wrapper around `@conduit/client` (the same package
that powers the web UI). The wire protocol is documented in
[`docs/protocol.md`](../../docs/protocol.md).

```
VS Code TextDocument <-> editorBinding.ts <-> ConduitClient <-> middleman <-> SFTP
                            ^                       ^
                            +-- awareness ----------+
                                (remote cursors)
```
