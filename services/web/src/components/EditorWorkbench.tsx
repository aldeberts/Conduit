import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import { catppuccinMochaTheme } from "../editor/catppuccinMocha";
import { languageSupportForPath } from "../editor/languageSupport";

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
  tabs: EditorTab[];
  activePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onEdit: (path: string, value: string) => void;
  onSave: () => void;
  onRefresh: (force: boolean) => void;
  saveError: string | null;
};

export function EditorWorkbench({
  tabs,
  activePath,
  onSelectTab,
  onCloseTab,
  onEdit,
  onSave,
  onRefresh,
  saveError,
}: Props): JSX.Element {
  const active = tabs.find((t) => t.path === activePath) ?? null;

  const extensions = useMemo(
    () => [...catppuccinMochaTheme, EditorView.lineWrapping, ...languageSupportForPath(activePath ?? "")],
    [activePath],
  );

  const canSave = Boolean(active?.loaded && !active.loading && active.dirty);

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
        {!activePath || !active ? (
          <div className="editor-empty">Open a file from the sidebar to start editing.</div>
        ) : active.loading ? (
          <div className="editor-empty">Loading…</div>
        ) : active.loadError ? (
          <div className="editor-empty editor-empty-error">{active.loadError}</div>
        ) : (
          <CodeMirror
            value={active.content}
            height="100%"
            theme="dark"
            extensions={extensions}
            onChange={(value) => onEdit(active.path, value)}
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
            className="editor-codemirror"
          />
        )}
      </div>
    </section>
  );
}
