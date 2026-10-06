// GET /api/attendance/templates?conversationId= — presets ativos do canal Meta da conversa.
// GET /api/attendance/templates?admin=1 — lista admin da empresa.
// POST /api/attendance/templates — cria/atualiza preset (admin/gerente).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { sql } from "@/lib/pg.server";
import {
  canConfigureCampaignCosts,
  canViewCampaignCosts,
  actingUserFromAuth,
} from "@/lib/permissions";
import {
  listAttendanceTemplatesAdmin,
  listAttendanceTemplatesForConversation,
  listApprovedMetaTemplatesForCompany,
  upsertAttendanceTemplate,
} from "@/lib/attendance-template.server";

const PostBody = z.object({
  id: z.string().uuid().optional().nullable(),
  metaTemplateId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().nullable(),
  variables: z.array(z.record(z.string(), z.unknown())).optional(),
  active: z.boolean().optional(),
});

async function loadActor(companyId: string) {
  const uid = getSessionUserId();
  if (!uid) return null;
  const rows = await sql<{ id: string; role: string | null; tenant_id: string | null }[]>`
    SELECT id, role, tenant_id FROM public.users
    WHERE id = ${uid}::uuid
    LIMIT 1
  `;
  const u = rows[0];
  if (!u) return null;
  return actingUserFromAuth({
    id: u.id,
    role: String(u.role ?? "ATENDENTE"),
    tenantId: String(u.tenant_id ?? companyId),
  });
}

export const Route = createFileRoute("/api/attendance/templates")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        const url = new URL(request.url);
        const admin = url.searchParams.get("admin") === "1";
        const conversationId = url.searchParams.get("conversationId");

        if (admin) {
          const actor = await loadActor(company);
          if (!actor || !canViewCampaignCosts(actor)) {
            return Response.json({ error: "forbidden" }, { status: 403 });
          }
          const [templates, metaTemplates] = await Promise.all([
            listAttendanceTemplatesAdmin(company),
            listApprovedMetaTemplatesForCompany(company),
          ]);
          return Response.json({ templates, metaTemplates });
        }

        if (!conversationId) {
          return Response.json({ error: "conversationId_required" }, { status: 400 });
        }

        const result = await listAttendanceTemplatesForConversation({
          companyId: company,
          conversationId,
        });
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({
          channelType: result.channelType,
          contactName: result.contactName,
          templates: result.templates,
        });
      },

      POST: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        const actor = await loadActor(company);
        if (!actor || !canConfigureCampaignCosts(actor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode configurar templates de atendimento.",
            },
            { status: 403 },
          );
        }

        const json = await request.json().catch(() => null);
        const parsed = PostBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const result = await upsertAttendanceTemplate({
          companyId: company,
          id: parsed.data.id,
          metaTemplateId: parsed.data.metaTemplateId,
          name: parsed.data.name,
          description: parsed.data.description,
          variables: parsed.data.variables,
          active: parsed.data.active,
        });

        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({ template: result.template }, { status: 201 });
      },
    },
  },
});
