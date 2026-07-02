// Campanhas — lógica server-side (fase 1: rascunhos + público).
// Isolamento estrito por company_id. Sem envio WhatsApp nesta fase.
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  canViewCampaigns,
  canManageCampaigns,
  canDeleteCampaign,
  type ActingUser,
} from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";

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
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
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
  created_at: string;
};

type ActorContext = {
  companyId: string;
  userId: string | null;
  actor: ActingUser;
};

const CAMPAIGN_SELECT = `
  c.id, c.company_id, c.whatsapp_channel_id, c.name, c.message_text,
  c.message_type, c.status, c.scheduled_at, c.started_at, c.finished_at,
  c.send_interval_ms, c.total_contacts, c.sent_count, c.failed_count,
  c.skipped_count, c.created_by_user_id, c.created_at, c.updated_at,
  ch.name AS channel_name
`;

export async function getCampaignActor(
  mode: "view" | "manage" | "delete",
): Promise<ActorContext | Response> {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;

  const uid = getSessionUserId();
  if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const rows = await sql<{ id: string; role: string; tenant_id: string }[]>`
    SELECT id, role, tenant_id FROM public.users
    WHERE id = ${uid}::uuid AND company_id = ${company}::uuid
    LIMIT 1
  `;
  if (!rows[0]) {
    return Response.json({ error: "forbidden", message: "Sem permissão." }, { status: 403 });
  }

  const actor: ActingUser = {
    id: String(rows[0].id),
    role: rows[0].role as ActingUser["role"],
    tenantId: String(rows[0].tenant_id ?? ""),
  };

  if (mode === "view" && !canViewCampaigns(actor)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (mode === "manage" && !canManageCampaigns(actor)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (mode === "delete" && !canDeleteCampaign(actor)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  return { companyId: company, userId: uid, actor };
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
      AND deleted_at IS NULL
      AND active = true
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
  await sql()`
    UPDATE public.campaigns c
    SET total_contacts = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id
        ),
        skipped_count = (
          SELECT COUNT(*)::int FROM public.campaign_contacts cc
          WHERE cc.campaign_id = c.id AND cc.status = 'skipped'
        ),
        updated_at = now()
    WHERE c.id = ${campaignId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
  `;
}

export async function listCampaigns(companyId: string, status?: string): Promise<CampaignRow[]> {
  const rows = status
    ? await sql<CampaignRow[]>`
        SELECT ${sql.unsafe(CAMPAIGN_SELECT)}
        FROM public.campaigns c
        LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          AND ch.company_id = c.company_id
          AND lower(ch.channel_type) = 'evolution'
          AND ch.deleted_at IS NULL
          AND ch.active = true
        WHERE c.company_id = ${companyId}::uuid
          AND c.deleted_at IS NULL
          AND c.status = ${status}
        ORDER BY c.created_at DESC
      `
    : await sql<CampaignRow[]>`
        SELECT ${sql.unsafe(CAMPAIGN_SELECT)}
        FROM public.campaigns c
        LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          AND ch.company_id = c.company_id
          AND lower(ch.channel_type) = 'evolution'
          AND ch.deleted_at IS NULL
          AND ch.active = true
        WHERE c.company_id = ${companyId}::uuid
          AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC
      `;
  return rows;
}

export async function getCampaignById(
  companyId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const rows = await sql<CampaignRow[]>`
    SELECT ${sql.unsafe(CAMPAIGN_SELECT)}
    FROM public.campaigns c
    LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
      AND ch.company_id = c.company_id
      AND lower(ch.channel_type) = 'evolution'
      AND ch.deleted_at IS NULL
      AND ch.active = true
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
  data: {
    name: string;
    message_text?: string | null;
    whatsapp_channel_id?: string | null;
    send_interval_ms?: number;
  },
): Promise<CampaignDetail> {
  if (data.whatsapp_channel_id) {
    const ch = await validateEvolutionChannel(companyId, data.whatsapp_channel_id);
    if (!ch.ok) throw new Error(ch.error);
  }

  const rows = await sql<CampaignRow[]>`
    INSERT INTO public.campaigns (
      company_id, whatsapp_channel_id, name, message_text,
      message_type, status, send_interval_ms, created_by_user_id
    )
    VALUES (
      ${companyId}::uuid,
      ${data.whatsapp_channel_id ?? null}::uuid,
      ${data.name},
      ${data.message_text ?? null},
      'text',
      'draft',
      ${data.send_interval_ms ?? 5000},
      ${userId ?? null}::uuid
    )
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, total_contacts, sent_count, failed_count,
              skipped_count, created_by_user_id, created_at, updated_at
  `;
  const campaign = rows[0];
  await insertCampaignEvent(companyId, campaign.id, "campaign.created", userId, {
    name: data.name,
  });
  return withChannelStatus(companyId, campaign);
}

export async function updateCampaign(
  companyId: string,
  campaignId: string,
  userId: string | null,
  data: {
    name?: string;
    message_text?: string | null;
    whatsapp_channel_id?: string | null;
    send_interval_ms?: number;
  },
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
  const nextInterval = data.send_interval_ms ?? existing.send_interval_ms;

  const rows = await sql<CampaignRow[]>`
    UPDATE public.campaigns
    SET name = ${nextName},
        message_text = ${nextMessage},
        whatsapp_channel_id = ${nextChannel}::uuid,
        send_interval_ms = ${nextInterval},
        updated_at = now()
    WHERE id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = 'draft'
      AND deleted_at IS NULL
    RETURNING id, company_id, whatsapp_channel_id, name, message_text,
              message_type, status, scheduled_at, started_at, finished_at,
              send_interval_ms, total_contacts, sent_count, failed_count,
              skipped_count, created_by_user_id, created_at, updated_at
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
           cc.name, cc.variables, cc.status, cc.skip_reason, cc.created_at
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
    }[]
  >`
    SELECT id, phone, name, status
    FROM public.contacts
    WHERE company_id = ${companyId}::uuid
      AND id = ANY(${contactIds}::uuid[])
  `;

  let added = 0;
  let skipped = 0;

  for (const ct of contacts) {
    const phone = normalizePhone(ct.phone);
    if (phone.length < 8) {
      skipped++;
      continue;
    }

    const isInactive = ct.status === "inativo" || ct.status === "merged";
    const rowStatus = isInactive ? "skipped" : "pending";
    const skipReason = isInactive ? "contact_inactive" : null;

    try {
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
      } else {
        skipped++;
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
