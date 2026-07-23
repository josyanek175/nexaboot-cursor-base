// Modelos de mensagem reutilizáveis por empresa (Evolution).
import { sql } from "@/lib/pg.server";
import {
  parseTemplateMessageBody,
  serializeTemplateMessageBody,
  type CampaignTemplateEmbeddedMeta,
} from "@/lib/campaign-template-metadata";

export type CampaignTemplateRow = {
  id: string;
  company_id: string;
  name: string;
  message_body: string;
  active: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CampaignTemplatePublic = CampaignTemplateRow & {
  visible_body: string;
  description: string | null;
  channel_type: "evolution" | "meta" | "both";
  footer: string | null;
  response_options: CampaignTemplateEmbeddedMeta["responseOptions"];
  source_meta_template_id: string | null;
  source_meta_template_name: string | null;
  variables: string[];
};

function toPublic(row: CampaignTemplateRow): CampaignTemplatePublic {
  const { visibleBody, meta } = parseTemplateMessageBody(row.message_body);
  const varMatches = visibleBody.match(/\{([a-zA-Z0-9_]+)\}/g) ?? [];
  const variables = [...new Set(varMatches.map((m) => m.slice(1, -1).toLowerCase()))];
  return {
    ...row,
    visible_body: visibleBody,
    description: meta.description ?? null,
    channel_type: meta.channelType ?? "evolution",
    footer: meta.footer ?? null,
    response_options: meta.responseOptions ?? [],
    source_meta_template_id: meta.sourceMetaTemplateId ?? null,
    source_meta_template_name: meta.sourceMetaTemplateName ?? null,
    variables,
  };
}

export async function listCampaignTemplates(
  companyId: string,
  opts?: { includeInactive?: boolean },
): Promise<CampaignTemplatePublic[]> {
  const rows = await sql<CampaignTemplateRow[]>`
    SELECT id, company_id, name, message_body, active,
           created_by_user_id, created_at, updated_at
    FROM public.campaign_templates
    WHERE company_id = ${companyId}::uuid
      AND (${opts?.includeInactive ?? false} OR active = true)
    ORDER BY updated_at DESC, name ASC
  `;
  return (rows ?? []).map(toPublic);
}

export async function getCampaignTemplate(
  companyId: string,
  templateId: string,
  opts?: { includeInactive?: boolean },
): Promise<CampaignTemplatePublic | null> {
  const rows = await sql<CampaignTemplateRow[]>`
    SELECT id, company_id, name, message_body, active,
           created_by_user_id, created_at, updated_at
    FROM public.campaign_templates
    WHERE id = ${templateId}::uuid
      AND company_id = ${companyId}::uuid
      AND (${opts?.includeInactive ?? false} OR active = true)
    LIMIT 1
  `;
  return rows[0] ? toPublic(rows[0]) : null;
}

export async function createCampaignTemplate(
  companyId: string,
  userId: string | null,
  data: {
    name: string;
    message_body: string;
    description?: string;
    footer?: string;
    response_options?: CampaignTemplateEmbeddedMeta["responseOptions"];
    source_meta_template_id?: string;
    source_meta_template_name?: string;
    source_meta_language_code?: string;
    channel_type?: CampaignTemplateEmbeddedMeta["channelType"];
  },
): Promise<CampaignTemplatePublic> {
  const meta: CampaignTemplateEmbeddedMeta = {
    description: data.description,
    channelType: data.channel_type ?? "evolution",
    footer: data.footer,
    responseOptions: data.response_options,
    sourceMetaTemplateId: data.source_meta_template_id,
    sourceMetaTemplateName: data.source_meta_template_name,
    sourceMetaLanguageCode: data.source_meta_language_code,
  };
  const storedBody = serializeTemplateMessageBody(data.message_body.trim(), meta);

  const rows = await sql<CampaignTemplateRow[]>`
    INSERT INTO public.campaign_templates
      (company_id, name, message_body, created_by_user_id)
    VALUES (
      ${companyId}::uuid,
      ${data.name.trim()},
      ${storedBody},
      ${userId ?? null}::uuid
    )
    RETURNING id, company_id, name, message_body, active,
              created_by_user_id, created_at, updated_at
  `;
  return toPublic(rows[0]);
}

export async function updateCampaignTemplate(
  companyId: string,
  templateId: string,
  data: {
    name?: string;
    message_body?: string;
    description?: string;
    footer?: string;
    response_options?: CampaignTemplateEmbeddedMeta["responseOptions"];
    channel_type?: CampaignTemplateEmbeddedMeta["channelType"];
    active?: boolean;
  },
): Promise<CampaignTemplatePublic | null> {
  const existing = await getCampaignTemplate(companyId, templateId, { includeInactive: true });
  if (!existing) return null;

  const name = data.name?.trim() ?? existing.name;
  const visibleBody = data.message_body?.trim() ?? existing.visible_body;
  const meta: CampaignTemplateEmbeddedMeta = {
    description: data.description ?? existing.description ?? undefined,
    channelType: data.channel_type ?? existing.channel_type,
    footer: data.footer ?? existing.footer ?? undefined,
    responseOptions: data.response_options ?? existing.response_options ?? undefined,
    sourceMetaTemplateId: existing.source_meta_template_id ?? undefined,
    sourceMetaTemplateName: existing.source_meta_template_name ?? undefined,
  };
  const storedBody = serializeTemplateMessageBody(visibleBody, meta);
  const active = data.active ?? existing.active;

  const rows = await sql<CampaignTemplateRow[]>`
    UPDATE public.campaign_templates
    SET name = ${name},
        message_body = ${storedBody},
        active = ${active},
        updated_at = now()
    WHERE id = ${templateId}::uuid
      AND company_id = ${companyId}::uuid
    RETURNING id, company_id, name, message_body, active,
              created_by_user_id, created_at, updated_at
  `;
  return rows[0] ? toPublic(rows[0]) : null;
}

export async function deactivateCampaignTemplate(
  companyId: string,
  templateId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE public.campaign_templates
    SET active = false, updated_at = now()
    WHERE id = ${templateId}::uuid
      AND company_id = ${companyId}::uuid
      AND active = true
    RETURNING id
  `;
  return !!rows[0];
}

export { toPublic as campaignTemplateToPublic };
