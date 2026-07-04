// Campanhas — lógica server-side (rascunhos + público + agenda).
// Ritmo de envio é interno (auto_safe). Cliente não configura intervalo/pausa.
// Isolamento estrito por company_id.
import { sql } from "@/lib/pg.server";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  canViewCampaigns,
  canManageCampaigns,
  canDeleteCampaign,
  type ActingUser,
} from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";
import {
  CAMPAIGN_SEND_MODE,
  buildVariedMessage,
  isInvalidCampaignPhone,
  isOptOutContact,
} from "@/lib/campaign-send-policy";
import { getCampaignTemplate } from "@/lib/campaign-template.server";

export type CampaignRow = {
  id: string;
  company_id: string;
  whatsapp_channel_id: string | null;
  name: string;
  message_text: string | null;
  message_type: string;
  status: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  send_interval_ms: number;
  schedule_date: string | null;
  window_start_time: string | null;
  window_end_time: string | null;
  send_mode: string;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  total_replied: number;
  total_interested: number;
  total_opt_out: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  channel_name?: string | null;
};

export type CampaignDetail = CampaignRow & {
  channel_unavailable: boolean;
};

export type CampaignContactRow = {
  id: string;
  campaign_id: string;
  company_id: string;
  contact_id: string | null;
  phone: string;
  name: string | null;
  variables: Record<string, unknown>;
  status: string;
  skip_reason: string | null;
  greeting_variant: string | null;
  closing_variant: string | null;
  rendered_message: string | null;
  responded_at: string | null;
  response_text: string | null;
  response_intent: string | null;
  created_at: string;
};

function normalizeTimeInput(v: string | null | undefined): string | null {
  if (v == null || String(v).trim() === "") return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

function normalizeDateInput(v: string | null | undefined): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

export type CampaignWriteInput = {
  name?: string;
  message_text?: string | null;
  whatsapp_channel_id?: string | null;
  schedule_date?: string | null;
  window_start_time?: string | null;
  window_end_time?: string | null;
  template_id?: string | null;
  source_campaign_id?: string | null;
};

type ActorContext = {
  companyId: string;
  userId: string | null;
  actor: ActingUser;
};

export async function listCampaigns(companyId: string, status?: string): Promise<CampaignRow[]> {
  try {
    const rows = status
      ? await sql<CampaignRow[]>`
          SELECT
            c.id, c.company_id, c.whatsapp_channel_id, c.name, c.message_text,
            c.message_type, c.status, c.scheduled_at, c.started_at, c.finished_at,
            c.send_interval_ms, c.schedule_date, c.window_start_time, c.window_end_time,
            COALESCE(c.send_mode, 'auto_safe') AS send_mode,
            c.total_contacts, c.sent_count, c.failed_count, c.skipped_count,
            COALESCE(c.total_replied, 0) AS total_replied,
            COALESCE(c.total_interested, 0) AS total_interested,
            COALESCE(c.total_opt_out, 0) AS total_opt_out,
            c.created_by_user_id, c.created_at, c.updated_at,
            ch.name AS channel_name
          FROM public.campaigns c
          LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
            AND ch.company_id = c.company_id
            AND lower(ch.channel_type) = 'evolution'
          WHERE c.company_id = ${companyId}::uuid
            AND c.deleted_at IS NULL
            AND c.status = ${status}
          ORDER BY c.created_at DESC
        `
      : await sql<CampaignRow[]>`
          SELECT
            c.id, c.company_id, c.whatsapp_channel_id, c.name, c.message_text,
            c.message_type, c.status, c.scheduled_at, c.started_at, c.finished_at,
            c.send_interval_ms, c.schedule_date, c.window_start_time, c.window_end_time,
            COALESCE(c.send_mode, 'auto_safe') AS send_mode,
            c.total_contacts, c.sent_count, c.failed_count, c.skipped_count,
            COALESCE(c.total_replied, 0) AS total_replied,
            COALESCE(c.total_interested, 0) AS total_interested,
            COALESCE(c.total_opt_out, 0) AS total_opt_out,
            c.created_by_user_id, c.created_at, c.updated_at,
            ch.name AS channel_name
          FROM public.campaigns c
          LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
            AND ch.company_id = c.company_id
            AND lower(ch.channel_type) = 'evolution'
          WHERE c.company_id = ${companyId}::uuid
            AND c.deleted_at IS NULL
          ORDER BY c.created_at DESC
        `;
    console.log("[CAMPAIGNS_LIST_OK]", { companyId, status: status ?? null, count: rows.length });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    const err = e as Error;
    console.error("[CAMPAIGNS_LIST_FAIL]", {
      companyId,
      status: status ?? null,
      message: err.message,
      stack: err.stack,
    });
    throw e;
  }
}

const CAMPAIGNS_AUTH_VERSION = "campaigns-auth-v5";

function campaignsAuthLog(
  stage: string,
  fields: {
    hasUid?: boolean;
    role?: string | null;
    companyId?: string | null;
    status?: number;
    mode?: string;
    ok?: boolean;
  },
) {
  console.log("[CAMPAIGNS_AUTH_DEBUG]", {
    authVersion: CAMPAIGNS_AUTH_VERSION,
    stage,
    ...fields,
  });
}

type CampaignActorResult = {
  userId: string;
  companyId: string;
  role: string;
  actor: ActingUser;
};

/**
 * Auth isolada de Campanhas — não altera requireCompanyId global.
 * Espelha /api/evolution/channels (requireCompanyId) + checagem de perfil.
 */
async function requireCampaignActor(
  mode: "view" | "manage" | "delete",
): Promise<CampaignActorResult | Response> {
  let uid = getSessionUserId();
  let companyId: string | Response;

  if (uid) {
    companyId = await requireCompanyId(uid);
  } else {
    // Fallback: mesmo caminho de GET /api/evolution/channels (cookie lido dentro de requireCompanyId).
    companyId = await requireCompanyId();
    if (!(companyId instanceof Response)) {
      const info = await getCurrentUserCompanyInfo();
      uid = info.userId;
    }
  }

  if (companyId instanceof Response) {
    campaignsAuthLog("requireCompanyId", {
      hasUid: !!uid,
      role: null,
      companyId: null,
      status: companyId.status,
      mode,
      ok: false,
    });
    return companyId;
  }

  if (!uid) {
    campaignsAuthLog("session", {
      hasUid: false,
      role: null,
      companyId,
      status: 401,
      mode,
      ok: false,
    });
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const info = await getCurrentUserCompanyInfo(uid);
  const role = info.role ?? null;

  if (!role) {
    campaignsAuthLog("user_role", {
      hasUid: true,
      role: null,
      companyId,
      status: 401,
      mode,
      ok: false,
    });
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const rows = await sql<{ tenant_id: string; active: boolean | null }[]>`
    SELECT tenant_id, active FROM public.users
    WHERE id = ${uid}::uuid
    LIMIT 1
  `;
  if (rows[0]?.active === false) {
    campaignsAuthLog("user_inactive", {
      hasUid: true,
      role,
      companyId,
      status: 403,
      mode,
      ok: false,
    });
    return Response.json(
      { error: "user_inactive", message: "Usuário inativo." },
      { status: 403 },
    );
  }

  const actor: ActingUser = {
    id: uid,
    role: role as ActingUser["role"],
    tenantId: String(rows[0]?.tenant_id ?? ""),
  };

  if (mode === "view" && !canViewCampaigns(actor)) {
    campaignsAuthLog("forbidden", {
      hasUid: true,
      role,
      companyId,
      status: 403,
      mode,
      ok: false,
    });
    return Response.json(
      { error: "forbidden", message: "Seu perfil não tem permissão para acessar Campanhas." },
      { status: 403 },
    );
  }
  if (mode === "manage" && !canManageCampaigns(actor)) {
    campaignsAuthLog("forbidden", {
      hasUid: true,
      role,
      companyId,
      status: 403,
      mode,
      ok: false,
    });
    return Response.json(
      { error: "forbidden", message: "Seu perfil não tem permissão para gerenciar Campanhas." },
      { status: 403 },
    );
  }
  if (mode === "delete" && !canDeleteCampaign(actor)) {
    campaignsAuthLog("forbidden", {
      hasUid: true,
      role,
      companyId,
      status: 403,
      mode,
      ok: false,
    });
    return Response.json(
      { error: "forbidden", message: "Seu perfil não tem permissão para excluir campanhas." },
      { status: 403 },
    );
  }

  campaignsAuthLog("ok", {
    hasUid: true,
    role,
    companyId,
    status: 200,
    mode,
    ok: true,
  });

  return { userId: uid, companyId, role, actor };
}

export async function getCampaignActor(
  mode: "view" | "manage" | "delete",
): Promise<ActorContext | Response> {
  const result = await requireCampaignActor(mode);
  if (result instanceof Response) return result;
  return {
    companyId: result.companyId,
    userId: result.userId,
    actor: result.actor,
  };
}

export async function validateEvolutionChannel(
  companyId: string,
  channelId: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'evolution'
    LIMIT 1
  `;
  if (!rows[0]) return { ok: false, error: "invalid_channel" };
  return { ok: true, id: rows[0].id };
}

export async function isSavedChannelAvailable(
  companyId: string,
  channelId: string | null,
): Promise<boolean> {
  if (!channelId) return true;
  const result = await validateEvolutionChannel(companyId, channelId);
  return result.ok;
}

async function withChannelStatus(
  companyId: string,
  campaign: CampaignRow,
): Promise<CampaignDetail> {
  const channel_unavailable = campaign.whatsapp_channel_id
    ? !(await isSavedChannelAvailable(companyId, campaign.whatsapp_channel_id))
    : false;
  return { ...campaign, channel_unavailable };
}

export async function insertCampaignEvent(
  companyId: string,
  campaignId: string,
  eventType: string,
  userId: string | null,
  payload: Record<string, unknown> = {},
  campaignContactId?: string | null,
): Promise<void> {
  await sql()`
    INSERT INTO public.campaign_events
      (campaign_id, company_id, campaign_contact_id, event_type, payload, created_by_user_id)
    VALUES (
      ${campaignId}::uuid, ${companyId}::uuid,
      ${campaignContactId ?? null}::uuid,
      ${eventType}, ${JSON.stringify(payload)}::jsonb,
      ${userId ?? null}::uuid
    )
  `;
}

export async function syncCampaignContactCounters(
  campaignId: string,
  companyId: string,
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaigns c
    SET total_contacts = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id
        ),
        skipped_count = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.status = 'skipped'
        ),
        sent_count = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.status IN ('sent', 'responded')
        ),
        failed_count = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.status IN ('failed', 'erro_envio')
        ),
        total_replied = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.status = 'responded'
        ),
        total_interested = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.response_intent = 'interested'
        ),
        total_opt_out = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.response_intent = 'opt_out'
        ),
        updated_at = now()
    WHERE c.id = ${campaignId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
  `;
}

/** Agenda campanha (draft → scheduled). Ritmo continua interno (auto_safe). */
export async function scheduleCampaign(
  companyId: string,
  campaignId: string,
  userId: string | null,
): Promise<CampaignDetail | null> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) return null;
  if (existing.status !== "draft" && existing.status !== "paused") {
    throw new Error("not_schedulable");
  }
  if (!existing.whatsapp_channel_id) throw new Error("missing_channel");
  if (!existing.message_text?.trim()) throw new Error("missing_message");
  if (!existing.schedule_date) throw new Error("missing_schedule_date");
  if (!existing.window_start_time || !existing.window_end_time) {
    throw new Error("missing_window");
  }

  const ch = await validateEvolutionChannel(companyId, existing.whatsapp_channel_id);
  if (!ch.ok) throw new Error("invalid_channel");

  const s = sql();
  const pending = await s<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'pending'
  `;
  if (parseInt(pending[0]?.count ?? "0", 10) < 1) throw new Error("no_pending_contacts");

  const rows = await s<CampaignRow[]>`
    UPDATE public.campaigns
    SET status = 'scheduled',
        send_mode = 'auto_safe',
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, schedule_date, window_start_time, window_end_time,
              send_mode, total_contacts, sent_count, failed_count, skipped_count,
              total_replied, total_interested, total_opt_out,
              created_by_user_id, created_at, updated_at
  `;
  if (!rows[0]) return null;

  await insertCampaignEvent(companyId, campaignId, "campaign.scheduled", userId, {
    schedule_date: existing.schedule_date,
    window_start_time: existing.window_start_time,
    window_end_time: existing.window_end_time,
  });
  return withChannelStatus(companyId, rows[0]);
}

export async function getCampaignById(
  companyId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const rows = await sql<CampaignRow[]>`
    SELECT
      c.id, c.company_id, c.whatsapp_channel_id, c.name, c.message_text,
      c.message_type, c.status, c.scheduled_at, c.started_at, c.finished_at,
      c.send_interval_ms, c.schedule_date, c.window_start_time, c.window_end_time,
      COALESCE(c.send_mode, 'auto_safe') AS send_mode,
      c.total_contacts, c.sent_count, c.failed_count, c.skipped_count,
      COALESCE(c.total_replied, 0) AS total_replied,
      COALESCE(c.total_interested, 0) AS total_interested,
      COALESCE(c.total_opt_out, 0) AS total_opt_out,
      c.created_by_user_id, c.created_at, c.updated_at,
      ch.name AS channel_name
    FROM public.campaigns c
    LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
      AND ch.company_id = c.company_id
      AND lower(ch.channel_type) = 'evolution'
    WHERE c.id = ${campaignId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getCampaignDetail(
  companyId: string,
  campaignId: string,
): Promise<CampaignDetail | null> {
  const campaign = await getCampaignById(companyId, campaignId);
  if (!campaign) return null;
  return withChannelStatus(companyId, campaign);
}

export async function createCampaign(
  companyId: string,
  userId: string | null,
  data: CampaignWriteInput & { name: string },
): Promise<CampaignDetail> {
  if (data.whatsapp_channel_id) {
    const ch = await validateEvolutionChannel(companyId, data.whatsapp_channel_id);
    if (!ch.ok) throw new Error(ch.error);
  }

  const scheduleDate = normalizeDateInput(data.schedule_date);
  const windowStart = normalizeTimeInput(data.window_start_time);
  const windowEnd = normalizeTimeInput(data.window_end_time);
  if (windowStart && windowEnd && windowStart === windowEnd) {
    throw new Error("invalid_window");
  }

  const rows = await sql<CampaignRow[]>`
    INSERT INTO public.campaigns (
      company_id, whatsapp_channel_id, name, message_text,
      message_type, status, send_interval_ms, send_mode,
      schedule_date, window_start_time, window_end_time,
      template_id, source_campaign_id,
      created_by_user_id
    )
    VALUES (
      ${companyId}::uuid,
      ${data.whatsapp_channel_id ?? null}::uuid,
      ${data.name},
      ${data.message_text ?? null},
      'text',
      'draft',
      5000,
      ${CAMPAIGN_SEND_MODE},
      ${scheduleDate}::date,
      ${windowStart}::time,
      ${windowEnd}::time,
      ${data.template_id ?? null}::uuid,
      ${data.source_campaign_id ?? null}::uuid,
      ${userId ?? null}::uuid
    )
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, schedule_date, window_start_time, window_end_time,
              send_mode, total_contacts, sent_count, failed_count, skipped_count,
              total_replied, total_interested, total_opt_out,
              created_by_user_id, created_at, updated_at
  `;
  const campaign = rows[0];
  await insertCampaignEvent(companyId, campaign.id, "campaign.created", userId, {
    name: data.name,
    send_mode: CAMPAIGN_SEND_MODE,
  });
  return withChannelStatus(companyId, campaign);
}

export async function updateCampaign(
  companyId: string,
  campaignId: string,
  userId: string | null,
  data: CampaignWriteInput,
): Promise<CampaignDetail | null> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) return null;
  if (existing.status !== "draft") {
    throw new Error("not_draft");
  }

  if (data.whatsapp_channel_id) {
    const ch = await validateEvolutionChannel(companyId, data.whatsapp_channel_id);
    if (!ch.ok) throw new Error(ch.error);
  }

  const nextName = data.name ?? existing.name;
  const nextMessage = data.message_text !== undefined ? data.message_text : existing.message_text;
  const nextChannel =
    data.whatsapp_channel_id !== undefined
      ? data.whatsapp_channel_id
      : existing.whatsapp_channel_id;
  const nextSchedule =
    data.schedule_date !== undefined
      ? normalizeDateInput(data.schedule_date)
      : existing.schedule_date
        ? String(existing.schedule_date).slice(0, 10)
        : null;
  const nextStart =
    data.window_start_time !== undefined
      ? normalizeTimeInput(data.window_start_time)
      : normalizeTimeInput(existing.window_start_time);
  const nextEnd =
    data.window_end_time !== undefined
      ? normalizeTimeInput(data.window_end_time)
      : normalizeTimeInput(existing.window_end_time);

  if (nextStart && nextEnd && nextStart === nextEnd) {
    throw new Error("invalid_window");
  }

  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET name = ${nextName},
        message_text = ${nextMessage},
        whatsapp_channel_id = ${nextChannel}::uuid,
        schedule_date = ${nextSchedule}::date,
        window_start_time = ${nextStart}::time,
        window_end_time = ${nextEnd}::time,
        send_mode = ${CAMPAIGN_SEND_MODE},
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'draft'
      AND deleted_at IS NULL
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, schedule_date, window_start_time, window_end_time,
              send_mode, total_contacts, sent_count, failed_count, skipped_count,
              total_replied, total_interested, total_opt_out,
              created_by_user_id, created_at, updated_at
  `;
  if (!rows[0]) return null;

  await insertCampaignEvent(
    companyId,
    campaignId,
    "campaign.updated",
    userId,
    data as Record<string, unknown>,
  );
  return withChannelStatus(companyId, rows[0]);
}

/** Prepara e grava a variação de mensagem para um contato da campanha (uso no worker de envio). */
export async function prepareCampaignContactMessage(
  companyId: string,
  campaignId: string,
  contactRowId: string,
): Promise<{ rendered_message: string; greeting_variant: string; closing_variant: string } | null> {
  const campaign = await getCampaignById(companyId, campaignId);
  if (!campaign?.message_text) return null;

  const rows = await sql<
    {
      id: string;
      phone: string;
      name: string | null;
      variables: Record<string, unknown> | null;
    }[]
  >`
    SELECT id, phone, name, variables
    FROM public.campaign_contacts
    WHERE id = ${contactRowId}::uuid
      AND campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const variation = buildVariedMessage(campaign.message_text, {
    ...(row.variables ?? {}),
    nome: row.name,
    name: row.name,
    phone: row.phone,
  });

  await sql`
    UPDATE public.campaign_contacts
    SET greeting_variant = ${variation.greeting_variant},
        closing_variant = ${variation.closing_variant},
        rendered_message = ${variation.rendered_message}
    WHERE id = ${row.id}::uuid
  `;

  return {
    rendered_message: variation.rendered_message,
    greeting_variant: variation.greeting_variant,
    closing_variant: variation.closing_variant,
  };
}

export async function deleteCampaign(
  companyId: string,
  campaignId: string,
  userId: string | null,
): Promise<boolean> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) return false;
  if (existing.status !== "draft") {
    throw new Error("not_draft");
  }

  await insertCampaignEvent(companyId, campaignId, "campaign.deleted", userId, {
    name: existing.name,
    soft_delete: true,
  });

  const rows = await sql<{ id: string }[]>`
    UPDATE public.campaigns
    SET deleted_at = now(), updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'draft'
      AND deleted_at IS NULL
    RETURNING id
  `;
  return !!rows[0];
}

export async function listCampaignContacts(
  companyId: string,
  campaignId: string,
  page: number,
  limit: number,
): Promise<{ contacts: CampaignContactRow[]; total: number }> {
  const offset = (page - 1) * limit;
  const countRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c ON c.id = cc.campaign_id
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
  `;
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const contacts = await sql<CampaignContactRow[]>`
    SELECT cc.id, cc.campaign_id, cc.company_id, cc.contact_id, cc.phone,
           cc.name, cc.variables, cc.status, cc.skip_reason,
           cc.greeting_variant, cc.closing_variant, cc.rendered_message,
           cc.responded_at, cc.response_text, cc.response_intent,
           cc.created_at
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c ON c.id = cc.campaign_id
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
    ORDER BY cc.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return { contacts, total };
}

export async function addCampaignContacts(
  companyId: string,
  campaignId: string,
  userId: string | null,
  contactIds: string[],
): Promise<{ added: number; skipped: number }> {
  const campaign = await getCampaignById(companyId, campaignId);
  if (!campaign) throw new Error("not_found");
  if (campaign.status !== "draft") throw new Error("not_draft");

  if (contactIds.length === 0) return { added: 0, skipped: 0 };

  const contacts = await sql<
    {
      id: string;
      phone: string;
      name: string | null;
      status: string | null;
      tags: string[] | null;
    }[]
  >`
    SELECT id, phone, name, status, tags
    FROM public.contacts
    WHERE company_id = ${companyId}::uuid
      AND id = ANY(${contactIds}::uuid[])
  `;

  let added = 0;
  let skipped = 0;

  for (const ct of contacts) {
    const phone = normalizePhone(ct.phone);

    let rowStatus = "pending";
    let skipReason: string | null = null;

    if (isInvalidCampaignPhone(phone)) {
      rowStatus = "skipped";
      skipReason = "invalid_phone";
    } else if (isOptOutContact({ status: ct.status, tags: ct.tags })) {
      rowStatus = "skipped";
      skipReason = ct.status === "inativo" || ct.status === "merged" ? "contact_inactive" : "opt_out";
    }

    try {
      // Duplicado na mesma campanha: ON CONFLICT (campaign_id, phone) ignora.
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO public.campaign_contacts
          (campaign_id, company_id, contact_id, phone, name, status, skip_reason)
        VALUES (
          ${campaignId}::uuid, ${companyId}::uuid, ${ct.id}::uuid,
          ${phone}, ${ct.name}, ${rowStatus}, ${skipReason}
        )
        ON CONFLICT (campaign_id, phone) DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) {
        if (rowStatus === "pending") added++;
        else skipped++;
      } else {
        skipped++; // duplicado
      }
    } catch {
      skipped++;
    }
  }

  skipped += contactIds.length - contacts.length;

  await syncCampaignContactCounters(campaignId, companyId);
  await insertCampaignEvent(companyId, campaignId, "contacts.added", userId, {
    requested: contactIds.length,
    added,
    skipped,
  });

  return { added, skipped };
}

export async function removeCampaignContact(
  companyId: string,
  campaignId: string,
  contactRowId: string,
  userId: string | null,
): Promise<boolean> {
  const campaign = await getCampaignById(companyId, campaignId);
  if (!campaign) return false;
  if (campaign.status !== "draft") throw new Error("not_draft");

  const deleted = await sql<{ id: string }[]>`
    DELETE FROM public.campaign_contacts cc
    USING public.campaigns c
    WHERE cc.id = ${contactRowId}::uuid
      AND cc.campaign_id = ${campaignId}::uuid
      AND c.id = cc.campaign_id
      AND c.company_id = ${companyId}::uuid
      AND c.status = 'draft'
      AND c.deleted_at IS NULL
    RETURNING cc.id
  `;
  if (!deleted[0]) return false;

  await syncCampaignContactCounters(campaignId, companyId);
  await insertCampaignEvent(companyId, campaignId, "contacts.removed", userId, {
    campaign_contact_id: contactRowId,
  });
  return true;
}

/** Nova campanha rascunho a partir de campanha anterior (sem copiar público/histórico). */
export async function createCampaignFromSource(
  companyId: string,
  userId: string | null,
  sourceCampaignId: string,
  opts?: { name?: string },
): Promise<CampaignDetail | null> {
  const source = await getCampaignById(companyId, sourceCampaignId);
  if (!source) return null;

  const suffix = new Date().toLocaleDateString("pt-BR");
  const name = opts?.name?.trim() || `${source.name} — novo disparo ${suffix}`;

  return createCampaign(companyId, userId, {
    name,
    message_text: source.message_text,
    whatsapp_channel_id: source.whatsapp_channel_id,
    source_campaign_id: sourceCampaignId,
    schedule_date: null,
    window_start_time: source.window_start_time
      ? String(source.window_start_time).slice(0, 5)
      : null,
    window_end_time: source.window_end_time
      ? String(source.window_end_time).slice(0, 5)
      : null,
  });
}

/** Nova campanha rascunho a partir de modelo salvo. */
export async function createCampaignFromTemplate(
  companyId: string,
  userId: string | null,
  templateId: string,
  data: CampaignWriteInput & { name: string },
): Promise<CampaignDetail | null> {
  const tpl = await getCampaignTemplate(companyId, templateId);
  if (!tpl) return null;

  return createCampaign(companyId, userId, {
    ...data,
    message_text: data.message_text ?? tpl.message_body,
    template_id: templateId,
  });
}
