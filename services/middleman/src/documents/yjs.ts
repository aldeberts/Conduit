import * as Y from "yjs";

export const YTEXT_KEY = "content";

export function createDocumentYDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.getText(YTEXT_KEY);
  return ydoc;
}

export function getYText(ydoc: Y.Doc): Y.Text {
  return ydoc.getText(YTEXT_KEY);
}

export function readYTextContent(ydoc: Y.Doc): string {
  return getYText(ydoc).toString();
}

/** Replaces the full collaborative buffer (used after SFTP load / refresh). */
export function setYTextContent(ydoc: Y.Doc, content: string): void {
  const ytext = getYText(ydoc);
  ytext.delete(0, ytext.length);
  if (content.length > 0) {
    ytext.insert(0, content);
  }
}

export function encodeDocUpdate(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc);
}

export function applyDocUpdate(ydoc: Y.Doc, update: Uint8Array, origin?: unknown): void {
  Y.applyUpdate(ydoc, update, origin);
}
