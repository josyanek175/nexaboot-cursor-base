// GET /api/health — diagnóstico de runtime (sem DB, auth ou integrações).
import { createFileRoute } from "@tanstack/react-router";
import { execSync } from "node:child_process";

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
        console.log("[HEALTH_CHECK]", {
          port: process.env.PORT ?? null,
          nodeEnv: process.env.NODE_ENV ?? null,
        });

        return Response.json({
          ok: true,
          service: "nexaboot-api",
          time: new Date().toISOString(),
          env: process.env.NODE_ENV ?? "unknown",
          port: process.env.PORT ?? null,
          commit: readGitCommit(),
          hasMetaVerifyToken: !!process.env.META_APP_VERIFY_TOKEN?.trim(),
          hasMetaAppSecret: !!process.env.META_APP_SECRET?.trim(),
        });
      },
    },
  },
});
