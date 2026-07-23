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
  assertApprovedMetaTemplate,
} from "@/lib/meta-message-templates.server";
import {
  CAMPAIGN_SEND_MODE,
  buildVariedMessage,
  isInvalidCampaignPhone,
  isOptOutContact,
} from "@/lib/campaign-send-policy";
import { getCampaignTemplate } from "@/lib/campaign-template.server";
import { stripTemplateMetadata } from "@/lib/campaign-template-metadata";
import { renderEvolutionTemplateBody } from "@/lib/campaign-template-variables";
import {
  isCampaignManualPauseAllowed,
  isCampaignManualResumeAllowed,
  isCampaignManualStartAllowed,
  MANUAL_PAUSED_STATUS,
} from "@/lib/campaign-manual-control";

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
  pending_count?: number;
  processing_count?: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  channel_name?: string | null;
  template_id?: string | null;
  meta_template_id?: string | null;
  meta_template_name?: string | null;
  meta_language_code?: string | null;
  meta_variable_mappings?: Record<string, string> | null;
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

function parseMappings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Garante template Meta APPROVED+active do mesmo canal/empresa. */
async function resolveValidatedMetaTemplateFields(opts: {
  companyId: string;
  channelId: string | null | undefined;
  templateName: string | null | undefined;
  languageCode: string | null | undefined;
  mappings?: Record<string, string> | null;
}): Promise<{
  meta_template_id: string;
  meta_template_name: string;
  meta_language_code: string;
  meta_variable_mappings: Record<string, string>;
}> {
  if (!opts.channelId) throw new Error("invalid_channel");
  if (!opts.templateName?.trim() || !opts.languageCode?.trim()) {
    throw new Error("missing_meta_template");
  }
  const checked = await assertApprovedMetaTemplate({
    companyId: opts.companyId,
    channelId: opts.channelId,
    templateName: opts.templateName,
    languageCode: opts.languageCode,
  });
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const mappings = parseMappings(opts.mappings);
  if (checked.row.template_name === "abordagem_inicial_troca_refil" && !mappings["1"]) {
    mappings["1"] = "name";
  }
  return {
    meta_template_id: checked.row.meta_template_id ?? checked.row.id,
    meta_template_name: checked.row.template_name,
    meta_language_code: checked.row.language_code,
    meta_variable_mappings: mappings,
  };
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
  meta_template_id?: string | null;
  meta_template_name?: string | null;
  meta_language_code?: string | null;
  meta_variable_mappings?: Record<string, string> | null;
  message_type?: "text" | "meta_template";
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
            c.meta_template_id, c.meta_template_name, c.meta_language_code,
            COALESCE(c.meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
            ch.name AS channel_name
          FROM public.campaigns c
          LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
            AND ch.company_id = c.company_id
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
            c.meta_template_id, c.meta_template_name, c.meta_language_code,
            COALESCE(c.meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
            ch.name AS channel_name
          FROM public.campaigns c
          LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
            AND ch.company_id = c.company_id
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

/** Canal Evolution ou Meta ativo da empresa (campanhas). */
export async function validateCampaignChannel(
  companyId: string,
  channelId: string,
): Promise<
  | { ok: true; id: string; channel_type: "evolution" | "meta" }
  | { ok: false; error: string }
> {
  const rows = await sql<{ id: string; channel_type: string }[]>`
    SELECT id, lower(channel_type) AS channel_type
    FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND COALESCE(active, true) = true
      AND lower(channel_type) IN ('evolution', 'meta')
    LIMIT 1
  `;
  if (!rows[0]) return { ok: false, error: "invalid_channel" };
  const channel_type = rows[0].channel_type === "meta" ? "meta" : "evolution";
  return { ok: true, id: rows[0].id, channel_type };
}

export async function isSavedChannelAvailable(
  companyId: string,
  channelId: string | null,
): Promise<boolean> {
  if (!channelId) return true;
  const result = await validateCampaignChannel(companyId, channelId);
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
  const isMetaTemplate =
    existing.message_type === "meta_template" || !!existing.meta_template_name?.trim();
  if (isMetaTemplate) {
    if (!existing.meta_template_name?.trim() || !existing.meta_language_code?.trim()) {
      throw new Error("missing_meta_template");
    }
    const checked = await assertApprovedMetaTemplate({
      companyId,
      channelId: existing.whatsapp_channel_id,
      templateName: existing.meta_template_name,
      languageCode: existing.meta_language_code,
    });
    if (!checked.ok) throw new Error(checked.error);
  } else if (!existing.message_text?.trim()) {
    throw new Error("missing_message");
  }
  if (!existing.schedule_date) throw new Error("missing_schedule_date");
  if (!existing.window_start_time || !existing.window_end_time) {
    throw new Error("missing_window");
  }

  const ch = await validateCampaignChannel(companyId, existing.whatsapp_channel_id);
  if (!ch.ok) throw new Error("invalid_channel");
  if (isMetaTemplate && ch.channel_type !== "meta") {
    throw new Error("invalid_channel");
  }
  if (!isMetaTemplate && ch.channel_type !== "evolution") {
    throw new Error("invalid_channel");
  }

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
              meta_template_id, meta_template_name, meta_language_code,
              COALESCE(meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
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

async function countPendingCampaignContacts(
  companyId: string,
  campaignId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'pending'
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
}

async function validateCampaignReadyToSend(
  existing: CampaignRow,
  companyId: string,
): Promise<void> {
  if (!existing.whatsapp_channel_id) throw new Error("missing_channel");

  const isMetaTemplate =
    existing.message_type === "meta_template" || !!existing.meta_template_name?.trim();

  if (isMetaTemplate) {
    if (!existing.meta_template_name?.trim() || !existing.meta_language_code?.trim()) {
      throw new Error("missing_meta_template");
    }
    const checked = await assertApprovedMetaTemplate({
      companyId,
      channelId: existing.whatsapp_channel_id,
      templateName: existing.meta_template_name,
      languageCode: existing.meta_language_code,
    });
    if (!checked.ok) throw new Error(checked.error);
  } else if (!existing.message_text?.trim()) {
    throw new Error("missing_message");
  }

  if (!existing.window_start_time || !existing.window_end_time) {
    throw new Error("missing_window");
  }

  const ch = await validateCampaignChannel(companyId, existing.whatsapp_channel_id);
  if (!ch.ok) throw new Error("invalid_channel");
  if (isMetaTemplate && ch.channel_type !== "meta") throw new Error("invalid_channel");
  if (!isMetaTemplate && ch.channel_type !== "evolution") throw new Error("invalid_channel");
}

/** Inicia disparo manual imediato (draft/scheduled/paused → running). */
export async function startCampaignNow(
  companyId: string,
  campaignId: string,
  userId: string | null,
): Promise<{ campaign: CampaignDetail; pendingCount: number; previousStatus: string }> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) throw new Error("not_found");

  console.log("[CAMPAIGN_MANUAL_START_REQUEST]", {
    campaignId,
    companyId,
    userId,
    previousStatus: existing.status,
    pending_count: existing.pending_count ?? 0,
  });

  if (existing.status === "running") {
    console.log("[CAMPAIGN_MANUAL_START_REJECTED]", {
      campaignId,
      companyId,
      userId,
      reason: "already_running",
      previousStatus: existing.status,
    });
    throw new Error("already_running");
  }

  if (existing.status === "completed") {
    console.log("[CAMPAIGN_MANUAL_START_REJECTED]", {
      campaignId,
      companyId,
      userId,
      reason: "already_completed",
      previousStatus: existing.status,
    });
    throw new Error("already_completed");
  }

  if (!isCampaignManualStartAllowed(existing.status)) {
    console.log("[CAMPAIGN_MANUAL_START_REJECTED]", {
      campaignId,
      companyId,
      userId,
      reason: "not_startable",
      previousStatus: existing.status,
    });
    throw new Error("not_startable");
  }

  await validateCampaignReadyToSend(existing, companyId);

  const pendingCount = await countPendingCampaignContacts(companyId, campaignId);
  if (pendingCount < 1) {
    console.log("[CAMPAIGN_MANUAL_START_REJECTED]", {
      campaignId,
      companyId,
      userId,
      reason: "no_pending_contacts",
      previousStatus: existing.status,
      pending_count: pendingCount,
    });
    throw new Error("no_pending_contacts");
  }

  const detail = await withChannelStatus(companyId, existing);
  if (detail.channel_unavailable) {
    console.log("[CAMPAIGN_MANUAL_START_REJECTED]", {
      campaignId,
      companyId,
      userId,
      reason: "invalid_channel",
      previousStatus: existing.status,
    });
    throw new Error("invalid_channel");
  }

  const previousStatus = existing.status;
  const scheduleDate =
    existing.schedule_date != null
      ? String(existing.schedule_date).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET status = 'running',
        send_mode = 'auto_safe',
        scheduled_at = now(),
        started_at = COALESCE(started_at, now()),
        schedule_date = COALESCE(schedule_date, ${scheduleDate}::date),
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND status IN ('draft', 'scheduled', 'paused', ${MANUAL_PAUSED_STATUS})
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, schedule_date, window_start_time, window_end_time,
              send_mode, total_contacts, sent_count, failed_count, skipped_count,
              total_replied, total_interested, total_opt_out,
              meta_template_id, meta_template_name, meta_language_code,
              COALESCE(meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
              created_by_user_id, created_at, updated_at
  `;

  if (!rows[0]) {
    const current = await getCampaignById(companyId, campaignId);
    if (current?.status === "running") {
      throw new Error("already_running");
    }
    throw new Error("not_startable");
  }

  await insertCampaignEvent(companyId, campaignId, "campaign.manual_started", userId, {
    previous_status: previousStatus,
    pending_count: pendingCount,
    schedule_date: scheduleDate,
  });

  const campaign = await getCampaignDetail(companyId, campaignId);
  if (!campaign) throw new Error("not_found");

  console.log("[CAMPAIGN_MANUAL_START_SUCCESS]", {
    campaignId,
    companyId,
    userId,
    previousStatus,
    newStatus: campaign.status,
    pending_count: pendingCount,
  });

  return { campaign, pendingCount, previousStatus };
}

/** Pausa manual — impede novos envios até retomar. */
export async function pauseCampaignManually(
  companyId: string,
  campaignId: string,
  userId: string | null,
): Promise<CampaignDetail> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) throw new Error("not_found");

  if (!isCampaignManualPauseAllowed(existing.status)) {
    throw new Error("not_pausable");
  }

  const previousStatus = existing.status;
  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET status = ${MANUAL_PAUSED_STATUS},
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND status IN ('running', 'scheduled')
    RETURNING id
  `;
  if (!rows[0]) throw new Error("not_pausable");

  await insertCampaignEvent(companyId, campaignId, "campaign.manual_paused", userId, {
    previous_status: previousStatus,
  });

  console.log("[CAMPAIGN_MANUAL_PAUSE]", {
    campaignId,
    companyId,
    userId,
    previousStatus,
    newStatus: MANUAL_PAUSED_STATUS,
    pending_count: existing.pending_count ?? 0,
  });

  const campaign = await getCampaignDetail(companyId, campaignId);
  if (!campaign) throw new Error("not_found");
  return campaign;
}

/** Retoma disparo manualmente. */
export async function resumeCampaignManually(
  companyId: string,
  campaignId: string,
  userId: string | null,
): Promise<CampaignDetail> {
  const existing = await getCampaignById(companyId, campaignId);
  if (!existing) throw new Error("not_found");

  if (!isCampaignManualResumeAllowed(existing.status)) {
    throw new Error("not_resumable");
  }

  const pendingCount = await countPendingCampaignContacts(companyId, campaignId);
  const previousStatus = existing.status;

  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET status = 'running',
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND status IN ('paused', ${MANUAL_PAUSED_STATUS})
    RETURNING id
  `;
  if (!rows[0]) throw new Error("not_resumable");

  await insertCampaignEvent(companyId, campaignId, "campaign.manual_resumed", userId, {
    previous_status: previousStatus,
    pending_count: pendingCount,
  });

  console.log("[CAMPAIGN_MANUAL_RESUME]", {
    campaignId,
    companyId,
    userId,
    previousStatus,
    newStatus: "running",
    pending_count: pendingCount,
  });

  const campaign = await getCampaignDetail(companyId, campaignId);
  if (!campaign) throw new Error("not_found");
  return campaign;
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
      (
        SELECT COUNT(*)::int FROM public.campaign_contacts cc
        WHERE cc.campaign_id = c.id AND cc.status = 'pending'
      ) AS pending_count,
      (
        SELECT COUNT(*)::int FROM public.campaign_contacts cc
        WHERE cc.campaign_id = c.id AND cc.status = 'processing'
      ) AS processing_count,
      c.created_by_user_id, c.created_at, c.updated_at,
      c.template_id,
      c.meta_template_id, c.meta_template_name, c.meta_language_code,
      COALESCE(c.meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
      ch.name AS channel_name
    FROM public.campaigns c
    LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
      AND ch.company_id = c.company_id
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
  let channelType: "evolution" | "meta" | null = null;
  if (data.whatsapp_channel_id) {
    const ch = await validateCampaignChannel(companyId, data.whatsapp_channel_id);
    if (!ch.ok) throw new Error(ch.error);
    channelType = ch.channel_type;
  }

  const scheduleDate = normalizeDateInput(data.schedule_date);
  const windowStart = normalizeTimeInput(data.window_start_time);
  const windowEnd = normalizeTimeInput(data.window_end_time);
  if (windowStart && windowEnd && windowStart === windowEnd) {
    throw new Error("invalid_window");
  }

  const isMeta =
    data.message_type === "meta_template" ||
    channelType === "meta" ||
    !!data.meta_template_name?.trim();
  const messageType = isMeta ? "meta_template" : "text";

  let metaFields: {
    meta_template_id: string | null;
    meta_template_name: string | null;
    meta_language_code: string | null;
    meta_variable_mappings: Record<string, string>;
  } = {
    meta_template_id: null,
    meta_template_name: null,
    meta_language_code: null,
    meta_variable_mappings: {},
  };

  if (isMeta && data.meta_template_name?.trim() && data.meta_language_code?.trim()) {
    metaFields = await resolveValidatedMetaTemplateFields({
      companyId,
      channelId: data.whatsapp_channel_id,
      templateName: data.meta_template_name,
      languageCode: data.meta_language_code,
      mappings: data.meta_variable_mappings,
    });
  } else if (isMeta && data.meta_template_name?.trim() && !data.meta_language_code?.trim()) {
    throw new Error("missing_meta_template");
  }

  const rows = await sql<CampaignRow[]>`
    INSERT INTO public.campaigns (
      company_id, whatsapp_channel_id, name, message_text,
      message_type, status, send_interval_ms, send_mode,
      schedule_date, window_start_time, window_end_time,
      template_id, source_campaign_id,
      meta_template_id, meta_template_name, meta_language_code, meta_variable_mappings,
      created_by_user_id
    )
    VALUES (
      ${companyId}::uuid,
      ${data.whatsapp_channel_id ?? null}::uuid,
      ${data.name},
      ${data.message_text ?? null},
      ${messageType},
      'draft',
      5000,
      ${CAMPAIGN_SEND_MODE},
      ${scheduleDate}::date,
      ${windowStart}::time,
      ${windowEnd}::time,
      ${isMeta ? null : (data.template_id ?? null)}::uuid,
      ${data.source_campaign_id ?? null}::uuid,
      ${metaFields.meta_template_id},
      ${metaFields.meta_template_name},
      ${metaFields.meta_language_code},
      ${JSON.stringify(metaFields.meta_variable_mappings)}::jsonb,
      ${userId ?? null}::uuid
    )
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, schedule_date, window_start_time, window_end_time,
              send_mode, total_contacts, sent_count, failed_count, skipped_count,
              total_replied, total_interested, total_opt_out,
              meta_template_id, meta_template_name, meta_language_code,
              COALESCE(meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
              created_by_user_id, created_at, updated_at
  `;
  const campaign = rows[0];
  await insertCampaignEvent(companyId, campaign.id, "campaign.created", userId, {
    name: data.name,
    send_mode: CAMPAIGN_SEND_MODE,
    message_type: messageType,
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

  let channelType: "evolution" | "meta" | null = null;
  if (data.whatsapp_channel_id) {
    const ch = await validateCampaignChannel(companyId, data.whatsapp_channel_id);
    if (!ch.ok) throw new Error(ch.error);
    channelType = ch.channel_type;
  } else if (existing.whatsapp_channel_id) {
    const ch = await validateCampaignChannel(companyId, existing.whatsapp_channel_id);
    if (ch.ok) channelType = ch.channel_type;
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

  const nextMetaName =
    data.meta_template_name !== undefined
      ? data.meta_template_name
      : existing.meta_template_name ?? null;
  const nextMetaLang =
    data.meta_language_code !== undefined
      ? data.meta_language_code
      : existing.meta_language_code ?? null;
  const nextMappings =
    data.meta_variable_mappings !== undefined
      ? parseMappings(data.meta_variable_mappings)
      : parseMappings(existing.meta_variable_mappings);

  const isMeta =
    data.message_type === "meta_template" ||
    channelType === "meta" ||
    !!nextMetaName?.trim();
  const messageType = isMeta ? "meta_template" : "text";

  let metaFields: {
    meta_template_id: string | null;
    meta_template_name: string | null;
    meta_language_code: string | null;
    meta_variable_mappings: Record<string, string>;
  } = {
    meta_template_id: null,
    meta_template_name: null,
    meta_language_code: null,
    meta_variable_mappings: {},
  };

  if (isMeta && nextMetaName?.trim() && nextMetaLang?.trim()) {
    metaFields = await resolveValidatedMetaTemplateFields({
      companyId,
      channelId: nextChannel,
      templateName: nextMetaName,
      languageCode: nextMetaLang,
      mappings: nextMappings,
    });
  } else if (isMeta && nextMetaName?.trim() && !nextMetaLang?.trim()) {
    throw new Error("missing_meta_template");
  }

  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET name = ${nextName},
        message_text = ${nextMessage},
        whatsapp_channel_id = ${nextChannel}::uuid,
        schedule_date = ${nextSchedule}::date,
        window_start_time = ${nextStart}::time,
        window_end_time = ${nextEnd}::time,
        message_type = ${messageType},
        meta_template_id = ${metaFields.meta_template_id},
        meta_template_name = ${metaFields.meta_template_name},
        meta_language_code = ${metaFields.meta_language_code},
        meta_variable_mappings = ${JSON.stringify(metaFields.meta_variable_mappings)}::jsonb,
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
              meta_template_id, meta_template_name, meta_language_code,
              COALESCE(meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
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
  if (!campaign) return null;

  let messageTemplate = campaign.message_text?.trim() ?? "";
  let templateMeta: Awaited<ReturnType<typeof getCampaignTemplate>> | null = null;

  if (campaign.template_id) {
    templateMeta = await getCampaignTemplate(companyId, campaign.template_id);
    if (templateMeta) {
      messageTemplate = templateMeta.visible_body;
    }
  }

  if (!messageTemplate) return null;

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

  const contactVars = {
    ...(row.variables ?? {}),
    nome: row.name,
    name: row.name,
    telefone: row.phone,
    phone: row.phone,
  };

  const usesBraceVars = /\{[a-zA-Z0-9_]+\}/.test(messageTemplate);
  let rendered_message: string;
  let greeting_variant = "";
  let closing_variant = "";

  if (usesBraceVars || templateMeta) {
    rendered_message = renderEvolutionTemplateBody(
      stripTemplateMetadata(messageTemplate),
      contactVars,
    );
  } else {
    const variation = buildVariedMessage(messageTemplate, contactVars);
    rendered_message = variation.rendered_message;
    greeting_variant = variation.greeting_variant;
    closing_variant = variation.closing_variant;
  }

  await sql`
    UPDATE public.campaign_contacts
    SET greeting_variant = ${greeting_variant || null},
        closing_variant = ${closing_variant || null},
        rendered_message = ${rendered_message}
    WHERE id = ${row.id}::uuid
  `;

  return {
    rendered_message,
    greeting_variant,
    closing_variant,
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
