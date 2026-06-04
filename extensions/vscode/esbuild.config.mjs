import { build } from "esbuild";

/**
 * Bundle the extension into a single CommonJS file for VS Code's host. We
 * pull in `@conduit/client` (ESM) + `y-protocols` + `yjs` (ESM) and emit one
 * `dist/extension.js`. `vscode` is marked external because the runtime
 * provides it.
 */

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
});
