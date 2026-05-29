import { appendFileSync } from "node:fs";

const LOG_PATH = "/Users/aldeneberts/Github/Conduit/.cursor/debug-cedecc.log";

export function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  try {
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({
        sessionId: "cedecc",
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      })}\n`,
    );
  } catch {
    /* ignore */
  }
}
