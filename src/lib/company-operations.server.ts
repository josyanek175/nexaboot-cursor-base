import { getSql } from "@/lib/pg.server";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { isPlatformRole } from "@/lib/platform-roles";
import type { PgSql } from "@/lib/pg-types";
import { allowedChannelIds } from "@/lib/channel-permissions.server";

export async function requireOperationsAdmin() {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;
  const actor = await getCurrentUserCompanyInfo();
  if (!actor.userId || !(isPlatformRole(actor.role) || actor.role === "ADMIN_EMPRESA"))
    return Response.json({ error: "forbidden" }, { status: 403 });
  return { companyId: company, userId: actor.userId };
}

export async function getOperationsSettings(companyId: string) {
  const rows =
    await getSql()`SELECT waiting_attendant_minutes, waiting_customer_hours, restrict_channels
    FROM public.company_operations_settings WHERE company_id=${companyId}::uuid`;
  return (
    rows[0] ?? {
      waiting_attendant_minutes: 10,
      waiting_customer_hours: 24,
      restrict_channels: false,
    }
  );
}

/** Oldest unanswered inbound is used, so additional customer messages do not reset the alert. */
export async function getAttendanceAlerts(companyId: string, userId: string, manager: boolean) {
  const allowed = await allowedChannelIds(companyId, userId);
  return getSql()`
    SELECT c.id, ct.name, c.whatsapp_channel_id, last.direction,
      COALESCE(pending.since, last.created_at) AS waiting_since,
      CASE WHEN last.direction IN ('in','inbound') THEN 'attendant' ELSE 'customer' END AS waiting_for
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id=c.contact_id AND ct.company_id=c.company_id
    LEFT JOIN public.company_operations_settings cfg ON cfg.company_id=c.company_id
    JOIN LATERAL (SELECT m.direction,m.created_at FROM public.messages m
      WHERE m.conversation_id=c.id AND m.direction IN ('in','inbound','out','outbound')
      AND m.message_type IS DISTINCT FROM 'system' ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last ON true
    LEFT JOIN LATERAL (SELECT min(m.created_at) AS since FROM public.messages m
      WHERE m.conversation_id=c.id AND m.direction IN ('in','inbound')
      AND m.created_at > COALESCE((SELECT max(o.created_at) FROM public.messages o
        WHERE o.conversation_id=c.id AND o.direction IN ('out','outbound')), '-infinity'::timestamptz)) pending ON true
    WHERE c.company_id=${companyId}::uuid AND c.status IN ('open','waiting')
      AND (${allowed === null} OR c.whatsapp_channel_id=ANY(${allowed ?? []}::uuid[]))
      AND (${manager} OR EXISTS(SELECT 1 FROM public.conversation_assignments a
        WHERE a.conversation_id=c.id AND a.user_id=${userId}::uuid AND a.active=true AND a.unassigned_at IS NULL))
      AND CASE WHEN last.direction IN ('in','inbound')
        THEN COALESCE(pending.since,last.created_at) <= now() - make_interval(mins=>COALESCE(cfg.waiting_attendant_minutes,10))
        ELSE last.created_at <= now() - make_interval(hours=>COALESCE(cfg.waiting_customer_hours,24)) END
    ORDER BY waiting_since LIMIT 100`;
}

/** No messages are sent. Contact locks serialize expiry with the Meta inbound transaction. */
export async function expireUnansweredCampaigns(db: PgSql, limit = 50) {
  return db.begin(async (tx) => {
    const eligible = tx`EXISTS(SELECT 1 FROM public.messages campaign WHERE campaign.conversation_id=c.id
      AND campaign.direction='out' AND campaign.raw_payload->>'origin'='CAMPANHA'
      AND campaign.created_at <= now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM public.messages newer WHERE newer.conversation_id=c.id
        AND newer.created_at>=campaign.created_at AND newer.id<>campaign.id
        AND (newer.direction IN ('in','inbound') OR newer.sent_by_user_id IS NOT NULL
          OR newer.raw_payload->>'message_source'='whatsapp_business_app'
          OR newer.raw_payload->>'origin'='CAMPANHA'))
      AND NOT EXISTS(SELECT 1 FROM public.conversation_assignments a WHERE a.conversation_id=c.id
        AND (a.active=true OR a.assigned_at>=campaign.created_at)))`;
    const candidates = await tx`SELECT c.id,c.company_id FROM public.conversations c
      JOIN public.contacts ct ON ct.id=c.contact_id AND ct.company_id=c.company_id
      WHERE c.status IN ('open','waiting') AND ${eligible}
      ORDER BY c.updated_at LIMIT ${limit} FOR UPDATE OF ct SKIP LOCKED`;
    let closed = 0;
    const sessionsTable = await tx`SELECT to_regclass('public.automation_sessions') AS present`;
    for (const c of candidates) {
      const updated = await tx`UPDATE public.conversations c SET status='finished',
        campaign_service_status=CASE WHEN campaign_reply_campaign_id IS NOT NULL THEN 'completed' ELSE campaign_service_status END,
        updated_at=now()
        WHERE c.id=${c.id}::uuid AND c.company_id=${c.company_id}::uuid AND c.status IN ('open','waiting')
        AND ${eligible} RETURNING id`;
      if (!updated[0]) continue;
      if (sessionsTable[0]?.present)
        await tx`UPDATE public.automation_sessions SET status='ended',updated_at=now()
        WHERE conversation_id=${c.id}::uuid AND company_id=${c.company_id}::uuid`;
      await tx`INSERT INTO public.messages(conversation_id,direction,message_type,message_text,from_me,status)
        VALUES(${c.id}::uuid,'system','system','Campanha encerrada: 24 horas sem resposta e sem atendimento humano.',false,'received')`;
      closed++;
    }
    return closed;
  });
}
