import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const [{ id: user }] =
    await db`INSERT INTO users(name,role) VALUES('User','ATENDENTE') RETURNING id`;
  let token = null;
  let unavailable = false;
  process.env.SESSION_SECRET = "isolated-diagnostics-test-secret";
  const sessions = tsLoader({ "@tanstack/react-start/server": { getCookie: () => token } })(
    "src/lib/session.server.ts",
  );
  const guard = tsLoader({
    "@/lib/pg.server": {
      getSql: () => {
        if (unavailable) throw new Error("offline");
        return db;
      },
    },
    "@/lib/session.server": sessions,
  })("src/lib/platform-diagnostics.server.ts");
  assert.equal((await guard.requirePlatformDiagnostics()).status, 401);
  token = sessions.createSessionToken(user);
  assert.equal((await guard.requirePlatformDiagnostics()).status, 403);
  await db`UPDATE users SET role='TI' WHERE id=${user}::uuid`;
  assert.equal(await guard.requirePlatformDiagnostics(), null);
  const originalNow = Date.now;
  Date.now = () => originalNow() - 60000;
  token = sessions.createSessionToken(user);
  Date.now = originalNow;
  await db`UPDATE users SET password_hash='changed' WHERE id=${user}::uuid`;
  assert.equal((await guard.requirePlatformDiagnostics()).status, 401);
  Date.now = () => originalNow() + 1000;
  token = sessions.createSessionToken(user);
  Date.now = originalNow;
  unavailable = true;
  const blocked = await guard.requirePlatformDiagnostics();
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get("cache-control"), "private, no-store");
  unavailable = false;
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
