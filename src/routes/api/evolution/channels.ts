// GET  /api/evolution/channels  → lista canais (ativos) do banco principal.
// POST /api/evolution/channels  → cria canal no banco + cria instância na
//   Evolution (se não existir) + configura webhook. Não expõe API key.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
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
  companyName: z.string().trim().min(1).max(160).optional(),
  companySlug: z.string().trim().min(1).max(80).optional(),
});

async function ensureDefaultCompany(companyName?: string, companySlug?: string): Promise<string> {
  const s = sql();
  const slug = companySlug || "default";
  const name = companyName || "Empresa Padrão";
  const rows = await s<{ id: string }[]>`
    INSERT INTO public.companies (name, slug)
    VALUES (${name}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return rows[0].id;
}

export const Route = createFileRoute("/api/evolution/channels")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const s = sql();
        const channels = await s`
          SELECT id, company_id, name, display_name, phone_number,
                 channel_type, evolution_instance_name, status,
                 last_connected_at, active, created_at, updated_at
          FROM public.whatsapp_channels
          WHERE deleted_at IS NULL AND active = true
          ORDER BY created_at DESC
        `;
        return Response.json({ channels, evolutionConfigured: hasEvoConfig(), webhookUrl: webhookUrl() });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const json = await request.json().catch(() => null);
        const parsed = CreateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }
        const { name, instanceName, companyName, companySlug } = parsed.data;
        const s = sql();
        const companyId = await ensureDefaultCompany(companyName, companySlug);

        // Upsert do canal no banco (idempotente por instância). Reativa se soft-deleted.
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
