// POST /api/evolution/register-channel — cria/garante o canal Evolution.
// Cria company padrão se não existir e o whatsapp_channel com a instância.
// Idempotente (não duplica canal por instância). Não destrutivo.
// Autorização: sessão logada OU token (?token= / header x-admin-token)
// igual a ADMIN_SETUP_TOKEN ou EVOLUTION_WEBHOOK_SECRET.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z
  .object({
    instanceName: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120).optional(),
    companyName: z.string().min(1).max(160).optional(),
    companySlug: z.string().min(1).max(80).optional(),
  })
  .optional();

function authorized(request: Request): boolean {
  if (getSessionUserId()) return true;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-admin-token") || "";
  const expected = process.env.ADMIN_SETUP_TOKEN || process.env.EVOLUTION_WEBHOOK_SECRET || "";
  return !!expected && token === expected;
}

export const Route = createFileRoute("/api/evolution/register-channel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        await ensureCrmSchema();

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
        const slug = d.companySlug || "default";
        const companyName = d.companyName || "Empresa Padrão";

        const company = await s<{ id: string }[]>`
          INSERT INTO public.companies (name, slug)
          VALUES (${companyName}, ${slug})
          ON CONFLICT (slug) DO UPDATE SET updated_at = now()
          RETURNING id
        `;
        const companyId = company[0].id;

        const existing = await s<{ id: string }[]>`
          SELECT id FROM public.whatsapp_channels
          WHERE lower(channel_type) = 'evolution' AND evolution_instance_name = ${instanceName}
          LIMIT 1
        `;

        let channelId: string;
        if (existing[0]) {
          channelId = existing[0].id;
          await s`
            UPDATE public.whatsapp_channels
            SET name = COALESCE(${d.name ?? null}, name),
                company_id = COALESCE(company_id, ${companyId}::uuid),
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
