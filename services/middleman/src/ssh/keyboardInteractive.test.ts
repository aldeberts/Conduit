import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildKeyboardResponses,
  formatSshAuthTranscript,
  isInteractive2faRound,
  isPasswordPrompt,
  parseNumberedOptions,
  tryAutoFillKeyboardResponses,
} from "./keyboardInteractive.js";

test("isPasswordPrompt detects common variants", () => {
  assert.equal(isPasswordPrompt("Password:"), true);
  assert.equal(isPasswordPrompt("password:"), true);
  assert.equal(isPasswordPrompt("Password for ajeberts@rice.stanford.edu:"), true);
  assert.equal(isPasswordPrompt("  Password  "), true);
  assert.equal(isPasswordPrompt("1. Duo Push"), false);
});

test("tryAutoFillKeyboardResponses fills single prompt as password", () => {
  assert.deepEqual(
    tryAutoFillKeyboardResponses([{ prompt: "Password for u@host.edu:", echo: false }], "", "secret"),
    ["secret"],
  );
});

test("tryAutoFillKeyboardResponses fills password round silently", () => {
  const prompts = [{ prompt: "Password:", echo: false }];
  assert.deepEqual(tryAutoFillKeyboardResponses(prompts, "", "secret"), ["secret"]);
});

test("tryAutoFillKeyboardResponses does not guess on empty prompts", () => {
  assert.equal(tryAutoFillKeyboardResponses([], "", "secret"), null);
});

test("tryAutoFillKeyboardResponses skips Duo rounds", () => {
  const prompts = [
    { prompt: "1. Duo Push to +1 555", echo: false },
    { prompt: "Passcode or option (1-2):", echo: true },
  ];
  assert.equal(
    tryAutoFillKeyboardResponses(prompts, "Duo two-factor login", "secret"),
    null,
  );
  assert.equal(isInteractive2faRound(prompts, "Duo two-factor login"), true);
});

test("parseNumberedOptions extracts Duo choices from prompts and instructions", () => {
  const opts = parseNumberedOptions(
    [{ prompt: "Passcode:", echo: true }],
    "1. Duo Push to iPhone\n2. Call +1 555-0100",
  );
  assert.deepEqual(opts, [
    { num: "1", label: "Duo Push to iPhone" },
    { num: "2", label: "Call +1 555-0100" },
  ]);
});

test("Stanford-style Duo round is detected and options are parsed", () => {
  const instructions = "Duo two-factor login for ajeberts";
  const prompts = [
    { prompt: "Enter a passcode or select one of the following options:", echo: false },
    { prompt: "1. Duo Push to XXX-XXX-8816", echo: false },
    { prompt: "2. Phone call to XXX-XXX-8816", echo: false },
    { prompt: "3. SMS passcodes to XXX-XXX-8816", echo: false },
    { prompt: "Passcode or option (1-3): ", echo: true },
  ];
  assert.equal(isInteractive2faRound(prompts, instructions), true);
  assert.equal(tryAutoFillKeyboardResponses(prompts, instructions, "secret"), null);
  assert.deepEqual(parseNumberedOptions(prompts), [
    { num: "1", label: "Duo Push to XXX-XXX-8816" },
    { num: "2", label: "Phone call to XXX-XXX-8816" },
    { num: "3", label: "SMS passcodes to XXX-XXX-8816" },
  ]);
  const transcript = formatSshAuthTranscript(prompts, instructions);
  assert.match(transcript, /Duo two-factor login for ajeberts/);
  assert.match(transcript, /Passcode or option \(1-3\)/);
});

test("buildKeyboardResponses targets passcode line when numbered options come first", () => {
  const prompts = [
    { prompt: "Passcode or option (1-3):", echo: false },
    { prompt: "1. Duo Push to XXX-XXX-8816", echo: false },
    { prompt: "2. Phone call to XXX-XXX-8816", echo: false },
    { prompt: "3. SMS passcodes to XXX-XXX-8816", echo: false },
  ];
  assert.deepEqual(buildKeyboardResponses(prompts, "1"), ["1", "", "", ""]);
});

test("Stanford-style buildKeyboardResponses fills only the answer prompt", () => {
  const prompts = [
    { prompt: "Enter a passcode or select one of the following options:", echo: false },
    { prompt: "1. Duo Push to XXX-XXX-8816", echo: false },
    { prompt: "2. Phone call to XXX-XXX-8816", echo: false },
    { prompt: "3. SMS passcodes to XXX-XXX-8816", echo: false },
    { prompt: "Passcode or option (1-3): ", echo: true },
  ];
  assert.deepEqual(buildKeyboardResponses(prompts, "1"), ["", "", "", "", "1"]);
});
