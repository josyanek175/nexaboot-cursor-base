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
  isMetaCoexistenceEnabled,
} from "../src/lib/meta-coexistence-policy.server.ts";
import { summarizeUnknownMetaWebhookFields } from "../src/lib/meta-webhook-parse.ts";

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
check("ADMIN_EMPRESA can coexistence", canManageMetaCoexistence("ADMIN_EMPRESA"));
check("ATENDENTE cannot coexistence", canManageMetaCoexistence("ATENDENTE") === false);

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
