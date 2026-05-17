import type { FastifyPluginAsync } from "fastify";
import { evictAllForConnection } from "../documents/registry.js";
import {
  closeConnection,
  createSftpConnection,
  getConnection,
  listTree,
  readRemoteTextFile,
  writeRemoteTextFile,
} from "../ssh/registry.js";

const connectionsApi: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: {
      label?: string;
      host?: string;
      port?: number;
      username?: string;
      remotePath?: string;
      password?: string;
      privateKey?: string;
    };
  }>("/api/connections", async (request, reply) => {
    const b = request.body ?? {};
    const label = typeof b.label === "string" && b.label.trim() !== "" ? b.label.trim() : "Untitled";
    const host = typeof b.host === "string" ? b.host.trim() : "";
    const username = typeof b.username === "string" ? b.username.trim() : "";
    const remotePath = typeof b.remotePath === "string" ? b.remotePath.trim() : "";
    const port = typeof b.port === "number" && Number.isFinite(b.port) ? Math.trunc(b.port) : 22;
    if (!host || !username || !remotePath) {
      return reply.status(400).send({ error: "host, username, and remotePath are required" });
    }
    if (port <= 0 || port > 65535) {
      return reply.status(400).send({ error: "invalid port" });
    }
    try {
      const created = await createSftpConnection({
        label,
        host,
        port,
        username,
        remotePath,
        password: typeof b.password === "string" ? b.password : undefined,
        privateKey: typeof b.privateKey === "string" ? b.privateKey : undefined,
      });
      return reply.send({
        id: created.id,
        label,
        remoteRoot: created.remoteRoot,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn({ err }, "createSftpConnection failed");
      return reply.status(502).send({ error: "ssh_connection_failed", message });
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/connections/:connectionId/tree", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = typeof request.query.path === "string" ? request.query.path : "";
    try {
      const entries = await listTree(connectionId, rel);
      return reply.send({ path: rel, entries });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "not_a_directory") {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: "list_failed", message });
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/connections/:connectionId/file", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = typeof request.query.path === "string" ? request.query.path : "";
    if (rel === "") {
      return reply.status(400).send({ error: "path is required" });
    }
    try {
      const text = await readRemoteTextFile(connectionId, rel);
      return reply.send({ path: rel, text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "is_directory") {
        return reply.status(400).send({ error: message });
      }
      if (message === "file_too_large") {
        return reply.status(413).send({ error: message });
      }
      return reply.status(500).send({ error: "read_failed", message });
    }
  });

  app.put<{
    Params: { connectionId: string };
    Body: { path?: string; text?: string };
  }>("/api/connections/:connectionId/file", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const b = request.body ?? {};
    const rel = typeof b.path === "string" ? b.path : "";
    const text = typeof b.text === "string" ? b.text : "";
    if (rel === "") {
      return reply.status(400).send({ error: "path is required" });
    }
    try {
      await writeRemoteTextFile(connectionId, rel, text);
      return reply.send({ ok: true, path: rel, bytes: text.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: "write_failed", message });
    }
  });

  app.delete<{
    Params: { connectionId: string };
  }>("/api/connections/:connectionId", async (request, reply) => {
    const { connectionId } = request.params;
    evictAllForConnection(connectionId);
    const closed = await closeConnection(connectionId);
    if (!closed) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    return reply.send({ ok: true });
  });
};

export default connectionsApi;
