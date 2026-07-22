/**
 * Poller do worker de campanhas (dev/produção).
 *
 * Requer o app NexaBoot rodando (API /api/campaigns/worker/tick).
 *
 * Uso:
 *   node scripts/campaign-worker.mjs
 *
 * Env:
 *   APP_URL                      (default http://localhost:3000)
 *   CAMPAIGN_WORKER_SECRET       (obrigatório em produção)
 *   CAMPAIGN_WORKER_IDLE_MS      (default 5000)
 *   WORKER_INTERVAL_MS           (alias de CAMPAIGN_WORKER_IDLE_MS)
 *   CAMPAIGN_WORKER_TIMEOUT_MS   (default 60000)
 *   CAMPAIGN_WORKER_ERROR_DELAY_MS (default 10000)
 */
import { readWorkerConfig, runWorkerLoop } from "./campaign-worker-lib.mjs";

const config = readWorkerConfig();

await runWorkerLoop({ config });
