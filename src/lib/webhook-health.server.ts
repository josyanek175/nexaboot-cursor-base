/**
 * Métricas da arquitetura de inbox para o /api/health do web.
 *
 * Nunca falha a health: se o pool da inbox não estiver disponível ou as
 * tabelas ainda não existirem, devolve nulls. Também não consulta RabbitMQ —
 * o estado do broker só existe no processo do worker/publicador.
 */

import { getMessageWorkerHealthSnapshot } from "@/lib/webhook-message-health";
import {
  isDurableWebhookInboxEnabled,
  isDurableWebhookInboxProcessingEnabled,
} from "@/lib/webhook-inbox-core";
import {
  detectWebhookConfigIssues,
  isLegacyProcessingActive,
  isWebhookLegacyProcessingEnabled,
  isWebhookOutboxPublisherEnabled,
  isWebhookRabbitProcessingEnabled,
} from "@/lib/webhook-message-core";

export type WebhookArchitectureHealth = {
  durableInboxEnabled: boolean;
  outboxPublisherEnabled: boolean;
  rabbitProcessingEnabled: boolean;
  legacyProcessingEnabled: boolean;
  legacyProcessingActive: boolean;
  durableInboxProcessingEnabled: boolean;
  configIssues: Array<{ code: string; severity: string }>;
  /** Snapshot do worker só faz sentido no processo do worker; no web fica falso. */
  messageWorker: ReturnType<typeof getMessageWorkerHealthSnapshot>;
};

export function readWebhookArchitectureHealth(
  env: NodeJS.ProcessEnv = process.env,
): WebhookArchitectureHealth {
  return {
    durableInboxEnabled: isDurableWebhookInboxEnabled(env),
    outboxPublisherEnabled: isWebhookOutboxPublisherEnabled(env),
    rabbitProcessingEnabled: isWebhookRabbitProcessingEnabled(env),
    legacyProcessingEnabled: isWebhookLegacyProcessingEnabled(env),
    legacyProcessingActive: isLegacyProcessingActive(env),
    durableInboxProcessingEnabled: isDurableWebhookInboxProcessingEnabled(env),
    configIssues: detectWebhookConfigIssues(env).map((i) => ({
      code: i.code,
      severity: i.severity,
    })),
    // No processo web o worker não está rodando; o snapshot reflete isso.
    messageWorker: getMessageWorkerHealthSnapshot(),
  };
}
