import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Actual modules and handlers, with an isolated database double. No hosted data.
const require = createRequire(import.meta.url);
function load(path, overrides = {}) {
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name) => (name in overrides ? overrides[name] : require(name)),
    module,
    module.exports,
  );
  return module.exports;
}
const uid = "11111111-1111-4111-8111-111111111111";
const a = "22222222-2222-4222-8222-222222222222";
const b = "33333333-3333-4333-8333-333333333333";
const platform = load("src/lib/platform-roles.ts");
const permissions = load("src/lib/permissions.ts", { "./platform-roles": platform });
assert.equal(permissions.canCreateTenant({ id: uid, role: "SUPER_ADMIN", tenantId: "" }), true);
for (const deniedRole of ["TI", "ADMIN_GERAL", "ADMIN_EMPRESA", "GERENTE", "ATENDENTE"]) {
  assert.equal(permissions.canCreateTenant({ id: uid, role: deniedRole, tenantId: a }), false);
}
const context = load("src/lib/company-context.ts");
const auth = load("src/lib/auth-user.ts", {
  "./platform-roles": platform,
  "./company-context": context,
});
const raw = {
  id: uid,
  name: "TI",
  email: "ti@example.test",
  role: "TI",
  tenant_id: "shared-legacy",
  company_valid: true,
};
const userA = auth.normalizeAuthUser({ ...raw, company_id: a });
const userB = auth.normalizeAuthUser({ ...raw, company_id: b });
assert.equal(userA.tenantId, a);
assert.equal(userB.tenantId, b);
assert.equal(userB.role, "TI");
assert.equal(auth.normalizeAuthUser({ ...raw, company_valid: false }).tenantId, "");
assert.equal(context.operationalTenant(null, null, false), null);

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
let authenticatedUser = userA;
const session = load("src/lib/session.tsx", {
  "./auth": {
    useAuth: () => ({
      user: authenticatedUser,
      tenant: authenticatedUser
        ? context.operationalTenant(authenticatedUser.companyId, "Empresa A", true)
        : null,
    }),
  },
  "./platform-roles": platform,
});
function Probe() {
  const value = session.useSession();
  return React.createElement(
    "span",
    null,
    `${value.user.id}:${value.session.tenantId}:${value.isSuperAdmin}`,
  );
}
assert.ok(
  renderToStaticMarkup(
    React.createElement(session.SessionProvider, null, React.createElement(Probe)),
  ).includes(`${uid}:${a}:true`),
);
authenticatedUser = null;
assert.equal(
  renderToStaticMarkup(
    React.createElement(session.SessionProvider, null, React.createElement(Probe)),
  ),
  "",
);

let cookie;
const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = "isolated-test-secret-never-used-in-production";
const cookies = load("src/lib/operational-company.server.ts", {
  "@tanstack/react-start/server": { getCookie: () => cookie },
});
cookie = cookies.buildOperationalCompanySetCookie(uid, a).split(";")[0].split("=")[1];
assert.equal(cookies.getOperationalCompanyIdFromCookie(uid), a);
assert.equal(
  cookies.getOperationalCompanyIdFromCookie(b),
  null,
  "Selection belongs to the original actor",
);
const signedCookie = cookie;
cookie = `${cookie.slice(0, -1)}!`;
assert.equal(cookies.getOperationalCompanyIdFromCookie(uid), null);
cookie = signedCookie;

let role = "TI";
let activeUser = true;
let selected = a;
let activeCompany = true;
const db = async (strings, ...values) => {
  const query = strings.join("?");
  if (query.includes("LEFT JOIN public.companies"))
    return [{ company_id: a, company_pk: activeCompany ? a : null, company_name: "Empresa A" }];
  if (query.includes("FROM public.users")) {
    assert.ok(query.includes("active = true"), "Inactive users cannot operate");
    return activeUser ? [{ id: uid, role, company_id: a }] : [];
  }
  if (query.includes("FROM public.companies"))
    return activeCompany && [a, b].includes(values[0])
      ? [{ id: values[0], name: "Empresa teste" }]
      : [];
  throw new Error(`Unexpected query: ${query}`);
};
const company = load("src/lib/company.server.ts", {
  "@/lib/pg.server": { sql: () => db },
  "@/lib/session.server": { getSessionUserId: () => uid },
  "@/lib/platform-roles": platform,
  "@/lib/operational-company.server": { getOperationalCompanyIdFromCookie: () => selected },
});
assert.equal((await company.getCurrentUserCompanyInfo()).companyId, a);
selected = b;
assert.equal((await company.getCurrentUserCompanyInfo()).companyId, b);
role = "ADMIN_EMPRESA";
assert.equal(
  (await company.getCurrentUserCompanyInfo()).companyId,
  a,
  "Company admin cannot use platform selection",
);
role = "TI";
selected = null;
assert.equal((await company.requireCompanyId()).status, 403);
selected = b;
activeCompany = false;
assert.equal((await company.requireCompanyId()).status, 403);
activeCompany = true;
activeUser = false;
assert.equal((await company.requireCompanyId()).status, 403);
activeUser = true;

const routeSql = (...args) => db(...args);
const handlers = load("src/routes/api/auth/operational-company.ts", {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": { sql: routeSql },
  "@/lib/session.server": { getSessionUserId: () => uid },
  "@/lib/platform-roles": platform,
  "@/lib/operational-company.server": cookies,
  "@/lib/company.server": company,
}).Route.server.handlers;
const select = (id) =>
  handlers.POST({
    request: new Request("https://example.test/api/auth/operational-company", {
      method: "POST",
      body: JSON.stringify({ company_id: id }),
    }),
  });
let response = await select(b);
assert.equal(response.status, 200);
assert.ok(response.headers.get("Set-Cookie").includes("HttpOnly"));
assert.equal((await response.json()).company_id, b);
assert.equal((await select("invalid")).status, 400);
activeCompany = false;
assert.equal((await select(b)).status, 404);
activeCompany = true;
role = "ADMIN_EMPRESA";
assert.equal((await select(b)).status, 403);
assert.equal((await handlers.GET()).status, 403);

// Administrative reset must affect only a user of the selected company.
role = "TI";
selected = a;
let writes = 0;
const userDb = async (strings, ...values) => {
  const query = strings.join("?");
  if (query.includes("WHERE active = true")) return [{ id: uid, role, company_id: null }];
  assert.ok(query.includes("company_id ="), "Every target read/write must have a company scope");
  const scopedCompany = values.at(-1);
  if (query.includes("UPDATE")) {
    assert.equal(scopedCompany, b);
    writes++;
    return [{ id: a, company_id: b }];
  }
  return scopedCompany === b ? [{ id: a, role: "ATENDENTE" }] : [];
};
const policy = load("src/lib/user-management-policy.ts", { "./platform-roles": platform });
const userHandlers = load("src/routes/api/users/$id.ts", {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": { getSql: () => userDb },
  "@/lib/session.server": { getSessionUserId: () => uid },
  "@/lib/company.server": company,
  "@/lib/user-management-policy": policy,
}).Route.server.handlers;
const reset = () =>
  userHandlers.PUT({
    params: { id: a },
    request: new Request("https://example.test/api/users/test", {
      method: "PUT",
      body: JSON.stringify({ password: "isolated-test-password" }),
    }),
  });
assert.equal((await reset()).status, 404);
assert.equal(writes, 0);
selected = b;
assert.equal((await reset()).status, 200);
assert.equal(writes, 1);

// Only SUPER_ADMIN creates a company; TI retains support access.
let transactionWrites = 0;
const tx = async (strings) => {
  const query = strings.join("?");
  transactionWrites++;
  if (query.includes("INSERT INTO public.companies")) return [{ id: b, name: "Empresa B", active: true }];
  if (query.includes("INSERT INTO public.users")) return [{ id: a }];
  if (query.includes("INSERT INTO public.company_subscriptions")) return [];
  throw new Error(`Unexpected transaction: ${query}`);
};
const createSql = (...args) => {
  if (!args.length) return createSql;
  const query = args[0].join("?");
  if (query.includes("WHERE lower(email)")) return [];
  if (query.includes("FROM public.users")) return [{ id: uid, role, tenant_id: "legacy", company_id: null }];
  if (query.includes("FROM public.plans")) return [{ id: a }];
  throw new Error(`Unexpected creation query: ${query}`);
};
const companies = load("src/routes/api/companies.ts", {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/pg.server": { sql: createSql, getSql: () => ({ begin: (fn) => fn(tx) }) },
  "@/lib/session.server": { getSessionUserId: () => uid },
  "@/lib/company.server": company,
  "@/lib/platform-roles": platform,
  "@/lib/subscription.server": { listCompaniesWithPlanUsage: async () => [{ id: a }, { id: b }] },
}).Route.server.handlers;
assert.equal((await (await companies.GET()).json()).companies.length, 2);
const createCompany = () => companies.POST({ request: new Request("https://example.test/api/companies", { method: "POST", body: JSON.stringify({ name: "Empresa B", plan_id: a, admin: { name: "Administrador", email: "admin@example.test", password: "isolated-password" } }) }) });
for (const deniedRole of ["TI", "ADMIN_GERAL", "ADMIN_EMPRESA", "GERENTE", "ATENDENTE"]) {
  role = deniedRole;
  assert.equal(platform.canCreateCompany(role), false);
  assert.equal((await createCompany()).status, 403);
  assert.equal(transactionWrites, 0);
}
role = "SUPER_ADMIN";
assert.equal(platform.canCreateCompany(role), true);
assert.equal((await createCompany()).status, 201);
assert.equal(transactionWrites, 3);
role = "ADMIN_EMPRESA";
assert.equal((await createCompany()).status, 403);
assert.equal(transactionWrites, 3);

// The browser reloads only after the server accepts a company change.
let authValue;
const authProvider = load("src/lib/auth.tsx", {
  "./company-context": context,
  "./auth-user": auth,
  "./audit-log": { pushAudit: () => {} },
  "./access-hours": load("src/lib/access-hours.ts"),
  sonner: { toast: { error: () => {} } },
});
function AuthProbe() { authValue = authProvider.useAuth(); return null; }
renderToStaticMarkup(React.createElement(authProvider.AuthProvider, null, React.createElement(AuthProbe)));
const previousFetch = globalThis.fetch;
const previousWindow = globalThis.window;
let reloads = 0;
globalThis.window = { location: { reload: () => reloads++ } };
let resolveFetch;
globalThis.fetch = (_url, options) => {
  assert.equal(options.cache, "no-store");
  return new Promise((resolve) => { resolveFetch = resolve; });
};
const pendingSwitch = authValue.setOperationalCompany(b);
assert.equal(reloads, 0);
await assert.rejects(authValue.setOperationalCompany(a), /andamento/);
resolveFetch(new Response(null, { status: 403 }));
await assert.rejects(pendingSwitch, /403/);
assert.equal(reloads, 0);
globalThis.fetch = async () => new Response(null, { status: 200 });
await authValue.setOperationalCompany(b);
assert.equal(reloads, 1);
globalThis.fetch = previousFetch;
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;
if (previousSecret === undefined) delete process.env.SESSION_SECRET;
else process.env.SESSION_SECRET = previousSecret;
console.log(
  "TI: context, signed cookies, inactive records, company creation, scoped password reset and browser reload passed. No real database accessed.",
);
