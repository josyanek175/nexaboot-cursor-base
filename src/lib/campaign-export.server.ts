/**
 * Exportação CSV segura de destinatários de campanha.
 * Streaming + cursor; timezone America/Sao_Paulo só na apresentação.
 */
import { sql } from "@/lib/pg.server";
import { insertCampaignEvent, getCampaignById } from "@/lib/campaign.server";

export const CAMPAIGN_EXPORT_TIMEZONE = "America/Sao_Paulo";
export const CAMPAIGN_EXPORT_BATCH_SIZE = 500;

export const CAMPAIGN_CSV_HEADERS = [
  "Campanha",
  "Origem do público",
  "Nome do contato",
  "Telefone",
  "Data e hora do disparo",
  "Status do envio",
  "Data e hora da resposta",
  "Resposta do cliente",
  "Classificação da resposta",
  "Criado por",
] as const;

export type CampaignExportResponseFilter = "all" | "responded" | "not_responded";
export type CampaignExportStatusFilter = "all" | "sent" | "failed" | "pending";

export type CampaignExportFilters = {
  response: CampaignExportResponseFilter;
  status: CampaignExportStatusFilter;
  sentFrom: string | null;
  sentTo: string | null;
};

export type CampaignExportRow = {
  cursor_id: string;
  campaign_name: string;
  audience_source: "CRM" | "Importação";
  contact_name: string | null;
  phone: string;
  sent_at: Date | string | null;
  send_status: string;
  responded_at: Date | string | null;
  response_text: string | null;
  response_intent: string | null;
  created_by_name: string | null;
};

const CSV_INJECTION_RE = /^[=+\-@]/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function parseCampaignExportFilters(
  searchParams: URLSearchParams,
): { ok: true; filters: CampaignExportFilters } | { ok: false; error: string } {
  const responseRaw = (searchParams.get("response") ?? "all").trim().toLowerCase();
  const statusRaw = (searchParams.get("status") ?? "all").trim().toLowerCase();
  const sentFrom = (searchParams.get("sent_from") ?? "").trim() || null;
  const sentTo = (searchParams.get("sent_to") ?? "").trim() || null;

  if (!["all", "responded", "not_responded"].includes(responseRaw)) {
    return { ok: false, error: "invalid_response_filter" };
  }
  if (!["all", "sent", "failed", "pending"].includes(statusRaw)) {
    return { ok: false, error: "invalid_status_filter" };
  }
  if (sentFrom && !isValidExportDateInput(sentFrom)) {
    return { ok: false, error: "invalid_sent_from" };
  }
  if (sentTo && !isValidExportDateInput(sentTo)) {
    return { ok: false, error: "invalid_sent_to" };
  }

  return {
    ok: true,
    filters: {
      response: responseRaw as CampaignExportResponseFilter,
      status: statusRaw as CampaignExportStatusFilter,
      sentFrom,
      sentTo,
    },
  };
}

function isValidExportDateInput(value: string): boolean {
  if (DATE_ONLY_RE.test(value)) return true;
  if (!DATETIME_RE.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/** Bounds inclusivos em timestamptz (entrada interpretada; DB permanece UTC). */
export function resolveSentBounds(
  sentFrom: string | null,
  sentTo: string | null,
): { from: Date | null; toExclusive: Date | null } {
  let from: Date | null = null;
  let toExclusive: Date | null = null;

  if (sentFrom) {
    if (DATE_ONLY_RE.test(sentFrom)) {
      // Início do dia em America/Sao_Paulo ≈ -03:00 (sem DST desde 2019)
      from = new Date(`${sentFrom}T00:00:00.000-03:00`);
    } else {
      from = new Date(sentFrom);
    }
  }
  if (sentTo) {
    if (DATE_ONLY_RE.test(sentTo)) {
      const end = new Date(`${sentTo}T00:00:00.000-03:00`);
      end.setUTCDate(end.getUTCDate() + 1);
      toExclusive = end;
    } else {
      toExclusive = new Date(sentTo);
    }
  }
  return { from, toExclusive };
}

/** Neutraliza CSV Injection (=, +, -, @ no início). */
export function neutralizeCsvInjection(value: string): string {
  if (!value) return value;
  if (CSV_INJECTION_RE.test(value)) return `'${value}`;
  return value;
}

export function escapeCsvField(value: string): string {
  const safe = neutralizeCsvInjection(value);
  if (/[;"\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function formatCsvDateTime(
  value: Date | string | null | undefined,
  timeZone: string = CAMPAIGN_EXPORT_TIMEZONE,
): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function formatAudienceSource(contactId: string | null | undefined): "CRM" | "Importação" {
  return contactId ? "CRM" : "Importação";
}

export function formatSendStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "Pendente",
    processing: "Processando",
    sent: "Enviado",
    responded: "Respondido",
    failed: "Falhou",
    erro_envio: "Falhou",
    skipped: "Ignorado",
  };
  return map[status] ?? status;
}

export function formatResponseIntentLabel(intent: string | null | undefined): string {
  if (!intent) return "";
  const map: Record<string, string> = {
    interested: "Interessado",
    not_interested: "Não interessado",
    opt_out: "Opt-out",
    unknown: "Desconhecido",
  };
  return map[intent] ?? intent;
}

export function rowToCsvLine(row: {
  campaign_name: string;
  audience_source: string;
  contact_name: string | null;
  phone: string;
  sent_at: Date | string | null;
  send_status: string;
  responded_at: Date | string | null;
  response_text: string | null;
  response_intent: string | null;
  created_by_name: string | null;
}): string {
  const cells = [
    row.campaign_name ?? "",
    row.audience_source ?? "",
    row.contact_name ?? "",
    row.phone ?? "",
    formatCsvDateTime(row.sent_at),
    formatSendStatusLabel(row.send_status ?? ""),
    formatCsvDateTime(row.responded_at),
    row.response_text ?? "",
    formatResponseIntentLabel(row.response_intent),
    row.created_by_name ?? "",
  ];
  return cells.map((c) => escapeCsvField(String(c))).join(";");
}

export function buildCsvHeaderLine(): string {
  return CAMPAIGN_CSV_HEADERS.map((h) => escapeCsvField(h)).join(";");
}

export function slugifyCampaignFilenamePart(name: string, fallbackId: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || fallbackId.slice(0, 8);
}

export function buildExportFilename(campaignName: string, campaignId: string, now = new Date()): string {
  const slug = slugifyCampaignFilenamePart(campaignName, campaignId);
  const datePart = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPAIGN_EXPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return `campanha-${slug}-${datePart}.csv`;
}

export async function countCampaignExportRows(
  companyId: string,
  campaignId: string,
  filters: CampaignExportFilters,
): Promise<number> {
  const { from, toExclusive } = resolveSentBounds(filters.sentFrom, filters.sentTo);
  const responseAll = filters.response === "all";
  const responseResponded = filters.response === "responded";
  const responseNotResponded = filters.response === "not_responded";
  const statusAll = filters.status === "all";
  const statusSent = filters.status === "sent";
  const statusFailed = filters.status === "failed";
  const statusPending = filters.status === "pending";

  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c
      ON c.id = cc.campaign_id
     AND c.company_id = cc.company_id
     AND c.deleted_at IS NULL
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND (
        ${responseAll}::boolean
        OR (${responseResponded}::boolean AND cc.responded_at IS NOT NULL)
        OR (${responseNotResponded}::boolean AND cc.responded_at IS NULL)
      )
      AND (
        ${statusAll}::boolean
        OR (${statusSent}::boolean AND cc.status IN ('sent', 'responded'))
        OR (${statusFailed}::boolean AND cc.status IN ('failed', 'erro_envio'))
        OR (${statusPending}::boolean AND cc.status = 'pending')
      )
      AND (${from}::timestamptz IS NULL OR cc.sent_at >= ${from}::timestamptz)
      AND (${toExclusive}::timestamptz IS NULL OR cc.sent_at < ${toExclusive}::timestamptz)
  `;
  return parseInt(rows[0]?.count ?? "0", 10) || 0;
}

async function fetchExportBatch(
  companyId: string,
  campaignId: string,
  filters: CampaignExportFilters,
  cursorId: string | null,
  limit: number,
): Promise<CampaignExportRow[]> {
  const { from, toExclusive } = resolveSentBounds(filters.sentFrom, filters.sentTo);
  const responseAll = filters.response === "all";
  const responseResponded = filters.response === "responded";
  const responseNotResponded = filters.response === "not_responded";
  const statusAll = filters.status === "all";
  const statusSent = filters.status === "sent";
  const statusFailed = filters.status === "failed";
  const statusPending = filters.status === "pending";

  const rows = await sql<
    {
      cursor_id: string;
      campaign_name: string;
      contact_id: string | null;
      contact_name: string | null;
      phone: string;
      sent_at: Date | string | null;
      send_status: string;
      responded_at: Date | string | null;
      response_text: string | null;
      response_intent: string | null;
      created_by_name: string | null;
    }[]
  >`
    SELECT
      cc.id AS cursor_id,
      c.name AS campaign_name,
      cc.contact_id,
      cc.name AS contact_name,
      cc.phone,
      cc.sent_at,
      cc.status AS send_status,
      cc.responded_at,
      cc.response_text,
      cc.response_intent,
      u.name AS created_by_name
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c
      ON c.id = cc.campaign_id
     AND c.company_id = cc.company_id
     AND c.deleted_at IS NULL
    LEFT JOIN public.users u ON u.id = c.created_by_user_id
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND (
        ${responseAll}::boolean
        OR (${responseResponded}::boolean AND cc.responded_at IS NOT NULL)
        OR (${responseNotResponded}::boolean AND cc.responded_at IS NULL)
      )
      AND (
        ${statusAll}::boolean
        OR (${statusSent}::boolean AND cc.status IN ('sent', 'responded'))
        OR (${statusFailed}::boolean AND cc.status IN ('failed', 'erro_envio'))
        OR (${statusPending}::boolean AND cc.status = 'pending')
      )
      AND (${from}::timestamptz IS NULL OR cc.sent_at >= ${from}::timestamptz)
      AND (${toExclusive}::timestamptz IS NULL OR cc.sent_at < ${toExclusive}::timestamptz)
      AND (${cursorId}::uuid IS NULL OR cc.id > ${cursorId}::uuid)
    ORDER BY cc.id ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    cursor_id: r.cursor_id,
    campaign_name: r.campaign_name,
    audience_source: formatAudienceSource(r.contact_id),
    contact_name: r.contact_name,
    phone: r.phone,
    sent_at: r.sent_at,
    send_status: r.send_status,
    responded_at: r.responded_at,
    response_text: r.response_text,
    response_intent: r.response_intent,
    created_by_name: r.created_by_name,
  }));
}

export type CampaignExportStreamResult = {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  expectedCount: number;
};

/**
 * Inicia exportação: valida campanha, audita (mesmo se download falhar depois)
 * e retorna stream UTF-8 com BOM + linhas CSV.
 */
export async function startCampaignRecipientsExport(params: {
  companyId: string;
  campaignId: string;
  userId: string | null;
  filters: CampaignExportFilters;
}): Promise<CampaignExportStreamResult | { error: "not_found" }> {
  const campaign = await getCampaignById(params.companyId, params.campaignId);
  if (!campaign) return { error: "not_found" };

  const filename = buildExportFilename(campaign.name, campaign.id);
  const expectedCount = await countCampaignExportRows(
    params.companyId,
    params.campaignId,
    params.filters,
  );

  await insertCampaignEvent(
    params.companyId,
    params.campaignId,
    "campaign.exported",
    params.userId,
    {
      filters: params.filters,
      expected_count: expectedCount,
      filename,
      timezone: CAMPAIGN_EXPORT_TIMEZONE,
      export_status: "started",
    },
  );

  const encoder = new TextEncoder();
  const companyId = params.companyId;
  const campaignId = params.campaignId;
  const filters = params.filters;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode("\uFEFF"));
        controller.enqueue(encoder.encode(`${buildCsvHeaderLine()}\r\n`));

        let cursorId: string | null = null;
        for (;;) {
          const batch = await fetchExportBatch(
            companyId,
            campaignId,
            filters,
            cursorId,
            CAMPAIGN_EXPORT_BATCH_SIZE,
          );
          if (batch.length === 0) break;

          for (const row of batch) {
            controller.enqueue(encoder.encode(`${rowToCsvLine(row)}\r\n`));
          }

          cursorId = batch[batch.length - 1]!.cursor_id;
          if (batch.length < CAMPAIGN_EXPORT_BATCH_SIZE) break;

          // Yield para não monopolizar o event loop (worker / inbound).
          await new Promise<void>((r) => setTimeout(r, 0));
        }
        controller.close();
      } catch (e) {
        console.error("[CAMPAIGN_EXPORT_STREAM_FAIL]", {
          campaignId,
          companyId,
          error: e instanceof Error ? e.message : String(e),
        });
        controller.error(e);
      }
    },
  });

  return { stream, filename, expectedCount };
}
