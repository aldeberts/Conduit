import type { FastifyReply, FastifyRequest } from "fastify";

export function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  const custom = request.headers["x-conduit-token"];
  if (typeof custom === "string") {
    return custom.trim();
  }
  return undefined;
}

export function extractTokenFromQuery(query: Record<string, unknown>): string | undefined {
  const raw = query.token;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

export function assertToken(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }
  return provided === expected;
}

export function unauthorized(reply: FastifyReply): void {
  void reply.status(401).send({ error: "unauthorized", message: "Missing or invalid API token" });
}
