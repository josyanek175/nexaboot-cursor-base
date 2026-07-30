/**
 * GET /api/internal/db-pool-status
 * Diagnóstico temporário do pool (sem segredos).
 * Protegido: sessão + SUPER_ADMIN | TI | ADMIN_GERAL.
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

/** Remove path absoluto, querystring e trechos sensíveis da origem. */
function sanitizeOrigin(origin: string): string {
  return origin
    .split(" | ")
    .map((part) =>
      part
        .replace(/\\/g, "/")
        .replace(/^[A-Za-z]:\/.*?\/(src\/)/, "$1")
        .replace(/^.*?\/(src\/)/, "$1")
        .replace(/\?.*?(?=:|$)/g, "")
        .replace(/https?:\/\/[^\s)]+/gi, "[url]")
        .slice(0, 180),
    )
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

export const Route = createFileRoute("/api/internal/db-pool-status")({
  server: {
    handlers: {
      GET: async () => {
        const uid = getSessionUserId();
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
          trackedActive: pool.trackedActive,
          trackedPending: pool.trackedPending,
          reservedOpenInProcess: pool.reservedOpenInProcess,
          reservePending: pool.reservePending,
          activeAcquisitions: pool.activeAcquisitions.map((a) => ({
            acquisitionId: a.acquisitionId,
            kind: a.kind,
            origin: sanitizeOrigin(a.origin),
            status: a.status,
            ageMs: a.ageMs,
            waitedMs: a.waitedMs,
            heldMs: a.heldMs,
          })),
          bootstrapState: getDatabaseBootstrapState(),
          bootstrapActiveRun: diag.bootstrapActiveRun,
          processPid: pool.processPid,
          instanceId: diag.bootstrapInstanceId,
        });
      },
    },
  },
});
