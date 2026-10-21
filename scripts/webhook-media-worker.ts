/**
 * Media-worker de webhooks (processo dedicado).
 *
 * - NÃO importa src/server.ts, não sobe servidor web, não roda bootstrap.
 * - Com WEBHOOK_MEDIA_WORKER_ENABLED=false fica estacionado.
 * - Com a flag ligada: claima webhook_media_jobs, baixa/armazena mídia e
 *   atualiza a mensagem — fora do pool do nexaboot-web.
 *
 * Uso:
 *   npm run webhook:media-worker
 *   tsx scripts/webhook-media-worker.ts
 */
import { hostname } from "node:os";

import {
  closeWebhookMediaSql,
  getWebhookMediaSql,
} from "@/lib/pg-webhook-media.server";
import {
  isWebhookMediaWorkerEnabled,
  readWebhookMediaConfig,
} from "@/lib/webhook-media-core";
import { runWebhookMediaWorkerLoop } from "@/lib/webhook-media-worker-loop.server";

function buildWorkerId(): string {
  const host = (() => {
    try {
      return hostname();
    } catch {
      return "unknown-host";
    }
  })();
  return `media:${host}:${process.pid}`;
}

const workerId = buildWorkerId();
const mediaConfig = readWebhookMediaConfig(process.env);
const mediaWorkerEnabled = isWebhookMediaWorkerEnabled(process.env);

let sqlOpened = false;

const { exitCode } = await runWebhookMediaWorkerLoop({
  config: mediaConfig,
  workerId,
  mediaWorkerEnabled,
  createSql: () => {
    sqlOpened = true;
    return getWebhookMediaSql();
  },
  closeResources: async () => {
    if (sqlOpened) await closeWebhookMediaSql();
  },
});

process.exit(exitCode);
