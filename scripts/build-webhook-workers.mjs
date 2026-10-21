import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  entryPoints: [
    "scripts/webhook-outbox-publisher.ts",
    "scripts/webhook-message-worker.ts",
    "scripts/webhook-media-worker.ts",
  ],
  outdir: ".output/workers",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  tsconfig: "tsconfig.json",
  banner: {
    js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "no-http-context-in-workers",
      setup(builder) {
        builder.onResolve({ filter: /^@tanstack\/react-start\/server$/ }, () => ({
          path: resolve("src/lib/worker-request-context.server.ts"),
        }));
      },
    },
  ],
});
console.log("Worker bundles generated in .output/workers (no service started).");
