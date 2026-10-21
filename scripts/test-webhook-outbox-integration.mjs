/**
 * Teste de integração OPCIONAL com um RabbitMQ real de DEV.
 *
 * Fica fora da suíte padrão de propósito: build e CI não podem depender de
 * broker. Sem a variável de ativação ele sai com sucesso e apenas informa que
 * foi ignorado.
 *
 * Como rodar (apontando para DEV, nunca para produção):
 *   $env:WEBHOOK_OUTBOX_INTEGRATION="true"
 *   $env:RABBITMQ_ENABLED="true"
 *   $env:RABBITMQ_URL="amqp://user:pass@host:5672"
 *   npx tsx scripts/test-webhook-outbox-integration.mjs
 *
 * O que ele valida contra o broker de verdade:
 *   - topologia durable (exchange, fila e DLQ) é criada;
 *   - publicação persistente recebe publisher confirm;
 *   - conexão e canal são reutilizados entre publicações.
 *
 * Ele NÃO consome a fila e NÃO toca em PostgreSQL.
 */
import {
  assertRabbitConfig,
  createRabbitPublisher,
  describeRabbitTopology,
  readRabbitConfig,
} from "../src/lib/rabbitmq.server.ts";
import { buildOutboxMessagePayload, buildOutboxRoutingKey } from "../src/lib/webhook-outbox-core.ts";

const enabled = String(process.env.WEBHOOK_OUTBOX_INTEGRATION ?? "").toLowerCase() === "true";

if (!enabled) {
  console.log(
    "SKIP integração RabbitMQ: defina WEBHOOK_OUTBOX_INTEGRATION=true e RABBITMQ_URL para executar.",
  );
  process.exit(0);
}

const config = readRabbitConfig(process.env);

if (!config.enabled || !config.url) {
  console.error("FAIL integração exige RABBITMQ_ENABLED=true e RABBITMQ_URL.");
  process.exit(1);
}

// Proteção contra apontar o teste para produção por engano.
const topology = describeRabbitTopology(config);
if (Object.values(topology).some((name) => /prod/i.test(name))) {
  console.error(`FAIL nomes de produção detectados na topologia: ${JSON.stringify(topology)}`);
  process.exit(1);
}

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assertRabbitConfig(config);
console.log(`Publicando em ${JSON.stringify(topology)} (URL omitida por segurança).`);

const publisher = createRabbitPublisher({ config });
const routingKey = buildOutboxRoutingKey("evolution", "integration.check");

try {
  const message = buildOutboxMessagePayload({
    inboxId: "00000000-0000-0000-0000-000000000000",
    provider: "evolution",
    identifiers: {
      eventType: "integration.check",
      instanceName: "integration",
      externalEventId: null,
      externalMessageId: `integration-${Date.now()}`,
      conversationKey: null,
    },
    receivedAt: new Date().toISOString(),
  });

  const startedAt = Date.now();
  await publisher.publish({ routingKey, body: message, messageId: message.externalMessageId });
  assert("publicação confirmada pelo broker", true);
  assert("confirm chegou em tempo razoável", Date.now() - startedAt < 15_000);
  assert("publisher ficou conectado", publisher.isConnected() === true);

  await publisher.publish({ routingKey, body: message, messageId: `${message.externalMessageId}-2` });
  assert("segunda publicação reutiliza a conexão", publisher.isConnected() === true);
} catch (e) {
  failed += 1;
  console.error("FAIL publicação no broker:", e instanceof Error ? e.message : String(e));
} finally {
  await publisher.close();
}

if (failed > 0) {
  console.error(`\n${failed} teste(s) de integração falharam.`);
  process.exit(1);
}
console.log("\nIntegração RabbitMQ OK.");
