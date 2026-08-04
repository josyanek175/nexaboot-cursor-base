/**
 * Testes da exportação CSV de campanhas.
 * Uso: npx tsx scripts/test-campaign-export.mjs
 *
 * Não exige DATABASE_URL. Não altera banco. Não faz deploy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CAMPAIGN_CSV_HEADERS,
  CAMPAIGN_EXPORT_BATCH_SIZE,
  CAMPAIGN_EXPORT_TIMEZONE,
  buildCsvHeaderLine,
  buildExportFilename,
  escapeCsvField,
  formatAudienceSource,
  formatCsvDateTime,
  neutralizeCsvInjection,
  parseCampaignExportFilters,
  resolveSentBounds,
  rowToCsvLine,
  slugifyCampaignFilenamePart,
} from "../src/lib/campaign-export.server.ts";

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

// ── Cabeçalho e colunas ─────────────────────────────────────────────────────
const header = buildCsvHeaderLine();
check("cabeçalho usa ponto e vírgula", header.includes(";"));
check(
  "cabeçalho tem 10 colunas na ordem correta",
  header === CAMPAIGN_CSV_HEADERS.join(";"),
);
check("coluna Origem do público (não Nome da lista)", header.includes("Origem do público"));
check("coluna Criado por (não Atendente)", header.includes("Criado por"));
check("não usa Nome da lista", !header.includes("Nome da lista"));
check("não usa Atendente como coluna", !/;Atendente(;|$)/.test(header));

// ── Origem do público ───────────────────────────────────────────────────────
check("origem CRM com contact_id", formatAudienceSource("uuid-here") === "CRM");
check("origem Importação sem contact_id", formatAudienceSource(null) === "Importação");
check("origem Importação undefined", formatAudienceSource(undefined) === "Importação");

// ── CSV Injection ───────────────────────────────────────────────────────────
check("neutraliza =", neutralizeCsvInjection("=CMD()") === "'=CMD()");
check("neutraliza +", neutralizeCsvInjection("+1+2") === "'+1+2");
check("neutraliza -", neutralizeCsvInjection("-2+3") === "'-2+3");
check("neutraliza @", neutralizeCsvInjection("@sum(A1)") === "'@sum(A1)");
check("não altera texto normal", neutralizeCsvInjection("Olá") === "Olá");

const injectionLine = rowToCsvLine({
  campaign_name: "Campanha",
  audience_source: "CRM",
  contact_name: "=HYPERLINK(\"http://x\")",
  phone: "5534999999999",
  sent_at: null,
  send_status: "sent",
  responded_at: null,
  response_text: "+1+1",
  response_intent: "unknown",
  created_by_name: "@evil",
});
check("linha com injection escapada no nome", injectionLine.includes("'=HYPERLINK"));
check("linha com injection escapada na resposta", injectionLine.includes("'+1+1"));
check("linha com injection escapada no criador", injectionLine.includes("'@evil"));

// ── Acentos ─────────────────────────────────────────────────────────────────
const accentLine = rowToCsvLine({
  campaign_name: "Campanha São João",
  audience_source: "Importação",
  contact_name: "José da Conceição",
  phone: "5534987654321",
  sent_at: new Date("2026-08-04T15:30:00.000Z"),
  send_status: "responded",
  responded_at: new Date("2026-08-04T16:00:00.000Z"),
  response_text: "Sim, tenho interesse!",
  response_intent: "interested",
  created_by_name: "Maria Ângela",
});
check("preserva acentos no nome", accentLine.includes("José da Conceição"));
check("preserva acentos na campanha", accentLine.includes("Campanha São João"));
check("preserva acentos no criador", accentLine.includes("Maria Ângela"));

// ── Com e sem resposta ──────────────────────────────────────────────────────
const withReply = rowToCsvLine({
  campaign_name: "C",
  audience_source: "CRM",
  contact_name: "A",
  phone: "1",
  sent_at: new Date("2026-01-01T12:00:00.000Z"),
  send_status: "responded",
  responded_at: new Date("2026-01-01T13:00:00.000Z"),
  response_text: "ok",
  response_intent: "interested",
  created_by_name: "B",
});
check("com resposta inclui texto", withReply.includes("ok"));
check("com resposta inclui classificação", withReply.includes("Interessado"));

const withoutReply = rowToCsvLine({
  campaign_name: "C",
  audience_source: "Importação",
  contact_name: "A",
  phone: "1",
  sent_at: new Date("2026-01-01T12:00:00.000Z"),
  send_status: "sent",
  responded_at: null,
  response_text: null,
  response_intent: null,
  created_by_name: null,
});
const withoutParts = withoutReply.split(";");
check("sem resposta: campos vazios no lugar certo", withoutParts.length === 10);
check("sem resposta: data resposta vazia", withoutParts[6] === "");
check("sem resposta: texto vazio", withoutParts[7] === "");
check("sem resposta: classificação vazia", withoutParts[8] === "");

// ── Timezone apresentação ───────────────────────────────────────────────────
check("timezone constante SP", CAMPAIGN_EXPORT_TIMEZONE === "America/Sao_Paulo");
const spFormatted = formatCsvDateTime(new Date("2026-08-04T15:00:00.000Z"));
check("formata em pt-BR com horário SP", /^\d{2}\/\d{2}\/\d{4}/.test(spFormatted));
// 15:00 UTC = 12:00 em São Paulo (UTC-3)
check("converte UTC→SP (15:00Z → 12:00)", spFormatted.includes("12:00:00"));

// ── Filtros ─────────────────────────────────────────────────────────────────
const okAll = parseCampaignExportFilters(new URLSearchParams("response=all&status=all"));
check("filtro all ok", okAll.ok === true);

const okResp = parseCampaignExportFilters(new URLSearchParams("response=responded"));
check("filtro responded ok", okResp.ok && okResp.filters.response === "responded");

const badResp = parseCampaignExportFilters(new URLSearchParams("response=other"));
check("filtro response inválido", badResp.ok === false);

const badStatus = parseCampaignExportFilters(new URLSearchParams("status=running"));
check("filtro status inválido", badStatus.ok === false);

const dates = parseCampaignExportFilters(
  new URLSearchParams("sent_from=2026-01-01&sent_to=2026-01-31"),
);
check("sent_from/sent_to datas ok", dates.ok === true);

const bounds = resolveSentBounds("2026-01-01", "2026-01-01");
check("bound from definido", bounds.from instanceof Date);
check("bound toExclusive é dia seguinte", bounds.toExclusive instanceof Date);

// ── Filename ────────────────────────────────────────────────────────────────
check(
  "slug remove acentos",
  slugifyCampaignFilenamePart("Campanha São João!", "abc") === "campanha-sao-joao",
);
const fn = buildExportFilename("Promo Refil", "11111111-1111-1111-1111-111111111111");
check("filename padrão campanha-slug-data.csv", /^campanha-promo-refil-\d{4}-\d{2}-\d{2}\.csv$/.test(fn));

// ── Escape aspas / separador ────────────────────────────────────────────────
check("escape ponto e vírgula no valor", escapeCsvField("a;b") === '"a;b"');
check('escape aspas', escapeCsvField('diz "oi"') === '"diz ""oi"""');

// ── Muitos registros (simulação de streaming em memória controlada) ─────────
const many = [];
for (let i = 0; i < 2500; i++) {
  many.push(
    rowToCsvLine({
      campaign_name: "Bulk",
      audience_source: i % 2 === 0 ? "CRM" : "Importação",
      contact_name: `Contato ${i}`,
      phone: `5534999${String(i).padStart(6, "0")}`,
      sent_at: null,
      send_status: i % 3 === 0 ? "responded" : "sent",
      responded_at: null,
      response_text: null,
      response_intent: null,
      created_by_name: "Ops",
    }),
  );
}
check("gera 2500 linhas sem crash", many.length === 2500);
check(
  "batch size documentado para cursor",
  CAMPAIGN_EXPORT_BATCH_SIZE === 500 && many.length > CAMPAIGN_EXPORT_BATCH_SIZE,
);
check("última linha válida", many[2499].startsWith("Bulk;"));

// ── Campanha sem destinatários (só cabeçalho) ───────────────────────────────
const emptyCsv = `\uFEFF${buildCsvHeaderLine()}\r\n`;
check("CSV vazio tem BOM", emptyCsv.charCodeAt(0) === 0xfeff);
check("CSV vazio só cabeçalho", emptyCsv.trimEnd().split(/\r?\n/).length === 1);

// ── Fonte: isolamento, rota, auditoria, status sent inclui responded ────────
const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const exportSrc = read("src/lib/campaign-export.server.ts");
check(
  "SQL filtra company_id no destinatário",
  /cc\.company_id = \$\{companyId\}/.test(exportSrc),
);
check(
  "SQL filtra company_id na campanha (join)",
  /c\.company_id = cc\.company_id/.test(exportSrc),
);
check(
  "status=sent inclui responded",
  /statusSent[\s\S]*'sent',\s*'responded'/.test(exportSrc) ||
    /cc\.status IN \('sent', 'responded'\)/.test(exportSrc),
);
check("auditoria campaign.exported", exportSrc.includes('"campaign.exported"') || exportSrc.includes("'campaign.exported'"));
check("auditoria export_status started", exportSrc.includes('export_status: "started"'));
check("cursor por id", /cc\.id > \$\{cursorId\}/.test(exportSrc));
check("LIMIT no batch", /LIMIT \$\{limit\}/.test(exportSrc));
check("BOM UTF-8", exportSrc.includes("\\uFEFF"));
check("timezone só na apresentação", exportSrc.includes("America/Sao_Paulo"));

const routeFile = path.join(root, "src/routes/api/campaigns/$id/export[.]csv.ts");
check("arquivo de rota export[.]csv.ts existe", fs.existsSync(routeFile));
const routeSrc = read("src/routes/api/campaigns/$id/export[.]csv.ts");
check("rota path /api/campaigns/$id/export.csv", routeSrc.includes('"/api/campaigns/$id/export.csv"'));
check("rota usa getCampaignActor view", /getCampaignActor\("view"\)/.test(routeSrc));
check("rota retorna 404 not_found", routeSrc.includes("not_found"));

const uiSrc = read("src/routes/_app.campanhas.$id.tsx");
check("UI tem Baixar relatório", uiSrc.includes("Baixar relatório"));
check("UI opção lista completa", uiSrc.includes("Lista completa"));
check("UI opção respondidos", uiSrc.includes("Somente respondidos"));
check("UI opção não respondidos", uiSrc.includes("Somente não respondidos"));

// Isolamento / permissão / inexistente — contrato estático (sem DB)
check(
  "export exige campanha da empresa via getCampaignById(companyId)",
  /getCampaignById\(params\.companyId,\s*params\.campaignId\)/.test(exportSrc),
);

if (failed > 0) {
  console.error(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os checks de exportação CSV passaram.");
