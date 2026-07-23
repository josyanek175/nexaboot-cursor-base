/**
 * Worker de envio de campanhas (Automático seguro).
 * Usa exclusivamente campaign-send-policy.ts para ritmo/janela/variação.
 * Não lê intervalo/velocidade da API pública.
 */
import { sql, ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { normalizePhone, normalizePhoneE164, normalizePhoneForMatch, isValidE164Digits } from "@/lib/phone";
import {
  nextAllowedSendAt,
  nextBlockSize,
  nextPauseAfterSend,
  isInvalidCampaignPhone,
} from "@/lib/campaign-send-policy";
import {
  insertCampaignEvent,
  prepareCampaignContactMessage,
  syncCampaignContactCounters,
} from "@/lib/campaign.server";
import { getCampaignTemplate } from "@/lib/campaign-template.server";
import { isPhoneInOptOutList } from "@/lib/campaign-response.server";
import { sendMetaTemplateMessage } from "@/lib/meta-send-message.server";
import {
  assertApprovedMetaTemplate,
  buildMetaTemplateBodyParameters,
  renderMetaTemplateFromComponents,
} from "@/lib/meta-message-templates.server";
import {
  describeTemplateComponents,
  ensureMetaTemplateOutboundBody,
  normalizeTemplateComponents,
  previewText,
} from "@/lib/meta-template-render";
import {
  classifyCampaignSendError,
  classifyThrownError,
  readProcessingStaleMs,
  DEFAULT_MAX_SEND_ATTEMPTS,
  TRANSIENT_RETRY_DELAY_MS,
  type ClassifiedSendError,
} from "@/lib/campaign-worker-processing";
import { MANUAL_PAUSED_STATUS } from "@/lib/campaign-manual-control";
import {
  aggregateIdleTickDelay,
  computeCampaignWakeupMs,
  getScheduleStart,
  isCampaignOutsideSendWindow,
  type CampaignSkipReason,
} from "@/lib/campaign-worker-selection";

const SYSTEM_SENDER_NAME = "Disparo Automático";

type WorkerCampaign = {
  id: string;
  company_id: string;
  whatsapp_channel_id: string;
  name: string;
  message_text: string | null;
  message_type: string;
  status: string;
  schedule_date: string | null;
  window_start_time: string | null;
  window_end_time: string | null;
  sent_count: number;
  evolution_instance_name: string | null;
  channel_type: string;
  meta_template_name: string | null;
  meta_language_code: string | null;
  meta_variable_mappings: Record<string, string>;
  template_id: string | null;
  started_at: string | null;
};

type PendingContact = {
  id: string;
  phone: string;
  name: string | null;
  contact_id: string | null;
  rendered_message: string | null;
  variables?: Record<string, unknown> | null;
};

export type WorkerTickResult = {
  ok: boolean;
  action:
    | "idle"
    | "sent"
    | "failed"
    | "paused"
    | "completed"
    | "waiting_window"
    | "error";
  campaignId?: string;
  contactId?: string;
  delayMs: number;
  message?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function dateStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v).slice(0, 10);
}

async function sendTextEvolution(
  instance: string,
  number: string,
  text: string,
): Promise<{ ok: true; providerId: string | null } | { ok: false; error: string }> {
  const apiUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  if (!apiUrl || !apiKey) {
    return { ok: false, error: "missing_evolution_config" };
  }

  try {
    const res = await fetch(
      `${apiUrl}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number, text }),
      },
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      console.error("[CAMPAIGN_WORKER_EVO_ERROR]", {
        status: res.status,
        body: body.slice(0, 400),
        instance,
        number,
      });
      return {
        ok: false,
        error: `evolution_http_${res.status}:${body.slice(0, 200)}`,
      };
    }
    let providerId: string | null = null;
    try {
      providerId = JSON.parse(body)?.key?.id ?? null;
    } catch {
      /* ignore */
    }
    return { ok: true, providerId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[CAMPAIGN_WORKER_EVO_UNREACHABLE]", msg);
    return { ok: false, error: `evolution_unreachable:${msg}` };
  }
}

async function ensureContactForCampaign(
  companyId: string,
  phone: string,
  name: string | null,
  existingContactId: string | null,
): Promise<string> {
  const s = sql();
  if (existingContactId) {
    const ok = await s<{ id: string }[]>`
      SELECT id FROM public.contacts
      WHERE id = ${existingContactId}::uuid AND company_id = ${companyId}::uuid
      LIMIT 1
    `;
    if (ok[0]) return ok[0].id;
  }

  const phoneMatch = normalizePhoneForMatch(phone);
  const existing = await s<{ id: string }[]>`
    SELECT id FROM public.contacts
    WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
    ORDER BY (status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo') DESC,
             created_at ASC
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;

  const finalName = name?.trim() || phone;
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.contacts
      (company_id, phone, phone_match, name, name_source, external_jid, contact_type, status)
    VALUES
      (${companyId}::uuid, ${phone}, ${phoneMatch}, ${finalName}, 'campaign',
       ${`${phone}@s.whatsapp.net`}, 'individual', 'ativo')
    RETURNING id
  `;
  return inserted[0].id;
}

async function ensureConversationForCampaign(
  companyId: string,
  channelId: string,
  contactId: string,
): Promise<string> {
  const s = sql();
  const existing = await s<{ id: string; status: string | null }[]>`
    SELECT id, status FROM public.conversations
    WHERE company_id = ${companyId}::uuid
      AND whatsapp_channel_id = ${channelId}::uuid
      AND contact_id = ${contactId}::uuid
      AND status IS DISTINCT FROM 'merged'
      AND status IS DISTINCT FROM 'archived'
    ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  if (existing[0]) {
    if (existing[0].status !== "open") {
      await s`
        UPDATE public.conversations
        SET status = 'open', updated_at = now()
        WHERE id = ${existing[0].id}::uuid
      `;
    }
    return existing[0].id;
  }
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.conversations
      (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
    VALUES
      (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid, 'open', 0, now())
    RETURNING id
  `;
  return inserted[0].id;
}

async function saveOutboundCampaignMessage(opts: {
  conversationId: string;
  text: string;
  providerId: string | null;
  campaignId: string;
  campaignContactId: string;
  metaTemplate?: {
    template_name: string;
    template_language: string;
    template_category: string | null;
    template_components: unknown;
    body_parameters: string[];
    template_buttons: string[];
    provider_message_id: string | null;
    wamid: string | null;
  };
  evolutionTemplate?: {
    campaign_template_id: string | null;
    channel_type: "evolution";
    rendered_variables: Record<string, unknown>;
    response_options: Array<{ n: number; label: string; intent: string }>;
  };
}): Promise<void> {
  const s = sql();
  const payload: Record<string, unknown> = {
    origin: "CAMPANHA",
    campaign_id: opts.campaignId,
    campaign_contact_id: opts.campaignContactId,
    sender: SYSTEM_SENDER_NAME,
  };
  if (opts.metaTemplate) {
    payload.meta_template = opts.metaTemplate;
  }
  if (opts.evolutionTemplate) {
    payload.channel_type = opts.evolutionTemplate.channel_type;
    payload.campaign_template_id = opts.evolutionTemplate.campaign_template_id;
    payload.rendered_variables = opts.evolutionTemplate.rendered_variables;
    payload.response_options = opts.evolutionTemplate.response_options;
  }

  if (opts.providerId) {
    await s`
      INSERT INTO public.messages (
        conversation_id, external_id, external_message_id, direction,
        message_type, message_text, from_me, status,
        sent_by_user_id, sent_by_name, raw_payload
      ) VALUES (
        ${opts.conversationId}::uuid,
        ${opts.providerId},
        ${opts.providerId},
        'out',
        'text',
        ${opts.text},
        true,
        'sent',
        NULL,
        ${SYSTEM_SENDER_NAME},
        ${JSON.stringify(payload)}::jsonb
      )
      ON CONFLICT (conversation_id, external_message_id)
        WHERE external_message_id IS NOT NULL
      DO UPDATE SET
        message_text = EXCLUDED.message_text,
        raw_payload = EXCLUDED.raw_payload,
        status = EXCLUDED.status
    `;
  } else {
    await s`
      INSERT INTO public.messages (
        conversation_id, external_id, external_message_id, direction,
        message_type, message_text, from_me, status,
        sent_by_user_id, sent_by_name, raw_payload
      ) VALUES (
        ${opts.conversationId}::uuid,
        ${opts.providerId},
        ${opts.providerId},
        'out',
        'text',
        ${opts.text},
        true,
        'sent',
        NULL,
        ${SYSTEM_SENDER_NAME},
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  }
  await s`
    UPDATE public.conversations
    SET last_message = ${opts.text},
        last_message_at = now(),
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
  `;
}

async function loadDueCampaigns(): Promise<WorkerCampaign[]> {
  const s = sql();
  const rows = await s<Record<string, unknown>[]>`
    SELECT
      c.id, c.company_id, c.whatsapp_channel_id, c.name, c.message_text,
      c.message_type, c.status, c.schedule_date, c.window_start_time, c.window_end_time,
      c.sent_count, c.started_at,
      c.meta_template_name, c.meta_language_code,
      COALESCE(c.meta_variable_mappings, '{}'::jsonb) AS meta_variable_mappings,
      c.template_id,
      ch.evolution_instance_name,
      lower(ch.channel_type) AS channel_type
    FROM public.campaigns c
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.deleted_at IS NULL
      AND c.status IN ('scheduled', 'running', 'paused')
      AND c.whatsapp_channel_id IS NOT NULL
      AND COALESCE(c.send_mode, 'auto_safe') = 'auto_safe'
      AND ch.deleted_at IS NULL
      AND COALESCE(ch.active, true) = true
      AND (
        (
          lower(ch.channel_type) = 'evolution'
          AND c.message_text IS NOT NULL
          AND btrim(c.message_text) <> ''
        )
        OR (
          lower(ch.channel_type) = 'meta'
          AND c.meta_template_name IS NOT NULL
          AND btrim(c.meta_template_name) <> ''
          AND c.meta_language_code IS NOT NULL
          AND btrim(c.meta_language_code) <> ''
        )
      )
    ORDER BY
      CASE c.status WHEN 'running' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
      c.updated_at ASC
    LIMIT 20
  `;

  return rows.map((r) => {
    const mappingsRaw = r.meta_variable_mappings;
    const mappings: Record<string, string> = {};
    if (mappingsRaw && typeof mappingsRaw === "object" && !Array.isArray(mappingsRaw)) {
      for (const [k, v] of Object.entries(mappingsRaw as Record<string, unknown>)) {
        if (typeof v === "string") mappings[k] = v;
      }
    }
    return {
      id: String(r.id),
      company_id: String(r.company_id),
      whatsapp_channel_id: String(r.whatsapp_channel_id),
      name: String(r.name),
      message_text: r.message_text != null ? String(r.message_text) : null,
      message_type: String(r.message_type ?? "text"),
      status: String(r.status),
      schedule_date: dateStr(r.schedule_date),
      window_start_time: timeStr(r.window_start_time),
      window_end_time: timeStr(r.window_end_time),
      sent_count: Number(r.sent_count ?? 0),
      evolution_instance_name: r.evolution_instance_name
        ? String(r.evolution_instance_name)
        : null,
      channel_type: String(r.channel_type ?? "evolution"),
      meta_template_name: r.meta_template_name ? String(r.meta_template_name) : null,
      meta_language_code: r.meta_language_code ? String(r.meta_language_code) : null,
      meta_variable_mappings: mappings,
      template_id: r.template_id ? String(r.template_id) : null,
      started_at: r.started_at ? String(r.started_at) : null,
    };
  });
}

async function claimNextPendingContact(
  companyId: string,
  campaignId: string,
): Promise<PendingContact | null> {
  const s = sql();
  // Reserva atômica: pending → processing (SKIP LOCKED evita dois ticks no mesmo contato).
  const rows = await s<PendingContact[]>`
    WITH next AS (
      SELECT id
      FROM public.campaign_contacts
      WHERE campaign_id = ${campaignId}::uuid
        AND company_id = ${companyId}::uuid
        AND status = 'pending'
        AND (provider_message_id IS NULL OR btrim(provider_message_id) = '')
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE public.campaign_contacts cc
    SET status = 'processing'
    FROM next
    WHERE cc.id = next.id
      AND cc.company_id = ${companyId}::uuid
      AND cc.status = 'pending'
      AND (cc.provider_message_id IS NULL OR btrim(cc.provider_message_id) = '')
    RETURNING cc.id, cc.phone, cc.name, cc.contact_id, cc.rendered_message, cc.variables
  `;
  return rows[0] ?? null;
}

async function setCampaignStatus(
  companyId: string,
  campaignId: string,
  status: string,
  extra: { started?: boolean; finished?: boolean } = {},
): Promise<void> {
  const s = sql();
  if (extra.started) {
    await s`
      UPDATE public.campaigns
      SET status = ${status},
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = ${campaignId}::uuid AND company_id = ${companyId}::uuid
    `;
  } else if (extra.finished) {
    await s`
      UPDATE public.campaigns
      SET status = ${status},
          finished_at = now(),
          updated_at = now()
      WHERE id = ${campaignId}::uuid AND company_id = ${companyId}::uuid
    `;
  } else {
    await s`
      UPDATE public.campaigns
      SET status = ${status}, updated_at = now()
      WHERE id = ${campaignId}::uuid AND company_id = ${companyId}::uuid
    `;
  }
}

async function markContactSent(
  companyId: string,
  contactRowId: string,
  providerId: string | null,
): Promise<boolean> {
  const s = sql();
  const rows = await s<{ id: string }[]>`
    UPDATE public.campaign_contacts
    SET status = 'sent',
        sent_at = now(),
        provider_message_id = COALESCE(${providerId}, provider_message_id),
        error_code = NULL,
        error_message = NULL
    WHERE id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('processing', 'pending')
      AND (provider_message_id IS NULL OR btrim(provider_message_id) = '' OR provider_message_id = ${providerId})
    RETURNING id
  `;
  return rows.length > 0;
}

async function markContactFailed(
  companyId: string,
  contactRowId: string,
  error: string,
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaign_contacts
    SET status = 'failed',
        error_code = 'erro_envio',
        error_message = ${error.slice(0, 1000)}
    WHERE id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('processing', 'pending')
      AND (provider_message_id IS NULL OR btrim(provider_message_id) = '')
  `;
}

async function markContactSkipped(
  companyId: string,
  contactRowId: string,
  reason: string,
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaign_contacts
    SET status = 'skipped',
        skip_reason = ${reason}
    WHERE id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('pending', 'processing')
      AND (provider_message_id IS NULL OR btrim(provider_message_id) = '')
  `;
}

async function releaseContactClaim(
  companyId: string,
  contactRowId: string,
  reason: string,
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaign_contacts
    SET status = 'pending',
        error_code = 'claim_rollback',
        error_message = ${reason.slice(0, 1000)}
    WHERE id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'processing'
      AND (provider_message_id IS NULL OR btrim(provider_message_id) = '')
  `;
  await s`
    UPDATE public.campaign_send_queue
    SET locked_at = NULL,
        locked_by = NULL,
        status = 'pending'
    WHERE campaign_contact_id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('pending', 'processing')
  `;
}

/** pending/processing com wamid → sent (evita bloqueio permanente no claim). */
async function reconcileInconsistentContactStates(
  companyId: string,
  campaignId: string,
): Promise<number> {
  const s = sql();
  const rows = await s<{ id: string; provider_message_id: string }[]>`
    UPDATE public.campaign_contacts cc
    SET status = 'sent',
        sent_at = COALESCE(sent_at, now()),
        error_code = NULL,
        error_message = NULL
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND cc.status IN ('pending', 'processing')
      AND cc.provider_message_id IS NOT NULL
      AND btrim(cc.provider_message_id) <> ''
    RETURNING cc.id, cc.provider_message_id
  `;
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await s`
      UPDATE public.campaign_send_queue q
      SET locked_at = NULL,
          locked_by = NULL,
          status = 'sent'
      WHERE q.campaign_contact_id = ANY(${ids}::uuid[])
        AND q.company_id = ${companyId}::uuid
    `;
    console.log("[CAMPAIGN_WORKER_RECONCILE_WAMID]", {
      campaignId,
      reconciledCount: rows.length,
      contactIds: ids,
    });
  }
  return rows.length;
}

/** processing sem wamid e sem linha ativa na fila — reserva órfã. */
async function releaseOrphanProcessingContacts(
  companyId: string,
  campaignId: string,
): Promise<number> {
  const s = sql();
  const rows = await s<{ id: string }[]>`
    UPDATE public.campaign_contacts cc
    SET status = 'pending',
        error_code = 'orphan_processing_released',
        error_message = 'Reserva órfã liberada — retentativa'
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND cc.status = 'processing'
      AND (cc.provider_message_id IS NULL OR btrim(cc.provider_message_id) = '')
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_send_queue q
        WHERE q.campaign_contact_id = cc.id
          AND q.company_id = ${companyId}::uuid
          AND q.locked_at IS NOT NULL
          AND q.status IN ('pending', 'processing')
      )
    RETURNING cc.id
  `;
  if (rows.length > 0) {
    console.log("[CAMPAIGN_WORKER_ORPHAN_RELEASED]", {
      campaignId,
      releasedCount: rows.length,
      contactIds: rows.map((r) => r.id),
    });
  }
  return rows.length;
}

async function countUnclaimablePending(
  companyId: string,
  campaignId: string,
): Promise<number> {
  const s = sql();
  const rows = await s<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'pending'
      AND provider_message_id IS NOT NULL
      AND btrim(provider_message_id) <> ''
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
}

async function claimAndLockNextContact(
  companyId: string,
  campaignId: string,
  workerId = "campaign-worker",
): Promise<PendingContact | null> {
  const contact = await claimNextPendingContact(companyId, campaignId);
  if (!contact) return null;
  try {
    await upsertContactProcessingLock(companyId, campaignId, contact.id, workerId);
    return contact;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[CAMPAIGN_WORKER_LOCK_FAIL]", {
      campaignId,
      contactId: contact.id,
      error: msg,
    });
    await releaseContactClaim(
      companyId,
      contact.id,
      `Falha ao registrar lock: ${msg}`,
    );
    throw e;
  }
}

/** Registra reserva em campaign_send_queue.locked_at (coluna existente). */
async function upsertContactProcessingLock(
  companyId: string,
  campaignId: string,
  contactId: string,
  workerId = "campaign-worker",
): Promise<void> {
  const s = sql();
  const updated = await s<{ id: string }[]>`
    UPDATE public.campaign_send_queue q
    SET locked_at = now(),
        locked_by = ${workerId},
        status = 'processing'
    FROM (
      SELECT id
      FROM public.campaign_send_queue
      WHERE campaign_contact_id = ${contactId}::uuid
        AND company_id = ${companyId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    ) latest
    WHERE q.id = latest.id
    RETURNING q.id
  `;
  if (updated[0]) return;

  await s`
    INSERT INTO public.campaign_send_queue (
      campaign_id, campaign_contact_id, company_id,
      scheduled_for, attempts, max_attempts, status, locked_at, locked_by
    ) VALUES (
      ${campaignId}::uuid,
      ${contactId}::uuid,
      ${companyId}::uuid,
      now(),
      0,
      ${DEFAULT_MAX_SEND_ATTEMPTS},
      'processing',
      now(),
      ${workerId}
    )
  `;
}

async function clearContactProcessingLock(
  companyId: string,
  contactId: string,
  queueStatus: "sent" | "failed" | "pending",
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaign_send_queue
    SET locked_at = NULL,
        locked_by = NULL,
        status = ${queueStatus}
    WHERE campaign_contact_id = ${contactId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('pending', 'processing', 'sent', 'failed')
  `;
}

/**
 * Libera processing sem wamid quando campaign_send_queue.locked_at expirou.
 * Requer linha na fila com locked_at — contatos sem lock não são recuperados (seguro).
 */
async function releaseStaleProcessingContacts(
  companyId: string,
  campaignId: string,
  staleMs: number,
): Promise<number> {
  const staleSeconds = Math.max(Math.ceil(staleMs / 1000), 120);
  const s = sql();
  const rows = await s<{ id: string }[]>`
    UPDATE public.campaign_contacts cc
    SET status = 'pending',
        error_code = 'stale_processing_released',
        error_message = 'Reserva expirada — retentativa'
    FROM public.campaign_send_queue q
    WHERE cc.id = q.campaign_contact_id
      AND cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND cc.status = 'processing'
      AND (cc.provider_message_id IS NULL OR btrim(cc.provider_message_id) = '')
      AND q.locked_at IS NOT NULL
      AND q.locked_at < now() - (${staleSeconds}::text || ' seconds')::interval
    RETURNING cc.id
  `;
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await s`
      UPDATE public.campaign_send_queue q
      SET locked_at = NULL,
          locked_by = NULL,
          status = 'pending'
      WHERE q.campaign_contact_id = ANY(${ids}::uuid[])
        AND q.company_id = ${companyId}::uuid
    `;
  }
  return rows.length;
}

type CampaignWorkerDiagnostics = {
  campaignId: string;
  campaignStatus: string;
  pendingCount: number;
  processingCount: number;
  sentCount: number;
  oldestProcessingAgeMs: number | null;
  oldestProcessingContactId: string | null;
  oldestProcessingHasWamid: boolean | null;
  processingWithoutQueueLock: number;
};

async function getCampaignWorkerDiagnostics(
  companyId: string,
  campaignId: string,
  campaignStatus: string,
): Promise<CampaignWorkerDiagnostics> {
  const s = sql();
  const counts = await getCampaignWorkerCounts(companyId, campaignId);
  const processingRows = await s<
    {
      id: string;
      provider_message_id: string | null;
      locked_at: string | null;
    }[]
  >`
    SELECT
      cc.id,
      cc.provider_message_id,
      q.locked_at
    FROM public.campaign_contacts cc
    LEFT JOIN public.campaign_send_queue q
      ON q.campaign_contact_id = cc.id
      AND q.company_id = cc.company_id
      AND q.status IN ('pending', 'processing')
    WHERE cc.campaign_id = ${campaignId}::uuid
      AND cc.company_id = ${companyId}::uuid
      AND cc.status = 'processing'
    ORDER BY q.locked_at ASC NULLS LAST, cc.created_at ASC
  `;

  let oldestProcessingAgeMs: number | null = null;
  let oldestProcessingContactId: string | null = null;
  let oldestProcessingHasWamid: boolean | null = null;
  let processingWithoutQueueLock = 0;
  const now = Date.now();

  for (const row of processingRows) {
    if (!row.locked_at) {
      processingWithoutQueueLock += 1;
      continue;
    }
    const ageMs = now - new Date(row.locked_at).getTime();
    if (oldestProcessingAgeMs == null || ageMs > oldestProcessingAgeMs) {
      oldestProcessingAgeMs = ageMs;
      oldestProcessingContactId = String(row.id);
      oldestProcessingHasWamid = !!(
        row.provider_message_id && String(row.provider_message_id).trim()
      );
    }
  }

  return {
    campaignId,
    campaignStatus,
    pendingCount: counts.pending,
    processingCount: counts.processing,
    sentCount: counts.sent,
    oldestProcessingAgeMs,
    oldestProcessingContactId,
    oldestProcessingHasWamid,
    processingWithoutQueueLock,
  };
}

function logCampaignWorkerTickResult(
  result: WorkerTickResult,
  diagnostics?: CampaignWorkerDiagnostics | null,
): void {
  console.log("[CAMPAIGN_WORKER_TICK_RESULT]", {
    action: result.action,
    ok: result.ok,
    campaignId: result.campaignId ?? diagnostics?.campaignId ?? null,
    contactId: result.contactId ?? null,
    delayMs: result.delayMs,
    message: result.message ?? null,
    pendingCount: diagnostics?.pendingCount ?? null,
    processingCount: diagnostics?.processingCount ?? null,
    sentCount: diagnostics?.sentCount ?? null,
    oldestProcessingAgeMs: diagnostics?.oldestProcessingAgeMs ?? null,
    oldestProcessingContactId: diagnostics?.oldestProcessingContactId ?? null,
    oldestProcessingHasWamid: diagnostics?.oldestProcessingHasWamid ?? null,
    processingWithoutQueueLock: diagnostics?.processingWithoutQueueLock ?? null,
    campaignStatus: diagnostics?.campaignStatus ?? null,
  });
}

async function markContactRetryPending(
  companyId: string,
  campaignId: string,
  contactRowId: string,
  classified: ClassifiedSendError,
): Promise<{ attempts: number; maxAttempts: number }> {
  const s = sql();
  const queueRows = await s<{ attempts: number; max_attempts: number }[]>`
    SELECT attempts, max_attempts
    FROM public.campaign_send_queue
    WHERE campaign_contact_id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const prevAttempts = queueRows[0]?.attempts ?? 0;
  const maxAttempts = queueRows[0]?.max_attempts ?? DEFAULT_MAX_SEND_ATTEMPTS;
  const nextAttempts = prevAttempts + 1;

  await s`
    UPDATE public.campaign_contacts
    SET status = 'pending',
        error_code = ${classified.code},
        error_message = ${classified.message}
    WHERE id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'processing'
      AND (provider_message_id IS NULL OR btrim(provider_message_id) = '')
  `;

  await s`
    UPDATE public.campaign_send_queue
    SET status = 'pending',
        attempts = ${nextAttempts},
        locked_at = NULL,
        locked_by = NULL,
        scheduled_for = now() + (${TRANSIENT_RETRY_DELAY_MS}::text || ' milliseconds')::interval
    WHERE campaign_contact_id = ${contactRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('pending', 'processing')
  `;

  await insertCampaignEvent(companyId, campaignId, "contact.retry_scheduled", null, {
    code: classified.code,
    attempts: nextAttempts,
    max_attempts: maxAttempts,
  }, contactRowId);

  return { attempts: nextAttempts, maxAttempts };
}

async function handleContactPipelineError(
  companyId: string,
  campaignId: string,
  contactRowId: string,
  error: string,
  opts?: { httpStatus?: number },
): Promise<WorkerTickResult> {
  const classified =
    opts?.httpStatus != null
      ? classifyCampaignSendError(error, { httpStatus: opts.httpStatus })
      : classifyCampaignSendError(error);

  if (classified.kind === "transient") {
    const { attempts, maxAttempts } = await markContactRetryPending(
      companyId,
      campaignId,
      contactRowId,
      classified,
    );
    await syncCampaignContactCounters(campaignId, companyId);
    if (attempts >= maxAttempts) {
      await markContactFailed(companyId, contactRowId, classified.message);
      await clearContactProcessingLock(companyId, contactRowId, "failed");
      await syncCampaignContactCounters(campaignId, companyId);
      await insertCampaignEvent(companyId, campaignId, "contact.failed", null, {
        code: classified.code,
        attempts,
        max_attempts: maxAttempts,
      }, contactRowId);
      const diagnostics = await getCampaignWorkerDiagnostics(companyId, campaignId, "running");
      const result: WorkerTickResult = {
        ok: true,
        action: "failed",
        campaignId,
        contactId: contactRowId,
        delayMs: 500,
        message: classified.message,
      };
      logCampaignWorkerTickResult(result, diagnostics);
      return result;
    }
    const diagnostics = await getCampaignWorkerDiagnostics(companyId, campaignId, "running");
    const result: WorkerTickResult = {
      ok: true,
      action: "idle",
      campaignId,
      contactId: contactRowId,
      delayMs: TRANSIENT_RETRY_DELAY_MS,
      message: `Retry agendado (${attempts}/${maxAttempts})`,
    };
    logCampaignWorkerTickResult(result, diagnostics);
    return result;
  }

  await markContactFailed(companyId, contactRowId, classified.message);
  await clearContactProcessingLock(companyId, contactRowId, "failed");
  await syncCampaignContactCounters(campaignId, companyId);
  await insertCampaignEvent(companyId, campaignId, "contact.failed", null, {
    code: classified.code,
    kind: classified.kind,
  }, contactRowId);
  const diagnostics = await getCampaignWorkerDiagnostics(companyId, campaignId, "running");
  const result: WorkerTickResult = {
    ok: true,
    action: "failed",
    campaignId,
    contactId: contactRowId,
    delayMs: 500,
    message: classified.message,
  };
  logCampaignWorkerTickResult(result, diagnostics);
  return result;
}

async function getCampaignWorkerCounts(
  companyId: string,
  campaignId: string,
): Promise<{ pending: number; processing: number; sent: number }> {
  const s = sql();
  const rows = await s<
    { pending: string; processing: string; sent: string }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
      COUNT(*) FILTER (WHERE status = 'processing')::text AS processing,
      COUNT(*) FILTER (WHERE status IN ('sent', 'responded'))::text AS sent
    FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
  `;
  return {
    pending: parseInt(rows[0]?.pending ?? "0", 10),
    processing: parseInt(rows[0]?.processing ?? "0", 10),
    sent: parseInt(rows[0]?.sent ?? "0", 10),
  };
}

/** Estado em memória do bloco atual (por processo do worker). */
const blockState = new Map<string, { blockSize: number; messagesInBlock: number }>();

function getBlockState(campaignId: string): { blockSize: number; messagesInBlock: number } {
  let st = blockState.get(campaignId);
  if (!st) {
    st = { blockSize: nextBlockSize(), messagesInBlock: 0 };
    blockState.set(campaignId, st);
  }
  return st;
}

function logCampaignSkipped(campaignId: string, reason: CampaignSkipReason): void {
  console.log("[CAMPAIGN_WORKER_CAMPAIGN_SKIPPED]", { campaignId, reason });
}

function logRunnableSelected(campaignId: string, pendingCount: number): void {
  console.log("[CAMPAIGN_WORKER_RUNNABLE_SELECTED]", { campaignId, pendingCount });
}

/**
 * Processa no máximo UM envio (um contato de uma campanha).
 * Retorna delayMs sugerido até o próximo tick (política interna).
 */
export async function processCampaignWorkerTick(): Promise<WorkerTickResult> {
  await ensureCrmSchema();
  await ensureCampaignsSchema();

  const processingStaleMs = readProcessingStaleMs();

  const campaigns = await loadDueCampaigns();
  if (campaigns.length === 0) {
    console.log("[CAMPAIGN_WORKER_NO_DUE_CAMPAIGN]", {
      reason: "no_eligible_campaign",
      delayMs: 5_000,
    });
    const result: WorkerTickResult = {
      ok: true,
      action: "idle",
      delayMs: 5_000,
      message: "Nenhuma campanha devida",
    };
    logCampaignWorkerTickResult(result);
    return result;
  }

  const now = new Date();
  const futureWakeups: number[] = [];
  let lastCompletedCampaignId: string | undefined;

  for (const campaign of campaigns) {
    if (campaign.status === MANUAL_PAUSED_STATUS) {
      logCampaignSkipped(campaign.id, "manual_paused");
      continue;
    }

    const windowStart = campaign.window_start_time;
    const windowEnd = campaign.window_end_time;
    const scheduleDate = campaign.schedule_date;

    const scheduleStart = getScheduleStart(scheduleDate, windowStart);
    if (scheduleStart && now < scheduleStart) {
      futureWakeups.push(computeCampaignWakeupMs(now, {
        scheduleDate,
        windowStart,
        windowEnd,
      }));
      logCampaignSkipped(campaign.id, "before_schedule");
      continue;
    }

    if (isCampaignOutsideSendWindow(now, {
      scheduleDate,
      windowStart,
      windowEnd,
    })) {
      const nextAt = nextAllowedSendAt(now, scheduleDate, windowStart, windowEnd);
      if (campaign.status === "running" || campaign.status === "scheduled") {
        await setCampaignStatus(campaign.company_id, campaign.id, "paused");
        await insertCampaignEvent(campaign.company_id, campaign.id, "campaign.paused", null, {
          reason: "outside_window",
          resume_at: nextAt.toISOString(),
        });
        console.log("[CAMPAIGN_WORKER_PAUSED]", {
          campaignId: campaign.id,
          resumeAt: nextAt.toISOString(),
        });
        campaign.status = "paused";
      }
      futureWakeups.push(computeCampaignWakeupMs(now, {
        scheduleDate,
        windowStart,
        windowEnd,
      }));
      logCampaignSkipped(campaign.id, "outside_window");
      continue;
    }

    // scheduled/paused → running
    if (campaign.status === "scheduled" || campaign.status === "paused") {
      await setCampaignStatus(campaign.company_id, campaign.id, "running", { started: true });
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        campaign.status === "paused" ? "campaign.resumed" : "campaign.started",
        null,
        { at: now.toISOString() },
      );
      console.log("[CAMPAIGN_WORKER_RUNNING]", {
        campaignId: campaign.id,
        from: campaign.status,
      });
      campaign.status = "running";
    }

    await reconcileInconsistentContactStates(campaign.company_id, campaign.id);

    await releaseStaleProcessingContacts(
      campaign.company_id,
      campaign.id,
      processingStaleMs,
    );

    await releaseOrphanProcessingContacts(campaign.company_id, campaign.id);

    let contact: PendingContact | null = null;
    try {
      contact = await claimAndLockNextContact(campaign.company_id, campaign.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[CAMPAIGN_WORKER_CLAIM_LOCK_ERROR]", {
        campaignId: campaign.id,
        error: msg,
      });
      continue;
    }

    if (!contact) {
      const counts = await getCampaignWorkerCounts(campaign.company_id, campaign.id);
      const unclaimablePending = await countUnclaimablePending(
        campaign.company_id,
        campaign.id,
      );
      const diagnostics = await getCampaignWorkerDiagnostics(
        campaign.company_id,
        campaign.id,
        campaign.status,
      );

      console.log("[CAMPAIGN_WORKER_COMPLETION_CHECK]", {
        ...diagnostics,
        processingStaleMs,
        unclaimablePending,
        reason: "no_claimable_contact",
        note:
          diagnostics.processingWithoutQueueLock > 0
            ? "processing_sem_lock_na_fila_nao_recuperado_automaticamente"
            : unclaimablePending > 0
              ? "pending_com_wamid_bloqueado_no_claim"
              : null,
      });

      if (counts.pending + counts.processing > 0) {
        logCampaignSkipped(campaign.id, "waiting_processing");
        continue;
      }
      await setCampaignStatus(campaign.company_id, campaign.id, "completed", { finished: true });
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(campaign.company_id, campaign.id, "campaign.completed", null, {
        sent_count: campaign.sent_count,
      });
      blockState.delete(campaign.id);
      console.log("[CAMPAIGN_WORKER_COMPLETED]", {
        campaignId: campaign.id,
        sentCount: counts.sent,
      });
      logCampaignSkipped(campaign.id, "no_pending");
      lastCompletedCampaignId = campaign.id;
      continue;
    }

    const runnableCounts = await getCampaignWorkerCounts(campaign.company_id, campaign.id);
    logRunnableSelected(
      campaign.id,
      runnableCounts.pending + runnableCounts.processing,
    );

    console.log("[CAMPAIGN_WORKER_CONTACT_SELECTED]", {
      campaignId: campaign.id,
      contactId: contact.id,
      campaignStatus: campaign.status,
    });

    try {
    const isMeta = campaign.channel_type === "meta";
    const phone = isMeta
      ? normalizePhoneE164(contact.phone, { defaultCountry: "BR" })
      : normalizePhone(contact.phone);

    if (
      isInvalidCampaignPhone(phone) ||
      (isMeta && (!phone || !isValidE164Digits(phone)))
    ) {
      await markContactSkipped(campaign.company_id, contact.id, "invalid_phone");
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.skipped",
        null,
        { reason: "invalid_phone", phone },
        contact.id,
      );
      return {
        ok: true,
        action: "failed",
        campaignId: campaign.id,
        contactId: contact.id,
        delayMs: 200,
        message: "Telefone inválido — ignorado",
      };
    }

    if (await isPhoneInOptOutList(campaign.company_id, phone)) {
      await markContactSkipped(campaign.company_id, contact.id, "opt_out");
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.skipped",
        null,
        { reason: "opt_out", phone },
        contact.id,
      );
      return {
        ok: true,
        action: "failed",
        campaignId: campaign.id,
        contactId: contact.id,
        delayMs: 200,
        message: "Opt-out — ignorado",
      };
    }

    // Prepara conteúdo conforme o tipo de canal.
    let text: string | null = null;
    let bodyParams: string[] = [];
    let metaTemplatePersist:
      | {
          template_name: string;
          template_language: string;
          template_category: string | null;
          template_components: unknown;
          body_parameters: string[];
          template_buttons: string[];
        }
      | undefined;

    if (isMeta) {
      const templateName = campaign.meta_template_name?.trim();
      const languageCode = campaign.meta_language_code?.trim();
      if (!templateName || !languageCode) {
        await markContactFailed(campaign.company_id, contact.id, "missing_meta_template");
        return {
          ok: false,
          action: "error",
          campaignId: campaign.id,
          delayMs: 10_000,
          message: "Template Meta não configurado na campanha",
        };
      }

      const approved = await assertApprovedMetaTemplate({
        companyId: campaign.company_id,
        channelId: campaign.whatsapp_channel_id,
        templateName,
        languageCode,
      });
      if (!approved.ok) {
        await markContactFailed(campaign.company_id, contact.id, approved.error);
        await syncCampaignContactCounters(campaign.id, campaign.company_id);
        return {
          ok: true,
          action: "failed",
          campaignId: campaign.id,
          contactId: contact.id,
          delayMs: 1_000,
          message: approved.error,
        };
      }

      const contactVars =
        contact.variables && typeof contact.variables === "object"
          ? contact.variables
          : {};
      const built = buildMetaTemplateBodyParameters({
        templateName: approved.row.template_name,
        components: approved.row.components,
        mappings: campaign.meta_variable_mappings ?? {},
        contact: {
          name: contact.name,
          phone,
          variables: contactVars,
        },
      });
      if (!built.ok) {
        await markContactFailed(campaign.company_id, contact.id, built.error);
        await syncCampaignContactCounters(campaign.id, campaign.company_id);
        await insertCampaignEvent(
          campaign.company_id,
          campaign.id,
          "contact.failed",
          null,
          { reason: built.error, empty_key: built.emptyKey },
          contact.id,
        );
        return {
          ok: true,
          action: "failed",
          campaignId: campaign.id,
          contactId: contact.id,
          delayMs: 200,
          message: built.error,
        };
      }
      bodyParams = built.parameters;
      const normalizedComponents = normalizeTemplateComponents(approved.row.components);
      const componentDiag = describeTemplateComponents(approved.row.components);
      const rendered = renderMetaTemplateFromComponents({
        components: normalizedComponents ?? approved.row.components,
        parameters: bodyParams,
      });
      const outboundBody = ensureMetaTemplateOutboundBody({
        renderedBody: rendered.body,
        templateName: approved.row.template_name,
      });
      text = outboundBody.body;

      console.log("[META_TEMPLATE_OUTBOUND_PERSISTENCE]", {
        campaignId: campaign.id,
        campaignContactId: contact.id,
        templateName: approved.row.template_name,
        language: approved.row.language_code,
        renderedBodyLength: rendered.body.length,
        renderedBodyPreview: previewText(rendered.body),
        persistedBodyLength: text.length,
        persistedBodyPreview: previewText(text),
        usedFallback: outboundBody.usedFallback,
        renderReason: rendered.reason ?? outboundBody.reason ?? null,
        buttonsCount: rendered.buttons.length,
        componentsType: componentDiag.componentsType,
        componentsCount: componentDiag.componentsCount,
        hasBodyComponent: componentDiag.hasBodyComponent,
        hasMetaTemplateMetadata: true,
        bodyParametersCount: bodyParams.length,
      });

      metaTemplatePersist = {
        template_name: approved.row.template_name,
        template_language: approved.row.language_code,
        template_category: approved.row.category,
        template_components: normalizedComponents ?? approved.row.components,
        body_parameters: bodyParams,
        template_buttons: rendered.buttons,
      };
    } else {
      text = contact.rendered_message;
      if (!text) {
        try {
          const prepared = await prepareCampaignContactMessage(
            campaign.company_id,
            campaign.id,
            contact.id,
          );
          text = prepared?.rendered_message ?? null;
        } catch (prepErr) {
          const prepMsg = (prepErr as Error).message ?? "";
          if (prepMsg.startsWith("empty_variable:")) {
            const vars = prepMsg.slice("empty_variable:".length).split(",").filter(Boolean);
            const failMsg = `Variável sem preenchimento: ${vars.map((v) => `{${v}}`).join(", ")}`;
            await markContactFailed(campaign.company_id, contact.id, failMsg);
            await syncCampaignContactCounters(campaign.id, campaign.company_id);
            await insertCampaignEvent(
              campaign.company_id,
              campaign.id,
              "contact.failed",
              null,
              { reason: "empty_variable", variables: vars },
              contact.id,
            );
            return {
              ok: true,
              action: "failed",
              campaignId: campaign.id,
              contactId: contact.id,
              delayMs: 200,
              message: failMsg,
            };
          }
          throw prepErr;
        }
      }
      if (!text?.trim()) {
        await markContactFailed(campaign.company_id, contact.id, "empty_message");
        await syncCampaignContactCounters(campaign.id, campaign.company_id);
        await insertCampaignEvent(
          campaign.company_id,
          campaign.id,
          "contact.failed",
          null,
          { reason: "empty_message" },
          contact.id,
        );
        return {
          ok: true,
          action: "failed",
          campaignId: campaign.id,
          contactId: contact.id,
          delayMs: 200,
          message: "Mensagem vazia",
        };
      }
    }

    let providerId: string | null = null;
    let sendError: string | null = null;

    if (isMeta) {
      const templateName = campaign.meta_template_name!.trim();
      const languageCode = campaign.meta_language_code!.trim();

      console.log("[CAMPAIGN_WORKER_SEND]", {
        campaignId: campaign.id,
        contactRowId: contact.id,
        phone,
        provider: "meta",
        templateName,
      });

      const meta = await sendMetaTemplateMessage({
        companyId: campaign.company_id,
        channelId: campaign.whatsapp_channel_id,
        toPhone: phone,
        templateName,
        languageCode,
        bodyParameters: bodyParams,
      });

      if (!meta.ok) {
        sendError = meta.errorMessage || meta.error;
      } else {
        providerId = meta.wamid;
        // Persistir sent+wamid ANTES de gravar CRM — evita reenvio se save falhar.
        const marked = await markContactSent(campaign.company_id, contact.id, providerId);
        if (!marked) {
          console.error("[CAMPAIGN_WORKER_META_ALREADY_SENT]", {
            campaignId: campaign.id,
            contactId: contact.id,
            wamid: providerId,
          });
          await clearContactProcessingLock(campaign.company_id, contact.id, "sent");
          const dedupeResult: WorkerTickResult = {
            ok: true,
            action: "sent",
            campaignId: campaign.id,
            contactId: contact.id,
            delayMs: 200,
            message: "Já enviado (dedupe)",
          };
          logCampaignWorkerTickResult(
            dedupeResult,
            await getCampaignWorkerDiagnostics(campaign.company_id, campaign.id, campaign.status),
          );
          return dedupeResult;
        }
        await clearContactProcessingLock(campaign.company_id, contact.id, "sent");
      }
    } else {
      const instance =
        campaign.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME || "";
      if (!instance) {
        await markContactFailed(campaign.company_id, contact.id, "missing_evolution_instance");
        return {
          ok: false,
          action: "error",
          campaignId: campaign.id,
          delayMs: 10_000,
          message: "Instância Evolution não configurada",
        };
      }

      console.log("[CAMPAIGN_WORKER_SEND]", {
        campaignId: campaign.id,
        contactRowId: contact.id,
        phone,
        instance,
      });

      const evo = await sendTextEvolution(instance, phone, text!);
      if (!evo.ok) {
        sendError = evo.error;
      } else {
        providerId = evo.providerId;
      }
    }

    const block = getBlockState(campaign.id);

    if (sendError) {
      return handleContactPipelineError(
        campaign.company_id,
        campaign.id,
        contact.id,
        sendError,
      );
    }

    // Sucesso: grava conversa/mensagem. Meta já está sent+wamid (sem reenvio se falhar aqui).
    try {
      const contactId = await ensureContactForCampaign(
        campaign.company_id,
        phone,
        contact.name,
        contact.contact_id,
      );
      const conversationId = await ensureConversationForCampaign(
        campaign.company_id,
        campaign.whatsapp_channel_id,
        contactId,
      );

      let evolutionTemplatePayload:
        | {
            campaign_template_id: string | null;
            channel_type: "evolution";
            rendered_variables: Record<string, unknown>;
            response_options: Array<{ n: number; label: string; intent: string }>;
          }
        | undefined;

      if (!isMeta && campaign.template_id) {
        const tpl = await getCampaignTemplate(campaign.company_id, campaign.template_id);
        if (tpl) {
          evolutionTemplatePayload = {
            campaign_template_id: tpl.id,
            channel_type: "evolution",
            rendered_variables: {
              ...(contact.variables && typeof contact.variables === "object"
                ? contact.variables
                : {}),
              nome: contact.name,
              telefone: phone,
            },
            response_options: (tpl.response_options ?? []).map((o) => ({
              n: o.n,
              label: o.label,
              intent: o.intent,
            })),
          };
        }
      }

      await saveOutboundCampaignMessage({
        conversationId,
        text: text!,
        providerId,
        campaignId: campaign.id,
        campaignContactId: contact.id,
        metaTemplate: metaTemplatePersist
          ? {
              ...metaTemplatePersist,
              provider_message_id: providerId,
              wamid: providerId,
            }
          : undefined,
        evolutionTemplate: evolutionTemplatePayload,
      });
    } catch (e) {
      console.error("[CAMPAIGN_WORKER_SAVE_FAIL]", e);
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.save_warning",
        null,
        { error: e instanceof Error ? e.message : String(e), wamid: providerId },
        contact.id,
      );
    }

    if (!isMeta) {
      await markContactSent(campaign.company_id, contact.id, providerId);
    }
    await clearContactProcessingLock(campaign.company_id, contact.id, "sent");
    await syncCampaignContactCounters(campaign.id, campaign.company_id);
    await insertCampaignEvent(
      campaign.company_id,
      campaign.id,
      "contact.sent",
      null,
      {
        phone,
        provider_id: providerId,
        provider: isMeta ? "meta" : "evolution",
        template_name: isMeta ? campaign.meta_template_name : undefined,
      },
      contact.id,
    );

    block.messagesInBlock += 1;
    const sentInCampaign = campaign.sent_count + 1;
    const pause = nextPauseAfterSend({
      sentInCampaign,
      messagesInCurrentBlock: block.messagesInBlock,
      blockSize: block.blockSize,
    });

    if (pause.kind === "block" || pause.kind === "long") {
      block.messagesInBlock = 0;
      block.blockSize = pause.nextBlockSize ?? nextBlockSize();
      await insertCampaignEvent(campaign.company_id, campaign.id, "campaign.send_pause", null, {
        kind: pause.kind,
        delay_ms: pause.delayMs,
        sent_in_campaign: sentInCampaign,
      });
      console.log("[CAMPAIGN_WORKER_PAUSE]", {
        campaignId: campaign.id,
        kind: pause.kind,
        delayMs: pause.delayMs,
      });
    }

    blockState.set(campaign.id, block);

    console.log("[CAMPAIGN_WORKER_SENT]", {
      campaignId: campaign.id,
      contactId: contact.id,
      nextDelayMs: pause.delayMs,
      provider: isMeta ? "meta" : "evolution",
    });

    console.log("[CAMPAIGN_WORKER_NEXT_SCHEDULED]", {
      campaignId: campaign.id,
      contactId: contact.id,
      campaignStatus: "running",
      delayMs: pause.delayMs,
      reason: pause.kind,
    });

    const sentResult: WorkerTickResult = {
      ok: true,
      action: "sent",
      campaignId: campaign.id,
      contactId: contact.id,
      delayMs: pause.delayMs,
      message: isMeta ? "Template Meta enviado" : "Mensagem enviada",
    };
    const sentDiagnostics = await getCampaignWorkerDiagnostics(
      campaign.company_id,
      campaign.id,
      "running",
    );
    logCampaignWorkerTickResult(sentResult, sentDiagnostics);
    return sentResult;
    } catch (e) {
      const classified = classifyThrownError(e);
      console.error("[CAMPAIGN_WORKER_CONTACT_ERROR]", {
        campaignId: campaign.id,
        contactId: contact.id,
        code: classified.code,
        kind: classified.kind,
        error: classified.message,
      });
      return handleContactPipelineError(
        campaign.company_id,
        campaign.id,
        contact.id,
        classified.message,
      );
    }
  }

  const wakeupDelayMs = aggregateIdleTickDelay(futureWakeups);
  if (wakeupDelayMs != null) {
    const result: WorkerTickResult = {
      ok: true,
      action: "paused",
      delayMs: wakeupDelayMs,
      message: "Campanhas aguardando janela ou agenda",
    };
    logCampaignWorkerTickResult(result);
    return result;
  }

  if (lastCompletedCampaignId) {
    const result: WorkerTickResult = {
      ok: true,
      action: "completed",
      campaignId: lastCompletedCampaignId,
      delayMs: 1_000,
      message: "Campanha finalizada",
    };
    logCampaignWorkerTickResult(result);
    return result;
  }

  const result: WorkerTickResult = {
    ok: true,
    action: "idle",
    delayMs: 5_000,
    message: "Nenhuma campanha executável neste tick",
  };
  logCampaignWorkerTickResult(result);
  return result;
}

/** Loop contínuo para desenvolvimento/produção (processo dedicado). */
export async function runCampaignWorkerLoop(opts?: {
  idleDelayMs?: number;
  stopSignal?: { stopped: boolean };
}): Promise<void> {
  const idleDelayMs = opts?.idleDelayMs ?? 5_000;
  const stopSignal = opts?.stopSignal ?? { stopped: false };

  console.log("[CAMPAIGN_WORKER_START]", {
    idleDelayMs,
    hasEvoUrl: !!process.env.EVOLUTION_API_URL,
    hasEvoKey: !!process.env.EVOLUTION_API_KEY,
  });

  while (!stopSignal.stopped) {
    let delayMs = idleDelayMs;
    try {
      const result = await processCampaignWorkerTick();
      delayMs = result.delayMs > 0 ? result.delayMs : idleDelayMs;
      if (result.action !== "idle") {
        console.log("[CAMPAIGN_WORKER_TICK]", result);
      }
    } catch (e) {
      console.error("[CAMPAIGN_WORKER_TICK_ERROR]", e);
      delayMs = 10_000;
    }
    await sleep(delayMs);
  }

  console.log("[CAMPAIGN_WORKER_STOP]");
}
