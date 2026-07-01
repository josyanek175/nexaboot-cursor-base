// Diagnóstico: schema de planos + execução dos SELECTs usados pela app.
// GET /api/debug/plans-selects
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  listCompaniesWithPlanUsage,
  getCompanyPlanUsage,
  countActiveWhatsAppChannels,
} from "@/lib/subscription.server";

const PLAN_COLUMNS = [
  "id", "name", "code", "description", "max_whatsapp_channels",
  "max_users", "max_messages_month", "max_campaigns_month",
  "allow_automations", "allow_internal_chat", "allow_api_access",
  "active", "created_at", "updated_at",
];

const SUB_COLUMNS = [
  "id", "company_id", "plan_id", "status", "started_at",
  "ends_at", "canceled_at", "created_at", "updated_at",
];

export const Route = createFileRoute("/api/debug/plans-selects")({
  server: {
    handlers: {
      GET: async () => {
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "DATABASE_URL não configurada" }, { status: 500 });
        }
        try {
          await ensureCrmSchema();

          const colRows = await sql<{ table_name: string; column_name: string }[]>`
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('plans', 'company_subscriptions', 'companies', 'whatsapp_channels')
            ORDER BY table_name, ordinal_position
          `;

          const colsByTable: Record<string, string[]> = {};
          for (const r of colRows) {
            (colsByTable[r.table_name] ??= []).push(r.column_name);
          }

          const missing = {
            plans: PLAN_COLUMNS.filter((c) => !colsByTable.plans?.includes(c)),
            company_subscriptions: SUB_COLUMNS.filter(
              (c) => !colsByTable.company_subscriptions?.includes(c),
            ),
          };

          const plans = await sql`
            SELECT id, code, name, max_whatsapp_channels, active
            FROM public.plans
            ORDER BY max_whatsapp_channels ASC
          `;

          const companies = await listCompaniesWithPlanUsage({});

          const sampleCompanyId = companies[0]?.id as string | undefined;
          let sampleUsage = null;
          let sampleChannelCount = null;
          if (sampleCompanyId) {
            sampleUsage = await getCompanyPlanUsage(sampleCompanyId);
            sampleChannelCount = await countActiveWhatsAppChannels(sampleCompanyId);
          }

          const subscriptions = await sql`
            SELECT cs.id, c.name AS company_name, p.code AS plan_code, cs.status
            FROM public.company_subscriptions cs
            JOIN public.companies c ON c.id = cs.company_id
            JOIN public.plans p ON p.id = cs.plan_id
            ORDER BY c.name
            LIMIT 20
          `;

          return Response.json({
            ok: true,
            tables: colsByTable,
            missing_columns: missing,
            plans_count: plans.length,
            plans,
            companies_with_usage: companies,
            subscriptions_sample: subscriptions,
            sample_company_id: sampleCompanyId ?? null,
            sample_usage: sampleUsage,
            sample_channel_count: sampleChannelCount,
          });
        } catch (e) {
          const err = e as { message?: string; code?: string; detail?: string };
          return Response.json(
            {
              ok: false,
              error: err.message ?? String(e),
              code: err.code,
              detail: err.detail,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
