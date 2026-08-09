/**
 * Teste de integração opcional do message-worker com RabbitMQ DEV.
 *
 * Desligado por padrão. Não roda em CI. Exige broker real e flags explícitas.
 *
 *   $env:WEBHOOK_MESSAGE_WORKER_INTEGRATION="true"
 *   $env:RABBITMQ_ENABLED="true"
 *   $env:RABBITMQ_URL="amqp://..."
 *   npx tsx scripts/test-webhook-message-worker-integration.mjs
 *
 * Recusa nomes de topologia que pareçam produção.
 */
import { readRabbitConfig, assertRabbitConfig } from "../src/lib/rabbitmq.server.ts";
import { createRabbitConsumer } from "../src/lib/rabbitmq-consumer.server.ts";
import { createRabbitPublisher } from "../src/lib/rabbitmq.server.ts";
import { OUTBOX_MESSAGE_SCHEMA_VERSION } from "../src/lib/webhook-outbox-core.ts";
import { randomUUID } from "node:crypto";

const enabled = (process.env.WEBHOOK_MESSAGE_WORKER_INTEGRATION ?? "").toLowerCase() === "true";
if (!enabled) {
  console.log("SKIP message-worker integration (WEBHOOK_MESSAGE_WORKER_INTEGRATION!=true)");
  process.exit(0);
}

const config = readRabbitConfig(process.env);
assertRabbitConfig(config);

const looksProd = [config.exchange, config.queue, config.dlq].some((n) =>
  /prod|production|live/i.test(n),
);
if (looksProd) {
  console.error("FAIL recusa topologia que parece produção.");
  process.exit(1);
}

const inboxId = randomUUID();
const publisher = createRabbitPublisher({ config });
const consumer = createRabbitConsumer({ config, prefetch: 1 });

let received = null;
await consumer.start(async (msg) => {
  received = JSON.parse(msg.content.toString("utf8"));
  return { action: "ack" };
});

await publisher.publish({
  routingKey: "evolution.messages.upsert",
  body: {
    schemaVersion: OUTBOX_MESSAGE_SCHEMA_VERSION,
    inboxId,
    provider: "evolution",
    eventType: "messages.upsert",
    conversationKey: "integration@test",
    receivedAt: new Date().toISOString(),
  },
  messageId: inboxId,
});

const deadline = Date.now() + 15_000;
while (!received && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

await consumer.stop();
await consumer.close();
await publisher.close();

if (!received || received.inboxId !== inboxId) {
  console.error("FAIL nao recebeu a mensagem publicada", received);
  process.exit(1);
}

console.log("OK   message-worker integration recebeu e confirmou mensagem DEV");
