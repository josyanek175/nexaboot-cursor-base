/**
 * Relatório/auditoria de conversas (ADMIN_EMPRESA / GERENTE).
 * Isolamento estrito por company_id da sessão. Sem migration.
 */
import { sql } from "@/lib/pg.server";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  canViewConversationReports,
  actingUserFromAuth,
  type ActingUser,
} from "@/lib/permissions";
import {
  CSV_EXPORT_TIMEZONE,
  escapeCsvField,
  formatCsvDateTime,
  joinCsvRow,
} from "@/lib/csv-safe";

export const CONVERSATION_REPORT_MAX_RANGE_DAYS = 90;
export const CONVERSATION_REPORT_DEFAULT_DAYS = 7;
export const CONVERSATION_REPORT_PAGE_LIMIT = 50;
export const CONVERSATION_REPORT_PAGE_LIMIT_MAX = 100;
export const CONVERSATION_REPORT_CSV_BATCH = 500;
export const CONVERSATION_REPORT_STATEMENT_TIMEOUT_MS = 15_000;

export const CONVERSATION_REPORT_CSV_HEADERS = [
  "Cliente",
  "Telefone",
  "Atendente",
  "Canal",
  "Origem da mensagem",
  "Mensagem",
  "Data e hora",
  "Status do atendimento",
] as const;

export type ConversationReportOriginFilter = "all" | "client" | "attendant";
export type ConversationReportStatusFilter =
  | "all"
  | "open"
  | "waiting"
  | "finished"
  | "archived";

export type ConversationReportFilters = {
  dateFrom: string;
  dateTo: string;
  attendantUserId: string | null;
  search: string | null;
  channelId: string | null;
  status: ConversationReportStatusFilter;
  origin: ConversationReportOriginFilter;
  includeSystem: boolean;
};

export type ConversationReportCursor = {
  createdAt: string;
  id: string;
};

export type ConversationReportRow = {
  id: string;
  created_at: string;
  contact_name: string | null;
  phone: string | null;
  channel_name: string | null;
  attendance_status: string;
  message_origin: "Cliente" | "Atendente" | "Sistema";
  message_display: string;
  assigned_attendant_name: string | null;
  sender_name: string | null;
  displayed_attendant_name: string | null;
};

type ActorContext = {
  userId: string;
  companyId: string;
  role: string;
  actor: ActingUser;
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatReportMediaLabel(
  messageType: string | null | undefined,
  mediaType: string | null | undefined,
): string {
  const t = String(mediaType || messageType || "")
    .toLowerCase()
    .trim();
  if (!t || t === "text" || t === "system") return "";
  if (t === "sticker") return "[Figurinha]";
  if (t === "image" || t === "img" || t.includes("image")) return "[Imagem]";
  if (t === "audio" || t === "ptt" || t === "voice" || t.includes("audio")) return "[Áudio]";
  if (t === "video" || t.includes("video")) return "[Vídeo]";
  if (t === "document" || t === "file" || t === "application" || t.includes("document"))
    return "[Documento]";
  if (t === "location") return "[Localização]";
  if (t === "contact" || t === "contacts" || t === "vcard") return "[Contato]";
  return "[Mídia]";
}

export function buildMessageDisplay(params: {
  messageText: string | null | undefined;
  messageType: string | null | undefined;
  mediaType: string | null | undefined;
  mediaCaption: string | null | undefined;
}): string {
  const mediaLabel = formatReportMediaLabel(params.messageType, params.mediaType);
  const caption = String(params.mediaCaption ?? "").trim();
  const text = String(params.messageText ?? "").trim();

  if (mediaLabel) {
    if (caption) return `${mediaLabel} ${caption}`;
    if (text && text !== mediaLabel && !text.startsWith("[")) return `${mediaLabel} ${text}`;
    return mediaLabel;
  }
  return text;
}

export function resolveDisplayedAttendantName(params: {
  direction: string;
  senderName: string | null | undefined;
  assignedName: string | null | undefined;
}): string | null {
  const direction = String(params.direction ?? "").toLowerCase();
  const sender = String(params.senderName ?? "").trim();
  const assigned = String(params.assignedName ?? "").trim();
  if (direction === "out" || direction === "outbound") {
    if (sender) return sender;
    return assigned || null;
  }
  return assigned || null;
}

export function mapMessageOrigin(
  direction: string,
): "Cliente" | "Atendente" | "Sistema" {
  const d = String(direction ?? "").toLowerCase();
  if (d === "in" || d === "inbound") return "Cliente";
  if (d === "out" || d === "outbound") return "Atendente";
  return "Sistema";
}

export function mapAttendanceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    open: "Aberta",
    waiting: "Aguardando",
    finished: "Finalizada",
    archived: "Arquivada",
  };
  return map[status] ?? status;
}

/** Início do dia SP e fim exclusivo (dia seguinte 00:00 SP). */
export function resolveReportDateBounds(
  dateFrom: string,
  dateTo: string,
): { from: Date; toExclusive: Date } {
  // Limites em America/Sao_Paulo (-03). date_to é inclusivo no calendário;
  // o limite SQL é exclusivo no início do dia seguinte (não perde o último dia).
  const from = new Date(`${dateFrom}T00:00:00.000-03:00`);
  const toStart = new Date(`${dateTo}T00:00:00.000-03:00`);
  const toExclusive = new Date(toStart.getTime() + 24 * 60 * 60 * 1000);
  return { from, toExclusive };
}

export function validateReportDateRange(
  dateFrom: string,
  dateTo: string,
): { ok: true; from: Date; toExclusive: Date } | { ok: false; error: string; message: string } {
  if (!DATE_ONLY_RE.test(dateFrom) || !DATE_ONLY_RE.test(dateTo)) {
    return {
      ok: false,
      error: "invalid_date",
      message: "Use datas no formato AAAA-MM-DD.",
    };
  }
  const { from, toExclusive } = resolveReportDateBounds(dateFrom, dateTo);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime())) {
    return { ok: false, error: "invalid_date", message: "Datas inválidas." };
  }
  if (from.getTime() >= toExclusive.getTime()) {
    return {
      ok: false,
      error: "invalid_range",
      message: "A data inicial deve ser anterior ou igual à data final.",
    };
  }
  const maxMs = CONVERSATION_REPORT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (toExclusive.getTime() - from.getTime() > maxMs) {
    return {
      ok: false,
      error: "range_too_large",
      message: `O período máximo por consulta é de ${CONVERSATION_REPORT_MAX_RANGE_DAYS} dias.`,
    };
  }
  return { ok: true, from, toExclusive };
}

export function defaultReportDateRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CSV_EXPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const to = fmt.format(now);
  const fromDate = new Date(now.getTime() - (CONVERSATION_REPORT_DEFAULT_DAYS - 1) * 86400000);
  const from = fmt.format(fromDate);
  return { dateFrom: from, dateTo: to };
}

export function parseConversationReportFilters(
  searchParams: URLSearchParams,
):
  | { ok: true; filters: ConversationReportFilters }
  | { ok: false; error: string; message: string } {
  const defaults = defaultReportDateRange();
  const dateFrom = (searchParams.get("date_from") ?? defaults.dateFrom).trim();
  const dateTo = (searchParams.get("date_to") ?? defaults.dateTo).trim();
  const range = validateReportDateRange(dateFrom, dateTo);
  if (!range.ok) return range;

  const attendantRaw = (searchParams.get("attendant_user_id") ?? "").trim();
  if (attendantRaw && !UUID_RE.test(attendantRaw)) {
    return { ok: false, error: "invalid_attendant", message: "Atendente inválido." };
  }
  const channelRaw = (searchParams.get("channel_id") ?? "").trim();
  if (channelRaw && !UUID_RE.test(channelRaw)) {
    return { ok: false, error: "invalid_channel", message: "Canal inválido." };
  }

  const statusRaw = (searchParams.get("status") ?? "all").trim().toLowerCase();
  if (!["all", "open", "waiting", "finished", "archived"].includes(statusRaw)) {
    return { ok: false, error: "invalid_status", message: "Status inválido." };
  }
  const originRaw = (searchParams.get("origin") ?? "all").trim().toLowerCase();
  if (!["all", "client", "attendant"].includes(originRaw)) {
    return { ok: false, error: "invalid_origin", message: "Origem inválida." };
  }
  const includeSystemRaw = (searchParams.get("include_system") ?? "false").trim().toLowerCase();
  const includeSystem = includeSystemRaw === "1" || includeSystemRaw === "true" || includeSystemRaw === "yes";
  const search = (searchParams.get("search") ?? "").trim() || null;

  return {
    ok: true,
    filters: {
      dateFrom,
      dateTo,
      attendantUserId: attendantRaw || null,
      search,
      channelId: channelRaw || null,
      status: statusRaw as ConversationReportStatusFilter,
      origin: originRaw as ConversationReportOriginFilter,
      includeSystem,
    },
  };
}

export function parseReportCursor(
  searchParams: URLSearchParams,
): ConversationReportCursor | null {
  const createdAt = (searchParams.get("cursor_created_at") ?? "").trim();
  const id = (searchParams.get("cursor_id") ?? "").trim();
  if (!createdAt || !id) return null;
  if (!UUID_RE.test(id)) return null;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return { createdAt: new Date(t).toISOString(), id };
}

export async function requireConversationReportActor(): Promise<ActorContext | Response> {
  let uid = getSessionUserId();
  let companyId: string | Response;

  if (uid) {
    companyId = await requireCompanyId(uid);
  } else {
    companyId = await requireCompanyId();
    if (!(companyId instanceof Response)) {
      const info = await getCurrentUserCompanyInfo();
      uid = info.userId;
    }
  }

  if (companyId instanceof Response) return companyId;
  if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const info = await getCurrentUserCompanyInfo(uid);
  const role = info.role ?? null;
  if (!role) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const actor = actingUserFromAuth({
    id: uid,
    role,
    tenantId: info.companyId ?? "",
  });

  if (!canViewConversationReports(actor)) {
    return Response.json(
      {
        error: "forbidden",
        message: "Seu perfil não tem permissão para acessar o relatório de conversas.",
      },
      { status: 403 },
    );
  }

  return { userId: uid, companyId, role, actor };
}

type DbMessageRow = {
  id: string;
  created_at: Date | string;
  contact_name: string | null;
  phone: string | null;
  channel_name: string | null;
  attendance_status: string;
  direction: string;
  message_text: string | null;
  message_type: string | null;
  media_type: string | null;
  media_caption: string | null;
  sent_by_name: string | null;
  sender_user_name: string | null;
  assigned_attendant_name: string | null;
};

function mapDbRow(row: DbMessageRow): ConversationReportRow {
  const senderName =
    String(row.sent_by_name ?? "").trim() ||
    String(row.sender_user_name ?? "").trim() ||
    null;
  const assigned = String(row.assigned_attendant_name ?? "").trim() || null;
  const displayed = resolveDisplayedAttendantName({
    direction: row.direction,
    senderName,
    assignedName: assigned,
  });
  return {
    id: row.id,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    contact_name: row.contact_name,
    phone: row.phone,
    channel_name: row.channel_name,
    attendance_status: row.attendance_status,
    message_origin: mapMessageOrigin(row.direction),
    message_display: buildMessageDisplay({
      messageText: row.message_text,
      messageType: row.message_type,
      mediaType: row.media_type,
      mediaCaption: row.media_caption,
    }),
    assigned_attendant_name: assigned,
    sender_name: senderName,
    displayed_attendant_name: displayed,
  };
}

async function fetchReportBatch(
  companyId: string,
  filters: ConversationReportFilters,
  cursor: ConversationReportCursor | null,
  limit: number,
): Promise<DbMessageRow[]> {
  const bounds = resolveReportDateBounds(filters.dateFrom, filters.dateTo);
  const statusAll = filters.status === "all";
  const statusValue = filters.status === "all" ? null : filters.status;
  const originAll = filters.origin === "all";
  const originClient = filters.origin === "client";
  const originAttendant = filters.origin === "attendant";
  const includeSystem = filters.includeSystem;
  const search = filters.search;
  const searchPattern = search ? `%${search}%` : null;
  const attendantId = filters.attendantUserId;
  const channelId = filters.channelId;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const s = sql();
  return s.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${CONVERSATION_REPORT_STATEMENT_TIMEOUT_MS}`,
    );
    return tx<DbMessageRow[]>`
      SELECT
        m.id,
        m.created_at,
        ct.name AS contact_name,
        ct.phone,
        ch.name AS channel_name,
        c.status AS attendance_status,
        m.direction,
        m.message_text,
        m.message_type,
        m.media_type,
        m.media_caption,
        m.sent_by_name,
        u_sender.name AS sender_user_name,
        u_assignee.name AS assigned_attendant_name
      FROM public.messages m
      INNER JOIN public.conversations c
        ON c.id = m.conversation_id
       AND c.company_id = ${companyId}::uuid
       AND c.status IS DISTINCT FROM 'merged'
      INNER JOIN public.contacts ct
        ON ct.id = c.contact_id
       AND ct.company_id = ${companyId}::uuid
      LEFT JOIN public.whatsapp_channels ch
        ON ch.id = c.whatsapp_channel_id
       AND ch.company_id = ${companyId}::uuid
      LEFT JOIN public.users u_sender
        ON u_sender.id = m.sent_by_user_id
       AND u_sender.company_id = ${companyId}::uuid
      LEFT JOIN LATERAL (
        SELECT ca.user_id
        FROM public.conversation_assignments ca
        WHERE ca.conversation_id = c.id
          AND ca.company_id = ${companyId}::uuid
          AND ca.active = true
          AND ca.unassigned_at IS NULL
        ORDER BY ca.assigned_at DESC NULLS LAST
        LIMIT 1
      ) current_assignment ON true
      LEFT JOIN public.users u_assignee
        ON u_assignee.id = current_assignment.user_id
       AND u_assignee.company_id = ${companyId}::uuid
      WHERE m.created_at >= ${bounds.from}::timestamptz
        AND m.created_at < ${bounds.toExclusive}::timestamptz
        AND (
          ${statusAll}::boolean
          OR c.status = ${statusValue}
        )
        AND (
          ${originAll}::boolean
          OR (${originClient}::boolean AND lower(m.direction) IN ('in', 'inbound'))
          OR (${originAttendant}::boolean AND lower(m.direction) IN ('out', 'outbound'))
        )
        AND (
          ${includeSystem}::boolean
          OR lower(m.direction) IS DISTINCT FROM 'system'
        )
        AND (
          ${attendantId}::uuid IS NULL
          OR current_assignment.user_id = ${attendantId}::uuid
        )
        AND (
          ${channelId}::uuid IS NULL
          OR c.whatsapp_channel_id = ${channelId}::uuid
        )
        AND (
          ${searchPattern}::text IS NULL
          OR ct.name ILIKE ${searchPattern}
          OR ct.phone ILIKE ${searchPattern}
        )
        AND (
          ${cursorCreatedAt}::timestamptz IS NULL
          OR (m.created_at, m.id) > (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ${limit}
    `;
  }) as Promise<DbMessageRow[]>;
}

export async function countConversationReportRows(
  companyId: string,
  filters: ConversationReportFilters,
): Promise<number> {
  const bounds = resolveReportDateBounds(filters.dateFrom, filters.dateTo);
  const statusAll = filters.status === "all";
  const statusValue = filters.status === "all" ? null : filters.status;
  const originAll = filters.origin === "all";
  const originClient = filters.origin === "client";
  const originAttendant = filters.origin === "attendant";
  const includeSystem = filters.includeSystem;
  const search = filters.search;
  const searchPattern = search ? `%${search}%` : null;
  const attendantId = filters.attendantUserId;
  const channelId = filters.channelId;

  const s = sql();
  const rows = await s.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${CONVERSATION_REPORT_STATEMENT_TIMEOUT_MS}`,
    );
    return tx<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM public.messages m
      INNER JOIN public.conversations c
        ON c.id = m.conversation_id
       AND c.company_id = ${companyId}::uuid
       AND c.status IS DISTINCT FROM 'merged'
      INNER JOIN public.contacts ct
        ON ct.id = c.contact_id
       AND ct.company_id = ${companyId}::uuid
      LEFT JOIN LATERAL (
        SELECT ca.user_id
        FROM public.conversation_assignments ca
        WHERE ca.conversation_id = c.id
          AND ca.company_id = ${companyId}::uuid
          AND ca.active = true
          AND ca.unassigned_at IS NULL
        ORDER BY ca.assigned_at DESC NULLS LAST
        LIMIT 1
      ) current_assignment ON true
      WHERE m.created_at >= ${bounds.from}::timestamptz
        AND m.created_at < ${bounds.toExclusive}::timestamptz
        AND (
          ${statusAll}::boolean
          OR c.status = ${statusValue}
        )
        AND (
          ${originAll}::boolean
          OR (${originClient}::boolean AND lower(m.direction) IN ('in', 'inbound'))
          OR (${originAttendant}::boolean AND lower(m.direction) IN ('out', 'outbound'))
        )
        AND (
          ${includeSystem}::boolean
          OR lower(m.direction) IS DISTINCT FROM 'system'
        )
        AND (
          ${attendantId}::uuid IS NULL
          OR current_assignment.user_id = ${attendantId}::uuid
        )
        AND (
          ${channelId}::uuid IS NULL
          OR c.whatsapp_channel_id = ${channelId}::uuid
        )
        AND (
          ${searchPattern}::text IS NULL
          OR ct.name ILIKE ${searchPattern}
          OR ct.phone ILIKE ${searchPattern}
        )
    `;
  });
  return parseInt((rows as { count: string }[])[0]?.count ?? "0", 10) || 0;
}

export async function listConversationReportPage(params: {
  companyId: string;
  filters: ConversationReportFilters;
  cursor: ConversationReportCursor | null;
  limit?: number;
}): Promise<{
  rows: ConversationReportRow[];
  nextCursor: ConversationReportCursor | null;
  hasMore: boolean;
}> {
  const limit = Math.min(
    CONVERSATION_REPORT_PAGE_LIMIT_MAX,
    Math.max(1, params.limit ?? CONVERSATION_REPORT_PAGE_LIMIT),
  );
  const batch = await fetchReportBatch(
    params.companyId,
    params.filters,
    params.cursor,
    limit + 1,
  );
  const hasMore = batch.length > limit;
  const slice = hasMore ? batch.slice(0, limit) : batch;
  const rows = slice.map(mapDbRow);
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor:
      hasMore && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
  };
}

export function buildConversationReportFilename(dateFrom: string, dateTo: string): string {
  return `conversas-${dateFrom}-${dateTo}.csv`;
}

export function conversationReportRowToCsvLine(row: ConversationReportRow): string {
  return joinCsvRow([
    row.contact_name,
    row.phone,
    row.displayed_attendant_name,
    row.channel_name,
    row.message_origin,
    row.message_display,
    formatCsvDateTime(row.created_at),
    mapAttendanceStatusLabel(row.attendance_status),
  ]);
}

export function buildConversationReportCsvHeader(): string {
  return CONVERSATION_REPORT_CSV_HEADERS.map((h) => escapeCsvField(h)).join(";");
}

/**
 * Inicia exportação CSV com streaming + auditoria estruturada (sem migration).
 * Melhoria futura: persistir em report_export_events.
 */
export async function startConversationReportExport(params: {
  companyId: string;
  userId: string;
  role: string;
  filters: ConversationReportFilters;
  signal?: AbortSignal | null;
}): Promise<{ stream: ReadableStream<Uint8Array>; filename: string; expectedCount: number }> {
  const filename = buildConversationReportFilename(
    params.filters.dateFrom,
    params.filters.dateTo,
  );
  let expectedCount = 0;
  try {
    expectedCount = await countConversationReportRows(params.companyId, params.filters);
  } catch (e) {
    console.warn("[CONVERSATION_REPORT_COUNT_FAIL]", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  console.log(
    JSON.stringify({
      event: "conversation_report_export_started",
      companyId: params.companyId,
      userId: params.userId,
      role: params.role,
      filters: params.filters,
      period: { from: params.filters.dateFrom, to: params.filters.dateTo },
      expectedCount,
      filename,
      timezone: CSV_EXPORT_TIMEZONE,
      timestamp: new Date().toISOString(),
    }),
  );

  const encoder = new TextEncoder();
  const companyId = params.companyId;
  const filters = params.filters;
  const signal = params.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode("\uFEFF"));
        controller.enqueue(encoder.encode(`${buildConversationReportCsvHeader()}\r\n`));

        let cursor: ConversationReportCursor | null = null;
        for (;;) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          const batch = await fetchReportBatch(
            companyId,
            filters,
            cursor,
            CONVERSATION_REPORT_CSV_BATCH,
          );
          if (batch.length === 0) break;
          for (const raw of batch) {
            if (signal?.aborted) {
              controller.close();
              return;
            }
            const row = mapDbRow(raw);
            controller.enqueue(encoder.encode(`${conversationReportRowToCsvLine(row)}\r\n`));
          }
          const last = batch[batch.length - 1]!;
          cursor = {
            createdAt:
              last.created_at instanceof Date
                ? last.created_at.toISOString()
                : new Date(last.created_at).toISOString(),
            id: last.id,
          };
          if (batch.length < CONVERSATION_REPORT_CSV_BATCH) break;
          await new Promise<void>((r) => setTimeout(r, 0));
        }
        controller.close();
      } catch (e) {
        console.error("[CONVERSATION_REPORT_EXPORT_STREAM_FAIL]", {
          companyId,
          error: e instanceof Error ? e.message : String(e),
        });
        controller.error(e);
      }
    },
  });

  return { stream, filename, expectedCount };
}

/** Canais da empresa para filtro (somente ativos não deletados). */
export async function listReportChannels(companyId: string): Promise<
  Array<{ id: string; name: string }>
> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name
    FROM public.whatsapp_channels
    WHERE company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND COALESCE(active, true) = true
    ORDER BY name ASC NULLS LAST
  `;
  return rows;
}
