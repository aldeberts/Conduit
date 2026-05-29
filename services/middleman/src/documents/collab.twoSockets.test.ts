import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { registerTestConnection } from "../ssh/registry.js";
import { registerWebSocket } from "../ws/handler.js";
import { configureDocumentStore, registerTestDocument } from "./registry.js";

async function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  await once(ws, "open");
  return ws;
}

function sendJson(ws: WebSocket, msg: WsClientMessage): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(
  ws: WebSocket,
  pred: (msg: WsServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const msg = JSON.parse(String(raw)) as WsServerMessage;
        if (pred(msg)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMessage);
  });
}

test("two browser WebSocket connections: tab A edit reaches tab B", async () => {
  configureDocumentStore("");
  const connectionId = "ws-collab-conn";
  const path = "src/ws.ts";
  registerTestConnection(connectionId);
  registerTestDocument(connectionId, path, "hello");

  const app = Fastify({ logger: false });
  await registerWebSocket(app, {});
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const tabA = await openWs(port);
    const tabB = await openWs(port);

    sendJson(tabA, { type: "subscribe", connectionId, path });
    sendJson(tabB, { type: "subscribe", connectionId, path });

    const subA = await waitFor(tabA, (m) => m.type === "subscribed");
    const subB = await waitFor(tabB, (m) => m.type === "subscribed");
    assert.equal(subA.type, "subscribed");
    assert.equal(subB.type, "subscribed");

    const base = subA.update;
    const editDoc = await import("yjs").then((Y) => {
      const client = new Y.Doc();
      Y.applyUpdate(client, Buffer.from(base, "base64"));
      const vector = Y.encodeStateVector(client);
      client.getText("content").insert(5, "!");
      return Y.encodeStateAsUpdate(client, vector);
    });

    sendJson(tabA, {
      type: "sync",
      connectionId,
      path,
      update: Buffer.from(editDoc).toString("base64"),
    });

    const live = await waitFor(tabB, (m) => m.type === "update");
    assert.equal(live.type, "update");

    const merged = await import("yjs").then((Y) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(subB.update, "base64"));
      if (live.type === "update") {
        Y.applyUpdate(doc, Buffer.from(live.update, "base64"));
      }
      return doc.getText("content").toString();
    });
    assert.equal(merged, "hello!");

    tabA.close();
    tabB.close();
  } finally {
    await app.close();
  }
});

test("tab A receives no spurious messages when tab B joins after tab A edited", async () => {
  configureDocumentStore("");
  const connectionId = "ws-late-join";
  const path = "src/late.ts";
  registerTestConnection(connectionId);
  registerTestDocument(connectionId, path, "base");

  const app = Fastify({ logger: false });
  await registerWebSocket(app, {});
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const tabA = await openWs(port);
    sendJson(tabA, { type: "subscribe", connectionId, path });
    const subA = await waitFor(tabA, (m) => m.type === "subscribed");
    assert.equal(subA.type, "subscribed");

    const editUpdate = await import("yjs").then((Y) => {
      const client = new Y.Doc();
      if (subA.type === "subscribed") {
        Y.applyUpdate(client, Buffer.from(subA.update, "base64"));
      }
      const vector = Y.encodeStateVector(client);
      client.getText("content").insert(4, " plus tab-A edit");
      return Y.encodeStateAsUpdate(client, vector);
    });

    sendJson(tabA, {
      type: "sync",
      connectionId,
      path,
      update: Buffer.from(editUpdate).toString("base64"),
    });

    // Drain anything queued for tab A so we can assert that tab B joining causes nothing new.
    await new Promise((r) => setTimeout(r, 50));
    const aMessages: WsServerMessage[] = [];
    tabA.on("message", (raw) => {
      aMessages.push(JSON.parse(String(raw)) as WsServerMessage);
    });

    const tabB = await openWs(port);
    sendJson(tabB, { type: "subscribe", connectionId, path });
    const subB = await waitFor(tabB, (m) => m.type === "subscribed");

    const tabBContent = await import("yjs").then((Y) => {
      const d = new Y.Doc();
      if (subB.type === "subscribed") {
        Y.applyUpdate(d, Buffer.from(subB.update, "base64"));
      }
      return d.getText("content").toString();
    });
    assert.equal(tabBContent, "base plus tab-A edit", "tab B snapshot must reflect tab A's edit");

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      aMessages.length,
      0,
      `tab A should receive nothing when tab B joins; got: ${JSON.stringify(aMessages)}`,
    );

    tabA.close();
    tabB.close();
  } finally {
    await app.close();
  }
});
