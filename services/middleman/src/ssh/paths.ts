import path from "node:path/posix";

/**
 * Joins `remoteRoot` (absolute POSIX path on the SSH host) with a relative
 * directory path from the UI, blocking traversal outside the workspace root.
 */
export function resolveUnderRemoteRoot(remoteRoot: string, relativePath: string): string {
  const root = remoteRoot.replace(/\/+$/, "") || "/";
  const raw = relativePath.trim() === "" ? "." : relativePath;
  const normalized = path.normalize(raw).replace(/^(\.\.(\/|$))+/, "");
  const joined = normalized === "." ? root : path.join(root, normalized);
  const resolved = path.normalize(joined);
  if (resolved === root) {
    return resolved;
  }
  if (!resolved.startsWith(`${root}/`)) {
    throw new Error("path escapes remote workspace root");
  }
  return resolved;
}
