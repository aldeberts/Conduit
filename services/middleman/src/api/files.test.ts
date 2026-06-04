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

test("DELETE /files removes the file, broadcasts tree_changed, and evicts subscribers", async () => {
  const connectionId = "files-delete";
  const path = "src/doomed.ts";
  const files = new Map<string, string>([["/root/src/doomed.ts", "rip"]]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app, port } = await buildApp();
  try {
    const tab = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await once(tab, "open");

    // Subscribe so we own a server-side doc that we can verify gets evicted.
    tab.send(JSON.stringify({ type: "subscribe", connectionId, path }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscribe timeout")), 4000);
      const onMessage = (raw: WebSocket.RawData): void => {
        const m = JSON.parse(String(raw)) as WsServerMessage;
        if (m.type === "subscribed") {
          clearTimeout(timer);
          tab.off("message", onMessage);
          resolve();
        }
      };
      tab.on("message", onMessage);
    });

    const collected: WsServerMessage[] = [];
    tab.on("message", (raw) => collected.push(JSON.parse(String(raw)) as WsServerMessage));

    const res = await app.inject({
      method: "DELETE",
      url: `/api/connections/${connectionId}/files`,
      payload: { path },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(files.has("/root/src/doomed.ts"), false, "remote file should be gone");

    // Wait briefly for the two broadcasts.
    await new Promise((r) => setTimeout(r, 80));
    const evicted = collected.find((m) => m.type === "doc_evicted");
    const treeChanged = collected.find((m) => m.type === "tree_changed");
    assert.ok(evicted, "subscribers should receive doc_evicted");
    assert.ok(treeChanged, "tree_changed should be broadcast");
    if (evicted?.type === "doc_evicted") {
      assert.equal(evicted.reason, "deleted");
    }
    if (treeChanged?.type === "tree_changed") {
      assert.equal(treeChanged.dir, "src");
    }

    tab.close();
  } finally {
    await app.close();
  }
});

test("DELETE /files returns 404 when file does not exist", async () => {
  const connectionId = "files-delete-missing";
  const files = new Map<string, string>();
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/connections/${connectionId}/files`,
      payload: { path: "ghost.txt" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "file_not_found");
  } finally {
    await app.close();
  }
});

test("POST /files/rename moves the file and broadcasts tree_changed for both dirs", async () => {
  const connectionId = "files-rename";
  const files = new Map<string, string>([["/root/src/old.ts", "hello"]]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app, port } = await buildApp();
  try {
    const tab = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await once(tab, "open");
    const treeMessages: WsServerMessage[] = [];
    tab.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as WsServerMessage;
      if (m.type === "tree_changed") {
        treeMessages.push(m);
      }
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files/rename`,
      payload: { from: "src/old.ts", to: "lib/new.ts" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(files.has("/root/src/old.ts"), false);
    assert.equal(files.get("/root/lib/new.ts"), "hello");

    await new Promise((r) => setTimeout(r, 80));
    // Two broadcasts: from-dir (src) and to-dir (lib).
    const dirs = treeMessages
      .filter((m): m is Extract<WsServerMessage, { type: "tree_changed" }> => m.type === "tree_changed")
      .map((m) => m.dir)
      .sort();
    assert.deepEqual(dirs, ["lib", "src"]);
    tab.close();
  } finally {
    await app.close();
  }
});

test("POST /files/rename returns 409 when target already exists", async () => {
  const connectionId = "files-rename-conflict";
  const files = new Map<string, string>([
    ["/root/a.txt", "A"],
    ["/root/b.txt", "B"],
  ]);
  registerTestConnection(connectionId, "/root", makeInMemorySftp(files));
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files/rename`,
      payload: { from: "a.txt", to: "b.txt" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "target_exists");
    // Both files untouched.
    assert.equal(files.get("/root/a.txt"), "A");
    assert.equal(files.get("/root/b.txt"), "B");
  } finally {
    await app.close();
  }
});

test("POST /files/rename returns 400 when from===to or either is blank", async () => {
  const connectionId = "files-rename-validate";
  registerTestConnection(connectionId, "/root", makeInMemorySftp(new Map([["/root/x.txt", "x"]])));
  const { app } = await buildApp();
  try {
    const r1 = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files/rename`,
      payload: { from: "x.txt", to: "x.txt" },
    });
    assert.equal(r1.statusCode, 400);
    const r2 = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files/rename`,
      payload: { from: "", to: "y.txt" },
    });
    assert.equal(r2.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /files/rename returns 404 when source does not exist", async () => {
  const connectionId = "files-rename-missing";
  registerTestConnection(connectionId, "/root", makeInMemorySftp(new Map()));
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/files/rename`,
      payload: { from: "ghost.txt", to: "renamed.txt" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "file_not_found");
  } finally {
    await app.close();
  }
});
