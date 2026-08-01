// GET /api/health — diagnóstico de runtime (sem DB, auth ou integrações).
import { createFileRoute } from "@tanstack/react-router";
import { execSync } from "node:child_process";
import {
  getDatabaseBootstrapHealthState,
  isDatabaseSchemaBootstrapEnabled,
  PG_POOL_MAX,
} from "@/lib/pg.server";

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

        console.log("[HEALTH_CHECK]", {
          port: process.env.PORT ?? null,
          nodeEnv: process.env.NODE_ENV ?? null,
          bootstrapEnabled,
          databaseBootstrap,
          poolMax: PG_POOL_MAX,
        });

        return Response.json({
          ok: true,
          ready: true,
          service: "nexaboot-api",
          time: new Date().toISOString(),
          env: process.env.NODE_ENV ?? "unknown",
          port: process.env.PORT ?? null,
          commit: readGitCommit(),
          bootstrapEnabled,
          databaseBootstrap,
          poolMax: PG_POOL_MAX,
          hasMetaVerifyToken: !!process.env.META_APP_VERIFY_TOKEN?.trim(),
          hasMetaAppSecret: !!process.env.META_APP_SECRET?.trim(),
          hasTokenEncryptionKey: !!process.env.META_TOKEN_ENCRYPTION_KEY?.trim(),
          metaCoexistenceEnabled:
            process.env.META_COEXISTENCE_ENABLED?.trim().toLowerCase() === "true" ||
            process.env.META_COEXISTENCE_ENABLED?.trim() === "1" ||
            process.env.META_COEXISTENCE_ENABLED?.trim().toLowerCase() === "yes",
        });
      },
    },
  },
});
