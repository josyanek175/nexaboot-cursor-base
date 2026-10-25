import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
const oldSecret = process.env.SESSION_SECRET,
  oldNow = Date.now;
process.env.SESSION_SECRET = "test-only-revocation-secret";
try {
  const [{ id: user }] =
    await db`INSERT INTO users(name,role,password_hash) VALUES('User','TI','old') RETURNING id`;
  let unavailable = false;
  let handlerCalls = 0;
  const load = tsLoader({
    "@tanstack/react-start/server": {},
    "./lib/pg.server": {
      sql: db,
      getSql: () => {
        if (unavailable) throw new Error("offline");
        return db;
      },
      PG_POOL_MAX: 2,
      isDatabaseSchemaBootstrapEnabled: () => false,
    },
    "./lib/access-hours.server": { accessAllowedNow: async () => ({ allowed: true }) },
    "./lib/error-capture": { consumeLastCapturedError: () => null },
    "./lib/error-page": { renderErrorPage: () => "" },
    "@tanstack/react-start/server-entry": {
      __esModule: true,
      default: {
        fetch: async () => {
          handlerCalls++;
          return Response.json({ ok: true });
        },
      },
    },
  });
  const sessions = load("src/lib/session.server.ts");
  Date.now = () => oldNow() - 60000;
  const old = sessions.createSessionToken(user);
  Date.now = oldNow;
  await db`UPDATE users SET password_hash='new' WHERE id=${user}::uuid`;
  assert.ok(
    (await db`SELECT password_changed_at FROM users WHERE id=${user}::uuid`)[0].password_changed_at,
  );
  const server = load("src/server.ts").default;
  const request = (token) =>
    new Request("https://example.test/api/companies", {
      headers: { cookie: "nexa_session=" + token },
    });
  const rejected = await server.fetch(request(old), {}, {});
  assert.equal(rejected.status, 401);
  assert.ok(rejected.headers.get("set-cookie").includes("Max-Age=0"));
  Date.now = () => oldNow() + 1000;
  const fresh = sessions.createSessionToken(user);
  Date.now = oldNow;
  assert.equal((await server.fetch(request(fresh), {}, {})).status, 200);
  unavailable = true;
  const previousCalls = handlerCalls;
  const offline = await server.fetch(request(fresh), {}, {});
  assert.equal(offline.status, 503);
  assert.equal(handlerCalls, previousCalls);
  assert.equal(offline.headers.get("set-cookie"), null);
  assert.equal(offline.headers.get("cache-control"), "private, no-store");
  unavailable = false;
  assert.equal((await server.fetch(request(fresh), {}, {})).status, 200);
  await db`UPDATE users SET active=false WHERE id=${user}::uuid`;
  assert.equal((await server.fetch(request(fresh), {}, {})).status, 401);
  console.log(
    "PASS: real server gate + isolated PostgreSQL — password-change trigger revokes earlier sessions, new session works, inactive user rejected.",
  );
} finally {
  Date.now = oldNow;
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
  await pg.close();
}
