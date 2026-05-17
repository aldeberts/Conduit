import type { FastifyPluginAsync } from "fastify";
import {
  closeDocument,
  getOpenDocument,
  listOpenDocuments,
  openDocument,
  patchDocument,
  refreshDocument,
  saveDocument,
} from "../documents/registry.js";
import { getConnection } from "../ssh/registry.js";

function requirePath(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

const documentsApi: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { connectionId: string } }>(
    "/api/connections/:connectionId/documents",
    async (request, reply) => {
      const { connectionId } = request.params;
      if (!getConnection(connectionId)) {
        return reply.status(404).send({ error: "unknown_connection" });
      }
      return reply.send({ documents: listOpenDocuments(connectionId) });
    },
  );

  app.post<{
    Params: { connectionId: string };
    Body: { path?: string };
  }>("/api/connections/:connectionId/documents/open", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.body?.path);
    if (!rel) {
      return reply.status(400).send({ error: "path is required" });
    }
    try {
      const doc = await openDocument(connectionId, rel);
      return reply.send({ document: doc });
    } catch (err) {
      return mapDocError(reply, err);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/connections/:connectionId/documents/one", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.query.path);
    if (!rel) {
      return reply.status(400).send({ error: "path is required" });
    }
    const doc = getOpenDocument(connectionId, rel);
    if (!doc) {
      return reply.status(404).send({ error: "document_not_open" });
    }
    return reply.send({ document: doc });
  });

  app.patch<{
    Params: { connectionId: string };
    Body: { path?: string; content?: string };
  }>("/api/connections/:connectionId/documents", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.body?.path);
    const content = typeof request.body?.content === "string" ? request.body.content : null;
    if (!rel || content === null) {
      return reply.status(400).send({ error: "path and content are required" });
    }
    try {
      const doc = patchDocument(connectionId, rel, content);
      return reply.send({ document: doc });
    } catch (err) {
      return mapDocError(reply, err);
    }
  });

  app.post<{
    Params: { connectionId: string };
    Body: { path?: string };
  }>("/api/connections/:connectionId/documents/save", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.body?.path);
    if (!rel) {
      return reply.status(400).send({ error: "path is required" });
    }
    try {
      const doc = await saveDocument(connectionId, rel);
      return reply.send({ document: doc });
    } catch (err) {
      return mapDocError(reply, err);
    }
  });

  app.post<{
    Params: { connectionId: string };
    Body: { path?: string; force?: boolean };
  }>("/api/connections/:connectionId/documents/refresh", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.body?.path);
    if (!rel) {
      return reply.status(400).send({ error: "path is required" });
    }
    const force = request.body?.force === true;
    try {
      const doc = await refreshDocument(connectionId, rel, force);
      return reply.send({ document: doc });
    } catch (err) {
      return mapDocError(reply, err);
    }
  });

  app.post<{
    Params: { connectionId: string };
    Body: { path?: string };
  }>("/api/connections/:connectionId/documents/close", async (request, reply) => {
    const { connectionId } = request.params;
    if (!getConnection(connectionId)) {
      return reply.status(404).send({ error: "unknown_connection" });
    }
    const rel = requirePath(request.body?.path);
    if (!rel) {
      return reply.status(400).send({ error: "path is required" });
    }
    closeDocument(connectionId, rel);
    return reply.send({ ok: true });
  });
};

function mapDocError(reply: import("fastify").FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  switch (message) {
    case "unknown_connection":
      return reply.status(404).send({ error: message });
    case "document_not_open":
      return reply.status(404).send({ error: message });
    case "is_directory":
      return reply.status(400).send({ error: message });
    case "file_too_large":
      return reply.status(413).send({ error: message });
    case "dirty_document":
      return reply.status(409).send({ error: message, message: "Document has unsaved edits; pass force=true to discard." });
    case "remote_conflict":
      return reply.status(409).send({
        error: message,
        message: "Remote file changed on disk since last load or save. Refresh from disk before saving.",
      });
    default:
      return reply.status(500).send({ error: "document_failed", message });
  }
}

export default documentsApi;
