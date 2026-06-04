import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearApiToken,
  getApiToken,
  hasAnyToken,
  setApiToken,
} from "./authToken.js";

function fakeStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    store,
  };
}

test("getApiToken returns undefined when nothing stored", () => {
  const storage = fakeStorage();
  assert.equal(getApiToken(storage), undefined);
});

test("setApiToken persists trimmed value; getApiToken returns it", () => {
  const storage = fakeStorage();
  setApiToken("  abc123  ", storage);
  assert.equal(storage.store.get("conduit.apiToken.v1"), "abc123");
  assert.equal(getApiToken(storage), "abc123");
});

test("clearApiToken removes the cached token", () => {
  const storage = fakeStorage({ "conduit.apiToken.v1": "abc" });
  clearApiToken(storage);
  assert.equal(storage.store.size, 0);
  assert.equal(getApiToken(storage), undefined);
});

test("hasAnyToken reflects storage state", () => {
  const storage = fakeStorage();
  assert.equal(hasAnyToken(storage), false);
  setApiToken("zzz", storage);
  assert.equal(hasAnyToken(storage), true);
  clearApiToken(storage);
  assert.equal(hasAnyToken(storage), false);
});

test("getApiToken ignores blank stored values", () => {
  const storage = fakeStorage({ "conduit.apiToken.v1": "   " });
  assert.equal(getApiToken(storage), undefined);
});
