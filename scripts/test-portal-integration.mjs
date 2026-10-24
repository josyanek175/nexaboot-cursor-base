import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import ts from "typescript";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const module = { exports: {} };
const js = ts.transpileModule(readFileSync("src/lib/portal-integration-auth.server.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("require", "module", "exports", js)(require, module, module.exports);
const { verifyPortalRequest } = module.exports;
const secret = "test-only-key-with-at-least-thirty-two-characters";
const now = Date.now(),
  body = JSON.stringify({ action: "overview" });
function signed({
  timestamp = String(now),
  nonce = randomUUID(),
  text = body,
  path = "/api/internal/portal",
  key = secret,
} = {}) {
  const signature = createHmac("sha256", key)
    .update([timestamp, nonce, "POST", path, text].join("\n"))
    .digest("hex");
  return new Request("https://dev.example.test" + path, {
    method: "POST",
    headers: {
      "x-nexa-timestamp": timestamp,
      "x-nexa-nonce": nonce,
      "x-nexa-signature": signature,
    },
    body: text,
  });
}
const request = signed();
assert.equal(verifyPortalRequest(request, body, secret, now), true);
assert.equal(verifyPortalRequest(request, body, secret, now), false, "Reject replay");
assert.equal(verifyPortalRequest(signed(), body + " ", secret, now), false, "Reject modified body");
assert.equal(
  verifyPortalRequest(signed({ timestamp: String(now - 61000) }), body, secret, now),
  false,
);
assert.equal(
  verifyPortalRequest(signed({ timestamp: String(now + 61000) }), body, secret, now),
  false,
);
assert.equal(verifyPortalRequest(signed({ key: "wrong" }), body, secret, now), false);
assert.equal(verifyPortalRequest(signed(), body, undefined, now), false);
assert.equal(verifyPortalRequest(signed(), body, "short", now), false);
console.log(
  "OK: signed requests, replay rejection, tampered payload, expired/future timestamp, wrong/missing/short secret.",
);
