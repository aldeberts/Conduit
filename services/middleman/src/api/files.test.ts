import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { WsServerMessage } from "@conduit/shared";
import Fastify from "fastify";
import { WebSocket } from "ws";
import {
  makeInMemorySftp,
  registerTestConnection,
} from "../ssh/registry.js";
import { registerWebSocket } from "../ws/handler.js";
import { configureDocumentStore } from "../documents/registry.js";
import connectionsApi from "./connections.js";

async function buildApp(): Promise<{ app: ReturnType<typeof Fastify>; port: number }> {
  configureDocumentStore("");
  const app = Fastify({ logger: false });
  await app.register(connectionsApi);
  await registerWebSocket(app, {});
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, port };
}

test("POST /files returns 404 when connection is unknown", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/missing/files",
      payload: { path: "foo.ts" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "unknown_connection");
  } finally {
    await app.close();
  }
});

test("POST /files returns 400 when path is missing/blank", async () => {
  const connectionId = "files-validate";
  registerTestConnection(connectionId, "/root");
  const { app } = await buildApp();
  try {
    const res1 = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files`,
      payload: {},
    });
    assert.equal(res1.statusCode, 400);
    const res2 = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files`,
      payload: { path: "   " },
    });
    assert.equal(res2.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /files creates an empty file and broadcasts tree_changed to all sockets", async () => {
  const connectionId = "files-create";
  const files = new Map<string, string>();
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app, port } = await buildApp();
  try {
    // Open two WS clients (different "browsers"). Both should receive the broadcast.
    const tabA = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const tabB = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await Promise.all([once(tabA, "open"), once(tabB, "open")]);

    const treeP = (ws: WebSocket): Promise<WsServerMessage> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting tree_changed")), 4000);
        const onMessage = (raw: WebSocket.RawData): void => {
          const m = JSON.parse(String(raw)) as WsServerMessage;
          if (m.type === "tree_changed") {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(m);
          }
        };
        ws.on("message", onMessage);
      });
    const treeA = treeP(tabA);
    const treeB = treeP(tabB);

    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files`,
      payload: { path: "src/new.ts" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, path: "src/new.ts" });
    assert.equal(files.get("/root/src/new.ts"), "");

    const [msgA, msgB] = await Promise.all([treeA, treeB]);
    if (msgA.type !== "tree_changed" || msgB.type !== "tree_changed") {
      throw new Error("expected tree_changed");
    }
    assert.equal(msgA.connectionId, connectionId);
    assert.equal(msgA.dir, "src");
    assert.equal(msgB.connectionId, connectionId);
    assert.equal(msgB.dir, "src");

    tabA.close();
    tabB.close();
  } finally {
    await app.close();
  }
});

test("POST /files returns 409 when the target already exists", async () => {
  const connectionId = "files-exists";
  const files = new Map<string, string>([["/root/already.txt", "old"]]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files`,
      payload: { path: "already.txt" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "file_exists");
    // File contents must be untouched.
    assert.equal(files.get("/root/already.txt"), "old");
  } finally {
    await app.close();
  }
});

test("POST /files with a root-level path broadcasts dir=''", async () => {
  const connectionId = "files-root";
  const files = new Map<string, string>();
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app, port } = await buildApp();
  try {
    const tab = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await once(tab, "open");
    const treeMsg = new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 4000);
      tab.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as WsServerMessage;
        if (m.type === "tree_changed") {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files`,
      payload: { path: "root-level.md" },
    });
    assert.equal(res.statusCode, 200);
    const msg = await treeMsg;
    if (msg.type !== "tree_changed") throw new Error("wrong type");
    assert.equal(msg.dir, "");
    tab.close();
  } finally {
    await app.close();
  }
});
