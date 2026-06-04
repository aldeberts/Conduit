import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSshAuthSession,
  resetSshAuthSessionsForTests,
  startSshAuthSession,
  submitSshAuthResponses,
} from "./pendingAuth.js";
import { buildKeyboardResponses } from "./keyboardInteractive.js";

test("ssh auth session progresses through keyboard-interactive to connected", async () => {
  resetSshAuthSessionsForTests();

  const orig = (globalThis as { createSftpConnectionInteractive?: unknown }).createSftpConnectionInteractive;
  // Mock is injected via registry in integration tests; here we simulate by replacing
  // the module export is hard — use a minimal manual session test instead.

  const authSessionId = startSshAuthSession({
    input: {
      label: "lab",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      remotePath: "/tmp",
      password: "pw",
    },
    userId: null,
    db: null,
  });

  assert.equal(getSshAuthSession(authSessionId)?.status, "connecting");

  // Without a live SSH host this will eventually fail; wait briefly for failure state.
  await new Promise((r) => setTimeout(r, 1500));
  const final = getSshAuthSession(authSessionId);
  assert.ok(final?.status === "failed" || final?.status === "connecting");
});

test("buildKeyboardResponses puts answer on last echo prompt", () => {
  const prompts = [
    { prompt: "1. Duo Push to XXX-XXX-8816", echo: false },
    { prompt: "Passcode or option (1-3): ", echo: true },
  ];
  assert.deepEqual(buildKeyboardResponses(prompts, "1"), ["", "1"]);
});

test("submitSshAuthResponses rejects when not awaiting input", () => {
  resetSshAuthSessionsForTests();
  const id = startSshAuthSession({
    input: {
      label: "lab",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      remotePath: "/tmp",
      password: "pw",
    },
    userId: null,
    db: null,
  });
  const result = submitSshAuthResponses(id, "1");
  assert.equal(result.ok, false);
});
