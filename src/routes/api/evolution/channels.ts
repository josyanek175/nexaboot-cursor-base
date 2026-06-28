// GET  /api/evolution/channels  → lista canais (ativos) do banco principal.
// POST /api/evolution/channels  → cria canal no banco + cria instância na
//   Evolution (se não existir) + configura webhook. Não expõe API key.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getCurrentUserCompanyId } from "@/lib/company.server";
import {
  hasEvoConfig, instanceExists, createInstanceEvo, setInstanceWebhook,
  instanceState, mapEvoStatus, webhookUrl,
} from "@/lib/evolution.server";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  instanceName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+$/, "use apenas letras, números, ponto, hífen ou underline"),
  // Aceitos por compatibilidade, mas ignorados: o canal é vinculado à empresa
  // do usuário logado, não a uma empresa arbitrária do corpo da requisição.
  companyName: z.string().trim().min(1).max(160).optional(),
  companySlug: z.string().trim().min(1).max(80).optional(),
});

export const Route = createFileRoute("/api/evolution/channels")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });
        const s = sql();
        const channels = await s`
          SELECT id, company_id, name, display_name, phone_number,
                 channel_type, evolution_instance_name, status,
                 last_connected_at, active, created_at, updated_at
          FROM public.whatsapp_channels
          WHERE deleted_at IS NULL AND active = true
            AND company_id = ${companyId}::uuid
          ORDER BY created_at DESC
        `;
        return Response.json({ channels, evolutionConfigured: hasEvoConfig(), webhookUrl: webhookUrl() });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });

        const json = await request.json().catch(() => null);
        const parsed = CreateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }
        const { name, instanceName } = parsed.data;
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
          await s`
            UPDATE public.whatsapp_channels
            SET name = ${name}, display_name = COALESCE(display_name, ${name}),
                company_id = COALESCE(company_id, ${companyId}::uuid),
                active = true, deleted_at = NULL, updated_at = now()
            WHERE id = ${channelId}::uuid
          `;
        } else {
          const inserted = await s<{ id: string }[]>`
            INSERT INTO public.whatsapp_channels
              (company_id, name, display_name, channel_type, evolution_instance_name, status)
            VALUES
              (${companyId}::uuid, ${name}, ${name}, 'evolution', ${instanceName}, 'disconnected')
            RETURNING id
          `;
          channelId = inserted[0].id;
        }

        // Integração com a Evolution (best-effort; não bloqueia a criação no banco).
        const evolution: Record<string, unknown> = { configured: hasEvoConfig() };
        if (hasEvoConfig()) {
          try {
            const exists = await instanceExists(instanceName);
            evolution.alreadyExisted = exists;
            if (!exists) {
              const created = await createInstanceEvo(instanceName);
              evolution.created = created.ok;
              if (!created.ok) evolution.createError = created.error;
            }
            const wh = await setInstanceWebhook(instanceName);
            evolution.webhookSet = wh.ok;
            if (!wh.ok) evolution.webhookError = wh.error;

            const st = await instanceState(instanceName);
            const mapped = st.ok ? mapEvoStatus(st.data?.instance?.state ?? st.data?.state) : "connecting";
            evolution.status = mapped;
            await s`UPDATE public.whatsapp_channels SET status = ${mapped}, updated_at = now() WHERE id = ${channelId}::uuid`;
          } catch (e) {
            console.error("[EVOLUTION_ERROR]", e);
            evolution.error = e instanceof Error ? e.message : String(e);
          }
        }

        console.log("[EVOLUTION_CHANNEL_REGISTERED]", { channelId, companyId, instanceName });
        const rows = await s`
          SELECT id, company_id, name, display_name, phone_number, channel_type,
                 evolution_instance_name, status, last_connected_at, active, created_at, updated_at
          FROM public.whatsapp_channels WHERE id = ${channelId}::uuid
        `;
        return Response.json({ ok: true, channel: rows[0], evolution });
      },
    },
  },
});
