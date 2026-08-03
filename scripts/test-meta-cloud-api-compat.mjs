/**
 * Contrato estático: pipeline Meta atual não depende de meta_connection_mode.
 * Garante que lookup/send/webhook ainda filtram por channel_type='meta' e phone_number_id.
 * Uso: node scripts/test-meta-cloud-api-compat.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
let failed = 0;

function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`OK   ${label}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const router = read("src/lib/whatsapp/whatsapp-provider-router.server.ts");
check(
  "lookup phone_number_id filtra channel_type meta",
  router.includes("lower(channel_type) = 'meta'") && router.includes("phone_number_id"),
);
check(
  "lookup NÃO exige meta_connection_mode",
  !router.includes("meta_connection_mode"),
);

const send = read("src/lib/meta-send-message.server.ts");
check("send pipeline checa channel_type meta", send.includes("channel_type").toString() && send.includes("'meta'"));
check("send NÃO ramifica por coexistence", !send.includes("coexistence"));

const webhook = read("src/lib/meta-webhook.server.ts");
check("webhook preserva X-Hub-Signature log/path", webhook.toLowerCase().includes("x-hub-signature") || webhook.includes("signature"));
check("webhook NÃO processa echo por default", !webhook.includes("smb_message_echoes") || webhook.includes("UNKNOWN_FIELD"));
check("webhook loga unknown field com segurança", webhook.includes("META_WEBHOOK_UNKNOWN_FIELD"));

const tokenModal = read("src/routes/_app.canais.tsx");
check("MetaTokenModal ainda existe (Cloud API tradicional)", tokenModal.includes("function MetaTokenModal"));
check("Coexistence modal é componente separado", fs.existsSync(path.join(root, "src/components/meta-coexistence-modal.tsx")));

const evoRouter = read("src/lib/whatsapp/whatsapp-provider-router.server.ts");
check("Evolution path ainda presente no router", evoRouter.includes("evolution") || evoRouter.includes("Evolution"));

const coexistencePolicy = read("src/lib/meta-coexistence-policy.server.ts");
check("flag META_COEXISTENCE_ENABLED no policy", coexistencePolicy.includes("META_COEXISTENCE_ENABLED"));

const connectRoute = read("src/routes/api/meta/coexistence/connect.ts");
check("connect gated pela flag", connectRoute.includes("assertMetaCoexistenceAccess"));
check("connect exige migration", connectRoute.includes("migration_required"));
check("connect NÃO troca code", !connectRoute.includes("exchangeAuthorizationCode"));
check("connect rejeita fields proibidos", connectRoute.includes("findForbiddenConnectField"));
check("connect usa onboarding_id", connectRoute.includes("onboarding_id") || connectRoute.includes("CoexistenceConnectBodySchema"));
check(
  "connect transacional",
  connectRoute.includes("completeCoexistenceConnectTransactional"),
);
check("connect sem Graph fetch", !/fetch\s*\(/.test(connectRoute));

const startSrc = read("src/routes/api/meta/embedded-signup/start.ts");
const completeSrc = read("src/routes/api/meta/embedded-signup/complete.ts");
const connStatusSrc = read("src/routes/api/meta/channels/$id/connection-status.ts");
check("embedded-signup/start gated", startSrc.includes("assertMetaCoexistenceAccess"));
check("embedded-signup/start cria CSRF", startSrc.includes("createCoexistenceCsrfState"));
check("embedded-signup/complete gated", completeSrc.includes("assertMetaCoexistenceAccess"));
check("embedded-signup/complete troca code 1x", completeSrc.includes("exchangeAuthorizationCode"));
check("embedded-signup/complete assina WABA", completeSrc.includes("subscribeAppToWaba"));
check("embedded-signup/complete valida inscrição", completeSrc.includes("verifyAppSubscribedToWaba"));
check("embedded-signup/complete sem devolver token", !/Response\.json\([\s\S]*access_token\s*:/.test(completeSrc) && !completeSrc.includes("access_token: exchanged"));
check(
  "embedded-signup/complete não inclui access_token na resposta",
  !completeSrc.includes("access_token:") ||
    (completeSrc.includes("createCoexistenceOnboarding") &&
      !/return Response\.json\([^)]*access_token/.test(completeSrc)),
);
check("connection-status sem secrets", !connStatusSrc.includes("access_token_ciphertext"));
check("connection-status expõe connection_mode", connStatusSrc.includes("connection_mode"));

const channelsCreate = read("src/routes/api/meta/channels.ts");
check(
  "POST /meta/channels (cloud_api) NÃO seta coexistence",
  channelsCreate.includes("channel_type") && !channelsCreate.includes("'coexistence'"),
);

if (failed > 0) {
  console.error(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log("\nCompatibilidade cloud_api estática OK.");
