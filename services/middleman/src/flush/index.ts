import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes UTF-8 text to REAL_ROOT, creating parent directories as needed.
 * Used on "save" once merged CRDT state is serialized to a string.
 */
export async function flushTextFile(
  realRoot: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const safeRelative = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const target = path.join(realRoot, safeRelative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}
