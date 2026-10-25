import assert from "node:assert/strict";
import { tsLoader } from "./test-support/isolated-postgres.mjs";
const { Route } = tsLoader({
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": new Proxy(
    {},
    {
      get() {
        throw Error("Demo seed must not access any database");
      },
    },
  ),
})("src/routes/api/admin/seed-demo.ts");
assert.equal((await Route.server.handlers.GET()).status, 410);
assert.equal((await Route.server.handlers.POST()).status, 410);
console.log("PASS: legacy demo-seed GET/POST disabled without any database access.");
