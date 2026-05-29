import assert from "node:assert/strict";
import { test } from "node:test";
import { CollabHub } from "./collabHub.js";

const CONN = "shared-connection";
const PATH = "src/app.ts";

/**
 * Each tab is a separate DocumentSyncCore + WebSocket (modelled by CollabHub).
 */
test("browser tab A edit appears in browser tab B when both have the file open", () => {
  const hub = new CollabHub();
  hub.openDocument(CONN, PATH, "hello");

  const tabA = hub.connectTab("browser-a", CONN, PATH, "hello");
  const tabB = hub.connectTab("browser-b", CONN, PATH, "hello");

  tabA.simulateLocalInsert(5, "!");
  assert.equal(tabB.ytext.toString(), "hello!");
});

test("browser tab B joins later and receives tab A edits on subscribe", () => {
  const hub = new CollabHub();
  hub.openDocument(CONN, PATH, "v1");

  const tabA = hub.connectTab("browser-a", CONN, PATH, "v1");
  tabA.simulateLocalInsert(2, " (edited)");

  const tabB = hub.connectTab("browser-b", CONN, PATH, "v1");
  assert.equal(tabB.ytext.toString(), "v1 (edited)");
});

test("browser tab B never opened the file does not get a live session until connectTab", () => {
  const hub = new CollabHub();
  hub.openDocument(CONN, PATH, "only-a");

  const tabA = hub.connectTab("browser-a", CONN, PATH, "only-a");
  tabA.simulateLocalInsert(6, "!");

  const content = hub.openDocument(CONN, PATH, "ignored");
  assert.equal(content, "only-a!");
});

test("tab A keeps its content when tab B joins after tab A edits", () => {
  const hub = new CollabHub();
  hub.openDocument(CONN, PATH, "starter");

  const tabA = hub.connectTab("browser-a", CONN, PATH, "starter");
  tabA.simulateLocalInsert(7, " edited");
  assert.equal(tabA.ytext.toString(), "starter edited");

  const tabB = hub.connectTab("browser-b", CONN, PATH, "starter");

  assert.equal(tabB.ytext.toString(), "starter edited", "tab B should see tab A's edits");
  assert.equal(tabA.ytext.toString(), "starter edited", "tab A must not go blank when tab B joins");
});
