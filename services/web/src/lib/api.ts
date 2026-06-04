import { getApiToken } from "./authToken";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const token = getApiToken();
  if (token) {
    h.authorization = `Bearer ${token}`;
  }
  return h;
}

/** All browser API calls send session cookies (email/password login flow). */
function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    credentials: "include",
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

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

export async function fetchTree(
  connectionId: string,
  path: string,
): Promise<{ path: string; entries: TreeEntry[] }> {
  const q = new URLSearchParams();
  if (path !== "") {
    q.set("path", path);
  }
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/tree?${q.toString()}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as { path: string; entries: TreeEntry[] };
}

export async function openDocument(connectionId: string, path: string): Promise<DocumentState> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/open`, {
    method: "POST",
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
  const res = await apiFetch(
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
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/documents`, {
    method: "PATCH",
    body: JSON.stringify({ path, content }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function saveDocument(connectionId: string, path: string): Promise<DocumentState> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/save`, {
    method: "POST",
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
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/refresh`, {
    method: "POST",
    body: JSON.stringify({ path, force }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data.document as DocumentState;
}

export async function closeDocument(connectionId: string, path: string): Promise<void> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/documents/close`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}

export async function createFile(connectionId: string, path: string): Promise<void> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/files`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}

export async function deleteFile(connectionId: string, path: string): Promise<void> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/files`, {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}

export async function renameFile(connectionId: string, from: string, to: string): Promise<void> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/files/rename`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}

export async function deleteConnection(connectionId: string): Promise<void> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export type SshAuthPrompt = { prompt: string; echo: boolean };

export type SshAuthSessionStatus =
  | { status: "connecting"; phase?: "dialing" | "password_sent" | "duo_pending" }
  | { status: "awaiting_input"; prompts: SshAuthPrompt[]; instructions: string }
  | { status: "connected"; id: string; remoteRoot: string; label: string }
  | { status: "failed"; message: string; transcript?: string };

export async function createConnection(body: {
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  password?: string;
  privateKey?: string;
  interactiveAuth?: boolean;
}): Promise<{ id: string; label: string; remoteRoot: string }> {
  const res = await apiFetch("/api/connections", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await parseJson(res);
  if (res.status === 202 && typeof data.authSessionId === "string") {
    return waitForInteractiveConnection(data.authSessionId as string, body.label);
  }
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as { id: string; label: string; remoteRoot: string };
}

/** Starts an interactive SSH auth flow; caller should show {@link SshAuthModal}. */
export async function startInteractiveConnection(body: {
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  password?: string;
  privateKey?: string;
}): Promise<{ authSessionId: string }> {
  const res = await apiFetch("/api/connections", {
    method: "POST",
    body: JSON.stringify({ ...body, interactiveAuth: true }),
  });
  const data = await parseJson(res);
  if (res.status !== 202 || typeof data.authSessionId !== "string") {
    throw apiError(data, res.status);
  }
  return { authSessionId: data.authSessionId as string };
}

export async function pollSshAuthSession(authSessionId: string): Promise<SshAuthSessionStatus> {
  const res = await apiFetch(`/api/connections/ssh-auth/${encodeURIComponent(authSessionId)}`);
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as unknown as SshAuthSessionStatus;
}

export async function submitSshAuthResponses(
  authSessionId: string,
  answer: string,
): Promise<{ answer: string; responses: string[] }> {
  const res = await apiFetch(`/api/connections/ssh-auth/${encodeURIComponent(authSessionId)}`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  const responses = Array.isArray(data.responses)
    ? (data.responses as unknown[]).map((v) => String(v))
    : [];
  return { answer: answer.trim(), responses };
}

async function waitForInteractiveConnection(
  authSessionId: string,
  label: string,
): Promise<{ id: string; label: string; remoteRoot: string }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await pollSshAuthSession(authSessionId);
    if (status.status === "connected") {
      return { id: status.id, label: status.label, remoteRoot: status.remoteRoot };
    }
    if (status.status === "failed") {
      throw new Error(status.message);
    }
    if (status.status === "awaiting_input") {
      throw new Error("SSH two-factor authentication required; use the interactive connect flow");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for SSH connection");
}

export type ServerConnection = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  createdAt: number;
  isOwner: boolean;
  isOpen: boolean;
  /** True when the owner can revive the SSH session with a single click
   *  because the server has at-rest secret storage configured AND a secret
   *  was sealed at create-time. */
  canRevive: boolean;
};

export async function reopenConnection(
  connectionId: string,
): Promise<{ id: string; remoteRoot?: string; alreadyOpen?: boolean }> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/reopen`, {
    method: "POST",
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return data as { id: string; remoteRoot?: string; alreadyOpen?: boolean };
}

export async function listMyConnections(): Promise<ServerConnection[]> {
  const res = await apiFetch(`/api/connections`);
  if (!res.ok) {
    if (res.status === 401) return [];
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { connections: ServerConnection[] };
  return data.connections;
}

export type ConnectionMember = {
  userId: string;
  email: string;
  role: "owner" | "member";
};

export async function listMembers(connectionId: string): Promise<ConnectionMember[]> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/members`);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { members: ConnectionMember[] };
  return data.members;
}

export async function inviteMember(connectionId: string, email: string): Promise<ConnectionMember> {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(connectionId)}/members`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw apiError(data, res.status);
  }
  return (data as { member: ConnectionMember }).member;
}

export async function removeMember(connectionId: string, userId: string): Promise<void> {
  const res = await apiFetch(
    `/api/connections/${encodeURIComponent(connectionId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await parseJson(res);
    throw apiError(data, res.status);
  }
}
