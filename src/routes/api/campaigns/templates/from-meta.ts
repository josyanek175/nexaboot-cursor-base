import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import { getMetaTemplateRowById } from "@/lib/meta-message-templates.server";
import { convertMetaTemplateToEvolutionDraft } from "@/lib/campaign-template-meta-convert";
import { createCampaignTemplate } from "@/lib/campaign-template.server";

const Body = z.object({
  meta_template_row_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  footer: z.string().max(500).optional(),
  meta_variable_mappings: z.record(z.string(), z.string()).optional(),
});

export const Route = createFileRoute("/api/campaigns/templates/from-meta")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const metaRow = await getMetaTemplateRowById(
          ctx.companyId,
          parsed.data.meta_template_row_id,
        );
        if (!metaRow) {
          return Response.json({ error: "meta_template_not_found" }, { status: 404 });
        }
        if (metaRow.status !== "APPROVED" || !metaRow.active) {
          return Response.json({ error: "meta_template_not_approved" }, { status: 400 });
        }

        const draft = convertMetaTemplateToEvolutionDraft({
          templateName: metaRow.template_name,
          languageCode: metaRow.language_code,
          components: metaRow.components,
          metaTemplateId: metaRow.meta_template_id ?? metaRow.id,
          metaVariableMappings: parsed.data.meta_variable_mappings,
          customName: parsed.data.name,
          footer: parsed.data.footer,
        });

        const template = await createCampaignTemplate(ctx.companyId, ctx.userId, {
          name: draft.name,
          message_body: draft.visibleBody,
          description: draft.meta.description,
          footer: draft.meta.footer,
          response_options: draft.responseOptions,
          source_meta_template_id: draft.meta.sourceMetaTemplateId,
          source_meta_template_name: draft.meta.sourceMetaTemplateName,
          source_meta_language_code: draft.meta.sourceMetaLanguageCode,
          channel_type: "evolution",
        });

        return Response.json({ template, draft: { visibleBody: draft.visibleBody } }, { status: 201 });
      },
    },
  },
});
