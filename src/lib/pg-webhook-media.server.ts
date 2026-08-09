/**
 * Pool PostgreSQL exclusivo do media-worker.
 *
 * Separado do pool do nexaboot-web e do pool da inbox de propósito: download
 * de mídia não pode saturar a UI nem a ingestão. NÃO importar pg.server.
 */

import postgres from "postgres";
import type { PgSql } from "@/lib/pg-types";

let _mediaSql: PgSql | null = null;
let _configLogged = false;

function readIntEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min || floored > max) return fallback;
  return floored;
}

export const WEBHOOK_MEDIA_DEFAULT_POOL_MAX = 2;
export const WEBHOOK_MEDIA_DEFAULT_CONNECT_TIMEOUT_SEC = 10;
export const WEBHOOK_MEDIA_DEFAULT_IDLE_TIMEOUT_SEC = 20;
export const WEBHOOK_MEDIA_DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;

export function readWebhookMediaPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(env.WEBHOOK_MEDIA_PG_POOL_MAX, WEBHOOK_MEDIA_DEFAULT_POOL_MAX, 1, 20);
}

export function resolveWebhookMediaDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.WEBHOOK_MEDIA_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  const inbox = env.WEBHOOK_INBOX_DATABASE_URL?.trim();
  if (inbox) return inbox;
  const fallback = env.DATABASE_URL?.trim();
  if (fallback) return fallback;
  throw new Error("WEBHOOK_MEDIA_DATABASE_URL (ou WEBHOOK_INBOX_DATABASE_URL/DATABASE_URL) não configurada");
}

export function getWebhookMediaSql(env: NodeJS.ProcessEnv = process.env): PgSql {
  if (_mediaSql) return _mediaSql;

  const url = resolveWebhookMediaDatabaseUrl(env);
  const max = readWebhookMediaPoolMax(env);
  const connectTimeoutSec = readIntEnv(env.WEBHOOK_MEDIA_PG_CONNECT_TIMEOUT_SEC, 10, 1, 60);
  const idleTimeoutSec = readIntEnv(env.WEBHOOK_MEDIA_PG_IDLE_TIMEOUT_SEC, 20, 1, 600);
  const statementTimeoutMs = readIntEnv(
    env.WEBHOOK_MEDIA_PG_STATEMENT_TIMEOUT_MS,
    WEBHOOK_MEDIA_DEFAULT_STATEMENT_TIMEOUT_MS,
    1,
    600_000,
  );

  _mediaSql = postgres(url, {
    ssl:
      url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
        ? "require"
        : undefined,
    max,
    prepare: false,
    connect_timeout: connectTimeoutSec,
    idle_timeout: idleTimeoutSec,
    max_lifetime: 60 * 30,
    connection: {
      statement_timeout: statementTimeoutMs,
    },
  });

  if (!_configLogged) {
    _configLogged = true;
    console.log("[WEBHOOK_MEDIA_PG_POOL]", {
      max,
      connectTimeoutSec,
      idleTimeoutSec,
      statementTimeoutMs,
      hasDedicatedUrl: Boolean(env.WEBHOOK_MEDIA_DATABASE_URL?.trim()),
    });
  }

  return _mediaSql;
}

export async function closeWebhookMediaSql(): Promise<void> {
  if (!_mediaSql) return;
  const sql = _mediaSql;
  _mediaSql = null;
  await sql.end({ timeout: 5 });
}
