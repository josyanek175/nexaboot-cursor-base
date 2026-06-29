// POST /api/evolution/register-channel — cria/garante o canal Evolution da
// empresa do usuário logado. Idempotente (não duplica canal por instância) e
// não destrutivo.
//
// Segurança (isolamento oficial por company_id):
//   - exige usuário logado COM empresa válida (requireCompanyId → 401/403);
//   - o canal é SEMPRE vinculado à company_id do usuário logado;
//   - NUNCA cria "Empresa Padrão", NUNCA usa slug='default', NUNCA faz
//     COALESCE(company_id, default), NUNCA aceita token solto sem empresa;
//   - se a instância já existir em OUTRA empresa, bloqueia (409).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

const Body = z
  .object({
    instanceName: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120).optional(),
    // Aceitos por compatibilidade, porém IGNORADOS: a empresa é sempre a do
    // usuário logado (nunca uma empresa arbitrária vinda do corpo).
    companyName: z.string().min(1).max(160).optional(),
    companySlug: z.string().min(1).max(80).optional(),
  })
  .optional();

export const Route = createFileRoute("/api/evolution/register-channel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();

        // Empresa obrigatória: sem sessão => 401; sem empresa válida => 403.
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const json = await request.json().catch(() => ({}));
        const parsed = Body.safeParse(json ?? {});
        const d = parsed.success ? parsed.data ?? {} : {};

        const instanceName = d.instanceName || process.env.EVOLUTION_INSTANCE_NAME;
        if (!instanceName) {
          return Response.json(
            { error: "missing_instance_name", hint: "defina EVOLUTION_INSTANCE_NAME ou envie instanceName no body" },
            { status: 400 },
          );
        }

        const s = sql();

        // Instância é única globalmente: bloqueia se já pertence a outra empresa.
        const existing = await s<{ id: string; company_id: string | null }[]>`
          SELECT id, company_id FROM public.whatsapp_channels
          WHERE lower(channel_type) = 'evolution' AND evolution_instance_name = ${instanceName}
          LIMIT 1
        `;
        if (existing[0] && existing[0].company_id && existing[0].company_id !== companyId) {
          return Response.json({ error: "instance_belongs_to_another_company" }, { status: 409 });
        }

        let channelId: string;
        if (existing[0]) {
          channelId = existing[0].id;
          // Vincula à empresa do usuário se ainda estiver sem empresa; nunca a
          // uma empresa padrão. (company_id só é definido para a própria empresa.)
          await s`
            UPDATE public.whatsapp_channels
            SET name = COALESCE(${d.name ?? null}, name),
                company_id = ${companyId}::uuid,
                updated_at = now()
            WHERE id = ${channelId}::uuid
          `;
        } else {
          const inserted = await s<{ id: string }[]>`
            INSERT INTO public.whatsapp_channels
              (company_id, name, channel_type, evolution_instance_name, status)
            VALUES
              (${companyId}::uuid, ${d.name || instanceName}, 'evolution', ${instanceName}, 'disconnected')
            RETURNING id
          `;
          channelId = inserted[0].id;
        }

        console.log("[EVOLUTION_CHANNEL_REGISTERED]", { companyId, channelId, instanceName });
        return Response.json({
          ok: true,
          company_id: companyId,
          whatsapp_channel_id: channelId,
          evolution_instance_name: instanceName,
        });
      },
    },
  },
});
