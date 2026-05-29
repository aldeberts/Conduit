import { CollaborativeEditor } from "./CollaborativeEditor";

export type EditorTab = {
  path: string;
  content: string;
  revision: number;
  loaded: boolean;
  loading: boolean;
  dirty: boolean;
  loadError?: string;
};

function shortName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

type Props = {
  connectionId: string;
  apiToken?: string;
  tabs: EditorTab[];
  activePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onRevision: (path: string, revision: number, dirty: boolean) => void;
  onMarkDirty: (path: string) => void;
  onSave: () => void;
  onRefresh: (force: boolean) => void;
  saveError: string | null;
};

export function EditorWorkbench({
  connectionId,
  apiToken,
  tabs,
  activePath,
  onSelectTab,
  onCloseTab,
  onRevision,
  onMarkDirty,
  onSave,
  onRefresh,
  saveError,
}: Props): JSX.Element {
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const canSave = Boolean(active?.loaded && !active.loading && active.dirty);
  const loadedTabs = tabs.filter((t) => t.loaded && !t.loading && !t.loadError);

  return (
    <section className="editor-pane">
      <div className="editor-tabs" role="tablist" aria-label="Open files">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            role="tab"
            aria-selected={tab.path === activePath}
            className={`editor-tab ${tab.path === activePath ? "active" : ""}`}
            onClick={() => onSelectTab(tab.path)}
          >
            <span className="editor-tab-label">
              {shortName(tab.path)}
              {tab.dirty ? <span className="editor-tab-dirty" title="Unsaved changes" /> : null}
            </span>
            <button
              type="button"
              className="editor-tab-close"
              aria-label={`Close ${tab.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="editor-toolbar">
        <span className="path" title={active?.path}>
          {active?.path ?? "Select a file from the tree"}
        </span>
        <button type="button" className="ghost" disabled={!active?.loaded} onClick={() => onRefresh(false)}>
          Reload
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!active?.loaded}
          title="Discard local edits and reload from disk"
          onClick={() => onRefresh(true)}
        >
          Revert
        </button>
        <button type="button" className="primary" disabled={!canSave} onClick={onSave}>
          Save
        </button>
      </div>
      {saveError ? <div className="error editor-banner">{saveError}</div> : null}
      <div className="editor-cm-host">
        {active?.loading ? (
          <div className="editor-empty">Loading…</div>
        ) : active?.loadError ? (
          <div className="editor-empty editor-empty-error">{active.loadError}</div>
        ) : loadedTabs.length === 0 ? (
          <div className="editor-empty">Select a file from the sidebar.</div>
        ) : (
          loadedTabs.map((tab) => (
            <div
              key={tab.path}
              className={`editor-tab-pane${tab.path === activePath ? " active" : ""}`}
              aria-hidden={tab.path !== activePath}
            >
              <CollaborativeEditor
                connectionId={connectionId}
                path={tab.path}
                active={tab.path === activePath}
                seedContent={tab.content}
                apiToken={apiToken}
                onRevision={(revision, dirty) => onRevision(tab.path, revision, dirty)}
                onMarkDirty={() => onMarkDirty(tab.path)}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
