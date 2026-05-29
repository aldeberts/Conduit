import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { WorkspaceId } from "@conduit/shared";

export type MiddlemanConfig = {
  /** HTTP listen port. */
  port: number;
  /** Absolute path where flushed file bytes are written (Phase 0). */
  realRoot: string;
  /** Single implicit workspace until the control plane exists. */
  workspaceId: WorkspaceId;
  /** Directory for persisted Yjs document state (Phase C). */
  dataDir: string;
  /** When set, require Bearer / X-Conduit-Token / ?token= on API and WebSocket. */
  apiToken?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root when running from `src/` or `dist/` under `services/middleman/`. */
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function parsePort(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    return 3333;
  }
  return n;
}

export function loadConfig(): MiddlemanConfig {
  const port = parsePort(process.env.PORT);
  const rawRoot = process.env.REAL_ROOT ?? "real_shadow";
  const realRoot = path.isAbsolute(rawRoot)
    ? rawRoot
    : path.resolve(repoRoot, rawRoot);
  const rawData = process.env.DATA_DIR ?? "data/conduit";
  const dataDir = path.isAbsolute(rawData) ? rawData : path.resolve(repoRoot, rawData);
  const apiToken = process.env.API_TOKEN?.trim() || undefined;
  return {
    port,
    realRoot,
    workspaceId: "local-default",
    dataDir,
    apiToken,
  };
}
