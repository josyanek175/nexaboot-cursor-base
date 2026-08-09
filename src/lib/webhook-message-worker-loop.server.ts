/**
 * Loop do message-worker.
 *
 * Com WEBHOOK_RABBITMQ_PROCESSING_ENABLED=false o processo fica estacionado:
 * não conecta ao RabbitMQ, não abre pool, não processa a inbox. Continua vivo
 * de propósito, para o orquestrador não entrar em laço de restart.
 *
 * Com a flag ligada: abre o consumidor, processa cada entrega e dá ACK só
 * depois do COMMIT no PostgreSQL. Em paralelo, um republisher de retry
 * republica linhas com `available_at` vencido — sem segurar prefetch no
 * backoff.
 */

import type { PgSql } from "@/lib/pg-types";
import {
  createRabbitConsumer,
  type RabbitConsumer,
} from "@/lib/rabbitmq-consumer.server";
import {
  assertRabbitConfig,
  createRabbitPublisher,
  maskRabbitError,
  type RabbitConfig,
  type RabbitConnect,
  type RabbitPublisher,
} from "@/lib/rabbitmq.server";
import {
  createSqlInboxClaimRepository,
  type InboxClaimRepository,
} from "@/lib/webhook-inbox-claim.server";
import {
  createSqlInboxRetryRepository,
  processInboxRetryBatch,
  type InboxRetryRepository,
} from "@/lib/webhook-inbox-retry.server";
import {
  detectWebhookConfigIssues,
  isWebhookRabbitProcessingEnabled,
  WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS,
  type WebhookMessageConfig,
} from "@/lib/webhook-message-core";
import {
  getMessageWorkerHealthSnapshot,
  setMessageWorkerHealthSnapshot,
  type MessageWorkerHealthSnapshot,
} from "@/lib/webhook-message-health";
import { processInboxMessage } from "@/lib/webhook-message-worker.server";

export type { MessageWorkerHealthSnapshot };
export { getMessageWorkerHealthSnapshot };

type LogFn = (tag: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (tag, data) => console.log(`[${tag}]`, data ?? {});
const defaultLogError: LogFn = (tag, data) => console.error(`[${tag}]`, data ?? {});

const RETRY_DISPATCH_INTERVAL_MS = 2_000;

export type MessageWorkerLoopResult = {
  exitCode: number;
  iterations: number;
  parked: boolean;
};

export async function runWebhookMessageWorkerLoop(params: {
  config: WebhookMessageConfig;
  rabbitConfig: RabbitConfig;
  workerId: string;
  processingEnabled?: boolean;
  createSql: () => PgSql;
  createRepository?: (sql: PgSql) => InboxClaimRepository;
  createRetryRepository?: (sql: PgSql) => InboxRetryRepository;
  createConsumer?: (args: {
    config: RabbitConfig;
    prefetch: number;
  }) => RabbitConsumer;
  createPublisher?: (args: { config: RabbitConfig }) => RabbitPublisher;
  connect?: RabbitConnect;
  closeResources?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onSignals?: boolean;
  /** Só testes: encerra depois de N iterações no modo estacionado. */
  maxIterations?: number;
  /** Intervalo do republisher de retry (default 2s). */
  retryDispatchIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
  logError?: LogFn;
}): Promise<MessageWorkerLoopResult> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const sleepFn = params.sleep;
  const env = params.env ?? process.env;
  const processingEnabled =
    params.processingEnabled ?? isWebhookRabbitProcessingEnabled(env);
  const retryDispatchIntervalMs =
    params.retryDispatchIntervalMs ?? RETRY_DISPATCH_INTERVAL_MS;

  let stopping = false;
  let exitCode = 0;
  let wake: (() => void) | null = null;
  let iterations = 0;

  const requestStop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log("WEBHOOK_MESSAGE_WORKER_STOPPING", { reason, workerId: params.workerId });
    wake?.();
  };

  const detachSignals: Array<() => void> = [];
  if (params.onSignals !== false && typeof process !== "undefined" && process.on) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => requestStop(signal);
      process.on(signal, handler);
      detachSignals.push(() => process.off?.(signal, handler));
    }
  }

  const interruptibleSleep = async (ms: number) => {
    if (stopping || ms <= 0) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wake = null;
        resolve();
      };

      if (sleepFn) {
        wake = finish;
        void Promise.resolve(sleepFn(ms)).then(finish);
        return;
      }

      const timer = setTimeout(finish, ms);
      wake = () => {
        clearTimeout(timer);
        finish();
      };
    });
  };

  const parked = !processingEnabled;
  setMessageWorkerHealthSnapshot({
    messageWorkerEnabled: processingEnabled,
    messageWorkerConnected: false,
    messageWorkerActive: false,
  });

  const result: MessageWorkerLoopResult = { exitCode: 0, iterations: 0, parked };

  try {
    // Aviso de configuração perigosa — sempre, mesmo estacionado: quem ligou
    // as flags erradas precisa ver o log antes de promover.
    for (const issue of detectWebhookConfigIssues(env)) {
      log("WEBHOOK_MESSAGE_CONFIG_CONFLICT", {
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
      });
    }

    if (parked) {
      log("WEBHOOK_MESSAGE_WORKER_PARKED", {
        workerId: params.workerId,
        reason: "processing_disabled",
        pollIntervalMs: WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS,
      });
      while (!stopping) {
        iterations += 1;
        if (params.maxIterations != null && iterations >= params.maxIterations) break;
        await interruptibleSleep(WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS);
      }
      return result;
    }

    assertRabbitConfig(params.rabbitConfig);

    const sql = params.createSql();
    const repo =
      params.createRepository?.(sql) ?? createSqlInboxClaimRepository(sql);
    const retryRepo =
      params.createRetryRepository?.(sql) ?? createSqlInboxRetryRepository(sql);
    const consumer =
      params.createConsumer?.({
        config: params.rabbitConfig,
        prefetch: params.config.prefetch,
      }) ??
      createRabbitConsumer({
        config: params.rabbitConfig,
        prefetch: params.config.prefetch,
        connect: params.connect,
        sleep: sleepFn,
        log: (tag, data) => log(tag, data),
        logError: (tag, data) => logError(tag, data),
      });
    const publisher =
      params.createPublisher?.({ config: params.rabbitConfig }) ??
      createRabbitPublisher({
        config: params.rabbitConfig,
        connect: params.connect,
        log: (tag, data) => log(tag, data),
        logError: (tag, data) => logError(tag, data),
      });

    log("WEBHOOK_MESSAGE_WORKER_STARTED", {
      workerId: params.workerId,
      prefetch: params.config.prefetch,
      leaseMs: params.config.leaseMs,
      maxAttempts: params.config.maxAttempts,
      retryDispatchIntervalMs,
    });

    try {
      await consumer.start(async (msg) => {
        const disposition = await processInboxMessage({
          rawMessage: msg.content,
          sql,
          repo,
          config: params.config,
          workerId: params.workerId,
          log,
          logError,
        });
        return {
          action: disposition.action,
          delayMs: disposition.delayMs,
        };
      });

      setMessageWorkerHealthSnapshot({
        messageWorkerEnabled: true,
        messageWorkerConnected: consumer.isConnected(),
        messageWorkerActive: consumer.isActive(),
      });

      // Loop de vida: consumo é event-driven; aqui atualizamos health e
      // disparamos o republisher de retry durável.
      while (!stopping) {
        iterations += 1;

        try {
          const retryBatch = await processInboxRetryBatch({
            repo: retryRepo,
            publisher,
            workerId: `${params.workerId}:retry`,
            batchSize: 20,
            leaseMs: params.config.leaseMs,
            log,
            logError,
          });
          if (retryBatch.claimed > 0) {
            log("WEBHOOK_INBOX_RETRY_DISPATCH", retryBatch);
          }
        } catch (e) {
          logError("WEBHOOK_INBOX_RETRY_DISPATCH_FAILED", {
            error: maskRabbitError(e),
          });
        }

        try {
          const [inbox, media] = await Promise.all([
            repo.countInboxByStatus(),
            repo.countMediaJobsByStatus().catch(() => null),
          ]);
          setMessageWorkerHealthSnapshot({
            messageWorkerEnabled: true,
            messageWorkerConnected: consumer.isConnected(),
            messageWorkerActive: consumer.isActive(),
            inboxPending: inbox.pending,
            inboxQueued: inbox.queued,
            inboxProcessing: inbox.processing,
            inboxRetry: inbox.retry,
            inboxDeadLetter: inbox.deadLetter,
            inboxOldestPendingAgeMs: inbox.oldestPendingAgeMs,
            mediaPending: media?.pending ?? null,
            mediaRetry: media?.retry ?? null,
            mediaDeadLetter: media?.deadLetter ?? null,
          });
        } catch (e) {
          logError("WEBHOOK_MESSAGE_WORKER_HEALTH_FAILED", {
            error: maskRabbitError(e),
          });
          setMessageWorkerHealthSnapshot({
            messageWorkerConnected: consumer.isConnected(),
            messageWorkerActive: consumer.isActive(),
          });
        }

        if (params.maxIterations != null && iterations >= params.maxIterations) break;
        await interruptibleSleep(retryDispatchIntervalMs);
      }
    } finally {
      await consumer.stop({ drainTimeoutMs: 30_000 }).catch(() => undefined);
      await consumer.close().catch(() => undefined);
      await publisher.close().catch(() => undefined);
      setMessageWorkerHealthSnapshot({
        messageWorkerConnected: false,
        messageWorkerActive: false,
      });
    }

    return result;
  } catch (e) {
    exitCode = 1;
    logError("WEBHOOK_MESSAGE_WORKER_FAILED", {
      workerId: params.workerId,
      error: maskRabbitError(e),
    });
    return result;
  } finally {
    for (const detach of detachSignals) detach();
    try {
      await params.closeResources?.();
    } catch (e) {
      exitCode = exitCode || 1;
      logError("WEBHOOK_MESSAGE_WORKER_FAILED", {
        workerId: params.workerId,
        reason: "close_resources",
        error: maskRabbitError(e),
      });
    }
    result.exitCode = exitCode;
    result.iterations = iterations;
    log("WEBHOOK_MESSAGE_WORKER_STOPPED", {
      workerId: params.workerId,
      iterations,
      exitCode,
    });
  }
}
