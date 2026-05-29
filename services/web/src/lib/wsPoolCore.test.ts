import assert from "node:assert/strict";
import { test } from "node:test";
import type { WsServerMessage } from "@conduit/shared";
import {
  dispatchMessage,
  queueSubscribe,
  socketBusy,
  WS_CONNECTING,
  WS_OPEN,
  type DispatchTargets,
} from "./wsPoolCore.js";

function makePool(ws: { readyState: number } | null, connecting = false): {
  connectionId: string;
  ws: { readyState: number } | null;
  paths: Map<string, Set<unknown>>;
  connecting: boolean;
  shuttingDown: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pendingSubscribes: { type: "subscribe"; connectionId: string; path: string }[];
} {
  return {
    connectionId: "c1",
    ws,
    paths: new Map([["a.ts", new Set([() => {}])]]),
    connecting,
    shuttingDown: false,
    reconnectTimer: null,
    pendingSubscribes: [],
  };
}

test("dead websocket (CLOSED) is not treated as busy", () => {
  const pool = makePool({ readyState: 3 });
  assert.equal(socketBusy(pool), false);
});

test("OPEN websocket is busy", () => {
  const pool = makePool({ readyState: WS_OPEN });
  assert.equal(socketBusy(pool), true);
});

test("CONNECTING websocket is busy", () => {
  const pool = makePool({ readyState: WS_CONNECTING });
  assert.equal(socketBusy(pool), true);
});

test("queueSubscribe dedupes paths", () => {
  const pool = makePool(null);
  queueSubscribe(pool, "src/a.ts");
  queueSubscribe(pool, "src/a.ts");
  assert.equal(pool.pendingSubscribes.length, 1);
});

function makeTargets(): {
  targets: DispatchTargets;
  pathCalls: WsServerMessage[];
  ptyCalls: WsServerMessage[];
  treeCalls: Extract<WsServerMessage, { type: "tree_changed" }>[];
} {
  const pathCalls: WsServerMessage[] = [];
  const ptyCalls: WsServerMessage[] = [];
  const treeCalls: Extract<WsServerMessage, { type: "tree_changed" }>[] = [];
  const targets: DispatchTargets = {
    paths: new Map([["a.ts", new Set([(m: WsServerMessage) => pathCalls.push(m)])]]),
    ptyHandlers: new Set([(m: WsServerMessage) => ptyCalls.push(m)]),
    treeHandlers: new Set([(m) => treeCalls.push(m)]),
  };
  return { targets, pathCalls, ptyCalls, treeCalls };
}

test("dispatchMessage routes tree_changed to tree handlers only", () => {
  const { targets, pathCalls, ptyCalls, treeCalls } = makeTargets();
  dispatchMessage(targets, { type: "tree_changed", connectionId: "c1", dir: "src" });
  assert.equal(treeCalls.length, 1);
  assert.equal(treeCalls[0]?.dir, "src");
  assert.equal(pathCalls.length, 0);
  assert.equal(ptyCalls.length, 0);
});

test("dispatchMessage routes path-scoped messages to matching path handler", () => {
  const { targets, pathCalls, ptyCalls, treeCalls } = makeTargets();
  dispatchMessage(targets, {
    type: "update",
    connectionId: "c1",
    path: "a.ts",
    update: "AA==",
    revision: 1,
    dirty: false,
  });
  assert.equal(pathCalls.length, 1);
  assert.equal(ptyCalls.length, 0);
  assert.equal(treeCalls.length, 0);
});

test("dispatchMessage drops path messages with no registered handler", () => {
  const { targets, pathCalls } = makeTargets();
  dispatchMessage(targets, {
    type: "update",
    connectionId: "c1",
    path: "missing.ts",
    update: "AA==",
    revision: 1,
    dirty: false,
  });
  assert.equal(pathCalls.length, 0);
});

test("dispatchMessage fans error to every path + pty handler", () => {
  const { targets, pathCalls, ptyCalls, treeCalls } = makeTargets();
  dispatchMessage(targets, { type: "error", message: "boom" });
  assert.equal(pathCalls.length, 1);
  assert.equal(ptyCalls.length, 1);
  assert.equal(treeCalls.length, 0);
});
