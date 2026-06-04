import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { makeAuthApi } from "./api/auth.js";
import { makeConnectionsApi } from "./api/connections.js";
import documentsApi from "./api/documents.js";
import { unauthorized } from "./auth.js";
import { resolvePrincipal } from "./auth/principal.js";
import { getDb } from "./db/index.js";
import { countUsers } from "./db/users.js";
import { configureDocumentStore } from "./documents/registry.js";
import { loadConfig } from "./config.js";
import { flushTextFile } from "./flush/index.js";
import { createTextDoc } from "./merge/index.js";
import { metrics, metricsSnapshot } from "./metrics.js";
import { ptyModuleLoaded } from "./pty/index.js";
import { registerWebSocket } from "./ws/handler.js";

const config = loadConfig();
configureDocumentStore(config.dataDir);
const db = getDb(config.dbPath);

const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(cors, {
  origin: true,
  credentials: true,
});
await app.register(cookie);

const PUBLIC_PATHS = new Set([
  "/health",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
]);

app.addHook("onRequest", async (request, reply) => {
  const url = request.url.split("?")[0] ?? request.url;
  if (PUBLIC_PATHS.has(url)) {
    return;
  }
  /** WebSocket auth uses `?token=` in the WS URL (see `registerWebSocket`); do not block the upgrade here. */
  if (url === "/api/ws") {
    return;
  }
  // When no apiToken is configured AND no users exist, leave the app open
  // (matches Phase 0 dev experience). Otherwise require a valid principal.
  const principal = await resolvePrincipal(db, request, config.apiToken);
  if (principal) {
    return;
  }
  if (!config.apiToken) {
    // No auth configured at all -- allow.
    return;
  }
  return unauthorized(reply);
});

await app.register(
  makeAuthApi({
    db,
    apiToken: config.apiToken,
    secureCookies: config.secureCookies,
    allowSelfSignup: config.allowSelfSignup,
  }),
);
await app.register(makeConnectionsApi({ db, apiToken: config.apiToken, secretsKey: config.secretsKey }));
await app.register(documentsApi);
await registerWebSocket(app, { apiToken: config.apiToken, db });

app.get("/health", async () => ({
  ok: true,
  service: "middleman",
  workspaceId: config.workspaceId,
  realRoot: config.realRoot,
  dataDir: config.dataDir,
  // True when there is *any* gate at all: admin token configured OR at least
  // one registered user. Web client uses this to decide whether to show the
  // login screen.
  authRequired: Boolean(config.apiToken) || countUsers(db) > 0,
  hasUsers: countUsers(db) > 0,
  ptyStub: ptyModuleLoaded(),
  metrics: metricsSnapshot(),
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
  app.log.info(
    `middleman listening on :${config.port} (REAL_ROOT=${config.realRoot}, DATA_DIR=${config.dataDir})`,
  );
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
