import * as Y from "yjs";

const YTEXT_KEY = "content";

/** Seeds a local Y.Doc text field (used before WS authoritative snapshot). */
export function setYTextContent(ydoc: Y.Doc, content: string): void {
  const ytext = ydoc.getText(YTEXT_KEY);
  ydoc.transact(() => {
    ytext.delete(0, ytext.length);
    if (content.length > 0) {
      ytext.insert(0, content);
    }
  });
}
