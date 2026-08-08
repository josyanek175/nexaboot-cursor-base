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
 *   CAMPAIGN_WORKER_MODE         (http | direct | disabled; default http)
 *   CAMPAIGN_WORKER_ENABLED      (default true)
 *
 * Em mode=direct, mode=disabled ou CAMPAIGN_WORKER_ENABLED=false o poller não
 * envia nenhum tick. O processo permanece ocioso em vez de sair, para não
 * provocar restart-loop no orquestrador.
 */
import { readWorkerConfig, runWorkerLoop } from "./campaign-worker-lib.mjs";

/** Mantém o processo vivo sem trabalho e sem log adicional, até SIGTERM/SIGINT. */
function parkUntilSignal() {
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = () => {
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const config = readWorkerConfig();

const outcome = await runWorkerLoop({ config });

if (outcome && outcome.started === false) {
  parkUntilSignal();
}
