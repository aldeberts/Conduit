import assert from "node:assert/strict";
import { test } from "node:test";
import { sealSecret, secretsConfigured, unsealSecret } from "./secrets.js";

const KEY = "test-key-for-conduit-1234567890";

test("seal + unseal roundtrip", () => {
  const blob = sealSecret("hunter2", KEY);
  assert.equal(unsealSecret(blob, KEY), "hunter2");
});

test("seal produces different ciphertexts each time (random iv)", () => {
  const a = sealSecret("same", KEY);
  const b = sealSecret("same", KEY);
  assert.notEqual(Buffer.from(a).toString("hex"), Buffer.from(b).toString("hex"));
});

test("unseal rejects tampered ciphertext", () => {
  // Use a long enough plaintext that we can reliably flip a ciphertext byte.
  const blob = sealSecret("this is a longer secret payload", KEY);
  // Layout: 1 byte version | 12 byte iv | 16 byte tag | N byte ct.
  // Flip a byte well inside the ciphertext (offset 30 = 1+12+16+1).
  const tampered = Buffer.from(blob);
  tampered[30] = tampered[30] ^ 0xff;
  assert.throws(() => unsealSecret(tampered, KEY));
});

test("unseal rejects tampered auth tag", () => {
  const blob = sealSecret("payload", KEY);
  const tampered = Buffer.from(blob);
  // Tag starts at offset 13.
  tampered[14] = tampered[14] ^ 0x01;
  assert.throws(() => unsealSecret(tampered, KEY));
});

test("unseal rejects wrong key", () => {
  const blob = sealSecret("secret", KEY);
  assert.throws(() => unsealSecret(blob, "different-key-here-1234567890"));
});

test("seal throws when no key configured", () => {
  assert.throws(() => sealSecret("x", ""));
});

test("unseal of null returns null", () => {
  assert.equal(unsealSecret(null, KEY), null);
});

test("secretsConfigured reflects key presence", () => {
  assert.equal(secretsConfigured(undefined), false);
  assert.equal(secretsConfigured(""), false);
  assert.equal(secretsConfigured("anything-here"), true);
});

test("unseal rejects unknown blob version", () => {
  const bogus = Buffer.alloc(30);
  bogus[0] = 0xff;
  assert.throws(() => unsealSecret(bogus, KEY));
});
