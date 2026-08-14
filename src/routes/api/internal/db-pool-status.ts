/**
 * GET /api/internal/db-pool-status
 * Diagnóstico temporário do pool (sem segredos).
 * Protegido: sessão + SUPER_ADMIN | TI | ADMIN_GERAL.
 *
 * Após remoção do Proxy global, trackedActive/trackedPending de queries = null.
 * Contadores confiáveis: reservedOpenInProcess, reservePending.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  getDatabaseBootstrapState,
  getDatabaseRuntimeDiag,
  getPgPoolStatus,
  sql,
} from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { isPlatformRole } from "@/lib/platform-roles";

export const Route = createFileRoute("/api/internal/db-pool-status")({
  server: {
    handlers: {
      GET: async () => {
        const uid = await getSessionUserId();
        if (!uid) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        try {
          const rows = await sql<{ role: string }[]>`
            SELECT role FROM public.users
            WHERE id = ${uid}
            LIMIT 1
          `;
          const role = rows[0]?.role;
          if (!isPlatformRole(role)) {
            return Response.json({ error: "forbidden" }, { status: 403 });
          }
        } catch {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const pool = getPgPoolStatus();
        const diag = getDatabaseRuntimeDiag();

        return Response.json({
          poolMax: pool.poolMax,
          trackedActive: null,
          trackedPending: null,
          reservedOpenInProcess: pool.reservedOpenInProcess,
          reservePending: pool.reservePending,
          activeAcquisitions: [],
          note: "query_tracking_disabled_no_proxy",
          bootstrapState: getDatabaseBootstrapState(),
          bootstrapActiveRun: diag.bootstrapActiveRun,
          processPid: pool.processPid,
          instanceId: diag.bootstrapInstanceId,
        });
      },
    },
  },
});
