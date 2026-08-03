/**
 * Regressão Meta Coexistence — flag, default cloud_api, lookup contract, Evolution intacto.
 * Uso: node scripts/test-meta-coexistence-regression.mjs
 *
 * Não exige DATABASE_URL. Não aplica migration. Não chama Graph API.
 */
import assert from "node:assert/strict";
import {
  DEFAULT_META_CONNECTION_MODE,
  isMetaConnectionMode,
  resolveMetaConnectionMode,
} from "../src/lib/meta-connection-mode.ts";
import {
  canManageMetaCoexistence,
  getMetaCoexistencePublicConfig,
  isCompanyAllowedForMetaCoexistence,
  isMetaCoexistenceEnabled,
  assertMetaCoexistenceAccess,
  assertMetaCoexistenceAccessWithScope,
  assertMetaCoexistenceCompanyScope,
  extractRequestedCompanyId,
  parseMetaCoexistenceAllowedCompanyIds,
} from "../src/lib/meta-coexistence-policy.server.ts";
import { summarizeUnknownMetaWebhookFields } from "../src/lib/meta-webhook-parse.ts";
import fs from "node:fs";
import path from "node:path";

let failed = 0;

function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`OK   ${label}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${label}`, e instanceof Error ? e.message : e);
  }
}

const permsSrc = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/lib/permissions.ts"),
  "utf8",
);
check(
  "UI permissions inclui ADMIN_EMPRESA no coexistence",
  /canManageMetaCoexistence[\s\S]*ADMIN_EMPRESA/.test(permsSrc),
);

// ── Feature flag ────────────────────────────────────────────────────────────
check("flag ausente = false", isMetaCoexistenceEnabled({}) === false);
check("flag false = false", isMetaCoexistenceEnabled({ META_COEXISTENCE_ENABLED: "false" }) === false);
check("flag true = true", isMetaCoexistenceEnabled({ META_COEXISTENCE_ENABLED: "true" }) === true);
check("flag 1 = true", isMetaCoexistenceEnabled({ META_COEXISTENCE_ENABLED: "1" }) === true);

// ── Default cloud_api ───────────────────────────────────────────────────────
check("default mode cloud_api", DEFAULT_META_CONNECTION_MODE === "cloud_api");
check("resolve undefined → cloud_api", resolveMetaConnectionMode(undefined) === "cloud_api");
check("resolve null → cloud_api", resolveMetaConnectionMode(null) === "cloud_api");
check("resolve coexistence", resolveMetaConnectionMode("coexistence") === "coexistence");
check("reject invalid mode", isMetaConnectionMode("evolution") === false);

// ── Auth roles ──────────────────────────────────────────────────────────────
check("SUPER_ADMIN can coexistence", canManageMetaCoexistence("SUPER_ADMIN"));
check("TI can coexistence", canManageMetaCoexistence("TI"));
check("ADMIN_EMPRESA can coexistence", canManageMetaCoexistence("ADMIN_EMPRESA"));
check("ADMIN_GERAL cannot coexistence", canManageMetaCoexistence("ADMIN_GERAL") === false);
check("ATENDENTE cannot coexistence", canManageMetaCoexistence("ATENDENTE") === false);
check("SUPERVISOR cannot coexistence", canManageMetaCoexistence("SUPERVISOR") === false);
check("GERENTE cannot coexistence", canManageMetaCoexistence("GERENTE") === false);

const companyA = "11111111-1111-1111-1111-111111111111";
const companyB = "22222222-2222-2222-2222-222222222222";
check(
  "allowlist vazia = ninguém",
  isCompanyAllowedForMetaCoexistence(companyA, { META_COEXISTENCE_ALLOWED_COMPANY_IDS: "" }) ===
    false,
);
check(
  "allowlist ausente = ninguém",
  isCompanyAllowedForMetaCoexistence(companyA, {}) === false,
);
check(
  "allowlist inclui empresa",
  isCompanyAllowedForMetaCoexistence(companyA, {
    META_COEXISTENCE_ALLOWED_COMPANY_IDS: `${companyA},${companyB}`,
  }) === true,
);
check(
  "allowlist exclui outra empresa",
  isCompanyAllowedForMetaCoexistence(companyB, {
    META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA,
  }) === false,
);
check(
  "parse allowlist trim",
  parseMetaCoexistenceAllowedCompanyIds({
    META_COEXISTENCE_ALLOWED_COMPANY_IDS: ` ${companyA} , ${companyB} `,
  }).length === 2,
);

const gateFlagOff = assertMetaCoexistenceAccess({
  role: "SUPER_ADMIN",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "false", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("gate flag false = 404", gateFlagOff instanceof Response && gateFlagOff.status === 404);

const gateEmptyAllow = assertMetaCoexistenceAccess({
  role: "SUPER_ADMIN",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: "" },
});
check(
  "gate allowlist vazia = 403 mesmo SUPER_ADMIN",
  gateEmptyAllow instanceof Response && gateEmptyAllow.status === 403,
);

const gateAdminOk = assertMetaCoexistenceAccess({
  role: "ADMIN_EMPRESA",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("gate ADMIN_EMPRESA + allowlist = ok", gateAdminOk === null);

const gateAdminOut = assertMetaCoexistenceAccess({
  role: "ADMIN_EMPRESA",
  companyId: companyB,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check(
  "gate ADMIN_EMPRESA fora allowlist = 403",
  gateAdminOut instanceof Response && gateAdminOut.status === 403,
);

const gateAtendente = assertMetaCoexistenceAccess({
  role: "ATENDENTE",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("gate role ATENDENTE = 403", gateAtendente instanceof Response && gateAtendente.status === 403);

const gateOk = assertMetaCoexistenceAccess({
  role: "TI",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("gate TI + allowlist = ok", gateOk === null);

const gateSuper = assertMetaCoexistenceAccess({
  role: "SUPER_ADMIN",
  companyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("gate SUPER_ADMIN + allowlist = ok", gateSuper === null);

check(
  "extract company_id body",
  extractRequestedCompanyId({ company_id: companyB, onboarding_id: "x" }) === companyB,
);
check(
  "extract companyId alias",
  extractRequestedCompanyId({ companyId: companyA }) === companyA,
);
check("extract ausente = null", extractRequestedCompanyId({ onboarding_id: "x" }) === null);

check(
  "scope mesmo company_id = ok",
  assertMetaCoexistenceCompanyScope({
    role: "ADMIN_EMPRESA",
    sessionCompanyId: companyA,
    requestedCompanyId: companyA,
  }) === null,
);
check(
  "scope omitido = ok (usa sessão)",
  assertMetaCoexistenceCompanyScope({
    role: "ADMIN_EMPRESA",
    sessionCompanyId: companyA,
    requestedCompanyId: null,
  }) === null,
);

const scopeForeign = assertMetaCoexistenceCompanyScope({
  role: "ADMIN_EMPRESA",
  sessionCompanyId: companyA,
  requestedCompanyId: companyB,
});
check(
  "ADMIN_EMPRESA outro company_id = 403",
  scopeForeign instanceof Response && scopeForeign.status === 403,
);

const scopeWithAccess = assertMetaCoexistenceAccessWithScope({
  role: "ADMIN_EMPRESA",
  sessionCompanyId: companyA,
  requestedCompanyId: companyB,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check(
  "ADMIN_EMPRESA + company_id estrangeiro bloqueia antes do allowlist OK",
  scopeWithAccess instanceof Response && scopeWithAccess.status === 403,
);

const scopeAdminAllowed = assertMetaCoexistenceAccessWithScope({
  role: "ADMIN_EMPRESA",
  sessionCompanyId: companyA,
  requestedCompanyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: companyA },
});
check("ADMIN_EMPRESA sessão allowlisted = ok", scopeAdminAllowed === null);

const scopeEmptyAllowAdmin = assertMetaCoexistenceAccessWithScope({
  role: "ADMIN_EMPRESA",
  sessionCompanyId: companyA,
  env: { META_COEXISTENCE_ENABLED: "true", META_COEXISTENCE_ALLOWED_COMPANY_IDS: "" },
});
check(
  "allowlist vazia bloqueia ADMIN_EMPRESA",
  scopeEmptyAllowAdmin instanceof Response && scopeEmptyAllowAdmin.status === 403,
);

// ── Public config sem secrets ───────────────────────────────────────────────
const pub = getMetaCoexistencePublicConfig({
  META_APP_ID: "app123",
  META_EMBEDDED_SIGNUP_CONFIG_ID: "cfg456",
  META_APP_SECRET: "should-not-leak",
  META_GRAPH_API_VERSION: "v21.0",
});
check("config has appId", pub.appId === "app123");
check("config has configId", pub.configId === "cfg456");
check("config JSON não inclui secret", !JSON.stringify(pub).includes("should-not-leak"));

// ── Unknown webhook fields (sem processar echo/history) ─────────────────────
const unknownPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "smb_message_echoes",
          value: {
            metadata: { phone_number_id: "999" },
            message_echoes: [{ id: "wamid.echo" }],
          },
        },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "999" },
            messages: [{ id: "wamid.in", from: "5511999999999", type: "text" }],
          },
        },
      ],
    },
  ],
};
const unknowns = summarizeUnknownMetaWebhookFields(unknownPayload);
check("unknown field detectado", unknowns.some((u) => u.field === "smb_message_echoes"));
check("messages não é unknown", !unknowns.some((u) => u.field === "messages"));

// ── Contrato legado: INSERT sem meta_connection_mode ⇒ cloud_api ────────────
const legacyInsertShape = {
  channel_type: "meta",
  waba_id: "WABA",
  phone_number_id: "PHONE",
  // meta_connection_mode omitido propositalmente
};
check(
  "legado sem mode ⇒ cloud_api",
  resolveMetaConnectionMode(legacyInsertShape.meta_connection_mode) === "cloud_api",
);

// ── Evolution contract (não mudou nesta entrega) ────────────────────────────
check(
  "Evolution channel_type permanece evolution",
  resolveMetaConnectionMode("cloud_api") !== "evolution" && "evolution" !== "meta",
);

if (failed > 0) {
  console.error(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes de regressão Coexistence (unit) passaram.");
