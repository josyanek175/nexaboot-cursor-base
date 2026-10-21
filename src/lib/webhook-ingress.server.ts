/**
 * Escolhe o envelope de execução do webhook.
 *
 * Com a inbox durável ligada, o gate de concorrência NÃO pode rodar antes da
 * ingestão: ele responde 503 sem ler o corpo, e o evento seria descartado.
 * O gate continua protegendo o fluxo legado, que é quem consome o pool.
 */

import { runWebhookWithConcurrencyLimit } from "@/lib/pg-pool-gate.server";
import { isDurableWebhookInboxEnabled } from "@/lib/webhook-inbox-core";

export async function runWebhookIngress(
  origin: string,
  handler: () => Promise<Response>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (isDurableWebhookInboxEnabled(env)) return handler();
  return runWebhookWithConcurrencyLimit(origin, handler);
}
