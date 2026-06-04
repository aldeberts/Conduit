export type SshAuthPrompt = { prompt: string; echo: boolean };

/** True when the prompt text is asking for a password (often echo=false on SSH servers). */
export function isPasswordPrompt(text: string): boolean {
  const t = text.trim();
  if (/\bduo\b|\bpasscode\b|\boption\s*\(\d/i.test(t)) return false;
  return /^password\b/i.test(t) || /\bpassword\s*:\s*$/i.test(t);
}

/** True when this round looks like Duo / OTP / 2FA — needs a human in the loop. */
export function isInteractive2faRound(prompts: SshAuthPrompt[], instructions: string): boolean {
  const blob = [instructions, ...prompts.map((p) => p.prompt)].join("\n");
  return /duo|passcode|two-factor|2fa|verification code|option\s*\(\d|select one of/i.test(blob);
}

/** Index of the prompt that should receive the user's Duo / OTP answer. */
export function duoInputPromptIndex(prompts: SshAuthPrompt[]): number {
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i]!.prompt.trim();
    if (/passcode or option|passcode\s*:|verification code|enter.*(?:passcode|option)/i.test(p)) {
      return i;
    }
  }
  for (let i = prompts.length - 1; i >= 0; i--) {
    if (!/^\d+\.\s/.test(prompts[i]!.prompt.trim())) return i;
  }
  return activePromptIndex(prompts);
}

/** Parse lines like "1. Duo Push to +1…" from prompts and instructions text. */
export function parseNumberedOptions(
  prompts: SshAuthPrompt[],
  instructions = "",
): { num: string; label: string }[] {
  const out: { num: string; label: string }[] = [];
  const seen = new Set<string>();
  const lines = [instructions, ...prompts.map((p) => p.prompt)].join("\n").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ num: m[1]!, label: m[2]!.trim() });
    }
  }
  return out;
}

/**
 * Build keyboard-interactive responses from the password the user already typed
 * on the connect form. Returns null when we need to show the 2FA UI.
 */
export function tryAutoFillKeyboardResponses(
  prompts: SshAuthPrompt[],
  instructions: string,
  password: string | undefined,
): string[] | null {
  if (!password) return null;
  if (isInteractive2faRound(prompts, instructions)) return null;

  // Stanford / PAM hosts usually send a single "Password:" keyboard-interactive prompt.
  if (prompts.length === 1) {
    return [password];
  }

  if (prompts.length === 0) {
    return null;
  }

  const passwordLike =
    /\bpassword\b/i.test(instructions) ||
    prompts.some((p) => isPasswordPrompt(p.prompt) || /\bpassword\b/i.test(p.prompt));
  if (!passwordLike) return null;

  const responses = prompts.map((p) =>
    isPasswordPrompt(p.prompt) || /\bpassword\b/i.test(p.prompt) ? password : "",
  );

  // Never auto-send blank passwords — that hangs the server waiting for real input.
  if (!responses.some((r) => r.length > 0)) {
    const fillAt = prompts.findIndex((p) => !p.echo);
    responses[fillAt >= 0 ? fillAt : 0] = password;
  }

  return responses;
}

/** Flatten prompts into terminal-style lines for the UI. */
export function formatSshAuthTranscript(prompts: SshAuthPrompt[], instructions: string): string {
  const lines: string[] = [];
  if (instructions.trim()) lines.push(instructions.trim());
  for (const p of prompts) {
    if (p.prompt.trim()) lines.push(p.prompt);
  }
  return lines.join("\n");
}

/** Index of the prompt the user should answer (last echo:true, or last prompt). */
export function activePromptIndex(prompts: SshAuthPrompt[]): number {
  for (let i = prompts.length - 1; i >= 0; i--) {
    if (prompts[i]!.echo) return i;
  }
  return prompts.length > 0 ? prompts.length - 1 : 0;
}

/**
 * Build the response array ssh2 expects: one string per prompt, only the
 * active (echo) prompt gets the user's choice (e.g. "1" for Duo Push).
 */
export function buildKeyboardResponses(prompts: SshAuthPrompt[], answer: string): string[] {
  if (prompts.length === 0) return [];
  const idx = duoInputPromptIndex(prompts);
  const trimmed = answer.trim();
  return prompts.map((_, i) => (i === idx ? trimmed : ""));
}
