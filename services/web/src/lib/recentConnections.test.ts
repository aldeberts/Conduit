import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forgetConnection,
  listRecentConnections,
  rememberConnection,
} from "./recentConnections.js";

function fakeStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

test("list returns [] when storage is empty", () => {
  const storage = fakeStorage();
  assert.deepEqual(listRecentConnections(storage), []);
});

test("remember persists and is returned by list", () => {
  const storage = fakeStorage();
  rememberConnection(
    {
      label: "Staging",
      host: "staging.example.com",
      port: 22,
      username: "alice",
      remotePath: "/home/alice/proj",
    },
    storage,
    () => 1000,
  );
  const list = listRecentConnections(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.label, "Staging");
  assert.equal(list[0]?.lastUsedAt, 1000);
});

test("remember dedupes by user@host:port+remotePath (label updates, timestamp bumps)", () => {
  const storage = fakeStorage();
  rememberConnection(
    {
      label: "Old Name",
      host: "h",
      port: 22,
      username: "u",
      remotePath: "/p",
    },
    storage,
    () => 1,
  );
  rememberConnection(
    {
      label: "New Name",
      host: "h",
      port: 22,
      username: "u",
      remotePath: "/p",
    },
    storage,
    () => 2,
  );
  const list = listRecentConnections(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.label, "New Name");
  assert.equal(list[0]?.lastUsedAt, 2);
});

test("remember keeps distinct entries separate (different remotePath)", () => {
  const storage = fakeStorage();
  rememberConnection(
    { label: "A", host: "h", port: 22, username: "u", remotePath: "/p1" },
    storage,
    () => 1,
  );
  rememberConnection(
    { label: "B", host: "h", port: 22, username: "u", remotePath: "/p2" },
    storage,
    () => 2,
  );
  const list = listRecentConnections(storage);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.label, "B", "newest first");
  assert.equal(list[1]?.label, "A");
});

test("remember caps at 8 entries (newest kept)", () => {
  const storage = fakeStorage();
  for (let i = 0; i < 12; i++) {
    rememberConnection(
      {
        label: `c${i}`,
        host: `h${i}`,
        port: 22,
        username: "u",
        remotePath: "/p",
      },
      storage,
      () => i + 1,
    );
  }
  const list = listRecentConnections(storage);
  assert.equal(list.length, 8);
  // Newest 8: c11..c4
  assert.equal(list[0]?.label, "c11");
  assert.equal(list[7]?.label, "c4");
});

test("forget removes a matching entry without touching siblings", () => {
  const storage = fakeStorage();
  rememberConnection(
    { label: "A", host: "h", port: 22, username: "u", remotePath: "/p1" },
    storage,
    () => 1,
  );
  rememberConnection(
    { label: "B", host: "h", port: 22, username: "u", remotePath: "/p2" },
    storage,
    () => 2,
  );
  const after = forgetConnection(
    { host: "h", port: 22, username: "u", remotePath: "/p1" },
    storage,
  );
  assert.equal(after.length, 1);
  assert.equal(after[0]?.label, "B");
  assert.deepEqual(listRecentConnections(storage), after);
});

test("list survives corrupt JSON in storage", () => {
  const storage = fakeStorage();
  storage.setItem("conduit.recentConnections.v1", "{not json");
  assert.deepEqual(listRecentConnections(storage), []);
});

test("list filters out malformed entries", () => {
  const storage = fakeStorage();
  storage.setItem(
    "conduit.recentConnections.v1",
    JSON.stringify([
      { label: "good", host: "h", port: 22, username: "u", remotePath: "/p", lastUsedAt: 1 },
      { label: "missing-port", host: "h", username: "u", remotePath: "/p", lastUsedAt: 2 },
      "not-an-object",
    ]),
  );
  const list = listRecentConnections(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.label, "good");
});
