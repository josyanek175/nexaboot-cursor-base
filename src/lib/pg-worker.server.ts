/**
 * Pool PostgreSQL exclusivo do campaign-worker (processo direct).
 * NÃO usar no nexaboot-web. NÃO importar pg.server daqui.
 */
import postgres from "postgres";
import type { PgSql } from "@/lib/pg-types";

let _workerSql: PgSql | null = null;
let _configLogged = false;

function readPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAMPAIGN_WORKER_PG_POOL_MAX?.trim();
  if (!raw) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  const floored = Math.floor(n);
  if (floored < 1 || floored > 10) return 2;
  return floored;
}

function readConnectTimeoutSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAMPAIGN_WORKER_PG_CONNECT_TIMEOUT_SEC?.trim();
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 60) return 10;
  return Math.floor(n);
}

function readIdleTimeoutSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAMPAIGN_WORKER_PG_IDLE_TIMEOUT_SEC?.trim();
  if (!raw) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 600) return 20;
  return Math.floor(n);
}

/**
 * URL do banco do worker.
 * Preferir CAMPAIGN_WORKER_DATABASE_URL.
 * Fallback DATABASE_URL só é válido dentro do serviço worker (documentado).
 */
export function resolveCampaignWorkerDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dedicated = env.CAMPAIGN_WORKER_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  const fallback = env.DATABASE_URL?.trim();
  if (fallback) return fallback;
  throw new Error(
    "CAMPAIGN_WORKER_DATABASE_URL (ou DATABASE_URL no serviço worker) não configurada",
  );
}

export function getCampaignWorkerPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return readPoolMax(env);
}

/** Cliente postgres.js do worker (lazy singleton deste processo). */
export function getWorkerSql(env: NodeJS.ProcessEnv = process.env): PgSql {
  if (_workerSql) return _workerSql;
  const url = resolveCampaignWorkerDatabaseUrl(env);
  const max = readPoolMax(env);
  const connectTimeoutSec = readConnectTimeoutSec(env);
  const idleTimeoutSec = readIdleTimeoutSec(env);

  _workerSql = postgres(url, {
    ssl:
      url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
        ? "require"
        : undefined,
    max,
    prepare: false,
    connect_timeout: connectTimeoutSec,
    idle_timeout: idleTimeoutSec,
    max_lifetime: 60 * 30,
  });

  if (!_configLogged) {
    _configLogged = true;
    console.log(
      JSON.stringify({
        event: "campaign_worker_pool_config",
        poolMax: max,
        connectTimeoutSec,
        idleTimeoutSec,
        maxLifetimeSec: 1800,
        hasDedicatedUrl: Boolean(env.CAMPAIGN_WORKER_DATABASE_URL?.trim()),
        // nunca logar a URL
      }),
    );
  }

  return _workerSql;
}

/** Encerra o pool com segurança (SIGTERM / shutdown). */
export async function closeWorkerSql(): Promise<void> {
  if (!_workerSql) return;
  const client = _workerSql;
  _workerSql = null;
  await client.end({ timeout: 5 });
}

export function isWorkerSqlOpen(): boolean {
  return _workerSql != null;
}
