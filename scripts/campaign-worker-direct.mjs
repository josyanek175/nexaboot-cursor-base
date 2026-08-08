/**
 * Entrypoint do campaign-worker directo (processo dedicado).
 *
 * - NÃO importa src/server.ts
 * - NÃO inicia bootstrap / servidor da aplicação web
 * - Usa pool dedicado (pg-worker.server) via processCampaignWorkerTick({ sql })
 *
 * Uso (EasyPanel / local):
 *   npm run campaign:worker:direct
 *   tsx scripts/campaign-worker-direct.mjs
 *
 * Env:
 *   CAMPAIGN_WORKER_MODE=direct
 *   CAMPAIGN_WORKER_ENABLED=true
 *   CAMPAIGN_WORKER_DATABASE_URL  (ou DATABASE_URL só neste serviço)
 *   CAMPAIGN_WORKER_CONCURRENCY=1
 *   CAMPAIGN_WORKER_HEALTH_ENABLED=true  (opcional; default off)
 *   CAMPAIGN_WORKER_HEALTH_PORT=8081
 */
import {
  assertDirectWorkerConfig,
  createWorkerHealthState,
  readDirectWorkerConfig,
  runDirectWorkerLoop,
  startHealthServer,
  maskExternalError,
} from "./campaign-worker-direct-lib.mjs";

const config = readDirectWorkerConfig(process.env);

try {
  assertDirectWorkerConfig(config);
} catch (e) {
  const code = e?.code;
  if (code === "worker_disabled") {
    // Desativação intencional — não é erro de configuração.
    console.log(
      JSON.stringify({
        event: "campaign_worker_disabled",
        code: "worker_disabled",
        message: "CAMPAIGN_WORKER_ENABLED=false — worker directo não inicia.",
      }),
    );
    process.exit(0);
  }
  console.error(
    JSON.stringify({
      event: "campaign_worker_direct_config_error",
      code: code ?? "config_error",
      error: maskExternalError(e),
    }),
  );
  process.exit(1);
}

// Imports TypeScript (requer tsx). Sem src/server.ts / bootstrap web.
const { getWorkerSql, closeWorkerSql } = await import("../src/lib/pg-worker.server.ts");
const { processCampaignWorkerTick } = await import("../src/lib/campaign-worker.server.ts");

const healthState = createWorkerHealthState();
let healthServer = null;

if (config.healthPort != null) {
  try {
    healthServer = await startHealthServer({
      port: config.healthPort,
      healthState,
      log: (line) => console.log(line),
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "campaign_worker_health_listen_error",
        error: maskExternalError(e),
      }),
    );
    process.exit(1);
  }
}

const sql = getWorkerSql();

const { exitCode } = await runDirectWorkerLoop({
  config,
  healthState,
  tickFn: async () => processCampaignWorkerTick({ sql }),
  closePoolFn: async () => {
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(() => resolve()));
    }
    await closeWorkerSql();
  },
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
});

process.exit(exitCode);
