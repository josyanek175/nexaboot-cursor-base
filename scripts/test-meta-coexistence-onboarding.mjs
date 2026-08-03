/**
 * Regressão: onboarding Coexistence — code 1x, connect sem code/token.
 * Uso: node scripts/test-meta-coexistence-onboarding.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_META_CONNECTION_MODE,
  resolveMetaConnectionMode,
} from "../src/lib/meta-connection-mode.ts";
import {
  isMetaCoexistenceEnabled,
  canManageMetaCoexistence,
} from "../src/lib/meta-coexistence-policy.server.ts";
import {
  COEXISTENCE_CONNECT_TX_STEPS,
  CoexistenceConnectBodySchema,
  assertSafeOnboardingDto,
  evaluateOnboardingAccess,
  findForbiddenConnectField,
  toSafeOnboardingDto,
} from "../src/lib/meta-coexistence-connect-body.ts";

const root = path.resolve(import.meta.dirname, "..");
let failed = 0;

function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`OK   ${label}`);
  } catch {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// Flag
check("flag false", isMetaCoexistenceEnabled({ META_COEXISTENCE_ENABLED: "false" }) === false);
check("flag true", isMetaCoexistenceEnabled({ META_COEXISTENCE_ENABLED: "true" }) === true);

// Connect rejeita code / access_token
check("forbidden code", findForbiddenConnectField({ onboarding_id: "x", code: "abc" }) === "code");
check(
  "forbidden access_token",
  findForbiddenConnectField({ onboarding_id: "x", access_token: "tok" }) === "access_token",
);
check(
  "forbidden authorization_code",
  findForbiddenConnectField({ authorization_code: "x" }) === "authorization_code",
);
check(
  "allowed onboarding only",
  findForbiddenConnectField({
    onboarding_id: "11111111-1111-1111-1111-111111111111",
  }) === null,
);

const badCode = CoexistenceConnectBodySchema.safeParse({
  onboarding_id: "11111111-1111-1111-1111-111111111111",
  code: "should-fail-strict",
});
check("zod strict rejeita code", badCode.success === false);

const good = CoexistenceConnectBodySchema.safeParse({
  onboarding_id: "11111111-1111-1111-1111-111111111111",
});
check("zod aceita só onboarding_id", good.success === true);

const badUuid = CoexistenceConnectBodySchema.safeParse({ onboarding_id: "not-a-uuid" });
check("onboarding_id inválido", badUuid.success === false);

// DTO seguro
const safeDto = toSafeOnboardingDto({
  id: "11111111-1111-1111-1111-111111111111",
  company_id: "c",
  user_id: "u",
  access_token_ciphertext: "CIPHER",
  token_expires_at: null,
  waba_id: "WABA",
  phone_number_id: "PHONE",
  business_id: null,
  display_phone_number: "+55 11 99999-9999",
  created_at: new Date(),
  expires_at: new Date(Date.now() + 600000),
  consumed_at: null,
  invalidated_at: null,
});
check("DTO tem onboarding_id", !!safeDto.onboarding_id);
check("DTO sem token", assertSafeOnboardingDto(safeDto));
check("DTO JSON sem ciphertext", !JSON.stringify(safeDto).includes("CIPHER"));
check("DTO JSON sem access_token", !JSON.stringify(safeDto).includes("access_token"));

const baseRow = {
  company_id: "co-1",
  user_id: "u-1",
  expires_at: new Date(Date.now() + 60_000),
  consumed_at: null,
  invalidated_at: null,
  access_token_ciphertext: "cipher",
};
check(
  "access ok mesmo user",
  evaluateOnboardingAccess({
    row: baseRow,
    companyId: "co-1",
    userId: "u-1",
    role: "ADMIN_EMPRESA",
  }) === "ok",
);
check(
  "company mismatch",
  evaluateOnboardingAccess({
    row: baseRow,
    companyId: "co-other",
    userId: "u-1",
    role: "ADMIN_EMPRESA",
  }) === "company_mismatch",
);
check(
  "user mismatch sem plataforma",
  evaluateOnboardingAccess({
    row: baseRow,
    companyId: "co-1",
    userId: "u-other",
    role: "ADMIN_EMPRESA",
  }) === "user_mismatch",
);
check(
  "plataforma pode confirmar onboarding de outro user (mesma empresa)",
  evaluateOnboardingAccess({
    row: baseRow,
    companyId: "co-1",
    userId: "u-other",
    role: "SUPER_ADMIN",
  }) === "ok",
);
check(
  "expirado",
  evaluateOnboardingAccess({
    row: { ...baseRow, expires_at: new Date(Date.now() - 1000) },
    companyId: "co-1",
    userId: "u-1",
    role: "ADMIN_EMPRESA",
  }) === "expired",
);
check(
  "já consumido",
  evaluateOnboardingAccess({
    row: { ...baseRow, consumed_at: new Date() },
    companyId: "co-1",
    userId: "u-1",
    role: "ADMIN_EMPRESA",
  }) === "consumed",
);

// Static: exchange troca code; connect não
const exchangeSrc = read("src/routes/api/meta/coexistence/exchange.ts");
const connectSrc = read("src/routes/api/meta/coexistence/connect.ts");
const graphSrc = read("src/lib/meta-coexistence-graph.server.ts");

check("exchange chama exchangeAuthorizationCode", exchangeSrc.includes("exchangeAuthorizationCode"));
check("exchange requer state CSRF", exchangeSrc.includes("consumeCoexistenceCsrfState"));
check("exchange cria onboarding", exchangeSrc.includes("createCoexistenceOnboarding"));
check(
  "exchange não persiste se Graph falha antes",
  exchangeSrc.includes("graph_assets_unavailable") || exchangeSrc.includes("ASSETS_FAIL"),
);

check("connect NÃO chama exchangeAuthorizationCode", !connectSrc.includes("exchangeAuthorizationCode"));
check(
  "connect NÃO usa claim precoce",
  !connectSrc.includes("claimCoexistenceOnboarding"),
);
check(
  "connect usa transação completa",
  connectSrc.includes("completeCoexistenceConnectTransactional"),
);
check("connect usa findForbiddenConnectField", connectSrc.includes("findForbiddenConnectField"));
check("connect importa CoexistenceConnectBodySchema", connectSrc.includes("CoexistenceConnectBodySchema"));
check("connect NÃO chama Graph/fetch", !/fetch\s*\(/.test(connectSrc));

const onboardingSrc = read("src/lib/meta-coexistence-onboarding.server.ts");
check("tx usa BEGIN", onboardingSrc.includes(".begin("));
check("tx usa FOR UPDATE no onboarding", onboardingSrc.includes("FOR UPDATE"));
check(
  "consumo é depois do vault",
  onboardingSrc.indexOf("whatsapp_channel_secrets") <
    onboardingSrc.indexOf("consumed_at = now()"),
);
check(
  "scrub ciphertext só no consume final",
  onboardingSrc.includes("access_token_ciphertext = NULL") &&
    onboardingSrc.includes("resulting_channel_id"),
);
check("vault sem Graph no connect tx", !onboardingSrc.includes("graph.facebook.com"));
check("idempotência via resulting_channel_id", onboardingSrc.includes("idempotent: true"));
check(
  "phone outra empresa rejeitado na tx",
  onboardingSrc.includes("phone_number_id_belongs_to_another_company"),
);
check(
  "TX steps: consume é o penúltimo antes de commit",
  COEXISTENCE_CONNECT_TX_STEPS[COEXISTENCE_CONNECT_TX_STEPS.length - 2] ===
    "mark_consumed_and_scrub" &&
    COEXISTENCE_CONNECT_TX_STEPS[COEXISTENCE_CONNECT_TX_STEPS.length - 1] === "commit",
);
check(
  "TX steps: vault antes do consume",
  COEXISTENCE_CONNECT_TX_STEPS.indexOf("persist_vault_ciphertext") <
    COEXISTENCE_CONNECT_TX_STEPS.indexOf("mark_consumed_and_scrub"),
);
check(
  "TX steps: FOR UPDATE primeiro útil",
  COEXISTENCE_CONNECT_TX_STEPS[1] === "select_onboarding_for_update",
);

check(
  "graph exchangeAuthorizationCode é a única troca",
  (graphSrc.match(/oauth\/access_token/g) || []).length === 1,
);

// Modal: Embedded Signup start/complete (sem token no browser)
const modal = read("src/components/meta-coexistence-modal.tsx");
check("modal usa embedded-signup/start", modal.includes("/meta/embedded-signup/start"));
check("modal usa embedded-signup/complete", modal.includes("/meta/embedded-signup/complete"));
check("modal estados oficiais", modal.includes("aguardando_confirmacao") && modal.includes("validando"));
check("modal sem localStorage de token", !modal.includes("localStorage"));
check("modal label coexistência", modal.includes("Conectar número existente em coexistência"));

// MetaTokenModal intacto
const canais = read("src/routes/_app.canais.tsx");
check("MetaTokenModal intacto", canais.includes("function MetaTokenModal"));
check(
  "MetaTokenModal ainda usa access_token patch",
  canais.includes("access_token: accessToken.trim()"),
);

// Evolution / cloud_api
check("default cloud_api", DEFAULT_META_CONNECTION_MODE === "cloud_api");
check("legado → cloud_api", resolveMetaConnectionMode(undefined) === "cloud_api");
const evo = read("src/lib/whatsapp/whatsapp-provider-router.server.ts");
check("Evolution path intacto", evo.includes("evolutionProvider"));
check("lookup sem meta_connection_mode", !evo.includes("meta_connection_mode"));

// Roles
check("ATENDENTE blocked", canManageMetaCoexistence("ATENDENTE") === false);
check("ADMIN_EMPRESA ok", canManageMetaCoexistence("ADMIN_EMPRESA") === true);
check("TI ok", canManageMetaCoexistence("TI") === true);
check("SUPER_ADMIN ok", canManageMetaCoexistence("SUPER_ADMIN") === true);

// Logs: endpoints não logam code/token variáveis
check(
  "exchange não loga parsed.data.code",
  !exchangeSrc.includes("parsed.data.code") ||
    !/console\.(log|error|warn).*code/.test(exchangeSrc),
);
check(
  "connect não loga accessToken",
  !/console\.(log|error|warn)[\s\S]{0,80}accessToken/.test(connectSrc),
);

if (failed > 0) {
  console.error(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log("\nOnboarding Coexistence tests OK.");
