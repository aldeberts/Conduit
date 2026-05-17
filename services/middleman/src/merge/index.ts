import * as Y from "yjs";

/**
 * Creates a collaborative text document for one file path.
 * Yjs updates will later sync over WebSocket between editors; for now this
 * proves the dependency is wired.
 */
export function createTextDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content");
  return doc;
}
