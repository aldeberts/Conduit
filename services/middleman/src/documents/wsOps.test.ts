import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { WsClientMessage, WsServerMessage } from "@conduit/shared";
import Fastify from "fastify";
import { WebSocket } from "ws";
import {
  makeInMemorySftp,
  registerTestConnection,
} from "../ssh/registry.js";
import { registerWebSocket } from "../ws/handler.js";
import {
  configureDocumentStore,
  evictDocument,
  registerTestDocument,
} from "./registry.js";

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
  timeoutMs = 4000,
): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const msg = JSON.parse(String(raw)) as WsServerMessage;
        if (pred(msg)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.on("message", onMessage);
  });
}

async function startApp(): Promise<{ app: ReturnType<typeof Fastify>; port: number }> {
  const app = Fastify({ logger: false });
  await registerWebSocket(app, {});
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, port };
}

test("WS save: success replies with op_result ok=true and persists to SFTP", async () => {
  configureDocumentStore("");
  const connectionId = "ws-save-ok";
  const path = "src/save.ts";
  const files = new Map<string, string>([["/root/src/save.ts", "old"]]);
  const sftp = makeInMemorySftp(files);
  registerTestConnection(connectionId, "/root", sftp);
  // Don't pre-register the document — let the subscribe path hydrate via SFTP
  // so doc.remote matches what stat returns.

  const { app, port } = await startApp();
  try {
    const ws = await openWs(port);
    sendJson(ws, { type: "subscribe", connectionId, path });
    const sub = await waitFor(ws, (m) => m.type === "subscribed");
    if (sub.type !== "subscribed") throw new Error("wrong type");

    const Y = await import("yjs");
    const local = new Y.Doc();
    Y.applyUpdate(local, Buffer.from(sub.update, "base64"));
    const baseVec = Y.encodeStateVector(local);
    local.getText("content").insert(0, "NEW ");
    // The server processes messages on a single socket in microtask order, so
    // sync's synchronous Y.Doc update runs before save's async stat resolves.
    sendJson(ws, {
      type: "sync",
      connectionId,
      path,
      update: Buffer.from(Y.encodeStateAsUpdate(local, baseVec)).toString("base64"),
    });
    sendJson(ws, { type: "save", connectionId, path });

    const result = await waitFor(ws, (m) => m.type === "op_result");
    if (result.type !== "op_result") throw new Error("wrong type");
    assert.equal(result.op, "save");
    assert.equal(result.ok, true, `expected ok=true, got error=${result.error ?? ""}`);
    assert.equal(files.get("/root/src/save.ts"), "NEW old", "SFTP should reflect the save");
    ws.close();
  } finally {
    await app.close();
  }
});

test("WS save: failure on unknown connection sends top-level error", async () => {
  const { app, port } = await startApp();
  try {
    const ws = await openWs(port);
    sendJson(ws, { type: "save", connectionId: "missing", path: "foo.ts" });
    const err = await waitFor(ws, (m) => m.type === "error");
    if (err.type !== "error") throw new Error("wrong type");
    assert.equal(err.message, "unknown_connection");
    ws.close();
  } finally {
    await app.close();
  }
});

test("WS refresh: dirty doc without force returns op_result ok=false", async () => {
  configureDocumentStore("");
  const connectionId = "ws-refresh-dirty";
  const path = "src/dirty.ts";
  const files = new Map<string, string>([["/root/src/dirty.ts", "original"]]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));

  const { app, port } = await startApp();
  try {
    const ws = await openWs(port);
    sendJson(ws, { type: "subscribe", connectionId, path });
    const sub = await waitFor(ws, (m) => m.type === "subscribed");
    if (sub.type !== "subscribed") throw new Error("wrong type");

    const Y = await import("yjs");
    const local = new Y.Doc();
    Y.applyUpdate(local, Buffer.from(sub.update, "base64"));
    const baseVec = Y.encodeStateVector(local);
    local.getText("content").insert(0, "X");
    sendJson(ws, {
      type: "sync",
      connectionId,
      path,
      update: Buffer.from(Y.encodeStateAsUpdate(local, baseVec)).toString("base64"),
    });
    sendJson(ws, { type: "refresh", connectionId, path, force: false });

    const result = await waitFor(ws, (m) => m.type === "op_result");
    if (result.type !== "op_result") throw new Error("wrong type");
    assert.equal(result.op, "refresh");
    assert.equal(result.ok, false);
    assert.equal(result.error, "dirty_document");
    ws.close();
  } finally {
    await app.close();
  }
});

test("WS refresh: force=true discards dirty edits and reloads from disk", async () => {
  configureDocumentStore("");
  const connectionId = "ws-refresh-force";
  const path = "src/force.ts";
  const files = new Map<string, string>([["/root/src/force.ts", "disk truth"]]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));

  const { app, port } = await startApp();
  try {
    const ws = await openWs(port);
    sendJson(ws, { type: "subscribe", connectionId, path });
    const sub = await waitFor(ws, (m) => m.type === "subscribed");
    if (sub.type !== "subscribed") throw new Error("wrong type");

    const Y = await import("yjs");
    const local = new Y.Doc();
    Y.applyUpdate(local, Buffer.from(sub.update, "base64"));
    const baseVec = Y.encodeStateVector(local);
    local.getText("content").insert(0, "DIRTY ");
    sendJson(ws, {
      type: "sync",
      connectionId,
      path,
      update: Buffer.from(Y.encodeStateAsUpdate(local, baseVec)).toString("base64"),
    });
    sendJson(ws, { type: "refresh", connectionId, path, force: true });

    const result = await waitFor(ws, (m) => m.type === "op_result");
    if (result.type !== "op_result") throw new Error("wrong type");
    assert.equal(result.ok, true);
    ws.close();
  } finally {
    await app.close();
  }
});

test("WS awareness: tab A presence is relayed to tab B", async () => {
  configureDocumentStore("");
  const connectionId = "ws-awareness";
  const path = "src/aw.ts";
  registerTestConnection(connectionId);
  registerTestDocument(connectionId, path, "data");

  const { app, port } = await startApp();
  try {
    const tabA = await openWs(port);
    sendJson(tabA, { type: "subscribe", connectionId, path });
    await waitFor(tabA, (m) => m.type === "subscribed");

    const tabB = await openWs(port);
    sendJson(tabB, { type: "subscribe", connectionId, path });
    await waitFor(tabB, (m) => m.type === "subscribed");

    // Tab A sends an awareness payload. Tab B should receive it (server relay).
    const awarenessPayload = "AAEC";
    const relayP = waitFor(tabB, (m) => m.type === "awareness");
    sendJson(tabA, { type: "awareness", connectionId, path, update: awarenessPayload });
    const relayed = await relayP;
    if (relayed.type !== "awareness") throw new Error("wrong type");
    assert.equal(relayed.update, awarenessPayload);

    tabA.close();
    tabB.close();
  } finally {
    await app.close();
  }
});

test("WS awareness: late joiner receives cached awareness on subscribe", async () => {
  configureDocumentStore("");
  const connectionId = "ws-awareness-late";
  const path = "src/late.ts";
  registerTestConnection(connectionId);
  registerTestDocument(connectionId, path, "data");

  const { app, port } = await startApp();
  try {
    const tabA = await openWs(port);
    sendJson(tabA, { type: "subscribe", connectionId, path });
    await waitFor(tabA, (m) => m.type === "subscribed");
    const tabB = await openWs(port);
    sendJson(tabB, { type: "subscribe", connectionId, path });
    await waitFor(tabB, (m) => m.type === "subscribed");

    // Tab A sends awareness, then Tab C joins after — it should get the cached
    // payload as part of the server's subscribe replay.
    sendJson(tabA, { type: "awareness", connectionId, path, update: "AAAB" });
    // Wait for relay so cache is definitely populated.
    await waitFor(tabB, (m) => m.type === "awareness");

    const tabC = await openWs(port);
    const cachedP = waitFor(tabC, (m) => m.type === "awareness");
    sendJson(tabC, { type: "subscribe", connectionId, path });
    await waitFor(tabC, (m) => m.type === "subscribed");
    const cached = await cachedP;
    if (cached.type !== "awareness") throw new Error("wrong type");
    assert.equal(cached.update, "AAAB");

    tabA.close();
    tabB.close();
    tabC.close();
  } finally {
    await app.close();
  }
});

test("doc_evicted is sent to subscribers when evictDocument runs", async () => {
  configureDocumentStore("");
  const connectionId = "ws-evict";
  const path = "src/evict.ts";
  registerTestConnection(connectionId);
  registerTestDocument(connectionId, path, "data");

  const { app, port } = await startApp();
  try {
    const ws = await openWs(port);
    sendJson(ws, { type: "subscribe", connectionId, path });
    await waitFor(ws, (m) => m.type === "subscribed");

    const evictedP = waitFor(ws, (m) => m.type === "doc_evicted");
    evictDocument(connectionId, path, "deleted");
    const got = await evictedP;
    if (got.type !== "doc_evicted") throw new Error("wrong type");
    assert.equal(got.reason, "deleted");

    ws.close();
  } finally {
    await app.close();
  }
});
