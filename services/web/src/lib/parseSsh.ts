export type ParsedSsh = {
  username: string;
  host: string;
  port: number;
};

/**
 * Best-effort parse of a typical OpenSSH invocation, e.g.
 * `ssh -p 2222 ubuntu@10.0.0.5` or `ssh deploy@host.example`.
 */
export function parseSshCommand(line: string): ParsedSsh | null {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (trimmed === "") {
    return null;
  }
  if (!trimmed.startsWith("ssh ")) {
    return null;
  }
  let rest = trimmed.slice(4).trim();
  let port = 22;

  const portFlag = /(?:^|\s)-p\s+(\d+)\b/;
  let m = rest.match(portFlag);
  while (m) {
    port = Number.parseInt(m[1] ?? "", 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return null;
    }
    rest = rest.replace(m[0], " ").trim();
    m = rest.match(portFlag);
  }

  rest = rest.replace(/(?:^|\s)-i\s+\S+/g, " ").trim();
  rest = rest.replace(/(?:^|\s)-o\s+\S+\s+\S+/g, " ").trim();

  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const userHost = parts[parts.length - 1];
  if (!userHost?.includes("@")) {
    return null;
  }
  const at = userHost.lastIndexOf("@");
  const username = userHost.slice(0, at).trim();
  const host = userHost.slice(at + 1).trim();
  if (!username || !host) {
    return null;
  }
  return { username, host, port };
}
