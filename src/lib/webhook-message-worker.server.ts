/**
 * Motor do message-worker.
 *
 * Ordem obrigatória:
 *   receber → validar envelope → claim → processar → COMMIT
 *   (marca processed + cria tarefas de mídia/campanha) →
 *   tentar campanha imediata (otimização) → ACK.
 *
 * Retry temporário: grava `retry`+`available_at`, dá ACK imediatamente.
 * Um republisher separado republica quando `available_at` vence — sem prender
 * slot de prefetch durante o backoff.
 */

import type { PgSql, SqlExecutor } from "@/lib/pg-types";
import type { WebhookProvider } from "@/lib/webhook-inbox-core";
import {
  markInboxProcessedTx,
  type InboxClaimRepository,
  type InboxEventRow,
} from "@/lib/webhook-inbox-claim.server";
import {
  classifyProcessingError,
  computeMessageRetryDelayMs,
  computeQueueLagMs,
  conversationAdvisoryLockKey,
  describeProcessingError,
  isSupportedProvider,
  parseInboxEnvelope,
  PermanentWebhookProcessingError,
  shouldDeadLetterMessage,
  TemporaryWebhookProcessingError,
  type WebhookMessageConfig,
} from "@/lib/webhook-message-core";
import { processEvolutionInboxEvent, type Json } from "@/lib/webhook-evolution-processing.server";
import { processMetaInboxEvent } from "@/lib/webhook-meta-processing.server";
import type { CampaignCandidate } from "@/lib/webhook-campaign-hook.server";
import { tryProcessCampaignJobImmediately } from "@/lib/webhook-campaign-jobs.server";

export type LogFn = (event: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (event, data) => console.log(`[${event}]`, data ?? {});
const defaultLogError: LogFn = (event, data) => console.error(`[${event}]`, data ?? {});

/**
 * Disposição da entrega AMQP.
 *
 * `ack` é o caminho normal — inclusive após gravar retry durável.
 * `requeue` ficou reservado a falhas antes de persistir estado (quase não usado).
 */
export type MessageDisposition = {
  action: "ack" | "requeue";
  reason: string;
  delayMs: number;
  inboxId: string | null;
};

export type ProcessInboxMessageParams = {
  rawMessage: unknown;
  sql: PgSql;
  repo: InboxClaimRepository;
  config: WebhookMessageConfig;
  workerId: string;
  /** Testes: substitui a otimização pós-COMMIT da campanha. */
  runCampaignJobs?: (
    jobs: Array<{ campaignJobId: string; candidate: CampaignCandidate }>,
  ) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: LogFn;
  logError?: LogFn;
};

type CampaignJobRef = {
  campaignJobId: string;
  candidate: CampaignCandidate;
};

type TransactionOutcome = {
  provider: WebhookProvider;
  companyId: string | null;
  channelId: string | null;
  conversationKey: string | null;
  messagesCreated: number;
  messagesDuplicated: number;
  mediaJobsCreated: number;
  campaignJobsCreated: number;
  campaignJobs: CampaignJobRef[];
  statusesApplied: number;
  markedProcessed: boolean;
};

async function runProviderInTransaction(params: {
  tx: SqlExecutor;
  row: InboxEventRow;
  provider: WebhookProvider;
  log: LogFn;
}): Promise<Omit<TransactionOutcome, "markedProcessed" | "provider">> {
  const { tx, row, provider, log } = params;

  if (provider === "evolution") {
    const result = await processEvolutionInboxEvent({
      sql: tx,
      payload: (row.payload ?? {}) as Json,
      media: { mode: "job", inboxId: row.id },
      log,
    });

    if (result.status === "channel_not_found") {
      throw new TemporaryWebhookProcessingError(
        "channel_not_found",
        `Canal Evolution não encontrado para a instância ${result.instance}`,
      );
    }
    if (result.status === "missing_instance") {
      throw new PermanentWebhookProcessingError(
        "missing_instance",
        "Evento Evolution sem instância: não há como resolver o canal",
      );
    }
    if (result.status === "channel_without_company") {
      return {
        companyId: null,
        channelId: result.channelId,
        conversationKey: row.conversationKey,
        messagesCreated: 0,
        messagesDuplicated: 0,
        mediaJobsCreated: 0,
        campaignJobsCreated: 0,
        campaignJobs: [],
        statusesApplied: 0,
      };
    }

    const campaignJobs: CampaignJobRef[] = [];
    for (const m of result.messages) {
      if (m.campaignJobId && m.campaignCandidate) {
        campaignJobs.push({
          campaignJobId: m.campaignJobId,
          candidate: m.campaignCandidate,
        });
      }
    }

    return {
      companyId: result.companyId,
      channelId: result.channelId,
      conversationKey: row.conversationKey,
      messagesCreated: result.messages.filter((m) => m.messageCreated).length,
      messagesDuplicated: result.messages.filter((m) => m.messageId && !m.messageCreated).length,
      mediaJobsCreated: result.messages.filter((m) => m.mediaJobCreated).length,
      campaignJobsCreated: result.messages.filter((m) => m.campaignJobCreated).length,
      campaignJobs,
      statusesApplied: 0,
    };
  }

  const result = await processMetaInboxEvent({
    sql: tx,
    payload: row.payload,
    inboxId: row.id,
    log,
  });

  if (result.status === "channel_not_found") {
    throw new TemporaryWebhookProcessingError(
      "channel_not_found",
      `Canal Meta não encontrado para phone_number_id ${result.phoneNumberId}`,
    );
  }
  if (result.status === "missing_phone_number_id") {
    throw new PermanentWebhookProcessingError(
      "missing_phone_number_id",
      "Evento Meta sem phone_number_id: não há como resolver o canal",
    );
  }

  const campaignJobs: CampaignJobRef[] = [];
  for (const m of result.messages) {
    if (m.campaignJobId && m.campaignCandidate) {
      campaignJobs.push({
        campaignJobId: m.campaignJobId,
        candidate: m.campaignCandidate,
      });
    }
  }

  return {
    companyId: result.companyId,
    channelId: result.channelId,
    conversationKey: row.conversationKey,
    messagesCreated: result.messages.filter((m) => m.messageCreated).length,
    messagesDuplicated: result.messages.filter((m) => !m.messageCreated).length,
    mediaJobsCreated: result.messages.filter((m) => m.mediaJobCreated).length,
    campaignJobsCreated: result.messages.filter((m) => m.campaignJobCreated).length,
    campaignJobs,
    statusesApplied: result.statusesApplied,
  };
}

export async function processInboxMessage(
  params: ProcessInboxMessageParams,
): Promise<MessageDisposition> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const now = params.now ?? Date.now;
  const random = params.random ?? Math.random;
  const startedAt = now();

  const parsed = parseInboxEnvelope(params.rawMessage);
  if (!parsed.ok) {
    logError("WEBHOOK_MESSAGE_INVALID_ENVELOPE", { reason: parsed.reason });
    return { action: "ack", reason: `invalid_envelope:${parsed.reason}`, delayMs: 0, inboxId: null };
  }

  const envelope = parsed.envelope;
  const inboxId = envelope.inboxId;
  log("WEBHOOK_MESSAGE_RECEIVED", {
    inboxId,
    provider: envelope.provider,
    eventType: envelope.eventType,
    queueLagMs: computeQueueLagMs(envelope.receivedAt, startedAt),
  });

  const claim = await params.repo.claim({
    inboxId,
    workerId: params.workerId,
    leaseMs: params.config.leaseMs,
  });

  if (claim.outcome === "already_processed") {
    log("WEBHOOK_MESSAGE_ALREADY_PROCESSED", { inboxId, attempts: claim.attempts });
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "already_processed" });
    return { action: "ack", reason: "already_processed", delayMs: 0, inboxId };
  }

  if (claim.outcome === "dead_letter") {
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "dead_letter", attempts: claim.attempts });
    return { action: "ack", reason: "dead_letter", delayMs: 0, inboxId };
  }

  if (claim.outcome === "not_found") {
    logError("WEBHOOK_MESSAGE_INVALID_ENVELOPE", { inboxId, reason: "inbox_not_found" });
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "inbox_not_found" });
    return { action: "ack", reason: "inbox_not_found", delayMs: 0, inboxId };
  }

  if (claim.outcome === "not_yet_available") {
    // Estado durável já tem available_at. ACK libera o prefetch; o republisher
    // republica quando vencer. NACK com sleep prendia capacidade.
    log("WEBHOOK_MESSAGE_ACK", {
      inboxId,
      reason: "backoff_pending_durable",
      availableInMs: claim.availableInMs,
    });
    return { action: "ack", reason: "backoff_pending_durable", delayMs: 0, inboxId };
  }

  if (claim.outcome === "lease_conflict") {
    log("WEBHOOK_MESSAGE_LEASE_CONFLICT", {
      inboxId,
      lockedBy: claim.lockedBy,
      leaseExpiresAt: claim.leaseExpiresAt,
    });
    // Outro worker é o dono. ACK para não prender prefetch nem gerar laço.
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "lease_conflict" });
    return { action: "ack", reason: "lease_conflict", delayMs: 0, inboxId };
  }

  const row = claim.row;
  const attempts = row.attempts;
  log("WEBHOOK_MESSAGE_CLAIMED", {
    inboxId,
    provider: row.provider,
    companyId: row.companyId,
    channelId: row.channelId,
    instanceName: row.instanceName,
    externalMessageId: row.externalMessageId,
    conversationKey: row.conversationKey,
    attempts,
  });

  try {
    if (!isSupportedProvider(row.provider)) {
      throw new PermanentWebhookProcessingError(
        "unknown_provider",
        `Provider desconhecido na inbox: ${row.provider}`,
      );
    }
    const provider = row.provider;

    log("WEBHOOK_MESSAGE_PROCESS_START", { inboxId, provider, attempts });

    const outcome = await params.sql.begin(async (tx) => {
      const txSql = tx as unknown as SqlExecutor;

      const lockKey = conversationAdvisoryLockKey(row.companyId, row.conversationKey);
      if (lockKey) {
        await txSql`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
      }

      const result = await runProviderInTransaction({ tx: txSql, row, provider, log });

      const markedProcessed = await markInboxProcessedTx(txSql, {
        inboxId,
        workerId: params.workerId,
      });

      return { ...result, provider, markedProcessed } satisfies TransactionOutcome;
    });

    if (!outcome.markedProcessed) {
      logError("WEBHOOK_MESSAGE_LEASE_CONFLICT", {
        inboxId,
        reason: "lease_lost_before_commit",
      });
    }

    // Otimização pós-COMMIT: tenta campanha agora. Falha NÃO pode derrubar
    // o ACK nem mandar a inbox para retry — a tarefa durável carrega o efeito.
    if (outcome.campaignJobs.length > 0) {
      try {
        if (params.runCampaignJobs) {
          await params.runCampaignJobs(outcome.campaignJobs);
        } else {
          for (const job of outcome.campaignJobs) {
            await tryProcessCampaignJobImmediately({
              sql: params.sql as unknown as SqlExecutor,
              campaignJobId: job.campaignJobId,
              candidate: job.candidate,
              log,
              logError,
            });
          }
        }
      } catch (e) {
        logError("WEBHOOK_CAMPAIGN_JOB_POST_COMMIT_FAILED", {
          inboxId,
          campaignJobs: outcome.campaignJobs.length,
          error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        });
      }
    }

    const elapsedMs = now() - startedAt;
    log("WEBHOOK_MESSAGE_PROCESS_SUCCESS", {
      inboxId,
      provider: outcome.provider,
      companyId: outcome.companyId,
      channelId: outcome.channelId,
      conversationKey: outcome.conversationKey,
      messagesCreated: outcome.messagesCreated,
      messagesDuplicated: outcome.messagesDuplicated,
      mediaJobsCreated: outcome.mediaJobsCreated,
      campaignJobsCreated: outcome.campaignJobsCreated,
      statusesApplied: outcome.statusesApplied,
      attempts,
      elapsedMs,
    });
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "processed", elapsedMs });
    return { action: "ack", reason: "processed", delayMs: 0, inboxId };
  } catch (error) {
    return handleProcessingFailure({
      error,
      inboxId,
      attempts,
      params,
      log,
      logError,
      random,
      startedAt,
      now,
    });
  }
}

async function handleProcessingFailure(args: {
  error: unknown;
  inboxId: string;
  attempts: number;
  params: ProcessInboxMessageParams;
  log: LogFn;
  logError: LogFn;
  random: () => number;
  startedAt: number;
  now: () => number;
}): Promise<MessageDisposition> {
  const { error, inboxId, attempts, params, log, logError, random } = args;
  const kind = classifyProcessingError(error);
  const description = describeProcessingError(error);
  const elapsedMs = args.now() - args.startedAt;
  const exhausted = shouldDeadLetterMessage(attempts, params.config);

  if (kind === "permanent" || exhausted) {
    await params.repo.markDeadLetter({
      inboxId,
      workerId: params.workerId,
      error: description,
    });
    logError("WEBHOOK_MESSAGE_DEAD_LETTER", {
      inboxId,
      attempts,
      elapsedMs,
      kind,
      reason: exhausted && kind !== "permanent" ? "max_attempts" : "permanent_error",
      error: description,
    });
    log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "dead_letter" });
    return { action: "ack", reason: "dead_letter", delayMs: 0, inboxId };
  }

  const delayMs = computeMessageRetryDelayMs(attempts, params.config, random);
  await params.repo.markRetry({
    inboxId,
    workerId: params.workerId,
    error: description,
    delayMs,
  });
  logError("WEBHOOK_MESSAGE_RETRY", {
    inboxId,
    attempts,
    elapsedMs,
    delayMs,
    error: description,
  });
  // ACK imediato: o estado durável carrega o backoff. O republisher republica
  // quando available_at vencer. Não prende prefetch.
  log("WEBHOOK_MESSAGE_ACK", { inboxId, reason: "temporary_error_durable_retry", delayMs });
  return { action: "ack", reason: "temporary_error_durable_retry", delayMs: 0, inboxId };
}
