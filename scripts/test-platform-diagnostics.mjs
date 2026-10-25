import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const [{ id: user }] =
    await db`INSERT INTO users(name,role) VALUES('User','ATENDENTE') RETURNING id`;
  let uid = null;
  const guard = tsLoader({
    "@/lib/pg.server": { getSql: () => db },
    "@/lib/session.server": { getSessionUserId: () => uid },
  })("src/lib/platform-diagnostics.server.ts");
  assert.equal((await guard.requirePlatformDiagnostics()).status, 401);
  uid = user;
  assert.equal((await guard.requirePlatformDiagnostics()).status, 403);
  await db`UPDATE users SET role='TI' WHERE id=${user}::uuid`;
  assert.equal(await guard.requirePlatformDiagnostics(), null);
  await db`UPDATE users SET active=false WHERE id=${user}::uuid`;
  assert.equal((await guard.requirePlatformDiagnostics()).status, 403);
  const routes = [
    "debug/db",
    "debug/cols",
    "debug/plans-selects",
    "webhooks/meta/diagnostic",
    "admin/auth-check",
  ];
  let diagnosticQueries = 0;
  const deny = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/session.server": { hasSessionSecret: () => true },
    "@/lib/platform-diagnostics.server": {
      requirePlatformDiagnostics: async () =>
        Response.json({ error: "unauthenticated" }, { status: 401 }),
    },
    "@/lib/pg.server": {
      sql: () => {
        diagnosticQueries++;
        throw Error("Must authorize first");
      },
    },
  });
  for (const route of routes) {
    const handler = deny("src/routes/api/" + route + ".ts").Route.server.handlers.GET;
    assert.equal(
      (await handler({ request: new Request("https://example.test/api/" + route) })).status,
      401,
    );
  }
  assert.equal(
    (
      await deny("src/routes/api/admin/auth-check.ts").Route.server.handlers.POST({
        request: new Request("https://example.test/api/admin/auth-check", { method: "POST" }),
      })
    ).status,
    401,
  );
  assert.equal(diagnosticQueries, 0);
  console.log(
    "PASS: isolated PostgreSQL — diagnostics require active platform role and all global diagnostic routes authorize before querying data.",
  );
} finally {
  await pg.close();
}
