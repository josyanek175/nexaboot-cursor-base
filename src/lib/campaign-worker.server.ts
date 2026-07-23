/**
 * Worker de envio de campanhas (Automático seguro).
 * Usa exclusivamente campaign-send-policy.ts para ritmo/janela/variação.
 * Não lê intervalo/velocidade da API pública.
 */
import { sql, ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { normalizePhone, normalizePhoneE164, normalizePhoneForMatch, isValidE164Digits } from "@/lib/phone";
import {
  isWithinSendWindow,
  nextAllowedSendAt,
  shouldPauseUntilNextDay,
  nextBlockSize,
  nextPauseAfterSend,
  isInvalidCampaignPhone,
} from "@/lib/campaign-send-policy";
import {
  insertCampaignEvent,
  prepareCampaignContactMessage,
  syncCampaignContactCounters,
} from "@/lib/campaign.server";
import { isPhoneInOptOutList } from "@/lib/campaign-response.server";
import { sendMetaTemplateMessage } from "@/lib/meta-send-message.server";
import {
  assertApprovedMetaTemplate,
  buildMetaTemplateBodyParameters,
  renderMetaTemplateFromComponents,
} from "@/lib/meta-message-templates.server";

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

/**
 * Processa no máximo UM envio (um contato de uma campanha).
 * Retorna delayMs sugerido até o próximo tick (política interna).
 */
export async function processCampaignWorkerTick(): Promise<WorkerTickResult> {
  await ensureCrmSchema();
  await ensureCampaignsSchema();

  const campaigns = await loadDueCampaigns();
  if (campaigns.length === 0) {
    return { ok: true, action: "idle", delayMs: 5_000, message: "Nenhuma campanha devida" };
  }

  const now = new Date();

  for (const campaign of campaigns) {
    const windowStart = campaign.window_start_time;
    const windowEnd = campaign.window_end_time;
    const scheduleDate = campaign.schedule_date;

    // Ainda não chegou a data/hora inicial da agenda.
    if (scheduleDate) {
      const startMin = windowStart
        ? Number(windowStart.slice(0, 2)) * 60 + Number(windowStart.slice(3, 5))
        : 0;
      const [y, m, d] = scheduleDate.split("-").map(Number);
      const scheduleStart = new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (now < scheduleStart) {
        const delayMs = Math.min(scheduleStart.getTime() - now.getTime(), 60_000);
        console.log("[CAMPAIGN_WORKER_WAIT_SCHEDULE]", {
          campaignId: campaign.id,
          scheduleStart: scheduleStart.toISOString(),
        });
        continue;
      }
    }

    // Fora da janela → pausar até o próximo horário permitido.
    if (
      shouldPauseUntilNextDay(now, windowEnd) ||
      !isWithinSendWindow(now, windowStart, windowEnd)
    ) {
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
      }
      const delayMs = Math.min(Math.max(nextAt.getTime() - now.getTime(), 1_000), 60_000);
      return {
        ok: true,
        action: "paused",
        campaignId: campaign.id,
        delayMs,
        message: `Pausada até ${nextAt.toISOString()}`,
      };
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

    const contact = await claimNextPendingContact(campaign.company_id, campaign.id);
    if (!contact) {
      // Sem pending reservável — verifica se ainda há processing (outro tick) ou finaliza.
      const s = sql();
      const pendingLeft = await s<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM public.campaign_contacts
        WHERE campaign_id = ${campaign.id}::uuid
          AND company_id = ${campaign.company_id}::uuid
          AND status IN ('pending', 'processing')
      `;
      if (parseInt(pendingLeft[0]?.count ?? "0", 10) > 0) {
        return {
          ok: true,
          action: "idle",
          campaignId: campaign.id,
          delayMs: 2_000,
          message: "Contatos em processamento por outro tick",
        };
      }
      await setCampaignStatus(campaign.company_id, campaign.id, "completed", { finished: true });
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(campaign.company_id, campaign.id, "campaign.completed", null, {
        sent_count: campaign.sent_count,
      });
      blockState.delete(campaign.id);
      console.log("[CAMPAIGN_WORKER_COMPLETED]", { campaignId: campaign.id });
      return {
        ok: true,
        action: "completed",
        campaignId: campaign.id,
        delayMs: 1_000,
        message: "Campanha finalizada",
      };
    }

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
      const rendered = renderMetaTemplateFromComponents({
        components: approved.row.components,
        parameters: bodyParams,
      });
      text = rendered.body;
      metaTemplatePersist = {
        template_name: approved.row.template_name,
        template_language: approved.row.language_code,
        template_category: approved.row.category,
        template_components: approved.row.components,
        body_parameters: bodyParams,
        template_buttons: rendered.buttons,
      };
    } else {
      text = contact.rendered_message;
      if (!text) {
        const prepared = await prepareCampaignContactMessage(
          campaign.company_id,
          campaign.id,
          contact.id,
        );
        text = prepared?.rendered_message ?? null;
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
          return {
            ok: true,
            action: "sent",
            campaignId: campaign.id,
            contactId: contact.id,
            delayMs: 200,
            message: "Já enviado (dedupe)",
          };
        }
        try {
          const s = sql();
          await s`
            INSERT INTO public.campaign_send_queue (
              campaign_id, campaign_contact_id, company_id,
              scheduled_for, attempts, status
            ) VALUES (
              ${campaign.id}::uuid,
              ${contact.id}::uuid,
              ${campaign.company_id}::uuid,
              now(),
              1,
              'sent'
            )
          `;
        } catch (e) {
          console.error("[CAMPAIGN_QUEUE_META_SAVE_FAIL]", e);
        }
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
      await markContactFailed(campaign.company_id, contact.id, sendError);
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.failed",
        null,
        { error: sendError, phone, provider: isMeta ? "meta" : "evolution" },
        contact.id,
      );
      if (isMeta) {
        try {
          const s = sql();
          await s`
            INSERT INTO public.campaign_send_queue (
              campaign_id, campaign_contact_id, company_id,
              scheduled_for, attempts, status
            ) VALUES (
              ${campaign.id}::uuid,
              ${contact.id}::uuid,
              ${campaign.company_id}::uuid,
              now(),
              1,
              'failed'
            )
          `;
        } catch {
          // ignore
        }
      }
      const pause = nextPauseAfterSend({
        sentInCampaign: campaign.sent_count,
        messagesInCurrentBlock: block.messagesInBlock,
        blockSize: block.blockSize,
      });
      console.error("[CAMPAIGN_WORKER_SEND_FAIL]", {
        campaignId: campaign.id,
        contactId: contact.id,
        error: sendError,
      });
      return {
        ok: true,
        action: "failed",
        campaignId: campaign.id,
        contactId: contact.id,
        delayMs: Math.min(pause.delayMs, 15_000),
        message: sendError,
      };
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
      phone,
      nextDelayMs: pause.delayMs,
      provider: isMeta ? "meta" : "evolution",
    });

    return {
      ok: true,
      action: "sent",
      campaignId: campaign.id,
      contactId: contact.id,
      delayMs: pause.delayMs,
      message: isMeta ? "Template Meta enviado" : "Mensagem enviada",
    };
  }

  return {
    ok: true,
    action: "waiting_window",
    delayMs: 15_000,
    message: "Campanhas aguardando janela/agenda",
  };
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
