import cors from "@fastify/cors";
import Fastify from "fastify";
import connectionsApi from "./api/connections.js";
import documentsApi from "./api/documents.js";
import { loadConfig } from "./config.js";
import { flushTextFile } from "./flush/index.js";
import { createTextDoc } from "./merge/index.js";
import { ptyModuleLoaded } from "./pty/index.js";

const config = loadConfig();

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

await app.register(connectionsApi);
await app.register(documentsApi);

app.get("/health", async () => ({
  ok: true,
  service: "middleman",
  workspaceId: config.workspaceId,
  realRoot: config.realRoot,
  ptyStub: ptyModuleLoaded(),
}));

/**
 * Dev-only echo of the merge + flush pipeline: accepts JSON `{ path, text }`,
 * applies trivial "merged" body to disk under REAL_ROOT.
 */
app.post("/dev/flush", async (request, reply) => {
  const body = request.body as { path?: string; text?: string } | undefined;
  const rel = typeof body?.path === "string" ? body.path : "hello.txt";
  const text = typeof body?.text === "string" ? body.text : "";
  const doc = createTextDoc();
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  const merged = ytext.toString();
  await flushTextFile(config.realRoot, rel, merged);
  return reply.send({ ok: true, wrote: rel, bytes: merged.length });
});

const start = async (): Promise<void> => {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`middleman listening on :${config.port} (REAL_ROOT=${config.realRoot})`);
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
