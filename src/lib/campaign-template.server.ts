// Modelos de mensagem reutilizáveis por empresa.
import { sql, ensureCampaignsSchema } from "@/lib/pg.server";

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

export async function listCampaignTemplates(companyId: string): Promise<CampaignTemplateRow[]> {
  await ensureCampaignsSchema();
  const rows = await sql<CampaignTemplateRow[]>`
    SELECT id, company_id, name, message_body, active,
           created_by_user_id, created_at, updated_at
    FROM public.campaign_templates
    WHERE company_id = ${companyId}::uuid
      AND active = true
    ORDER BY updated_at DESC, name ASC
  `;
  return rows ?? [];
}

export async function getCampaignTemplate(
  companyId: string,
  templateId: string,
): Promise<CampaignTemplateRow | null> {
  await ensureCampaignsSchema();
  const rows = await sql<CampaignTemplateRow[]>`
    SELECT id, company_id, name, message_body, active,
           created_by_user_id, created_at, updated_at
    FROM public.campaign_templates
    WHERE id = ${templateId}::uuid
      AND company_id = ${companyId}::uuid
      AND active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createCampaignTemplate(
  companyId: string,
  userId: string | null,
  data: { name: string; message_body: string },
): Promise<CampaignTemplateRow> {
  await ensureCampaignsSchema();
  const rows = await sql<CampaignTemplateRow[]>`
    INSERT INTO public.campaign_templates
      (company_id, name, message_body, created_by_user_id)
    VALUES (
      ${companyId}::uuid,
      ${data.name.trim()},
      ${data.message_body},
      ${userId ?? null}::uuid
    )
    RETURNING id, company_id, name, message_body, active,
              created_by_user_id, created_at, updated_at
  `;
  return rows[0];
}

export async function deactivateCampaignTemplate(
  companyId: string,
  templateId: string,
): Promise<boolean> {
  await ensureCampaignsSchema();
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
