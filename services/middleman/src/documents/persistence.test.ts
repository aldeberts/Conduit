import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as Y from "yjs";
import { encodeDocUpdate, createDocumentYDoc, setYTextContent } from "./yjs.js";
import { loadPersistedDocument, persistDocument } from "./persistence.js";

test("persist and load roundtrip", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "conduit-test-"));
  const connectionId = "conn-1";
  const relPath = "src/foo.ts";
  const ydoc = createDocumentYDoc();
  setYTextContent(ydoc, "persisted body");
  const update = encodeDocUpdate(ydoc);

  await persistDocument(dataDir, connectionId, relPath, update, {
    connectionId,
    path: relPath,
    remote: { mtimeMs: 1000, size: 14 },
    lastSavedAt: null,
    revision: 2,
  });

  const loaded = await loadPersistedDocument(dataDir, connectionId, relPath);
  assert.ok(loaded);
  assert.equal(loaded.meta.revision, 2);
  const ydoc2 = createDocumentYDoc();
  Y.applyUpdate(ydoc2, loaded.update);
  assert.equal(ydoc2.getText("content").toString(), "persisted body");
});
