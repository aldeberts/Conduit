import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { EditorWorkbench, type EditorTab } from "../components/EditorWorkbench";
import { MembersPanel } from "../components/MembersPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import {
  closeDocument,
  closeConnectionSession,
  createFile,
  deleteFile,
  openDocument,
  fetchTree,
  renameFile,
  type DocumentState,
  type TreeEntry,
} from "../lib/api";
import { getApiToken } from "../lib/authToken";
import { subscribeWsTree } from "../lib/wsPool";

type LocationState = { label?: string; remoteRoot?: string } | null;

function docToTab(doc: DocumentState): EditorTab {
  return {
    path: doc.path,
    content: doc.content,
    revision: doc.revision,
    dirty: doc.dirty,
    loaded: true,
    loading: false,
  };
}

export function WorkspacePage(): JSX.Element {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const meta = (location.state as LocationState) ?? null;

  const [title, setTitle] = useState(meta?.label ?? "Workspace");
  const [remoteRoot, setRemoteRoot] = useState(meta?.remoteRoot ?? "");

  const [entriesByDir, setEntriesByDir] = useState<Record<string, TreeEntry[] | "loading" | "error">>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const id = connectionId ?? "";
  // Resolved once on mount; the login screen routes through a navigation, so a
  // remount picks up new tokens. Stored in a ref so the value doesn't change
  // between renders inside this page.
  const apiTokenRef = useRef<string | undefined>(getApiToken());
  const apiToken = apiTokenRef.current;
  const openPaths = useMemo(() => new Set(tabs.map((t) => t.path)), [tabs]);

  useEffect(() => {
    setEntriesByDir({});
    setExpanded(new Set([""]));
    setTabs([]);
    setActivePath(null);
    setSaveError(null);
  }, [id]);

  const loadDir = useCallback(
    async (dirPath: string): Promise<void> => {
      if (!id) {
        return;
      }
      // Only show "loading" if we have nothing to display yet. Re-fetches (e.g.
      // after a `tree_changed`) keep the old entries visible until the new ones
      // arrive, avoiding a flicker.
      setEntriesByDir((prev) => {
        const existing = prev[dirPath];
        if (Array.isArray(existing)) {
          return prev;
        }
        return { ...prev, [dirPath]: "loading" };
      });
      try {
        const res = await fetchTree(id, dirPath);
        setEntriesByDir((prev) => ({ ...prev, [dirPath]: res.entries }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "unknown_connection") {
          setConnectionLost(true);
        }
        setEntriesByDir((prev) => ({ ...prev, [dirPath]: "error" }));
      }
    },
    [id],
  );

  // Use a ref so the WS handler (registered once per `id`) sees the latest
  // entries map; we only want to refresh dirs that have actually been loaded.
  const entriesByDirRef = useRef(entriesByDir);
  entriesByDirRef.current = entriesByDir;

  useEffect(() => {
    if (!id) {
      return;
    }
    const unsub = subscribeWsTree(
      id,
      (msg) => {
        if (msg.connectionId !== id) {
          return;
        }
        // Re-fetch the affected dir if it's already loaded in the tree. We
        // don't auto-load unloaded dirs because the user hasn't expanded them.
        if (entriesByDirRef.current[msg.dir] !== undefined) {
          void loadDir(msg.dir);
        }
      },
      apiToken,
    );
    return unsub;
  }, [id, loadDir]);

  useEffect(() => {
    if (!id) {
      return;
    }
    for (const dir of expanded) {
      if (entriesByDir[dir] === undefined) {
        void loadDir(dir);
      }
    }
  }, [id, expanded, entriesByDir, loadDir]);

  const applyDoc = useCallback((doc: DocumentState) => {
    setTabs((prev) => prev.map((t) => (t.path === doc.path ? { ...docToTab(doc), loadError: undefined } : t)));
  }, []);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (!id) {
        return;
      }
      setSaveError(null);
      setActivePath(path);

      let alreadyLoaded = false;
      setTabs((prev) => {
        const existing = prev.find((t) => t.path === path);
        if (existing?.loaded) {
          alreadyLoaded = true;
          return prev;
        }
        const ex = prev.find((t) => t.path === path);
        if (ex) {
          return prev.map((t) =>
            t.path === path ? { ...t, loading: true, loadError: undefined } : t,
          );
        }
        return [...prev, { path, content: "", revision: 0, loaded: false, loading: true, dirty: false }];
      });

      if (alreadyLoaded) {
        return;
      }

      try {
        const doc = await openDocument(id, path);
        applyDoc(doc);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path
              ? { ...t, loaded: false, loading: false, dirty: false, loadError: msg }
              : t,
          ),
        );
      }
    },
    [id, applyDoc],
  );

  const onRevision = useCallback((path: string, revision: number, dirty: boolean) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.path !== path) {
          return t;
        }
        if (t.revision === revision && t.dirty === dirty) {
          return t;
        }
        changed = true;
        return { ...t, revision, dirty };
      });
      return changed ? next : prev;
    });
  }, []);

  const onMarkDirty = useCallback((path: string) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.path !== path || t.dirty) {
          return t;
        }
        changed = true;
        return { ...t, dirty: true };
      });
      return changed ? next : prev;
    });
  }, []);

  /**
   * WebSocket op_result handler — fired when the server responds to a save or
   * refresh request issued by THIS tab's WS. Failures go in the save banner;
   * successes clear it (revision/dirty updates flow through onState already).
   */
  const onOpResult = useCallback(
    (_path: string, op: "save" | "refresh", ok: boolean, error?: string) => {
      if (ok) {
        setSaveError(null);
        return;
      }
      const verb = op === "save" ? "Save" : "Refresh";
      setSaveError(error ? `${verb} failed: ${error}` : `${verb} failed`);
    },
    [],
  );

  const onSocketUnavailable = useCallback(() => {
    setSaveError("Not connected. Wait for the editor to reconnect and try again.");
  }, []);

  const onCloseTab = useCallback(
    (path: string) => {
      if (id) {
        void closeDocument(id, path);
      }
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path);
        if (activePath === path) {
          const pick = next[idx]?.path ?? next[idx - 1]?.path ?? next[0]?.path ?? null;
          setActivePath(pick);
        }
        return next;
      });
    },
    [id, activePath],
  );

  const onDocEvicted = useCallback(
    (path: string, reason: "deleted" | "renamed" | "evicted") => {
      onCloseTab(path);
      const reasonLabel = reason === "renamed" ? "moved" : reason;
      setSaveError(`The file ${path} was ${reasonLabel}; the tab has been closed.`);
    },
    [onCloseTab],
  );

  const onSelectTab = useCallback(
    (path: string) => {
      setActivePath(path);
      void openFile(path);
    },
    [openFile],
  );

  const onCreateFile = useCallback(async (): Promise<void> => {
    if (!id) {
      return;
    }
    const raw = window.prompt(
      "New file path (relative to workspace root, e.g. src/new.ts):",
      "",
    );
    if (raw === null) {
      return;
    }
    const trimmed = raw.trim().replace(/^\/+/, "");
    if (trimmed === "") {
      return;
    }
    setSaveError(null);
    try {
      await createFile(id, trimmed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(
        msg === "file_exists"
          ? `A file already exists at ${trimmed}`
          : `Could not create ${trimmed}: ${msg}`,
      );
      return;
    }
    // The server broadcasts tree_changed so other tabs refresh the dir; our
    // own tab still needs an immediate refresh + ensure the parent is expanded.
    const slash = trimmed.lastIndexOf("/");
    const parentDir = slash >= 0 ? trimmed.slice(0, slash) : "";
    setExpanded((prev) => {
      if (prev.has(parentDir)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(parentDir);
      return next;
    });
    await loadDir(parentDir);
    void openFile(trimmed);
  }, [id, loadDir, openFile]);

  // Right-click context menu for file rows in the tree. Closes on click-out.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = (): void => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, { capture: true });
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  const onFileContextMenu = useCallback((filePath: string, x: number, y: number): void => {
    setContextMenu({ x, y, path: filePath });
  }, []);

  const onDeleteFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!id) return;
      setContextMenu(null);
      const ok = window.confirm(`Delete ${filePath}? This cannot be undone.`);
      if (!ok) return;
      setSaveError(null);
      try {
        await deleteFile(id, filePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(`Could not delete ${filePath}: ${msg}`);
        return;
      }
      // The server broadcasts tree_changed + doc_evicted; this tab refreshes
      // its own parent dir immediately for snappiness.
      const slash = filePath.lastIndexOf("/");
      const parentDir = slash >= 0 ? filePath.slice(0, slash) : "";
      await loadDir(parentDir);
    },
    [id, loadDir],
  );

  const onRenameFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!id) return;
      setContextMenu(null);
      const raw = window.prompt("Rename file to (path relative to workspace root):", filePath);
      if (raw === null) return;
      const target = raw.trim().replace(/^\/+/, "");
      if (target === "" || target === filePath) {
        return;
      }
      setSaveError(null);
      try {
        await renameFile(id, filePath, target);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(
          msg === "target_exists"
            ? `A file already exists at ${target}`
            : `Could not rename ${filePath}: ${msg}`,
        );
        return;
      }
      const fromSlash = filePath.lastIndexOf("/");
      const fromDir = fromSlash >= 0 ? filePath.slice(0, fromSlash) : "";
      const toSlash = target.lastIndexOf("/");
      const toDir = toSlash >= 0 ? target.slice(0, toSlash) : "";
      setExpanded((prev) => {
        if (prev.has(toDir)) return prev;
        const next = new Set(prev);
        next.add(toDir);
        return next;
      });
      await loadDir(fromDir);
      if (toDir !== fromDir) {
        await loadDir(toDir);
      }
      // Open the new file (the old tab was closed by the doc_evicted handler).
      void openFile(target);
    },
    [id, loadDir, openFile],
  );

  const onCloseConnection = async (): Promise<void> => {
    if (!id) {
      navigate("/");
      return;
    }
    setDisconnectError(null);
    try {
      await closeConnectionSession(id);
      navigate("/");
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleDir = (dirPath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const subtitle = useMemo(() => {
    if (remoteRoot) {
      return remoteRoot;
    }
    return id ? `session ${id.slice(0, 8)}…` : "";
  }, [id, remoteRoot]);

  useEffect(() => {
    if (meta?.label) {
      setTitle(meta.label);
    }
    if (meta?.remoteRoot) {
      setRemoteRoot(meta.remoteRoot);
    }
  }, [meta?.label, meta?.remoteRoot]);

  if (connectionLost) {
    return (
      <div className="editor-empty editor-empty-error" style={{ padding: "2rem", flexDirection: "column", gap: "1rem" }}>
        <div>This SSH connection no longer exists on the server (middleman was restarted).</div>
        <button type="button" className="primary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
          <div style={{ fontSize: "0.8rem", marginTop: "0.2rem", wordBreak: "break-all" }}>{subtitle}</div>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
            <button type="button" className="ghost" onClick={() => void onCreateFile()}>
              New file
            </button>
            <button type="button" className="ghost" onClick={() => setShowMembers(true)}>
              Members
            </button>
            <button type="button" className="ghost" onClick={() => void onCloseConnection()}>
              Disconnect
            </button>
          </div>
          {disconnectError ? (
            <div className="error" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
              {disconnectError}
            </div>
          ) : null}
        </div>
        <div className="tree">
          <DirBranch
            dirPath=""
            depth={0}
            expanded={expanded}
            entriesByDir={entriesByDir}
            onFileContextMenu={onFileContextMenu}
            activePath={activePath}
            openPaths={openPaths}
            onToggleDir={toggleDir}
            onOpenFile={(p) => void openFile(p)}
          />
        </div>
      </aside>
      <div className="workspace-main">
        <EditorWorkbench
          connectionId={id}
          apiToken={apiToken}
          tabs={tabs}
          activePath={activePath}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onRevision={onRevision}
          onMarkDirty={onMarkDirty}
          onOpResult={onOpResult}
          onDocEvicted={onDocEvicted}
          onSocketUnavailable={onSocketUnavailable}
          saveError={saveError}
        />
        {id ? <TerminalPanel connectionId={id} apiToken={apiToken} /> : null}
      </div>
      {contextMenu ? (
        <ul
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <li>
            <button
              type="button"
              className="context-menu-item"
              onClick={() => void onRenameFile(contextMenu.path)}
            >
              Rename file…
            </button>
          </li>
          <li>
            <button
              type="button"
              className="context-menu-item danger"
              onClick={() => void onDeleteFile(contextMenu.path)}
            >
              Delete file
            </button>
          </li>
        </ul>
      ) : null}
      {showMembers && id ? (
        <MembersPanel connectionId={id} onClose={() => setShowMembers(false)} />
      ) : null}
    </div>
  );
}

function DirBranch(props: {
  dirPath: string;
  depth: number;
  expanded: Set<string>;
  entriesByDir: Record<string, TreeEntry[] | "loading" | "error">;
  activePath: string | null;
  openPaths: Set<string>;
  onToggleDir: (dirPath: string) => void;
  onOpenFile: (path: string) => void;
  onFileContextMenu: (path: string, x: number, y: number) => void;
}): JSX.Element {
  const {
    dirPath,
    depth,
    expanded,
    entriesByDir,
    activePath,
    openPaths,
    onToggleDir,
    onOpenFile,
    onFileContextMenu,
  } = props;
  const bucket = entriesByDir[dirPath];

  if (bucket === "loading" || bucket === undefined) {
    return (
      <div className="tree-row" style={{ ["--depth" as string]: String(depth) }}>
        <span className="name" style={{ color: "var(--muted)" }}>
          Loading…
        </span>
      </div>
    );
  }
  if (bucket === "error") {
    return (
      <div className="tree-row" style={{ ["--depth" as string]: String(depth) }}>
        <span className="name" style={{ color: "var(--danger)" }}>
          Failed to load
        </span>
      </div>
    );
  }

  return (
    <>
      {bucket.map((ent) =>
        ent.type === "dir" ? (
          <div key={ent.path}>
            <div
              className="tree-row"
              style={{ ["--depth" as string]: String(depth) }}
              onClick={() => onToggleDir(ent.path)}
            >
              <span className="chevron">{expanded.has(ent.path) ? "▾" : "▸"}</span>
              <span className="name">{ent.name}/</span>
            </div>
            {expanded.has(ent.path) ? (
              <DirBranch
                dirPath={ent.path}
                depth={depth + 1}
                expanded={expanded}
                entriesByDir={entriesByDir}
                activePath={activePath}
                openPaths={openPaths}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onFileContextMenu={onFileContextMenu}
              />
            ) : null}
          </div>
        ) : (
          <div
            key={ent.path}
            className={[
              "tree-row",
              ent.path === activePath ? "selected" : "",
              openPaths.has(ent.path) && ent.path !== activePath ? "open-in-tab" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ ["--depth" as string]: String(depth + 1) }}
            onClick={() => onOpenFile(ent.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              onFileContextMenu(ent.path, e.clientX, e.clientY);
            }}
            title="Right-click for actions (rename, delete)"
          >
            <span className="chevron" />
            <span className="name">{ent.name}</span>
          </div>
        ),
      )}
    </>
  );
}
