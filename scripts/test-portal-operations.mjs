import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", js)(name => mocks[name] ?? require(name), module, module.exports);
  return module.exports;
}
const secret = "integration-test-key-at-least-thirty-two-characters";
const previous = process.env.NEXA_PORTAL_INTEGRATION_SECRET;
process.env.NEXA_PORTAL_INTEGRATION_SECRET = secret;
const companyId = "11111111-1111-4111-8111-111111111111", userId = "22222222-2222-4222-8222-222222222222";
let targetRole = "ATENDENTE", exists = true, planExists = true, writes = [];
const db = async (parts, ...values) => {
  const sql = parts.join("?");
  if (/INSERT|UPDATE public\./.test(sql)) { writes.push({ sql, values }); return [{ id: userId }]; }
  if (sql.includes("FROM public.companies")) return exists ? [{ id: companyId }] : [];
  if (sql.includes("FROM public.plans")) return planExists ? [{ id: companyId }] : [];
  if (sql.includes("SELECT role FROM public.users")) {
    assert.ok(values.includes(companyId), "Target lookup must include company");
    assert.ok(values.includes(userId), "Target lookup must include user");
    return exists ? [{ role: targetRole }] : [];
  }
  return [];
};
db.begin = async fn => fn(db);
const platform = load("src/lib/platform-roles.ts");
const policy = load("src/lib/user-management-policy.ts", { "./platform-roles": platform });
const auth = load("src/lib/portal-integration-auth.server.ts");
const handler = load("src/routes/api/internal/portal.ts", {
  "@tanstack/react-router": { createFileRoute: () => config => config },
  "@/lib/pg.server": { getSql: () => db },
  "@/lib/subscription.server": { listCompaniesWithPlanUsage: async () => [] },
  "@/lib/portal-integration-auth.server": auth,
  "@/lib/user-management-policy": policy,
}).Route.server.handlers.POST;
async function call(input, signed = true) {
  const body = JSON.stringify(input), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac("sha256", secret).update([timestamp, nonce, "POST", "/api/internal/portal", body].join("\n")).digest("hex");
  return handler({ request: new Request("https://dev.example.test/api/internal/portal", { method: "POST", body, headers: signed ? { "x-nexa-timestamp": timestamp, "x-nexa-nonce": nonce, "x-nexa-signature": signature } : {} }) });
}
try {
  assert.equal((await call({ action: "overview" }, false)).status, 401);
  assert.equal((await call({ action: "sql" })).status, 400);
  const user = { name: "Pessoa Teste", email: "test@example.test", role: "ATENDENTE", active: true };
  assert.equal((await call({ action: "createUser", companyId, user: { ...user, role: "TI" } })).status, 400);
  targetRole = "TI";
  assert.equal((await call({ action: "updateUser", companyId, userId, user })).status, 403);
  targetRole = "ADMIN_EMPRESA";
  assert.equal((await call({ action: "updateUser", companyId, userId, user })).status, 409);
  exists = false;
  assert.equal((await call({ action: "updateUser", companyId, userId, user })).status, 400);
  exists = true; planExists = false;
  assert.equal((await call({ action: "assignPlan", companyId, planId: companyId })).status, 400);
  assert.equal(writes.length, 0, "Rejected operations must not mutate records");
  targetRole = "ATENDENTE";
  assert.equal((await call({ action: "updateUser", companyId, userId, user })).status, 200);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].values.includes(companyId));
  assert.ok(writes[0].values.includes(userId));
  console.log("OK: real integration handler rejects unsigned/invalid requests, platform roles, last-admin removal, missing company/plan; user update remains company-scoped. No real database accessed.");
} finally {
  if (previous === undefined) delete process.env.NEXA_PORTAL_INTEGRATION_SECRET;
  else process.env.NEXA_PORTAL_INTEGRATION_SECRET = previous;
}
