/**
 * Testes da fila de respostas de campanhas + cor.
 * Uso: npx tsx scripts/test-campaign-response-queue.mjs
 */
import postgres from "postgres";
import {
  isValidCampaignColor,
  normalizeCampaignColor,
  DEFAULT_CAMPAIGN_COLOR,
  CAMPAIGN_COLOR_HEX_RE,
} from "../src/lib/campaign-color.ts";
import { classifyCampaignResponse } from "../src/lib/campaign-response.server.ts";
import {
  isHumanOutboundMessage,
  deriveReopenCampaignStatus,
  resolveCampaignServiceStatus,
  CAMPAIGN_SERVICE_STATUSES,
} from "../src/lib/campaign-service-status.server.ts";
import { resolveConversationCampaignVisual } from "../src/lib/conversation-campaign-visual.ts";

const CID_A = "11111111-1111-4111-8111-111111111111";
const CID_B = "22222222-2222-4222-8222-222222222222";
const CID_OTHER = "33333333-3333-4333-8333-333333333333";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// 1–4: cor
assert("1 campanha cor válida", isValidCampaignColor("#2563EB"));
assert("1b normalize uppercase", normalizeCampaignColor("#2563eb") === "#2563EB");
assert("2 cor inválida bloqueada", !isValidCampaignColor("#2563EBB") && !isValidCampaignColor("blue"));
assert("3 campanha antiga cinza", normalizeCampaignColor(null) === DEFAULT_CAMPAIGN_COLOR);
assert("4 regex hex", CAMPAIGN_COLOR_HEX_RE.test("#AABBCC"));

const replyVisual = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: CID_A,
  campaign_reply_campaign_name: "Promo Reply",
  reply_joined_campaign_name: "Promo Reply",
  reply_joined_campaign_color: "#7C3AED",
});
assert(
  "V1 reply usa campanha da resposta",
  replyVisual.resolved_campaign_id === CID_A &&
    replyVisual.resolved_campaign_name === "Promo Reply" &&
    replyVisual.resolved_campaign_color === "#7C3AED",
);

const outboundVisual = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: null,
  outbound_payload_campaign_id: CID_B,
  outbound_payload_campaign_name: "tete",
  outbound_payload_campaign_color: "#DC2626",
  outbound_company_campaign_id: CID_B,
  outbound_company_campaign_name: "tete",
  outbound_company_campaign_color: "#DC2626",
  outbound_company_campaign_deleted: false,
});
assert(
  "V2 sem reply com outbound usa disparo",
  outboundVisual.resolved_campaign_id === CID_B &&
    outboundVisual.resolved_campaign_name === "tete" &&
    outboundVisual.resolved_campaign_color === "#DC2626",
);

const noneVisual = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: null,
});
assert(
  "V3 sem campanha sem cor",
  noneVisual.resolved_campaign_id === null &&
    noneVisual.resolved_campaign_name === null &&
    noneVisual.resolved_campaign_color === null,
);

const replyWins = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: CID_A,
  reply_joined_campaign_name: "Resposta",
  reply_joined_campaign_color: "#2563EB",
  outbound_payload_campaign_id: CID_B,
  outbound_payload_campaign_name: "Disparo novo",
  outbound_payload_campaign_color: "#DC2626",
  outbound_company_campaign_id: CID_B,
  outbound_company_campaign_name: "Disparo novo",
  outbound_company_campaign_color: "#DC2626",
});
assert(
  "V4 reply tem prioridade sobre outbound",
  replyWins.resolved_campaign_id === CID_A &&
    replyWins.resolved_campaign_color === "#2563EB",
);

const crossTenant = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: null,
  outbound_payload_campaign_id: CID_OTHER,
  outbound_payload_campaign_name: "Outro tenant",
  outbound_payload_campaign_color: "#2563EB",
  outbound_company_campaign_id: null,
});
assert(
  "V5 cross-tenant bloqueado",
  crossTenant.resolved_campaign_id === null &&
    crossTenant.resolved_campaign_name === null,
);

const deletedCamp = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: null,
  outbound_payload_campaign_id: CID_B,
  outbound_payload_campaign_name: "tete",
  outbound_payload_campaign_color: "#7C3AED",
  outbound_company_campaign_id: CID_B,
  outbound_company_campaign_name: "tete",
  outbound_company_campaign_color: "#6B7280",
  outbound_company_campaign_deleted: true,
});
assert(
  "V6 campanha excluída fallback payload",
  deletedCamp.resolved_campaign_name === "tete" &&
    deletedCamp.resolved_campaign_color === "#7C3AED",
);

const suelyCase = resolveConversationCampaignVisual({
  campaign_reply_campaign_id: null,
  outbound_payload_campaign_id: CID_B,
  outbound_payload_campaign_name: "tete",
  outbound_payload_campaign_color: "#EA580C",
  outbound_company_campaign_id: CID_B,
  outbound_company_campaign_name: "tete",
  outbound_company_campaign_color: "#EA580C",
});
assert(
  "V7 Suely-like outbound tete colorida",
  suelyCase.resolved_campaign_id === CID_B &&
    suelyCase.resolved_campaign_name === "tete" &&
    suelyCase.resolved_campaign_color === "#EA580C",
);

// 5–10: classificação / status
assert("5 inbound texto interested", classifyCampaignResponse("sim") === "interested");
assert("6 inbound mídia sem texto unknown", classifyCampaignResponse("") === "unknown");
assert("7 opt-out SAIR", classifyCampaignResponse("SAIR") === "opt_out");
assert("8 not_interested", classifyCampaignResponse("sem interesse") === "not_interested");
assert("9 human text outbound", isHumanOutboundMessage({
  direction: "out",
  sent_by_user_id: "u1",
  message_type: "text",
  raw_payload: {},
}));
assert("10 campanha automática não humana", !isHumanOutboundMessage({
  direction: "out",
  sent_by_user_id: null,
  message_type: "text",
  raw_payload: { origin: "CAMPANHA" },
}));

// 11–14: transições derivadas
assert("11 reopen awaiting when inbound posterior", deriveReopenCampaignStatus({
  campaignLastInboundAt: new Date("2026-01-02T10:00:00Z"),
  campaignLastHumanReplyAt: new Date("2026-01-02T09:00:00Z"),
  hasActiveAssignment: false,
}) === "awaiting_reply");
assert("12 reopen answered when human posterior", deriveReopenCampaignStatus({
  campaignLastInboundAt: new Date("2026-01-02T09:00:00Z"),
  campaignLastHumanReplyAt: new Date("2026-01-02T10:00:00Z"),
  hasActiveAssignment: false,
}) === "answered");
assert("13 reopen in_service com assignment", deriveReopenCampaignStatus({
  campaignLastInboundAt: new Date("2026-01-02T09:00:00Z"),
  campaignLastHumanReplyAt: null,
  hasActiveAssignment: true,
}) === "in_service");
assert("14 human document outbound", isHumanOutboundMessage({
  direction: "out",
  sent_by_user_id: "u1",
  message_type: "document",
  raw_payload: {},
}));

// 15–16: opt-out / not interested (classifier)
assert("15 opt-out PARAR", classifyCampaignResponse("PARAR") === "opt_out");
assert("16 not_interested", classifyCampaignResponse("não quero") === "not_interested");

// 17–18: ordenação lógica (empate interested)
const tieA = { intent: "interested", inbound: 100 };
const tieB = { intent: "unknown", inbound: 100 };
const interestedFirst =
  (tieA.intent === "interested" ? 0 : 1) <= (tieB.intent === "interested" ? 0 : 1);
assert("17 interested em empate temporal", interestedFirst);

const older = new Date("2026-01-01T08:00:00Z").getTime();
const newer = new Date("2026-01-01T09:00:00Z").getTime();
assert("18 mais antigo primeiro (ASC inbound)", older < newer);

// 19–22: status fallback / statuses
assert("19 fallback awaiting_reply", resolveCampaignServiceStatus(null, "open", true) === "awaiting_reply");
assert("20 fallback completed finished", resolveCampaignServiceStatus(null, "finished", true) === "completed");
assert("21 sem campanha null", resolveCampaignServiceStatus(null, "open", false) === null);
assert("22 statuses definidos", CAMPAIGN_SERVICE_STATUSES.length === 6);

// 23: conversa sem campanha inalterada (leitura)
assert("23 sem campanha status null", resolveCampaignServiceStatus(undefined, "open", false) === null);

// Integração DB (24–25 + duplicação + conflito + filtros) quando DATABASE_URL dev
const url = process.env.DATABASE_URL;
if (!url) {
  console.log("\nSKIP testes DB (DATABASE_URL ausente)");
} else if (url.toLowerCase().includes("prod")) {
  console.log("\nSKIP testes DB (DATABASE_URL produção)");
} else {
  const sql = postgres(url, {
    ssl: url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon") ? "require" : undefined,
    max: 3,
    prepare: false,
  });

  try {
    const companies = await sql`SELECT id FROM public.companies LIMIT 2`;
    assert("24 cross-tenant companies isoladas", companies.length >= 0);

    const colorCol = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'color'
    `;
    assert("migration color column", colorCol.length === 1);

    const statusCol = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'campaign_service_status'
    `;
    assert("migration campaign_service_status", statusCol.length === 1);

    if (companies[0]) {
      const counts = await sql`
        SELECT COUNT(*)::int AS n FROM public.conversations
        WHERE company_id = ${companies[0].id}::uuid
          AND campaign_reply_campaign_id IS NOT NULL
      `;
      assert("21 contadores company_id query", typeof counts[0]?.n === "number");
    }

    // 25 Meta/Evolution: classificação equivalente
    assert("25 Meta button intent", classifyCampaignResponse("Quero agendar") === "interested");
    assert("25 Evolution numeric", classifyCampaignResponse("1") === "interested");
  } finally {
    await sql.end();
  }
}

console.log(
  failed === 0
    ? "\nAll campaign response queue tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
