import CodeMirror from "@uiw/react-codemirror";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter } from "@codemirror/language";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import { catppuccinMochaTheme } from "../editor/catppuccinMocha";
import { languageSupportForPath } from "../editor/languageSupport";
import { DocumentWsSync } from "../lib/documentWs";
import { base64ToUint8, uint8ToBase64 } from "@conduit/client";
import { loadOrCreateUserIdentity } from "../lib/userIdentity";

export type CollabActions = {
  /** Asks the server to flush this tab's buffer to remote storage. */
  save: () => boolean;
  /** Reload from remote storage. `force` discards local dirty edits. */
  refresh: (force: boolean) => boolean;
};

type Props = {
  connectionId: string;
  path: string;
  /** When false, editor stays mounted for CRDT sync but is hidden (background tab). */
  active?: boolean;
  /** Text from HTTP open; shown while waiting for WS snapshot only. */
  seedContent?: string;
  apiToken?: string;
  onRevision?: (revision: number, dirty: boolean) => void;
  onMarkDirty?: () => void;
  /** Result of a previously-issued save / refresh. `error` is non-empty on failure. */
  onOpResult?: (op: "save" | "refresh", ok: boolean, error?: string) => void;
  /** Server told us the document is gone; the tab should be closed locally. */
  onDocEvicted?: (reason: "deleted" | "renamed" | "evicted") => void;
  /**
   * Called once with `{save, refresh}` when the editor's WS sync is ready, and
   * once with `null` when it tears down. Parents key by path to route Save/Refresh
   * button clicks to the active tab.
   */
  registerActions?: (actions: CollabActions | null) => void;
};

/**
 * Manual CodeMirror EditorView for yCollab.
 *
 * We don't use @uiw/react-codemirror here because its controlled `value` prop conflicts
 * with yCollab: any time React rendered with `value` different from the editor doc,
 * the wrapper would dispatch an editor change marked `ExternalChange`. yCollab does not
 * recognise that annotation, so it would echo the change into ytext — and in StrictMode's
 * double-mount it would echo "delete everything, insert ''" because `value` briefly
 * collapsed to undefined/empty between mounts. That's what caused the doc to wipe and
 * the file to be marked dirty.
 *
 * Mounting EditorState.create({ doc: ytext.toString() }) once, exactly the way
 * y-codemirror.next docs recommend, sidesteps all of that.
 */
function CollabCodeMirrorPane({
  path,
  ytext,
  awareness,
  onEditorReady,
}: {
  path: string;
  ytext: Y.Text;
  awareness: Awareness;
  onEditorReady: (view: EditorView) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const heightTheme = EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": { height: "100% !important" },
    });
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        ...catppuccinMochaTheme,
        heightTheme,
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of(defaultKeymap),
        ...languageSupportForPath(path),
        yCollab(ytext, awareness, { undoManager: false }),
        // Put Tab last so it has highest precedence: without an editor binding
        // for Tab, the browser would otherwise move focus to the next
        // tabindex'd element (e.g. the terminal).
        keymap.of([indentWithTab]),
      ],
    });
    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    onEditorReady(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path, ytext, awareness, onEditorReady]);

  return <div ref={containerRef} className="editor-codemirror" />;
}

export function CollaborativeEditor({
  connectionId,
  path,
  active = true,
  seedContent,
  apiToken,
  onRevision,
  onMarkDirty,
  onOpResult,
  onDocEvicted,
  registerActions,
}: Props): JSX.Element {
  const syncRef = useRef<DocumentWsSync | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const [collabReady, setCollabReady] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRevisionRef = useRef(onRevision);
  onRevisionRef.current = onRevision;
  const onMarkDirtyRef = useRef(onMarkDirty);
  onMarkDirtyRef.current = onMarkDirty;
  const onOpResultRef = useRef(onOpResult);
  onOpResultRef.current = onOpResult;
  const onDocEvictedRef = useRef(onDocEvicted);
  onDocEvictedRef.current = onDocEvicted;
  const registerActionsRef = useRef(registerActions);
  registerActionsRef.current = registerActions;
  const seedContentRef = useRef(seedContent);
  seedContentRef.current = seedContent;
  const [fallbackText, setFallbackText] = useState(seedContent ?? "");

  useEffect(() => {
    if (seedContent) {
      setFallbackText(seedContent);
    }
  }, [seedContent]);

  useEffect(() => {
    if (!path) {
      return;
    }

    // `awareness` is constructed up here so both the sync callback and the
    // Y-Awareness 'update' listener (registered below) can close over it.
    let awareness: Awareness | null = null;

    const sync = new DocumentWsSync(
      connectionId,
      path,
      {
        onSubscribed: () => {
          setSubscribed(true);
          setCollabReady(true);
        },
        onState: (revision, dirty) => onRevisionRef.current?.(revision, dirty),
        onLocalEdit: () => onMarkDirtyRef.current?.(),
        onError: (msg) => setError(msg),
        onAwarenessUpdate: (updateB64) => {
          if (awareness) {
            applyAwarenessUpdate(awareness, base64ToUint8(updateB64), "remote");
          }
        },
        onOpResult: (op, ok, errorMsg) => onOpResultRef.current?.(op, ok, errorMsg),
        onDocEvicted: (reason) => onDocEvictedRef.current?.(reason),
      },
      apiToken,
    );

    const seed = seedContentRef.current ?? "";
    if (seed.length > 0) {
      setFallbackText(seed);
    }
    awareness = new Awareness(sync.ydoc);
    const identity = loadOrCreateUserIdentity();
    awareness.setLocalStateField("user", {
      name: identity.name,
      color: identity.color,
      colorLight: identity.colorLight,
    });

    // Forward local awareness changes (cursor moves, identity changes) to the
    // server, which fans them out to other subscribers. Skip events with
    // origin="remote" so we don't echo what we just received.
    const awarenessHandler = (
      _changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === "remote") {
        return;
      }
      if (!awareness) {
        return;
      }
      const payload = encodeAwarenessUpdate(awareness, [awareness.clientID]);
      sync.sendAwareness(uint8ToBase64(payload));
    };
    awareness.on("update", awarenessHandler);

    syncRef.current = sync;
    awarenessRef.current = awareness;
    setError(null);
    setCollabReady(true);
    setSubscribed(false);
    sync.connect();
    registerActionsRef.current?.({
      save: () => sync.save(),
      refresh: (force) => sync.refresh(force),
    });

    return () => {
      registerActionsRef.current?.(null);
      awareness?.off("update", awarenessHandler);
      sync.disableSync();
      sync.disconnect();
      awareness?.destroy();
      syncRef.current = null;
      awarenessRef.current = null;
      setCollabReady(false);
      setSubscribed(false);
    };
  }, [connectionId, path, apiToken]);

  useEffect(() => {
    const sync = syncRef.current;
    if (!sync || !subscribed) {
      return;
    }
    if (active) {
      sync.enableSync();
    } else {
      sync.disableSync();
    }
  }, [active, subscribed]);

  const activeRef = useRef(active);
  activeRef.current = active;
  const onCollabMount = useCallback((view: EditorView): void => {
    const s = syncRef.current;
    if (!s) {
      return;
    }
    if (activeRef.current) {
      s.enableSync();
    } else {
      s.disableSync();
    }
    void view;
  }, []);

  const wrapClass = (): string => "editor-cm-wrap";

  if (!path) {
    return <div className="editor-empty">Select a file from the sidebar.</div>;
  }

  if (error) {
    return <div className="editor-empty editor-empty-error">{error}</div>;
  }

  if (!collabReady || !syncRef.current || !awarenessRef.current) {
    return (
      <div className={wrapClass()}>
        <div className="editor-empty">Connecting collaborative session…</div>
      </div>
    );
  }

  const sync = syncRef.current;
  const awareness = awarenessRef.current;

  if (!subscribed) {
    const showConnectOverlay = fallbackText.length === 0;
    return (
      <div className={wrapClass()}>
        <CodeMirror
          key={`${path}-fallback`}
          height="100%"
          theme="dark"
          value={fallbackText}
          extensions={[
            ...catppuccinMochaTheme,
            EditorView.lineWrapping,
            EditorState.readOnly.of(true),
            ...languageSupportForPath(path),
          ]}
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
          className="editor-codemirror"
        />
        {showConnectOverlay ? (
          <div className="editor-connecting-overlay">Connecting collaborative session…</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={wrapClass()}>
      <CollabCodeMirrorPane
        path={path}
        ytext={sync.ytext}
        awareness={awareness}
        onEditorReady={onCollabMount}
      />
    </div>
  );
}
