/**
 * Message-worker de webhooks (processo dedicado).
 *
 * - NÃO importa src/server.ts, não sobe servidor web, não roda bootstrap.
 * - Com WEBHOOK_RABBITMQ_PROCESSING_ENABLED=false fica estacionado: não
 *   conecta ao RabbitMQ, não abre pool, não processa a inbox.
 * - Com a flag ligada: consome a fila, carrega o evento da inbox e executa o
 *   mesmo domínio que a rota legada — sem download de mídia.
 *
 * Uso:
 *   npm run webhook:message-worker
 *   tsx scripts/webhook-message-worker.ts
 *
 * Env obrigatórias quando WEBHOOK_RABBITMQ_PROCESSING_ENABLED=true:
 *   RABBITMQ_URL
 *   WEBHOOK_INBOX_DATABASE_URL (ou DATABASE_URL)
 */
import { hostname } from "node:os";

import {
  closeWebhookInboxSql,
  getWebhookInboxSql,
} from "@/lib/pg-webhook-inbox.server";
import { readRabbitConfig } from "@/lib/rabbitmq.server";
import {
  isWebhookRabbitProcessingEnabled,
  readWebhookMessageConfig,
} from "@/lib/webhook-message-core";
import { runWebhookMessageWorkerLoop } from "@/lib/webhook-message-worker-loop.server";

function buildWorkerId(): string {
  const host = (() => {
    try {
      return hostname();
    } catch {
      return "unknown-host";
    }
  })();
  return `msg:${host}:${process.pid}`;
}

const workerId = buildWorkerId();
const rabbitConfig = readRabbitConfig(process.env);
const messageConfig = readWebhookMessageConfig(process.env);
const processingEnabled = isWebhookRabbitProcessingEnabled(process.env);

let sqlOpened = false;

const { exitCode } = await runWebhookMessageWorkerLoop({
  config: messageConfig,
  rabbitConfig,
  workerId,
  processingEnabled,
  createSql: () => {
    sqlOpened = true;
    return getWebhookInboxSql();
  },
  closeResources: async () => {
    if (sqlOpened) await closeWebhookInboxSql();
  },
});

process.exit(exitCode);
