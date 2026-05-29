import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { WsServerMessage } from "@conduit/shared";
import * as Y from "yjs";
import {
  applyDocumentSync,
  configureDocumentStore,
  getOpenDocument,
  openDocument,
  patchDocument,
  registerTestDocument,
  subscribeDocument,
} from "./registry.js";
import { createDocumentYDoc, encodeDocUpdate } from "./yjs.js";

type SimClient = {
  id: string;
  inbox: WsServerMessage[];
};

function makeClient(): SimClient {
  return { id: randomUUID(), inbox: [] };
}

async function wsSubscribe(client: SimClient, connectionId: string, path: string): Promise<void> {
  await subscribeDocument(connectionId, path, {
    id: client.id,
    send: (msg) => client.inbox.push(msg),
  });
}

async function wsSyncFromYtext(
  client: SimClient,
  connectionId: string,
  path: string,
  ydoc: Y.Doc,
  afterSnapshotB64: string,
): Promise<void> {
  const local = createDocumentYDoc();
  Y.applyUpdate(local, Buffer.from(afterSnapshotB64, "base64"));
  const baseVector = Y.encodeStateVector(local);
  Y.applyUpdate(local, encodeDocUpdate(ydoc));
  const incremental = Y.encodeStateAsUpdate(local, baseVector);
  await applyDocumentSync(connectionId, path, incremental, client.id);
}

function snapshotB64(msg: WsServerMessage): string {
  assert.equal(msg.type, "subscribed");
  return msg.update;
}

function latestSubscribed(client: SimClient): WsServerMessage {
  const sub = client.inbox.filter((m) => m.type === "subscribed").at(-1);
  assert.ok(sub && sub.type === "subscribed");
  return sub;
}

test("two websocket clients: A edits, B receives live update", async () => {
  configureDocumentStore("");
  const connectionId = "collab-live";
  const path = "src/live.ts";
  registerTestDocument(connectionId, path, "hello");

  const tabA = makeClient();
  const tabB = makeClient();
  await wsSubscribe(tabA, connectionId, path);
  await wsSubscribe(tabB, connectionId, path);
  const snap = snapshotB64(latestSubscribed(tabA));
  tabA.inbox.length = 0;
  tabB.inbox.length = 0;
  const editDoc = createDocumentYDoc();
  Y.applyUpdate(editDoc, Buffer.from(snap, "base64"));
  editDoc.getText("content").insert(5, "!");
  await wsSyncFromYtext(tabA, connectionId, path, editDoc, snap);

  const updates = tabB.inbox.filter((m) => m.type === "update");
  assert.equal(updates.length, 1, "tab B should receive one incremental update");

  const merged = createDocumentYDoc();
  Y.applyUpdate(merged, Buffer.from(snap, "base64"));
  const u = updates[0];
  assert.equal(u?.type, "update");
  if (u?.type === "update") {
    Y.applyUpdate(merged, Buffer.from(u.update, "base64"));
  }
  assert.equal(merged.getText("content").toString(), "hello!");
  assert.equal(getOpenDocument(connectionId, path)?.content, "hello!");
});

test("tab B opens later: subscribe snapshot reflects tab A edits", async () => {
  configureDocumentStore("");
  const connectionId = "collab-late";
  const path = "src/late.ts";
  registerTestDocument(connectionId, path, "start");

  const tabA = makeClient();
  await wsSubscribe(tabA, connectionId, path);
  patchDocument(connectionId, path, "edited by A before B opens");

  const tabB = makeClient();
  await wsSubscribe(tabB, connectionId, path);
  const subB = latestSubscribed(tabB);
  const ydoc = createDocumentYDoc();
  Y.applyUpdate(ydoc, Buffer.from(snapshotB64(subB), "base64"));
  assert.equal(ydoc.getText("content").toString(), "edited by A before B opens");
});

test("HTTP open after edits returns live Yjs buffer for late tab", async () => {
  configureDocumentStore("");
  const connectionId = "collab-http";
  const path = "src/http.ts";
  registerTestDocument(connectionId, path, "v1");
  patchDocument(connectionId, path, "v2-after-edit");

  const doc = await openDocument(connectionId, path);
  assert.equal(doc.content, "v2-after-edit");
});
