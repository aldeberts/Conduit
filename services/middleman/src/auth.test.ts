import assert from "node:assert/strict";
import { test } from "node:test";
import { assertToken } from "./auth.js";

test("assertToken allows any when expected unset", () => {
  assert.equal(assertToken(undefined, undefined), true);
  assert.equal(assertToken("x", undefined), true);
});

test("assertToken requires match when expected set", () => {
  assert.equal(assertToken("secret", "secret"), true);
  assert.equal(assertToken("wrong", "secret"), false);
  assert.equal(assertToken(undefined, "secret"), false);
});
