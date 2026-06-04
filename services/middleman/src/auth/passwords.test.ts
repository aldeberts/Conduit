import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./passwords.js";

test("hashPassword produces a verifiable hash", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(await verifyPassword("correct horse battery staple", h), true);
  assert.equal(await verifyPassword("wrong guess", h), false);
});

test("hashPassword salts so two calls produce different hashes", async () => {
  const h1 = await hashPassword("same");
  const h2 = await hashPassword("same");
  assert.notEqual(h1, h2);
});

test("verifyPassword tolerates malformed inputs", async () => {
  assert.equal(await verifyPassword("x", "not-a-valid-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$bad$00$00"), false);
});

test("hashPassword rejects empty input", async () => {
  await assert.rejects(() => hashPassword(""));
});
