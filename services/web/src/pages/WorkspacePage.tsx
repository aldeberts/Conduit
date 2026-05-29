import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { EditorWorkbench, type EditorTab } from "../components/EditorWorkbench";
import { TerminalPanel } from "../components/TerminalPanel";
import {
  closeDocument,
  createFile,
  deleteConnection,
  getDocument,
  openDocument,
  refreshDocument,
  saveDocument,
  fetchTree,
  type DocumentState,
  type TreeEntry,
} from "../lib/api";
import { subscribeWsTree } from "../lib/wsPool";

type LocationState = { label?: string; remoteRoot?: string } | null;

const apiToken = import.meta.env.VITE_API_TOKEN as string | undefined;

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
  const [connectionLost, setConnectionLost] = useState(false);

  const id = connectionId ?? "";
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

  const onSave = async (): Promise<void> => {
    if (!id || !activePath) {
      return;
    }
    setSaveError(null);
    try {
      const doc = await saveDocument(id, activePath);
      applyDoc(doc);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRefresh = async (force: boolean): Promise<void> => {
    if (!id || !activePath) {
      return;
    }
    setSaveError(null);
    try {
      const doc = await refreshDocument(id, activePath, force);
      applyDoc(doc);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

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

  const onCloseConnection = async (): Promise<void> => {
    if (!id) {
      navigate("/");
      return;
    }
    try {
      await deleteConnection(id);
    } catch {
      /* still navigate home */
    }
    navigate("/");
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
          Back to connections
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
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.35rem" }}>
            <button type="button" className="ghost" onClick={() => void onCreateFile()}>
              New file
            </button>
            <button type="button" className="ghost" onClick={() => void onCloseConnection()}>
              Disconnect
            </button>
          </div>
        </div>
        <div className="tree">
          <DirBranch
            dirPath=""
            depth={0}
            expanded={expanded}
            entriesByDir={entriesByDir}
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
          onSave={() => void onSave()}
          onRefresh={(force) => void onRefresh(force)}
          saveError={saveError}
        />
        {id ? <TerminalPanel connectionId={id} apiToken={apiToken} /> : null}
      </div>
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
}): JSX.Element {
  const { dirPath, depth, expanded, entriesByDir, activePath, openPaths, onToggleDir, onOpenFile } = props;
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
          >
            <span className="chevron" />
            <span className="name">{ent.name}</span>
          </div>
        ),
      )}
    </>
  );
}
