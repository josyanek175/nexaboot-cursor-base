/**
 * FASE 2 — validações estáticas (paginação, raw_payload, polling, fingerprint).
 * Sem DB / sem secrets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function testConversationsLimit() {
  const q = read("src/lib/conversations-query.server.ts");
  assert.ok(/opts\.limit \?\? 100/.test(q) || /Math\.min\(Math\.max\(1, opts\.limit \?\? 100\), 100\)/.test(q));
  const api = read("src/routes/api/conversations.ts");
  assert.ok(api.includes("MAX_LIMIT = 100"));
  assert.ok(api.includes("DEFAULT_LIMIT = 100"));
  assert.ok(api.includes("parseLimit"));
  // COUNT não vem automático com campaign_queue
  assert.equal(
    /campaignQueue[\s\S]*includeCounts[\s\S]*getCampaignQueueCounts/.test(
      api.replace(/\s+/g, " "),
    ) && api.includes('include_counts") === "true"'),
    true,
  );
  assert.ok(api.includes('include_counts") === "true"') || api.includes("include_counts') === 'true'"));
  console.log("[TEST] conversations limit max 100 + counts opt-in: OK");
}

function testMessagesPaginationNoRawPayload() {
  const src = read("src/routes/api/conversations/$id/messages.ts");
  assert.ok(src.includes("MAX_LIMIT = 100"));
  assert.ok(src.includes("LIMIT ${limit}"));
  assert.ok(src.includes("ORDER BY m.created_at DESC"));
  assert.equal(/m\.raw_payload\s*,/.test(src), false, "must not select m.raw_payload column");
  assert.ok(src.includes("has_raw_payload"));
  assert.ok(src.includes("before"));

  const alt = read("src/routes/api/messages.ts");
  assert.ok(alt.includes("MAX_LIMIT = 100"));
  assert.equal(/m\.raw_payload\s*,/.test(alt), false);
  assert.ok(alt.includes("has_raw_payload"));
  console.log("[TEST] messages pagination + no raw_payload: OK");
}

function testPollingAndFingerprint() {
  const ui = read("src/routes/_app.atendimento.tsx");
  assert.ok(ui.includes("10_000") || ui.includes("10000"));
  assert.ok(ui.includes("5_000") || /setInterval\(\(\) => reloadMessages\([^)]+\), 5_000\)/.test(ui));
  assert.ok(ui.includes("convsFingerprintRef"));
  assert.ok(ui.includes("msgsFingerprintRef"));
  assert.ok(ui.includes('params.set("limit", "100")'));
  assert.ok(ui.includes("messages?limit=100"));
  // include_counts só no load não-silencioso
  assert.ok(ui.includes("if (!opts?.silent) params.set(\"include_counts\", \"true\")"));
  // intervals: conversas 10s, mensagens 5s — não 3000/5000 antigos para esses polls
  assert.equal(/setInterval\(\(\) => reloadConversations\(\{ silent: true \}\), 5000\)/.test(ui), false);
  assert.equal(/setInterval\(\(\) => reloadMessages\([^)]+\), 3000\)/.test(ui), false);
  console.log("[TEST] polling 10s/5s + fingerprint + skip counts on silent: OK");
}

function testMetaEvolutionMediaStillSupported() {
  // UI ainda transforma mensagens Meta/Evolution/mídia sem exigir raw_payload obrigatório
  const ui = read("src/routes/_app.atendimento.tsx");
  assert.ok(ui.includes("transformApiMessage"));
  assert.ok(ui.includes("media_type") || ui.includes("mediaType") || ui.includes("media_url"));
  assert.ok(ui.includes("parseMessageRawPayload"));
  // raw_payload opcional — parse deve tolerar ausência
  assert.ok(ui.includes("m.raw_payload ?? m.rawPayload"));
  // envio mídia / evolution paths ainda referenciados
  assert.ok(ui.includes("/messages/send-media") || ui.includes("send-media"));
  assert.ok(ui.includes("send/media/evolution") || ui.includes("evolution"));
  console.log("[TEST] Meta/Evolution/media paths still present: OK");
}

function testCampaignAndPollingNewMessages() {
  const ui = read("src/routes/_app.atendimento.tsx");
  // Detecção de novas mensagens no polling preservada
  assert.ok(ui.includes("newlyActive"));
  assert.ok(ui.includes("lastMessageAt"));
  assert.ok(ui.includes("playNotificationSound"));
  // campanha: include_counts no load visível
  assert.ok(ui.includes("campaign_queue"));
  console.log("[TEST] new-message detection + campaign queue: OK");
}

function testNoSecretsInScripts() {
  for (const rel of [
    "scripts/explain-conversations-queries.mjs",
    "scripts/load-test-45-attendance.mjs",
    "docs/fase2-index-proposal.md",
  ]) {
    const src = read(rel);
    assert.equal(/postgres:\/\/[^:]+:[^@]+@/.test(src), false, rel);
  }
  console.log("[TEST] no embedded secrets in fase2 scripts/docs: OK");
}

function testIndexNotAppliedInCode() {
  // Nenhum CREATE INDEX do índice proposto no código de runtime
  for (const rel of [
    "src/lib/conversations-query.server.ts",
    "src/routes/api/conversations.ts",
    "src/lib/pg.server.ts",
  ]) {
    const src = read(rel);
    assert.equal(
      src.includes("idx_conversations_company_last_message"),
      false,
      `${rel} must not create proposed index`,
    );
  }
  const proposal = read("docs/fase2-index-proposal.md");
  assert.ok(proposal.includes("NÃO aplicado") || proposal.includes("NOT APPLIED") || proposal.includes("Não aplicado") || /NÃO aplicado|não aplicado/i.test(proposal));
  console.log("[TEST] proposed index not applied in runtime: OK");
}

async function main() {
  testConversationsLimit();
  testMessagesPaginationNoRawPayload();
  testPollingAndFingerprint();
  testMetaEvolutionMediaStillSupported();
  testCampaignAndPollingNewMessages();
  testNoSecretsInScripts();
  testIndexNotAppliedInCode();
  console.log("[TEST] fase2 attendance checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
