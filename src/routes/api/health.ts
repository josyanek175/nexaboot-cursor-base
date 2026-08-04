// GET /api/health — liveness (ok) + readiness (ready) com probe SELECT 1.
import { createFileRoute } from "@tanstack/react-router";
import { execSync } from "node:child_process";
import {
  getDatabaseBootstrapHealthState,
  isDatabaseSchemaBootstrapEnabled,
  PG_POOL_MAX,
  getPgPoolStatus,
  probeDatabaseReadiness,
} from "@/lib/pg.server";
import { logPoolGateStatus } from "@/lib/pg-pool-gate.server";

function readGitCommit(): string | null {
  if (process.env.GIT_COMMIT?.trim()) return process.env.GIT_COMMIT.trim();
  if (process.env.EASYPANEL_GIT_COMMIT?.trim()) return process.env.EASYPANEL_GIT_COMMIT.trim();
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const bootstrapEnabled = isDatabaseSchemaBootstrapEnabled();
        const databaseBootstrap = getDatabaseBootstrapHealthState();
        const pool = getPgPoolStatus();

        let dbProbe: { ok: boolean; ms: number; error?: string } = {
          ok: false,
          ms: 0,
          error: "not_probed",
        };
        if (process.env.DATABASE_URL?.trim()) {
          dbProbe = await probeDatabaseReadiness();
        } else {
          dbProbe = { ok: false, ms: 0, error: "no_database_url" };
        }

        const ready = dbProbe.ok;
        logPoolGateStatus("PG_POOL_STATUS_HEALTH");

        console.log("[HEALTH_CHECK]", {
          port: process.env.PORT ?? null,
          nodeEnv: process.env.NODE_ENV ?? null,
          bootstrapEnabled,
          databaseBootstrap,
          poolMax: PG_POOL_MAX,
          ready,
          dbProbe,
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
        });

        return Response.json(
          {
            ok: true,
            ready,
            service: "nexaboot-api",
            time: new Date().toISOString(),
            env: process.env.NODE_ENV ?? "unknown",
            port: process.env.PORT ?? null,
            commit: readGitCommit(),
            bootstrapEnabled,
            databaseBootstrap,
            poolMax: PG_POOL_MAX,
            pool: {
              totalCount: pool.totalCount,
              idleCount: pool.idleCount,
              waitingCount: pool.waitingCount,
              reservedOpen: pool.reservedOpenInProcess,
              reservePending: pool.reservePending,
              connectTimeoutSec: pool.connectTimeoutSec,
              idleTimeoutSec: pool.idleTimeoutSec,
              webhookActive: pool.webhookActive,
              webhookMax: pool.webhookMax,
            },
            db: dbProbe,
            hasMetaVerifyToken: !!process.env.META_APP_VERIFY_TOKEN?.trim(),
            hasMetaAppSecret: !!process.env.META_APP_SECRET?.trim(),
            hasTokenEncryptionKey: !!process.env.META_TOKEN_ENCRYPTION_KEY?.trim(),
            metaCoexistenceEnabled:
              process.env.META_COEXISTENCE_ENABLED?.trim().toLowerCase() === "true" ||
              process.env.META_COEXISTENCE_ENABLED?.trim() === "1" ||
              process.env.META_COEXISTENCE_ENABLED?.trim().toLowerCase() === "yes",
          },
          { status: ready ? 200 : 503 },
        );
      },
    },
  },
});
