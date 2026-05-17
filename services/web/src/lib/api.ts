const jsonHeaders = { "content-type": "application/json" };

export type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

export type DocumentState = {
  path: string;
  content: string;
  dirty: boolean;
  revision: number;
  remote: { mtimeMs: number; size: number };
  lastLoadedAt: string;
  lastSavedAt: string | null;
};

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function apiError(data: Record<string, unknown>, status: number): Error {
  const msg =
    typeof data.message === "string"
      ? data.message
      : typeof data.error === "string"
        ? data.error
        : `HTTP ${status}`;
  return new Error(msg);
}

export async function createConnection(body: {
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  password?: string;
  privateKey?: string;
}): Promise<{ id: string; label: string; remoteRoot: string }> {
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as { id: string; label: string; remoteRoot: string };
}

export async function fetchTree(
  connectionId: string,
  path: string,
): Promise<{ path: string; entries: TreeEntry[] }> {
  const q = new URLSearchParams();
  if (path !== "") {
    q.set("path", path);
  }
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/tree?${q.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as { path: string; entries: TreeEntry[] };
}

export async function openDocument(connectionId: string, path: string): Promise<DocumentState> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/open`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ path }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  const doc = data.document as DocumentState;
  return doc;
}

export async function getDocument(connectionId: string, path: string): Promise<DocumentState> {
  const q = new URLSearchParams({ path });
  const res = await fetch(
    `/api/connections/${encodeURIComponent(connectionId)}/documents/one?${q.toString()}`,
  );
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function patchDocument(
  connectionId: string,
  path: string,
  content: string,
): Promise<DocumentState> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/documents`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ path, content }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function saveDocument(connectionId: string, path: string): Promise<DocumentState> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ path }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function refreshDocument(
  connectionId: string,
  path: string,
  force = false,
): Promise<DocumentState> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/refresh`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ path, force }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function closeDocument(connectionId: string, path: string): Promise<void> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/close`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}

export async function deleteConnection(connectionId: string): Promise<void> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}
