import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
let uid = null,
  role = "ATENDENTE",
  active = true,
  queries = 0;
const query = async (strings) => {
  queries++;
  assert.ok(strings.join("").includes("SELECT role"));
  assert.ok(strings.join("").includes("active=true"));
  return active ? [{ role }] : [];
};
const overrides = {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": {
    getSql: () => query,
    sql: () => {
      throw Error("Diagnostic must authorize before data queries");
    },
  },
  "@/lib/session.server": { getSessionUserId: () => uid, hasSessionSecret: () => false },
  "@/lib/subscription.server": {},
};
function load(path) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name in overrides) return overrides[name];
      if (name === "@/lib/platform-roles") return load("src/lib/platform-roles.ts");
      if (name === "@/lib/platform-diagnostics.server")
        return load("src/lib/platform-diagnostics.server.ts");
      return require(name);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const guard = load("src/lib/platform-diagnostics.server.ts");
assert.equal((await guard.requirePlatformDiagnostics()).status, 401);
assert.equal(queries, 0);
uid = "11111111-1111-4111-8111-111111111111";
assert.equal((await guard.requirePlatformDiagnostics()).status, 403);
for (const platform of ["TI", "SUPER_ADMIN", "ADMIN_GERAL"]) {
  role = platform;
  assert.equal(await guard.requirePlatformDiagnostics(), null);
}
active = false;
assert.equal((await guard.requirePlatformDiagnostics()).status, 403);
uid = null;
queries = 0;
for (const route of [
  "debug/db",
  "debug/cols",
  "debug/plans-selects",
  "webhooks/meta/diagnostic",
  "admin/auth-check",
]) {
  const handlers = load("src/routes/api/" + route + ".ts").Route.server.handlers;
  for (const method of ["GET", "POST"])
    if (handlers[method])
      assert.equal(
        (
          await handlers[method]({
            request: new Request("https://example.test/api/" + route, { method }),
          })
        ).status,
        401,
      );
}
const seed = load("src/routes/api/admin/seed-demo.ts").Route.server.handlers;
assert.equal((await seed.GET()).status, 410);
assert.equal((await seed.POST()).status, 410);
assert.equal(queries, 0);
console.log(
  "PASS: disabled demo seed, active platform-only diagnostics, anonymous/ordinary-user rejection before data queries. No database accessed.",
);
