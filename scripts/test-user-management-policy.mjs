import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the actual route handlers with an isolated database double. No network or database access.
const require = createRequire(import.meta.url);
function load(path, overrides = {}) {
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const policy = () =>
    load("src/lib/user-management-policy.ts", {
      "./platform-roles": load("src/lib/platform-roles.ts"),
    });
  new Function("require", "module", "exports", source)(
    (name) => {
      if (name in overrides) return overrides[name];
      if (name === "@/lib/user-management-policy") return policy();
      return require(name);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const platform = load("src/lib/platform-roles.ts");
const policy = load("src/lib/user-management-policy.ts", { "./platform-roles": platform });
for (const role of policy.COMPANY_USER_ROLES)
  assert.equal(policy.canAssignUserRole("ADMIN_EMPRESA", role), true);
for (const role of policy.PLATFORM_USER_ROLES) {
  assert.equal(policy.canAssignUserRole("ADMIN_EMPRESA", role), false);
  assert.equal(policy.canManageUserTarget("ADMIN_EMPRESA", role), false);
  assert.equal(policy.canAssignUserRole("SUPER_ADMIN", role), true);
}
assert.equal(policy.canAssignUserRole("TI", "invented-role"), false);
for (const role of ["TI", "ADMIN_GERAL", "ADMIN_EMPRESA"]) {
  assert.equal(policy.canAssignUserRole(role, "SUPER_ADMIN"), false);
  assert.equal(policy.canManageUserTarget(role, "SUPER_ADMIN"), false);
}
assert.equal(policy.canManageUserTarget("SUPER_ADMIN", "SUPER_ADMIN"), true);

let mutations = 0;
const actor = { id: "11111111-1111-4111-8111-111111111111", role: "ADMIN_EMPRESA", active: true };
const sql = () => async (strings) => {
  const query = strings.join("?");
  if (/INSERT|UPDATE|DELETE/.test(query)) mutations++;
  if (query.includes("WHERE active = true")) return [actor];
  if (query.includes("SELECT id, role")) return [{ id: actor.id, role: "TI" }];
  if (query.includes("SELECT role")) return [{ role: "TI" }];
  throw new Error("Unexpected query: " + query);
};
const overrides = {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": { sql, getSql: sql },
  "@/lib/session.server": { getSessionUserId: () => actor.id },
  "@/lib/company.server": { requireCompanyId: async () => "22222222-2222-4222-8222-222222222222" },
};
const create = load("src/routes/api/users.ts", overrides).Route.server.handlers.POST;
for (const role of policy.PLATFORM_USER_ROLES) {
  const response = await create({
    request: new Request("https://example.test/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: "Teste",
        email: "test@example.test",
        password: "validpassword",
        role,
      }),
    }),
  });
  assert.equal(response.status, 403);
}
const handlers = load("src/routes/api/users/$id.ts", overrides).Route.server.handlers;
const params = { id: "33333333-3333-4333-8333-333333333333" };
assert.equal(
  (
    await handlers.PUT({
      params,
      request: new Request("https://example.test/api/users/id", {
        method: "PUT",
        body: JSON.stringify({ password: "newpassword" }),
      }),
    })
  ).status,
  403,
);
assert.equal((await handlers.DELETE({ params })).status, 403);
assert.equal(mutations, 0, "Forbidden operations must never write to the database");
let planWrites = 0;
let transactionStarted = false;
const planSql = async (strings) => {
  const query = strings.join("?");
  if (query.includes("FROM public.users")) return [actor];
  throw new Error("Unexpected plan query: " + query);
};
const transactionSql = async (strings) => {
  const query = strings.join("?");
  if (query.includes("FROM public.companies")) return [{ id: params.id }];
  if (query.includes("FROM public.plans")) return [{ id: params.id }];
  if (/UPDATE|INSERT/.test(query)) {
    planWrites++;
    return [];
  }
  throw new Error("Unexpected transaction query: " + query);
};
const subscription = load("src/routes/api/companies/$id/subscription.ts", {
  ...overrides,
  "@/lib/platform-roles": platform,
  "@/lib/subscription.server": { getCompanyPlanUsage: async () => ({}) },
  "@/lib/pg.server": {
    sql: () => planSql,
    getSql: () => ({
      begin: async (fn) => {
        transactionStarted = true;
        return fn(transactionSql);
      },
    }),
  },
}).Route.server.handlers.PUT;
const request = () =>
  new Request("https://example.test/api/companies/id/subscription", {
    method: "PUT",
    body: JSON.stringify({ plan_id: params.id }),
  });
assert.equal((await subscription({ params, request: request() })).status, 403);
assert.equal(transactionStarted, false, "Company administrators cannot start a plan change");
actor.role = "SUPER_ADMIN";
assert.equal((await subscription({ params, request: request() })).status, 200);
assert.equal(
  planWrites,
  2,
  "Plan replacement cancels the former subscription and creates the new one in the transaction",
);
console.log(
  "OK: company roles, platform promotion, protected password reset and deactivation; no database mutations.",
);
console.log(
  "OK: subscription changes restricted to platform administrators and grouped in a transaction.",
);
