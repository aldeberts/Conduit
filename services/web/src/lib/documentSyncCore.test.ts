import assert from "node:assert/strict";
import { test } from "node:test";
import type { WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import {
  DocumentSyncCore,
  incrementalInsertAfterSnapshot,
  uint8ToBase64,
} from "./documentSyncCore.js";

const CONN = "conn-1";
const PATH = "src/a.ts";

function subscribedMsg(content: string, revision = 1): WsServerMessage {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return {
    type: "subscribed",
    connectionId: CONN,
    path: PATH,
    update: uint8ToBase64(Y.encodeStateAsUpdate(doc)),
    revision,
    dirty: false,
  };
}

function updateMsg(
  snapshotB64: string,
  index: number,
  insert: string,
  revision: number,
): WsServerMessage {
  return {
    type: "update",
    connectionId: CONN,
    path: PATH,
    update: incrementalInsertAfterSnapshot(snapshotB64, index, insert),
    revision,
    dirty: true,
  };
}

test("tab B receives tab A edit after both subscribed", () => {
  const outboundA: string[] = [];
  const tabA = new DocumentSyncCore(PATH, {}, (u) => outboundA.push(u));
  const tabB = new DocumentSyncCore(PATH, {}, () => {});

  const sub = subscribedMsg("hello");
  tabA.handleServerMessage(sub);
  tabB.handleServerMessage(sub);
  tabA.enableSync();
  tabB.enableSync();

  tabA.simulateLocalInsert(5, "!");
  assert.equal(outboundA.length, 1);

  const snapB64 = sub.type === "subscribed" ? sub.update : "";
  tabB.handleServerMessage(
    updateMsg(snapB64, 5, "!", 2),
  );

  assert.equal(tabA.ytext.toString(), "hello!");
  assert.equal(tabB.ytext.toString(), "hello!");
});

test("tab B buffers updates that arrive before subscribed snapshot", () => {
  const tabB = new DocumentSyncCore(PATH, {}, () => {});
  const sub = subscribedMsg("hello");
  const snapB64 = sub.type === "subscribed" ? sub.update : "";

  tabB.handleServerMessage(updateMsg(snapB64, 5, "!", 2));
  assert.equal(tabB.ytext.toString(), "", "must not apply incremental update before snapshot");

  tabB.handleServerMessage(sub);
  assert.equal(tabB.ytext.toString(), "hello!", "buffered update applies after snapshot");
});

test("tab B late subscribe snapshot includes tab A edits (open file later)", () => {
  const tabB = new DocumentSyncCore(PATH, {}, () => {});
  tabB.handleServerMessage(subscribedMsg("hello world", 3));
  assert.equal(tabB.ytext.toString(), "hello world");
});

test("outbound sync blocked until enableSync even when subscribed", () => {
  const outbound: string[] = [];
  const tab = new DocumentSyncCore(PATH, {}, (u) => outbound.push(u));
  tab.handleServerMessage(subscribedMsg("hi"));
  tab.simulateLocalInsert(2, "!");
  assert.equal(outbound.length, 0);

  tab.enableSync();
  tab.simulateLocalInsert(3, "?");
  assert.equal(outbound.length, 1);
  assert.equal(tab.ytext.toString(), "hi!?");
});

test("inbound updates apply while sync disabled (background tab)", () => {
  const tab = new DocumentSyncCore(PATH, {}, () => {});
  const sub = subscribedMsg("base");
  tab.handleServerMessage(sub);
  assert.equal(tab.ytext.toString(), "base");

  const snapB64 = sub.type === "subscribed" ? sub.update : "";
  tab.handleServerMessage(updateMsg(snapB64, 4, "!", 2));
  assert.equal(tab.ytext.toString(), "base!");
});

test("subscribed snapshot on empty ydoc matches server (production path)", () => {
  const tab = new DocumentSyncCore(PATH, {}, () => {});
  tab.handleServerMessage(subscribedMsg("server truth", 1));
  assert.equal(tab.ytext.toString(), "server truth");
});

test("re-subscribed snapshot does not wipe local content when applied via CRDT merge", () => {
  const tab = new DocumentSyncCore(PATH, {}, () => {});
  const original = subscribedMsg("base");
  tab.handleServerMessage(original);
  tab.enableSync();
  tab.simulateLocalInsert(4, "+local");
  assert.equal(tab.ytext.toString(), "base+local");

  // Server re-sends an authoritative snapshot (e.g., after re-subscribe).
  // Local in-flight content must survive.
  tab.handleServerMessage(original);
  assert.equal(tab.ytext.toString(), "base+local");
});

test("empty subscribed update is a no-op (does not wipe content)", () => {
  const tab = new DocumentSyncCore(PATH, {}, () => {});
  tab.handleServerMessage(subscribedMsg("important content"));
  tab.handleServerMessage({
    type: "subscribed",
    connectionId: CONN,
    path: PATH,
    update: "",
    revision: 1,
    dirty: false,
  });
  assert.equal(tab.ytext.toString(), "important content");
});
