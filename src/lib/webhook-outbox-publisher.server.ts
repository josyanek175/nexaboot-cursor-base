/**
 * Motor de publicação da outbox.
 *
 * Separado de `webhook-outbox.server.ts` porque este módulo depende da camada
 * RabbitMQ, e o endpoint HTTP não pode depender do broker. Só o serviço
 * publicador importa daqui.
 *
 * Regra que não pode ser quebrada: `published` só é gravado depois do publisher
 * confirm do broker. Qualquer falha antes disso vira `retry` ou `dead_letter`,
 * nunca `published`.
 */

import {
  assertRabbitConfig,
  isRabbitUnavailable,
  maskRabbitError,
  type RabbitConfig,
  type RabbitPublisher,
} from "@/lib/rabbitmq.server";
import {
  computeOutboxRetryDelayMs,
  shouldDeadLetter,
  WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS,
  type WebhookOutboxConfig,
} from "@/lib/webhook-outbox-core";
import type { OutboxRepository } from "@/lib/webhook-outbox.server";

type LogFn = (tag: string, data: Record<string, unknown>) => void;

const defaultLog: LogFn = (tag, data) => console.log(`[${tag}]`, data);
const defaultLogError: LogFn = (tag, data) => console.error(`[${tag}]`, data);

export type ProcessOutboxBatchResult = {
  recovered: number;
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  released: number;
  brokerUnavailable: boolean;
};

export async function processOutboxBatch(params: {
  repo: OutboxRepository;
  publisher: RabbitPublisher;
  config: WebhookOutboxConfig;
  workerId: string;
  /** Sinaliza shutdown: nenhuma publicação nova começa depois de virar true. */
  shouldStop?: () => boolean;
  random?: () => number;
  log?: LogFn;
  logError?: LogFn;
}): Promise<ProcessOutboxBatchResult> {
  const { repo, publisher, config, workerId } = params;
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const shouldStop = params.shouldStop ?? (() => false);
  const random = params.random ?? Math.random;

  const result: ProcessOutboxBatchResult = {
    recovered: 0,
    claimed: 0,
    published: 0,
    retried: 0,
    deadLettered: 0,
    released: 0,
    brokerUnavailable: false,
  };

  const recovered = await repo.recoverExpiredLeases();
  result.recovered = recovered.length;
  for (const row of recovered) {
    log("WEBHOOK_OUTBOX_LEASE_RECOVERED", {
      outboxId: row.id,
      attempts: row.attempts,
      previousOwner: row.lockedBy,
    });
  }

  if (shouldStop()) return result;

  const claimed = await repo.claimBatch({
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    workerId,
  });
  result.claimed = claimed.length;
  if (claimed.length > 0) {
    log("WEBHOOK_OUTBOX_CLAIMED", { workerId, count: claimed.length, leaseMs: config.leaseMs });
  }

  const pending = [...claimed];

  const releaseRemaining = async (reason: string) => {
    if (pending.length === 0) return;
    const ids = pending.map((r) => r.id);
    pending.length = 0;
    const releasedCount = await repo.releaseClaims({ ids, workerId });
    result.released += releasedCount;
    log("WEBHOOK_OUTBOX_CLAIMED", { workerId, released: releasedCount, reason });
  };

  while (pending.length > 0) {
    if (shouldStop()) {
      await releaseRemaining("shutdown");
      break;
    }

    const row = pending.shift()!;

    log("WEBHOOK_OUTBOX_PUBLISH_START", {
      outboxId: row.id,
      inboxId: row.inboxId,
      routingKey: row.routingKey,
      attempts: row.attempts,
      workerId,
    });

    try {
      // Resolve só depois do publisher confirm.
      await publisher.publish({
        exchange: row.exchangeName,
        routingKey: row.routingKey,
        body: row.messagePayload,
        messageId: row.id,
      });

      const marked = await repo.markPublished({ id: row.id, workerId });
      if (marked) {
        result.published += 1;
        log("WEBHOOK_OUTBOX_PUBLISHED", {
          outboxId: row.id,
          inboxId: row.inboxId,
          routingKey: row.routingKey,
          attempts: row.attempts,
          workerId,
        });
      } else {
        // Lease perdido durante a publicação: outro worker já é dono da linha.
        // A mensagem pode ser reentregue — o consumidor da etapa 3 é idempotente
        // por inboxId.
        logError("WEBHOOK_OUTBOX_PUBLISH_RETRY", {
          outboxId: row.id,
          inboxId: row.inboxId,
          attempts: row.attempts,
          workerId,
          reason: "lease_lost_after_publish",
        });
      }
    } catch (e) {
      const error = maskRabbitError(e);
      const brokerDown = isRabbitUnavailable(e);
      if (brokerDown) result.brokerUnavailable = true;

      if (shouldDeadLetter(row.attempts, config)) {
        await repo.markDeadLetter({ id: row.id, workerId, error });
        result.deadLettered += 1;
        logError("WEBHOOK_OUTBOX_DEAD_LETTER", {
          outboxId: row.id,
          inboxId: row.inboxId,
          routingKey: row.routingKey,
          attempts: row.attempts,
          maxAttempts: config.maxAttempts,
          error,
        });
      } else {
        const delayMs = computeOutboxRetryDelayMs(row.attempts, config, random);
        await repo.markRetry({ id: row.id, workerId, error, delayMs });
        result.retried += 1;
        logError("WEBHOOK_OUTBOX_PUBLISH_RETRY", {
          outboxId: row.id,
          inboxId: row.inboxId,
          routingKey: row.routingKey,
          attempts: row.attempts,
          delayMs,
          error,
        });
      }

      // Broker fora do ar: insistir no resto do lote só queima tentativas.
      if (brokerDown) {
        await releaseRemaining("broker_unavailable");
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Loop do serviço publicador
// ---------------------------------------------------------------------------

export type OutboxPublisherLoopResult = {
  exitCode: number;
  iterations: number;
  parked: boolean;
};

/**
 * Loop single-flight do serviço publicador.
 *
 * Com RABBITMQ_ENABLED=false o processo fica estacionado: não abre pool, não
 * consulta a outbox e dorme em intervalo longo. Ele continua vivo de propósito,
 * para o orquestrador não entrar em laço de restart.
 */
export async function runWebhookOutboxPublisherLoop(params: {
  config: WebhookOutboxConfig;
  rabbitConfig: RabbitConfig;
  workerId: string;
  /**
   * Segunda trava, além de RABBITMQ_ENABLED. Default true para não quebrar
   * quem já liga o publicador só pelo broker; o entrypoint passa o valor
   * de WEBHOOK_OUTBOX_PUBLISHER_ENABLED.
   */
  publisherEnabled?: boolean;
  /** Criados sob demanda: parado, o serviço não abre conexão nenhuma. */
  createRepository: () => OutboxRepository;
  createPublisher: () => RabbitPublisher;
  closeResources?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onSignals?: boolean;
  /** Só testes: encerra depois de N iterações. */
  maxIterations?: number;
  random?: () => number;
  log?: LogFn;
  logError?: LogFn;
}): Promise<OutboxPublisherLoopResult> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const sleepFn = params.sleep;

  let stopping = false;
  let exitCode = 0;
  let wake: (() => void) | null = null;

  const requestStop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log("WEBHOOK_OUTBOX_PUBLISHER_STOPPING", { reason, workerId: params.workerId });
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

      // O timer é cancelado no wake para o shutdown não esperar o intervalo
      // inteiro (60s no modo estacionado).
      const timer = setTimeout(finish, ms);
      wake = () => {
        clearTimeout(timer);
        finish();
      };
    });
  };

  const publisherEnabled = params.publisherEnabled !== false;
  const parked = !params.rabbitConfig.enabled || !publisherEnabled;
  let iterations = 0;
  // Objeto único: o bloco finally ainda consegue corrigir o exitCode depois do
  // return.
  const result: OutboxPublisherLoopResult = { exitCode: 0, iterations: 0, parked };

  try {
    if (parked) {
      log("WEBHOOK_OUTBOX_PUBLISHER_PARKED", {
        workerId: params.workerId,
        reason: !params.rabbitConfig.enabled
          ? "rabbitmq_disabled"
          : "publisher_disabled",
        pollIntervalMs: WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS,
      });
      while (!stopping) {
        iterations += 1;
        if (params.maxIterations != null && iterations >= params.maxIterations) break;
        await interruptibleSleep(WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS);
      }
      return result;
    }

    assertRabbitConfig(params.rabbitConfig);
    const repo = params.createRepository();
    const publisher = params.createPublisher();

    log("WEBHOOK_OUTBOX_PUBLISHER_STARTED", {
      workerId: params.workerId,
      batchSize: params.config.batchSize,
      pollIntervalMs: params.config.pollIntervalMs,
      leaseMs: params.config.leaseMs,
      maxAttempts: params.config.maxAttempts,
    });

    try {
      while (!stopping) {
        iterations += 1;

        let batch;
        try {
          batch = await processOutboxBatch({
            repo,
            publisher,
            config: params.config,
            workerId: params.workerId,
            shouldStop: () => stopping,
            random: params.random,
            log,
            logError,
          });
        } catch (e) {
          // Falha de banco: não derruba o serviço, só espera mais um pouco.
          logError("WEBHOOK_OUTBOX_PUBLISH_RETRY", {
            workerId: params.workerId,
            reason: "batch_error",
            error: maskRabbitError(e),
          });
          if (params.maxIterations != null && iterations >= params.maxIterations) break;
          await interruptibleSleep(params.config.pollIntervalMs);
          continue;
        }

        if (params.maxIterations != null && iterations >= params.maxIterations) break;

        // Lote cheio e sem broker caído: provavelmente há mais fila esperando.
        const drainImmediately =
          batch.claimed >= params.config.batchSize && !batch.brokerUnavailable;
        await interruptibleSleep(drainImmediately ? 0 : params.config.pollIntervalMs);
      }
    } finally {
      await publisher.close().catch(() => undefined);
    }

    return result;
  } catch (e) {
    exitCode = 1;
    logError("WEBHOOK_OUTBOX_PUBLISHER_FAILED", {
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
      logError("WEBHOOK_OUTBOX_PUBLISHER_FAILED", {
        workerId: params.workerId,
        reason: "close_resources",
        error: maskRabbitError(e),
      });
    }
    result.exitCode = exitCode;
    result.iterations = iterations;
    log("WEBHOOK_OUTBOX_PUBLISHER_STOPPED", { workerId: params.workerId, iterations, exitCode });
  }
}
