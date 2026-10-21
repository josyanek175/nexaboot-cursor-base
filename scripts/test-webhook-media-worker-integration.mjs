/**
 * Integração opcional do media-worker com RabbitMQ/storage de DEV.
 * Ignorada por padrão — não exige serviços reais.
 *
 *   WEBHOOK_MEDIA_WORKER_INTEGRATION=true RABBITMQ_ENABLED=true \
 *     RABBITMQ_URL=amqp://… npx tsx scripts/test-webhook-media-worker-integration.mjs
 */
const enabled =
  process.env.WEBHOOK_MEDIA_WORKER_INTEGRATION?.trim().toLowerCase() === "true" ||
  process.env.WEBHOOK_MEDIA_WORKER_INTEGRATION?.trim() === "1";

if (!enabled) {
  console.log("SKIP media-worker integration (WEBHOOK_MEDIA_WORKER_INTEGRATION not set)");
  process.exit(0);
}

console.log("Media-worker integration placeholder: configure Rabbit + storage DEV and extend.");
process.exit(0);
