import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getSql } from "@/lib/pg.server";
import { requireOperationsAdmin, getOperationsSettings } from "@/lib/company-operations.server";
import {
  checkOperationsSchema,
  operationsErrorResponse,
  operationsJson,
} from "@/lib/operations-readiness.server";
const Body = z.object({
  waiting_attendant_minutes: z.number().int().min(1).max(1440),
  waiting_customer_hours: z.number().int().min(1).max(720),
  restrict_channels: z.boolean(),
});
export const Route = createFileRoute("/api/company-operations")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const actor = await requireOperationsAdmin();
          if (actor instanceof Response) return actor;
          const unavailable = await checkOperationsSchema();
          if (unavailable) return unavailable;
          return operationsJson(await getOperationsSettings(actor.companyId));
        } catch (error) {
          return operationsErrorResponse(error, "company-operations.GET");
        }
      },
      PUT: async ({ request }) => {
        try {
          const actor = await requireOperationsAdmin();
          if (actor instanceof Response) return actor;
          const parsed = Body.safeParse(await request.json().catch(() => null));
          if (!parsed.success)
            return operationsJson(
              { error: "invalid_input", message: "Confira os dados informados." },
              400,
            );
          const unavailable = await checkOperationsSchema();
          if (unavailable) return unavailable;
          const d = parsed.data;
          await getSql()`INSERT INTO public.company_operations_settings(company_id,waiting_attendant_minutes,waiting_customer_hours,restrict_channels)
     VALUES(${actor.companyId}::uuid,${d.waiting_attendant_minutes},${d.waiting_customer_hours},${d.restrict_channels})
     ON CONFLICT(company_id) DO UPDATE SET waiting_attendant_minutes=EXCLUDED.waiting_attendant_minutes,waiting_customer_hours=EXCLUDED.waiting_customer_hours,restrict_channels=EXCLUDED.restrict_channels,updated_at=now()`;
          return operationsJson({ ok: true });
        } catch (error) {
          return operationsErrorResponse(error, "company-operations.PUT");
        }
      },
    },
  },
});
