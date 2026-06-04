import * as vscode from "vscode";
import type { ConduitClient } from "@conduit/client";
import type { ConduitFileSystemProvider } from "./fileSystemProvider";
import { parseUri } from "./fileSystemProvider";

/**
 * Hooks a `conduit://` text editor up to live Yjs sync + remote cursor
 * decorations. The pattern is:
 *   - Local edits → Y.Doc transaction (so other peers see the change).
 *   - Remote Y.Doc updates → diff against the current TextDocument and apply
 *     as a `WorkspaceEdit` (so VS Code's editor reflects them).
 *   - Awareness `getStates()` → decorate other users' cursors with colored
 *     gutter markers (full y-monaco-style fancy decorations are a follow-up).
 *
 * The implementation is deliberately conservative: it favors correctness over
 * minimal-diff cleverness. Performance for large files can be tuned later.
 */

type Binding = {
  uri: vscode.Uri;
  disposables: vscode.Disposable[];
  /** Last text we know VS Code has, used to detect VS-Code-initiated edits. */
  lastVsCodeText: string;
  /** Decoration types we created so we can dispose them on unbind. */
  cursorDecorations: vscode.TextEditorDecorationType[];
};

const bindings = new Map<string, Binding>();

function key(uri: vscode.Uri): string {
  return uri.toString();
}

export async function bindDocumentToTextEditor(
  client: ConduitClient,
  fsProvider: ConduitFileSystemProvider,
  editor: vscode.TextEditor,
): Promise<void> {
  const uri = editor.document.uri;
  if (bindings.has(key(uri))) return;
  const { connectionId, path } = parseUri(uri);

  const doc = await client.openDocument(connectionId, path, {
    initialAwareness: {
      user: {
        name: process.env.USER || process.env.USERNAME || "vscode-user",
        color: pickColor(),
      },
    },
  });
  await doc.ready();

  const ytext = doc.ydoc.getText("content");

  const binding: Binding = {
    uri,
    disposables: [],
    lastVsCodeText: editor.document.getText(),
    cursorDecorations: [],
  };
  bindings.set(key(uri), binding);

  /* ---- Y.Doc → editor ------------------------------------------------ */

  // Whenever Yjs changes, diff against VS Code's current text and patch.
  const applyRemote = async (): Promise<void> => {
    const yText = ytext.toString();
    if (yText === editor.document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length),
    );
    edit.replace(uri, fullRange, yText);
    await vscode.workspace.applyEdit(edit);
    binding.lastVsCodeText = yText;
  };
  const ytextObserver = (): void => {
    void applyRemote();
  };
  ytext.observe(ytextObserver);
  binding.disposables.push(new vscode.Disposable(() => ytext.unobserve(ytextObserver)));

  /* ---- editor → Y.Doc ----------------------------------------------- */

  binding.disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== uri.toString()) return;
      const next = e.document.getText();
      if (next === binding.lastVsCodeText) return;
      // Whole-document replace inside one Yjs transaction. Per-range edits
      // would be tighter; this keeps the binding small and correct.
      doc.ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, next);
      }, "vscode-edit");
      binding.lastVsCodeText = next;
    }),
  );

  /* ---- selection → awareness ---------------------------------------- */

  const pushSelection = (): void => {
    const sel = editor.selections[0];
    if (!sel) return;
    const anchor = editor.document.offsetAt(sel.anchor);
    const head = editor.document.offsetAt(sel.active);
    doc.awareness.setLocalStateField("cursor", { anchor, head });
  };
  pushSelection();
  binding.disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== editor) return;
      pushSelection();
    }),
  );

  /* ---- remote awareness → decorations ------------------------------- */

  const renderAwareness = (): void => {
    const states = doc.awareness.getStates();
    // Drop old decorations.
    for (const d of binding.cursorDecorations) d.dispose();
    binding.cursorDecorations = [];
    for (const [clientId, state] of states.entries()) {
      if (clientId === doc.awareness.clientID) continue;
      const cursor = (state as { cursor?: { anchor?: number; head?: number } }).cursor;
      const user = (state as { user?: { name?: string; color?: string } }).user;
      if (!cursor || typeof cursor.head !== "number" || !user?.color) continue;
      const dec = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: "▎",
          color: user.color,
          fontWeight: "bold",
        },
        after: {
          contentText: ` ${user.name ?? "anon"}`,
          color: user.color,
          fontStyle: "italic",
          margin: "0 0 0 4px",
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      const pos = editor.document.positionAt(cursor.head);
      editor.setDecorations(dec, [{ range: new vscode.Range(pos, pos) }]);
      binding.cursorDecorations.push(dec);
    }
  };
  renderAwareness();
  doc.awareness.on("change", renderAwareness);
  binding.disposables.push(new vscode.Disposable(() => doc.awareness.off("change", renderAwareness)));

  /* ---- save/refresh feedback --------------------------------------- */

  binding.disposables.push(
    new vscode.Disposable(
      doc.onOpResult((op, ok, err) => {
        if (ok) {
          vscode.window.setStatusBarMessage(`Conduit: ${op} ok`, 2000);
        } else {
          vscode.window.showWarningMessage(`Conduit: ${op} failed: ${err ?? "unknown"}`);
        }
      }),
    ),
  );
  binding.disposables.push(
    new vscode.Disposable(
      doc.onEvicted((reason) => {
        vscode.window.showWarningMessage(`Conduit: document was ${reason}; the editor will close.`);
        // Removing the editor pane is a bit aggressive — show the message and let
        // the user close it.
      }),
    ),
  );
}

export function unbindDocument(uri: vscode.Uri): void {
  const b = bindings.get(key(uri));
  if (!b) return;
  bindings.delete(key(uri));
  for (const d of b.disposables) {
    try {
      d.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const d of b.cursorDecorations) d.dispose();
}

const COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#fab387", "#cba6f7", "#f38ba8", "#94e2d5"];

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#89b4fa";
}
