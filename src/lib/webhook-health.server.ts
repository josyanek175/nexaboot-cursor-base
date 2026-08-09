/**
 * Métricas da arquitetura de inbox para o /api/health do web.
 *
 * Nunca falha a health. O snapshot do media-worker no processo web NÃO inventa
 * connected=true: só a flag (enabled) e, se houver probe de heartbeat com
 * timeout curto, o lastSeen — senão connected/active ficam "unknown".
 */

import { getMessageWorkerHealthSnapshot } from "@/lib/webhook-message-health";
import {
  mediaWorkerHealthFromFlagsOnly,
  type MediaWorkerHealthSnapshot,
} from "@/lib/webhook-media-health";
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
import { isWebhookMediaWorkerEnabled } from "@/lib/webhook-media-core";
import {
  isHeartbeatFresh,
  readMediaWorkerHeartbeat,
} from "@/lib/webhook-media-heartbeat.server";
import type { PgSql } from "@/lib/pg-types";

export type WebhookArchitectureHealth = {
  durableInboxEnabled: boolean;
  outboxPublisherEnabled: boolean;
  rabbitProcessingEnabled: boolean;
  legacyProcessingEnabled: boolean;
  legacyProcessingActive: boolean;
  durableInboxProcessingEnabled: boolean;
  mediaWorkerEnabled: boolean;
  configIssues: Array<{ code: string; severity: string }>;
  messageWorker: ReturnType<typeof getMessageWorkerHealthSnapshot>;
  mediaWorker: MediaWorkerHealthSnapshot;
};

export function readWebhookArchitectureHealth(
  env: NodeJS.ProcessEnv = process.env,
  mediaWorkerOverride?: MediaWorkerHealthSnapshot,
): WebhookArchitectureHealth {
  const enabled = isWebhookMediaWorkerEnabled(env);
  return {
    durableInboxEnabled: isDurableWebhookInboxEnabled(env),
    outboxPublisherEnabled: isWebhookOutboxPublisherEnabled(env),
    rabbitProcessingEnabled: isWebhookRabbitProcessingEnabled(env),
    legacyProcessingEnabled: isWebhookLegacyProcessingEnabled(env),
    legacyProcessingActive: isLegacyProcessingActive(env),
    durableInboxProcessingEnabled: isDurableWebhookInboxProcessingEnabled(env),
    mediaWorkerEnabled: enabled,
    configIssues: detectWebhookConfigIssues(env).map((i) => ({
      code: i.code,
      severity: i.severity,
    })),
    messageWorker: getMessageWorkerHealthSnapshot(),
    // Sem override/heartbeat: unknown — nunca true só pela flag.
    mediaWorker: mediaWorkerOverride ?? mediaWorkerHealthFromFlagsOnly(enabled),
  };
}

/**
 * Tenta enriquecer o health do media-worker via heartbeat PG (timeout curto).
 * Se a tabela não existir ou o probe falhar → mantém unknown.
 */
export async function enrichMediaWorkerHealthFromDb(params: {
  sql: PgSql;
  enabled: boolean;
  timeoutMs?: number;
}): Promise<MediaWorkerHealthSnapshot> {
  const base = mediaWorkerHealthFromFlagsOnly(params.enabled);
  const timeoutMs = params.timeoutMs ?? 150;
  try {
    const row = await Promise.race([
      readMediaWorkerHeartbeat(params.sql),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!row || !isHeartbeatFresh(row)) {
      return { ...base, mediaWorkerSource: "flag_only" };
    }
    return {
      ...base,
      mediaWorkerConnected: row.connected,
      mediaWorkerActive: row.active,
      mediaWorkerLastSeenAt: row.lastSeenAt,
      mediaWorkerSource: "heartbeat",
    };
  } catch {
    return base;
  }
}
