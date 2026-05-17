import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { EditorWorkbench, type EditorTab } from "../components/EditorWorkbench";
import {
  closeDocument,
  deleteConnection,
  getDocument,
  openDocument,
  patchDocument,
  refreshDocument,
  saveDocument,
  fetchTree,
  type DocumentState,
  type TreeEntry,
} from "../lib/api";

type LocationState = { label?: string; remoteRoot?: string } | null;

const PATCH_DEBOUNCE_MS = 400;

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

  const patchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const id = connectionId ?? "";
  const openPaths = useMemo(() => new Set(tabs.map((t) => t.path)), [tabs]);

  useEffect(() => {
    setEntriesByDir({});
    setExpanded(new Set([""]));
    setTabs([]);
    setActivePath(null);
    setSaveError(null);
    for (const t of patchTimers.current.values()) {
      clearTimeout(t);
    }
    patchTimers.current.clear();
  }, [id]);

  const loadDir = useCallback(
    async (dirPath: string): Promise<void> => {
      if (!id) {
        return;
      }
      setEntriesByDir((prev) => ({ ...prev, [dirPath]: "loading" }));
      try {
        const res = await fetchTree(id, dirPath);
        setEntriesByDir((prev) => ({ ...prev, [dirPath]: res.entries }));
      } catch {
        setEntriesByDir((prev) => ({ ...prev, [dirPath]: "error" }));
      }
    },
    [id],
  );

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

      const existing = tabs.find((t) => t.path === path);
      if (existing?.loaded) {
        try {
          const doc = await getDocument(id, path);
          applyDoc(doc);
        } catch {
          /* keep local tab state */
        }
        return;
      }

      setTabs((prev) => {
        const ex = prev.find((t) => t.path === path);
        if (ex) {
          return prev.map((t) =>
            t.path === path ? { ...t, loading: true, loadError: undefined } : t,
          );
        }
        return [
          ...prev,
          { path, content: "", revision: 0, loaded: false, loading: true, dirty: false },
        ];
      });

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
    [id, tabs, applyDoc],
  );

  const schedulePatch = useCallback(
    (path: string, content: string) => {
      if (!id) {
        return;
      }
      const prev = patchTimers.current.get(path);
      if (prev) {
        clearTimeout(prev);
      }
      patchTimers.current.set(
        path,
        setTimeout(() => {
          patchTimers.current.delete(path);
          void patchDocument(id, path, content)
            .then(applyDoc)
            .catch(() => {
              /* keep local dirty; user can retry on save */
            });
        }, PATCH_DEBOUNCE_MS),
      );
    },
    [id, applyDoc],
  );

  const onEdit = useCallback(
    (path: string, value: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.path === path ? { ...t, content: value, dirty: true } : t)),
      );
      schedulePatch(path, value);
    },
    [schedulePatch],
  );

  const onSave = async (): Promise<void> => {
    if (!id || !activePath) {
      return;
    }
    const pending = patchTimers.current.get(activePath);
    if (pending) {
      clearTimeout(pending);
      patchTimers.current.delete(activePath);
      const tab = tabs.find((t) => t.path === activePath);
      if (tab) {
        try {
          await patchDocument(id, activePath, tab.content);
        } catch {
          /* continue to save attempt */
        }
      }
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
      const pending = patchTimers.current.get(path);
      if (pending) {
        clearTimeout(pending);
        patchTimers.current.delete(path);
      }
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

  const onCloseConnection = async (): Promise<void> => {
    if (!id) {
      navigate("/");
      return;
    }
    for (const t of patchTimers.current.values()) {
      clearTimeout(t);
    }
    patchTimers.current.clear();
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

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
          <div style={{ fontSize: "0.8rem", marginTop: "0.2rem", wordBreak: "break-all" }}>{subtitle}</div>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.35rem" }}>
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
      <EditorWorkbench
        tabs={tabs}
        activePath={activePath}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onEdit={onEdit}
        onSave={() => void onSave()}
        onRefresh={(force) => void onRefresh(force)}
        saveError={saveError}
      />
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
