// GET /api/evolution/channels/:id/qrcode — solicita o QR Code da instância.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import {
  hasEvoConfig, connectInstanceEvo, extractQr, instanceState, mapEvoStatus,
} from "@/lib/evolution.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/evolution/channels/$id/qrcode")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });
        if (!hasEvoConfig()) return Response.json({ error: "missing_evolution_config" }, { status: 400 });

        const s = sql();
        const rows = await s<{ evolution_instance_name: string | null }[]>`
          SELECT evolution_instance_name FROM public.whatsapp_channels
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        const instance = rows[0].evolution_instance_name;
        if (!instance) return Response.json({ error: "missing_instance" }, { status: 400 });

        // Já conectada? Não há QR a gerar.
        const st = await instanceState(instance);
        const current = st.ok ? mapEvoStatus(st.data?.instance?.state ?? st.data?.state) : null;
        if (current === "connected") {
          await s`UPDATE public.whatsapp_channels SET status = 'connected', last_connected_at = now(), updated_at = now() WHERE id = ${params.id}::uuid`;
          return Response.json({ status: "connected", qrcode: null });
        }

        const r = await connectInstanceEvo(instance);
        const qrcode = extractQr(r.data);
        const status = qrcode ? "qrcode" : current ?? "connecting";
        await s`UPDATE public.whatsapp_channels SET status = ${status}, updated_at = now() WHERE id = ${params.id}::uuid`;
        return Response.json({ status, qrcode });
      },
    },
  },
});
