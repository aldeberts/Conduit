import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOrCreateUserIdentity, makeUserIdentity } from "./userIdentity.js";

function fakeStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Test-only: peek at what's been written. */
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    store,
  };
}

test("makeUserIdentity returns deterministic value for a deterministic rand", () => {
  const seq = [0.1, 0.2, 0.3];
  let i = 0;
  const rand = (): number => seq[i++ % seq.length]!;
  const a = makeUserIdentity(rand);
  i = 0;
  const b = makeUserIdentity(rand);
  assert.deepEqual(a, b);
  assert.match(a.name, /\w+ \w+/);
  assert.match(a.color, /^#[0-9a-f]{6}$/i);
  assert.match(a.colorLight, /^#[0-9a-f]{8}$/i);
});

test("loadOrCreateUserIdentity persists on first call", () => {
  const storage = fakeStorage();
  const id1 = loadOrCreateUserIdentity(storage, () => 0.42);
  assert.ok(id1.name.length > 0);
  assert.equal(storage.store.size, 1);
  const id2 = loadOrCreateUserIdentity(storage, () => 0.99);
  // 2nd call ignores rand and returns the persisted identity.
  assert.deepEqual(id2, id1);
});

test("loadOrCreateUserIdentity regenerates if stored value is corrupt", () => {
  const storage = fakeStorage({ "conduit.userIdentity.v1": "{not json" });
  const id = loadOrCreateUserIdentity(storage, () => 0.1);
  assert.ok(id.name.length > 0);
  // Should have re-persisted valid JSON.
  const stored = storage.store.get("conduit.userIdentity.v1") ?? "";
  const parsed = JSON.parse(stored) as { name: string };
  assert.equal(parsed.name, id.name);
});

test("loadOrCreateUserIdentity rejects partial stored values", () => {
  const storage = fakeStorage({
    "conduit.userIdentity.v1": JSON.stringify({ name: "Old", color: "#fff" }),
  });
  const id = loadOrCreateUserIdentity(storage, () => 0.1);
  // colorLight was missing → should have regenerated.
  assert.notEqual(id.name, "Old");
});

test("makeUserIdentity tolerates out-of-range rand values", () => {
  // Some seeded rngs return exactly 1, which would otherwise overflow the array.
  const id = makeUserIdentity(() => 1);
  assert.ok(id.name.length > 0);
  assert.ok(id.color.length > 0);
});
