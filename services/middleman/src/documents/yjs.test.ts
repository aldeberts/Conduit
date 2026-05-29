import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  applyDocUpdate,
  createDocumentYDoc,
  encodeDocUpdate,
  readYTextContent,
  setYTextContent,
} from "./yjs.js";

test("setYTextContent and readYTextContent", () => {
  const ydoc = createDocumentYDoc();
  setYTextContent(ydoc, "hello world");
  assert.equal(readYTextContent(ydoc), "hello world");
});

test("Yjs updates merge across two docs", () => {
  const a = createDocumentYDoc();
  const b = createDocumentYDoc();
  setYTextContent(a, "abc");
  applyDocUpdate(b, encodeDocUpdate(a), "remote");
  assert.equal(readYTextContent(b), "abc");

  a.getText("content").insert(3, "!");
  applyDocUpdate(b, Y.encodeStateAsUpdate(a), "remote");
  assert.equal(readYTextContent(b), "abc!");
});
