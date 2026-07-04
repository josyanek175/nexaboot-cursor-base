/**
 * Worker de envio de campanhas (Automático seguro).
 * Usa exclusivamente campaign-send-policy.ts para ritmo/janela/variação.
 * Não lê intervalo/velocidade da API pública.
 */
import { sql, ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { normalizePhone, normalizePhoneForMatch } from "@/lib/phone";
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

const SYSTEM_SENDER_NAME = "Disparo Automático";

type WorkerCampaign = {
  id: string;
  company_id: string;
  whatsapp_channel_id: string;
  name: string;
  message_text: string;
  status: string;
  schedule_date: string | null;
  window_start_time: string | null;
  window_end_time: string | null;
  sent_count: number;
  evolution_instance_name: string | null;
  started_at: string | null;
};

type PendingContact = {
  id: string;
  phone: string;
  name: string | null;
  contact_id: string | null;
  rendered_message: string | null;
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
}): Promise<void> {
  const s = sql();
  const payload = {
    origin: "CAMPANHA",
    campaign_id: opts.campaignId,
    campaign_contact_id: opts.campaignContactId,
    sender: SYSTEM_SENDER_NAME,
  };
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
      c.status, c.schedule_date, c.window_start_time, c.window_end_time,
      c.sent_count, c.started_at,
      ch.evolution_instance_name
    FROM public.campaigns c
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.deleted_at IS NULL
      AND c.status IN ('scheduled', 'running', 'paused')
      AND c.whatsapp_channel_id IS NOT NULL
      AND c.message_text IS NOT NULL
      AND btrim(c.message_text) <> ''
      AND COALESCE(c.send_mode, 'auto_safe') = 'auto_safe'
      AND ch.deleted_at IS NULL
      AND COALESCE(ch.active, true) = true
    ORDER BY
      CASE c.status WHEN 'running' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
      c.updated_at ASC
    LIMIT 20
  `;

  return rows.map((r) => ({
    id: String(r.id),
    company_id: String(r.company_id),
    whatsapp_channel_id: String(r.whatsapp_channel_id),
    name: String(r.name),
    message_text: String(r.message_text),
    status: String(r.status),
    schedule_date: dateStr(r.schedule_date),
    window_start_time: timeStr(r.window_start_time),
    window_end_time: timeStr(r.window_end_time),
    sent_count: Number(r.sent_count ?? 0),
    evolution_instance_name: r.evolution_instance_name
      ? String(r.evolution_instance_name)
      : null,
    started_at: r.started_at ? String(r.started_at) : null,
  }));
}

async function loadNextPendingContact(
  companyId: string,
  campaignId: string,
): Promise<PendingContact | null> {
  const s = sql();
  const rows = await s<PendingContact[]>`
    SELECT id, phone, name, contact_id, rendered_message
    FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
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
): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.campaign_contacts
    SET status = 'sent',
        sent_at = now(),
        provider_message_id = ${providerId},
        error_code = NULL,
        error_message = NULL
    WHERE id = ${contactRowId}::uuid AND company_id = ${companyId}::uuid
  `;
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
    WHERE id = ${contactRowId}::uuid AND company_id = ${companyId}::uuid
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
      AND status = 'pending'
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

    const contact = await loadNextPendingContact(campaign.company_id, campaign.id);
    if (!contact) {
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

    const phone = normalizePhone(contact.phone);
    if (isInvalidCampaignPhone(phone)) {
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

    // Prepara variação se ainda não existir.
    let text = contact.rendered_message;
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

    const instance =
      campaign.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME || "";
    if (!instance) {
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

    const evo = await sendTextEvolution(instance, phone, text);
    const block = getBlockState(campaign.id);

    if (!evo.ok) {
      await markContactFailed(campaign.company_id, contact.id, evo.error);
      await syncCampaignContactCounters(campaign.id, campaign.company_id);
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.failed",
        null,
        { error: evo.error, phone },
        contact.id,
      );
      const pause = nextPauseAfterSend({
        sentInCampaign: campaign.sent_count,
        messagesInCurrentBlock: block.messagesInBlock,
        blockSize: block.blockSize,
      });
      console.error("[CAMPAIGN_WORKER_SEND_FAIL]", {
        campaignId: campaign.id,
        contactId: contact.id,
        error: evo.error,
      });
      return {
        ok: true,
        action: "failed",
        campaignId: campaign.id,
        contactId: contact.id,
        delayMs: Math.min(pause.delayMs, 15_000),
        message: evo.error,
      };
    }

    // Sucesso: grava contato + conversa + mensagem no NexaBoot.
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
        text,
        providerId: evo.providerId,
        campaignId: campaign.id,
        campaignContactId: contact.id,
      });
    } catch (e) {
      console.error("[CAMPAIGN_WORKER_SAVE_FAIL]", e);
      // Envio na Evolution ok; ainda marca como enviado e registra aviso.
      await insertCampaignEvent(
        campaign.company_id,
        campaign.id,
        "contact.save_warning",
        null,
        { error: e instanceof Error ? e.message : String(e) },
        contact.id,
      );
    }

    await markContactSent(campaign.company_id, contact.id, evo.providerId);
    await syncCampaignContactCounters(campaign.id, campaign.company_id);
    await insertCampaignEvent(
      campaign.company_id,
      campaign.id,
      "contact.sent",
      null,
      { phone, provider_id: evo.providerId },
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
    });

    return {
      ok: true,
      action: "sent",
      campaignId: campaign.id,
      contactId: contact.id,
      delayMs: pause.delayMs,
      message: "Mensagem enviada",
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
