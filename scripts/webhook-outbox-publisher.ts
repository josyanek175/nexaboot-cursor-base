/**
 * Serviço publicador da outbox de webhooks (processo dedicado).
 *
 * - NÃO importa src/server.ts, não sobe servidor web, não roda bootstrap.
 * - NÃO executa processamento de contato, conversa ou mensagem: só transporta
 *   a referência do evento para o RabbitMQ.
 * - Com RABBITMQ_ENABLED=false ou WEBHOOK_OUTBOX_PUBLISHER_ENABLED=false fica
 *   estacionado, sem abrir pool nem consultar a outbox.
 *
 * Uso:
 *   npm run webhook:outbox-publisher
 *   tsx scripts/webhook-outbox-publisher.ts
 *
 * Env obrigatórias quando as duas flags estão ligadas:
 *   RABBITMQ_URL
 *   WEBHOOK_INBOX_DATABASE_URL (ou DATABASE_URL)
 */
import { hostname } from "node:os";

import {
  closeWebhookInboxSql,
  getWebhookInboxSql,
} from "@/lib/pg-webhook-inbox.server";
import {
  createRabbitPublisher,
  maskRabbitError,
  readRabbitConfig,
} from "@/lib/rabbitmq.server";
import { isWebhookOutboxPublisherEnabled } from "@/lib/webhook-message-core";
import { readWebhookOutboxConfig } from "@/lib/webhook-outbox-core";
import { runWebhookOutboxPublisherLoop } from "@/lib/webhook-outbox-publisher.server";
import { createSqlOutboxRepository } from "@/lib/webhook-outbox.server";

function buildWorkerId(): string {
  const host = (() => {
    try {
      return hostname();
    } catch {
      return "unknown-host";
    }
  })();
  return `${host}:${process.pid}`;
}

const workerId = buildWorkerId();
const rabbitConfig = readRabbitConfig(process.env);
const outboxConfig = readWebhookOutboxConfig(process.env);
const publisherEnabled = isWebhookOutboxPublisherEnabled(process.env);

// O pool só é aberto se o serviço realmente for trabalhar.
let sqlOpened = false;

const { exitCode } = await runWebhookOutboxPublisherLoop({
  config: outboxConfig,
  rabbitConfig,
  publisherEnabled,
  workerId,
  createRepository: () => {
    sqlOpened = true;
    return createSqlOutboxRepository(getWebhookInboxSql());
  },
  createPublisher: () => createRabbitPublisher({ config: rabbitConfig }),
  closeResources: async () => {
    if (sqlOpened) await closeWebhookInboxSql();
  },
});

if (exitCode !== 0) {
  console.error(
    "[WEBHOOK_OUTBOX_PUBLISHER_FAILED]",
    { workerId, exitCode, error: maskRabbitError(new Error("exit_nonzero")) },
  );
}

process.exit(exitCode);
