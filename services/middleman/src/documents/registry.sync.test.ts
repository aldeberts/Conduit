import assert from "node:assert/strict";
import { test } from "node:test";
import type { WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import {
  applyDocumentSync,
  closeDocument,
  configureDocumentStore,
  getOpenDocument,
  patchDocument,
  registerTestDocument,
  subscribeDocument,
} from "./registry.js";
import { createDocumentYDoc } from "./yjs.js";

test("broadcasts incremental Yjs updates to other subscribers", async () => {
  configureDocumentStore("");
  const connectionId = "sync-test-conn";
  const relPath = "src/a.ts";

  registerTestDocument(connectionId, relPath, "hello");

  const receivedA: WsServerMessage[] = [];
  const receivedB: WsServerMessage[] = [];

  await subscribeDocument(connectionId, relPath, {
    id: "client-a",
    send: (m) => receivedA.push(m),
  });
  await subscribeDocument(connectionId, relPath, {
    id: "client-b",
    send: (m) => receivedB.push(m),
  });

  const subA = receivedA.find((m) => m.type === "subscribed");
  assert.equal(subA?.type, "subscribed");

  const client = createDocumentYDoc();
  if (subA?.type === "subscribed") {
    Y.applyUpdate(client, Buffer.from(subA.update, "base64"));
  }
  const baseVector = Y.encodeStateVector(client);
  client.getText("content").insert(5, "!");
  const incremental = Y.encodeStateAsUpdate(client, baseVector);

  receivedA.length = 0;
  receivedB.length = 0;

  await applyDocumentSync(connectionId, relPath, incremental, "client-a");

  const updatesB = receivedB.filter((m) => m.type === "update");
  assert.equal(updatesB.length, 1);
  assert.ok(updatesB[0]?.type === "update" && updatesB[0].revision >= 2);

  const updatesA = receivedA.filter((m) => m.type === "update");
  assert.equal(updatesA.length, 0, "origin client should not receive echo");

  const merged = createDocumentYDoc();
  const snap = updatesB[0];
  assert.equal(snap?.type, "update");
  if (subA?.type === "subscribed") {
    Y.applyUpdate(merged, Buffer.from(subA.update, "base64"));
  }
  if (snap?.type === "update") {
    Y.applyUpdate(merged, Buffer.from(snap.update, "base64"));
  }
  assert.equal(merged.getText("content").toString(), "hello!");

  const open = getOpenDocument(connectionId, relPath);
  assert.equal(open?.content, "hello!");
});

test("late subscriber receives current document on subscribe", async () => {
  configureDocumentStore("");
  const connectionId = "sync-test-conn-2";
  const relPath = "src/b.ts";

  registerTestDocument(connectionId, relPath, "hello");
  patchDocument(connectionId, relPath, "changed");

  const received: WsServerMessage[] = [];
  await subscribeDocument(connectionId, relPath, {
    id: "client-late",
    send: (m) => received.push(m),
  });

  const sub = received.find((m) => m.type === "subscribed");
  assert.ok(sub && sub.type === "subscribed");
  const ydoc = createDocumentYDoc();
  Y.applyUpdate(ydoc, Buffer.from(sub.update, "base64"));
  assert.equal(ydoc.getText("content").toString(), "changed");
});

test("closeDocument keeps Yjs doc while websocket subscribers remain", async () => {
  configureDocumentStore("");
  const connectionId = "sync-test-conn-3";
  const relPath = "src/c.ts";

  registerTestDocument(connectionId, relPath, "keep-me");
  await subscribeDocument(connectionId, relPath, {
    id: "ws-only",
    send: () => {},
  });

  closeDocument(connectionId, relPath);

  const open = getOpenDocument(connectionId, relPath);
  assert.equal(open?.content, "keep-me");
});
