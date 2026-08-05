/**
 * Testes do relatório/auditoria de conversas.
 * Uso: npx tsx scripts/test-conversation-reports.mjs
 *
 * Não exige DATABASE_URL. Não altera banco. Não faz deploy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canViewConversationReports,
  canAccessConversationReportsModule,
  canViewReports,
} from "../src/lib/permissions.ts";
import {
  escapeCsvField,
  joinCsvRow,
  formatCsvDateTime,
  CSV_EXPORT_TIMEZONE,
} from "../src/lib/csv-safe.ts";
import {
  CONVERSATION_REPORT_CSV_HEADERS,
  CONVERSATION_REPORT_CSV_BATCH,
  CONVERSATION_REPORT_MAX_RANGE_DAYS,
  CONVERSATION_REPORT_DEFAULT_DAYS,
  CONVERSATION_REPORT_PAGE_LIMIT,
  buildMessageDisplay,
  formatReportMediaLabel,
  resolveDisplayedAttendantName,
  mapMessageOrigin,
  mapAttendanceStatusLabel,
  validateReportDateRange,
  defaultReportDateRange,
  parseConversationReportFilters,
  parseReportCursor,
  buildConversationReportFilename,
  buildConversationReportCsvHeader,
  conversationReportRowToCsvLine,
  resolveReportDateBounds,
} from "../src/lib/conversation-reports.server.ts";

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

function checkEq(label, actual, expected) {
  try {
    assert.equal(actual, expected, label);
    console.log(`OK   ${label}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${label}`, e instanceof Error ? e.message : e, { actual, expected });
  }
}

const uid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const company = "11111111-1111-1111-1111-111111111111";
function actor(role) {
  return { id: uid, role, tenantId: company };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

// ── Permissões ──────────────────────────────────────────────────────────────
check("ADMIN_EMPRESA autorizado", canViewConversationReports(actor("ADMIN_EMPRESA")));
check("GERENTE autorizado", canViewConversationReports(actor("GERENTE")));

for (const role of [
  "ATENDENTE",
  "ATENDENTE_GERAL",
  "SUPERVISOR",
  "TI",
  "SUPER_ADMIN",
  "ADMIN_GERAL",
]) {
  check(`${role} recebe 403 (canView=false)`, canViewConversationReports(actor(role)) === false);
  check(
    `${role} sem menu (módulo)`,
    canAccessConversationReportsModule(actor(role), true) === false,
  );
}

check(
  "ADMIN_EMPRESA com empresa válida vê menu",
  canAccessConversationReportsModule(actor("ADMIN_EMPRESA"), true),
);
check(
  "GERENTE com empresa válida vê menu",
  canAccessConversationReportsModule(actor("GERENTE"), true),
);
check(
  "ADMIN_EMPRESA sem empresa não vê menu",
  canAccessConversationReportsModule(actor("ADMIN_EMPRESA"), false) === false,
);
check(
  "canViewReports legado não autoriza SUPERVISOR no relatório de conversas",
  canViewReports(actor("SUPERVISOR")) === true &&
    canViewConversationReports(actor("SUPERVISOR")) === false,
);

// Menu no app-shell
{
  const shell = fs.readFileSync(path.join(root, "src/components/app-shell.tsx"), "utf8");
  check("menu aponta /relatorios/conversas", shell.includes('to: "/relatorios/conversas"'));
  check(
    "menu usa canAccessConversationReportsModule",
    shell.includes("canAccessConversationReportsModule"),
  );
  check("prefixo operacional inclui /relatorios", shell.includes('"/relatorios"'));
}

// Rotas
{
  const apiList = fs.readFileSync(
    path.join(root, "src/routes/api/reports/conversations.ts"),
    "utf8",
  );
  const apiCsv = fs.readFileSync(
    path.join(root, "src/routes/api/reports/conversations/export[.]csv.ts"),
    "utf8",
  );
  const ui = fs.readFileSync(
    path.join(root, "src/routes/_app.relatorios.conversas.tsx"),
    "utf8",
  );
  check("rota JSON /api/reports/conversations", apiList.includes('"/api/reports/conversations"'));
  check(
    "rota CSV /api/reports/conversations/export.csv",
    apiCsv.includes('"/api/reports/conversations/export.csv"'),
  );
  check("UI /_app/relatorios/conversas", ui.includes('"/_app/relatorios/conversas"'));
  check("UI sem dangerouslySetInnerHTML", !ui.includes("dangerouslySetInnerHTML"));
  check("UI tem estado vazio", ui.includes("Nenhuma mensagem encontrada"));
  check("UI tem loading", ui.includes("Carregando relatório"));
  check("UI tem carregar mais", ui.includes("Carregar mais"));
}

// Isolamento / company_id ignorado
{
  const sp = new URLSearchParams({
    date_from: "2026-07-01",
    date_to: "2026-07-07",
    company_id: "99999999-9999-9999-9999-999999999999",
  });
  const parsed = parseConversationReportFilters(sp);
  check("parse ok com company_id na query", parsed.ok === true);
  if (parsed.ok) {
    check(
      "company_id da query não entra nos filtros",
      !("companyId" in parsed.filters) && !("company_id" in parsed.filters),
    );
  }
  const serverSrc = fs.readFileSync(
    path.join(root, "src/lib/conversation-reports.server.ts"),
    "utf8",
  );
  check(
    "SQL isola por company_id da sessão (conversas)",
    serverSrc.includes("c.company_id = ${companyId}::uuid"),
  );
  check(
    "SQL isola contacts por company_id",
    serverSrc.includes("ct.company_id = ${companyId}::uuid"),
  );
  check(
    "SQL isola channels por company_id",
    serverSrc.includes("ch.company_id = ${companyId}::uuid"),
  );
  check(
    "SQL isola assignments por company_id",
    serverSrc.includes("ca.company_id = ${companyId}::uuid"),
  );
  check(
    "SQL isola users (sender/assignee) por company_id",
    serverSrc.includes("u_sender.company_id = ${companyId}::uuid") &&
      serverSrc.includes("u_assignee.company_id = ${companyId}::uuid"),
  );
  check("LATERAL assignment LIMIT 1", serverSrc.includes("LEFT JOIN LATERAL") && serverSrc.includes("LIMIT 1"));
  check("exclui merged", serverSrc.includes("IS DISTINCT FROM 'merged'"));
  check("não exclui archived no SQL base", !serverSrc.includes("IS DISTINCT FROM 'archived'"));
  check(
    "auditoria conversation_report_export_started",
    serverSrc.includes("conversation_report_export_started"),
  );
  check(
    "melhoria futura report_export_events documentada",
    serverSrc.includes("report_export_events"),
  );
  check("CSV batch ~500", CONVERSATION_REPORT_CSV_BATCH === 500);
  check("page limit definido", CONVERSATION_REPORT_PAGE_LIMIT > 0);
}

// Período
{
  const d = defaultReportDateRange(new Date("2026-07-26T15:00:00.000-03:00"));
  check("período padrão ~7 dias", CONVERSATION_REPORT_DEFAULT_DAYS === 7);
  const from = new Date(`${d.dateFrom}T00:00:00.000-03:00`);
  const to = new Date(`${d.dateTo}T00:00:00.000-03:00`);
  const days = Math.round((to - from) / 86400000) + 1;
  checkEq("default cobre 7 dias de calendário", days, 7);

  const ok = validateReportDateRange("2026-07-01", "2026-07-07");
  check("período 7 dias ok", ok.ok === true);

  const big = validateReportDateRange("2026-01-01", "2026-07-01");
  check("período > 90 dias rejeitado", big.ok === false);
  if (!big.ok) {
    check("erro range_too_large", big.error === "range_too_large");
    check("mensagem amigável 90 dias", big.message.includes(String(CONVERSATION_REPORT_MAX_RANGE_DAYS)));
  }

  const bounds = resolveReportDateBounds("2026-07-26", "2026-07-26");
  check(
    "date_to exclusivo no dia seguinte (não perde último dia)",
    bounds.toExclusive.getTime() === bounds.from.getTime() + 86400000,
  );
}

// Cursor / paginação
{
  const c = parseReportCursor(
    new URLSearchParams({
      cursor_created_at: "2026-07-26T12:00:00.000Z",
      cursor_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    }),
  );
  check("cursor composto parseado", c != null && c.id.endsWith("aaaaaaaaaaaa"));
  check(
    "cursor inválido rejeitado",
    parseReportCursor(new URLSearchParams({ cursor_created_at: "x", cursor_id: "y" })) == null,
  );
  const serverSrc = fs.readFileSync(
    path.join(root, "src/lib/conversation-reports.server.ts"),
    "utf8",
  );
  check(
    "paginação por (created_at, id) evita perda/repetição",
    serverSrc.includes("(m.created_at, m.id) >") &&
      serverSrc.includes("ORDER BY m.created_at ASC, m.id ASC"),
  );
}

// Atendente exibido
checkEq(
  "outbound prefer sent_by_name",
  resolveDisplayedAttendantName({
    direction: "out",
    senderName: "João",
    assignedName: "Maria",
  }),
  "João",
);
checkEq(
  "outbound sem sender usa assignee",
  resolveDisplayedAttendantName({
    direction: "out",
    senderName: null,
    assignedName: "Maria",
  }),
  "Maria",
);
checkEq(
  "inbound usa assignee",
  resolveDisplayedAttendantName({
    direction: "in",
    senderName: "João",
    assignedName: "Maria",
  }),
  "Maria",
);
checkEq(
  "sem info retorna null",
  resolveDisplayedAttendantName({
    direction: "in",
    senderName: null,
    assignedName: null,
  }),
  null,
);

// Origem
checkEq("inbound → Cliente", mapMessageOrigin("in"), "Cliente");
checkEq("outbound → Atendente", mapMessageOrigin("out"), "Atendente");
checkEq("system → Sistema", mapMessageOrigin("system"), "Sistema");

// Sistema oculto por padrão
{
  const def = parseConversationReportFilters(
    new URLSearchParams({ date_from: "2026-07-01", date_to: "2026-07-07" }),
  );
  check("include_system padrão false", def.ok && def.filters.includeSystem === false);
  const on = parseConversationReportFilters(
    new URLSearchParams({
      date_from: "2026-07-01",
      date_to: "2026-07-07",
      include_system: "true",
    }),
  );
  check("include_system=true", on.ok && on.filters.includeSystem === true);
}

// Filtro atendente = responsável (SQL)
{
  const serverSrc = fs.readFileSync(
    path.join(root, "src/lib/conversation-reports.server.ts"),
    "utf8",
  );
  check(
    "filtro atendente usa current_assignment.user_id",
    serverSrc.includes("current_assignment.user_id = ${attendantId}::uuid"),
  );
}

// Mídia + legenda
checkEq("imagem", formatReportMediaLabel("image", null), "[Imagem]");
checkEq("áudio", formatReportMediaLabel("audio", null), "[Áudio]");
checkEq("documento", formatReportMediaLabel("document", null), "[Documento]");
checkEq("vídeo", formatReportMediaLabel("video", null), "[Vídeo]");
checkEq("figurinha", formatReportMediaLabel("sticker", null), "[Figurinha]");
checkEq("localização", formatReportMediaLabel("location", null), "[Localização]");
checkEq("contato", formatReportMediaLabel("contact", null), "[Contato]");
checkEq("mídia desconhecida", formatReportMediaLabel("unknown_xyz", null), "[Mídia]");
checkEq(
  "imagem com legenda",
  buildMessageDisplay({
    messageText: null,
    messageType: "image",
    mediaType: "image/jpeg",
    mediaCaption: "Legenda da imagem",
  }),
  "[Imagem] Legenda da imagem",
);
checkEq(
  "texto puro",
  buildMessageDisplay({
    messageText: "Olá\nmundo",
    messageType: "text",
    mediaType: null,
    mediaCaption: null,
  }),
  "Olá\nmundo",
);

checkEq("status archived label", mapAttendanceStatusLabel("archived"), "Arquivada");

// CSV
{
  const header = buildConversationReportCsvHeader();
  checkEq(
    "cabeçalho CSV",
    header,
    CONVERSATION_REPORT_CSV_HEADERS.join(";"),
  );
  check(
    "cabeçalho esperado completo",
    header ===
      "Cliente;Telefone;Atendente;Canal;Origem da mensagem;Mensagem;Data e hora;Status do atendimento",
  );

  const injection = escapeCsvField("=CMD()");
  check("CSV Injection neutralizado", injection.startsWith("'="));

  const accents = joinCsvRow(["José", "São Paulo", "Ação"]);
  check("CSV com acentos preservados", accents.includes("José") && accents.includes("São Paulo"));

  const multiline = escapeCsvField("linha1\nlinha2;x");
  check("quebras de linha escapadas", multiline.startsWith('"') && multiline.includes('""') === false);
  check("ponto e vírgula escapado com aspas", multiline.includes("linha1\nlinha2;x"));

  const line = conversationReportRowToCsvLine({
    id: "x",
    created_at: "2026-07-26T15:30:00.000Z",
    contact_name: "José",
    phone: "5511999999999",
    channel_name: "Principal",
    attendance_status: "open",
    message_origin: "Cliente",
    message_display: "=1+1",
    assigned_attendant_name: "Maria",
    sender_name: null,
    displayed_attendant_name: "Maria",
  });
  check("linha CSV usa displayed_attendant", line.includes("Maria"));
  check("linha CSV protege injection na mensagem", line.includes("'=1+1"));
  checkEq("timezone SP", CSV_EXPORT_TIMEZONE, "America/Sao_Paulo");
  const formatted = formatCsvDateTime("2026-07-26T15:30:00.000Z");
  check("formatCsvDateTime retorna pt-BR", /\d{2}\/\d{2}\/\d{4}/.test(formatted));
  checkEq(
    "filename conversas-from-to",
    buildConversationReportFilename("2026-07-01", "2026-07-07"),
    "conversas-2026-07-01-2026-07-07.csv",
  );
}

// Volume alto — constantes de streaming (não carrega tudo em memória)
{
  const serverSrc = fs.readFileSync(
    path.join(root, "src/lib/conversation-reports.server.ts"),
    "utf8",
  );
  check("export usa lotes cursor (não array integral)", serverSrc.includes("CONVERSATION_REPORT_CSV_BATCH"));
  check("export respeita AbortSignal", serverSrc.includes("signal?.aborted"));
  check("statement_timeout definido", serverSrc.includes("statement_timeout"));
}

console.log(failed === 0 ? "\nTodos os testes passaram." : `\n${failed} teste(s) falharam.`);
process.exit(failed === 0 ? 0 : 1);
