import assert from "node:assert/strict";
import { tsLoader } from "./test-support/isolated-postgres.mjs";
const originalNow = Date.now,
  oldSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = "isolated-test-signing-key-not-for-deployment";
try {
  let now = 1800000000000;
  Date.now = () => now;
  const sessions = tsLoader({ "@tanstack/react-start/server": {} })("src/lib/session.server.ts");
  const token = sessions.createSessionToken("11111111-1111-4111-8111-111111111111");
  assert.ok(sessions.verifySessionToken(token));
  assert.equal(
    sessions.sessionPredatesPasswordChange(token, new Date(now + 1).toISOString()),
    true,
  );
  assert.equal(
    sessions.sessionPredatesPasswordChange(token, new Date(now - 1).toISOString()),
    false,
  );
  assert.equal(sessions.verifySessionToken(token + ".extra"), null);
  assert.equal(sessions.verifySessionToken(token.slice(0, -1) + "!"), null);
  now -= 120000;
  assert.equal(sessions.verifySessionToken(token), null);
  now += 120000 + 31 * 86400000;
  assert.equal(sessions.verifySessionToken(token), null);
  console.log("PASS: signed session expiry, future timestamps, tampering and malformed tokens.");
} finally {
  Date.now = originalNow;
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
}
