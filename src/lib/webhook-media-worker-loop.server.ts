/**
 * Loop do media-worker.
 *
 * Flag desligada → estacionado (sem pool, sem Rabbit, sem claim).
 * Flag ligada → pool dedicado + claim em batch + concorrência limitada.
 * RabbitMQ opcional (WEBHOOK_MEDIA_RABBITMQ_ENABLED): acelera wake-up;
 * PostgreSQL permanece a fonte da verdade.
 */

import type { PgSql } from "@/lib/pg-types";
import {
  createMediaStorage,
  readMediaStorageConfig,
  type MediaStorage,
} from "@/lib/media-storage.server";
import {
  createRabbitConsumer,
  type RabbitConsumer,
} from "@/lib/rabbitmq-consumer.server";
import {
  assertRabbitConfig,
  createRabbitPublisher,
  maskRabbitError,
  readRabbitConfig,
  type RabbitConfig,
  type RabbitPublisher,
} from "@/lib/rabbitmq.server";
import {
  createSqlMediaClaimRepository,
  type MediaClaimRepository,
} from "@/lib/webhook-media-claim.server";
import {
  MEDIA_JOB_SCHEMA_VERSION,
  WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS,
  isWebhookMediaRabbitEnabled,
  isWebhookMediaWorkerEnabled,
  parseMediaJobEnvelope,
  type WebhookMediaConfig,
} from "@/lib/webhook-media-core";
import {
  getMediaWorkerHealthSnapshot,
  setMediaWorkerHealthSnapshot,
  type MediaWorkerHealthSnapshot,
} from "@/lib/webhook-media-health";
import { upsertMediaWorkerHeartbeat } from "@/lib/webhook-media-heartbeat.server";
import {
  processMediaJobBatch,
  processMediaJobById,
} from "@/lib/webhook-media-worker.server";

export type { MediaWorkerHealthSnapshot };
export { getMediaWorkerHealthSnapshot };

type LogFn = (tag: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (tag, data) => console.log(`[${tag}]`, data ?? {});
const defaultLogError: LogFn = (tag, data) => console.error(`[${tag}]`, data ?? {});

export type MediaWorkerLoopResult = {
  exitCode: number;
  iterations: number;
  parked: boolean;
};

function readMediaRabbitConfig(env: NodeJS.ProcessEnv): RabbitConfig {
  const base = readRabbitConfig(env);
  return {
    ...base,
    queue: env.RABBITMQ_MEDIA_QUEUE?.trim() || `${base.queue}.media`,
    dlq: env.RABBITMQ_MEDIA_DLQ?.trim() || `${base.dlq || base.queue + ".dlq"}.media`,
  };
}

export async function runWebhookMediaWorkerLoop(params: {
  config: WebhookMediaConfig;
  workerId: string;
  mediaWorkerEnabled?: boolean;
  mediaRabbitEnabled?: boolean;
  createSql: () => PgSql;
  createRepository?: (sql: PgSql) => MediaClaimRepository;
  createStorage?: () => MediaStorage;
  createConsumer?: (args: { config: RabbitConfig; prefetch: number }) => RabbitConsumer;
  createPublisher?: (args: { config: RabbitConfig }) => RabbitPublisher;
  closeResources?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onSignals?: boolean;
  maxIterations?: number;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
  logError?: LogFn;
  processDownload?: Parameters<typeof processMediaJobBatch>[0]["processDownload"];
}): Promise<MediaWorkerLoopResult> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const sleepFn = params.sleep;
  const env = params.env ?? process.env;
  const enabled = params.mediaWorkerEnabled ?? isWebhookMediaWorkerEnabled(env);
  const rabbitEnabled = params.mediaRabbitEnabled ?? isWebhookMediaRabbitEnabled(env);

  let stopping = false;
  let exitCode = 0;
  let wake: (() => void) | null = null;
  let iterations = 0;

  const requestStop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log("WEBHOOK_MEDIA_WORKER_STOPPING", { reason, workerId: params.workerId });
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

  setMediaWorkerHealthSnapshot({
    mediaWorkerEnabled: enabled,
    mediaWorkerConnected: "unknown",
    mediaWorkerActive: "unknown",
    mediaWorkerSource: "flag_only",
  });

  const result: MediaWorkerLoopResult = { exitCode: 0, iterations: 0, parked: !enabled };

  try {
    if (!enabled) {
      log("WEBHOOK_MEDIA_WORKER_PARKED", {
        workerId: params.workerId,
        reason: "media_worker_disabled",
        pollIntervalMs: WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS,
      });
      while (!stopping) {
        iterations += 1;
        if (params.maxIterations != null && iterations >= params.maxIterations) break;
        await interruptibleSleep(WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS);
      }
      return result;
    }

    const sql = params.createSql();
    const repo = params.createRepository?.(sql) ?? createSqlMediaClaimRepository(sql);
    const storage = params.createStorage?.() ?? createMediaStorage(readMediaStorageConfig(env));
    const rabbitConfig = readMediaRabbitConfig(env);

    let consumer: RabbitConsumer | null = null;
    let publisher: RabbitPublisher | null = null;

    if (rabbitEnabled) {
      try {
        assertRabbitConfig(rabbitConfig);
        publisher =
          params.createPublisher?.({ config: rabbitConfig }) ??
          createRabbitPublisher({
            config: rabbitConfig,
            log: (tag, data) => log(tag, data),
            logError: (tag, data) => logError(tag, data),
          });
        consumer =
          params.createConsumer?.({
            config: rabbitConfig,
            prefetch: params.config.concurrency,
          }) ??
          createRabbitConsumer({
            config: rabbitConfig,
            prefetch: params.config.concurrency,
            log: (tag, data) => log(tag, data),
            logError: (tag, data) => logError(tag, data),
          });

        await consumer.start(async (msg) => {
          const parsed = parseMediaJobEnvelope(msg.content);
          if (!parsed.ok) {
            logError("MEDIA_JOB_RECEIVED", { reason: parsed.reason, invalid: true });
            return { action: "ack" };
          }
          log("MEDIA_JOB_RECEIVED", { mediaJobId: parsed.envelope.mediaJobId });
          await processMediaJobById({
            sql,
            repo,
            storage,
            config: params.config,
            workerId: params.workerId,
            mediaJobId: parsed.envelope.mediaJobId,
            log,
            logError,
            processDownload: params.processDownload,
          });
          return { action: "ack" };
        });
      } catch (e) {
        logError("WEBHOOK_MEDIA_RABBIT_UNAVAILABLE", {
          error: maskRabbitError(e),
          note: "continuando com claim PostgreSQL",
        });
        consumer = null;
        publisher = null;
      }
    }

    log("WEBHOOK_MEDIA_WORKER_STARTED", {
      workerId: params.workerId,
      concurrency: params.config.concurrency,
      batchSize: params.config.batchSize,
      leaseMs: params.config.leaseMs,
      maxAttempts: params.config.maxAttempts,
      storageProvider: storage.provider,
      rabbitEnabled: Boolean(consumer),
    });

    setMediaWorkerHealthSnapshot({
      mediaWorkerEnabled: true,
      mediaWorkerConnected: consumer ? consumer.isConnected() : true,
      mediaWorkerActive: true,
      mediaWorkerSource: "process",
      mediaWorkerLastSeenAt: new Date().toISOString(),
    });

    try {
      while (!stopping) {
        iterations += 1;

        try {
          const batch = await processMediaJobBatch({
            sql,
            repo,
            storage,
            config: params.config,
            workerId: params.workerId,
            log,
            logError,
            processDownload: params.processDownload,
          });

          if (publisher && batch.claimed === 0) {
            void publisher;
            void MEDIA_JOB_SCHEMA_VERSION;
          }
        } catch (e) {
          logError("WEBHOOK_MEDIA_WORKER_TICK_FAILED", { error: maskRabbitError(e) });
        }

        try {
          const counts = await repo.countByStatus();
          const connected = consumer ? consumer.isConnected() : true;
          setMediaWorkerHealthSnapshot({
            mediaWorkerEnabled: true,
            mediaWorkerConnected: connected,
            mediaWorkerActive: true,
            mediaWorkerSource: "process",
            mediaWorkerLastSeenAt: new Date().toISOString(),
            mediaPending: counts.pending,
            mediaProcessing: counts.processing,
            mediaRetry: counts.retry,
            mediaDeadLetter: counts.deadLetter,
            mediaOldestPendingAgeMs: counts.oldestPendingAgeMs,
          });
          await upsertMediaWorkerHeartbeat(sql, {
            workerId: params.workerId,
            connected,
            active: true,
            details: {
              pending: counts.pending,
              retry: counts.retry,
              deadLetter: counts.deadLetter,
            },
          }).catch(() => undefined);
        } catch (e) {
          logError("WEBHOOK_MEDIA_WORKER_HEALTH_FAILED", { error: maskRabbitError(e) });
        }

        if (params.maxIterations != null && iterations >= params.maxIterations) break;
        await interruptibleSleep(params.config.pollIntervalMs);
      }
    } finally {
      await consumer?.stop({ drainTimeoutMs: 30_000 }).catch(() => undefined);
      await consumer?.close().catch(() => undefined);
      await publisher?.close().catch(() => undefined);
      setMediaWorkerHealthSnapshot({
        mediaWorkerConnected: false,
        mediaWorkerActive: false,
        mediaWorkerSource: "process",
      });
      await upsertMediaWorkerHeartbeat(sql, {
        workerId: params.workerId,
        connected: false,
        active: false,
      }).catch(() => undefined);
    }

    return result;
  } catch (e) {
    exitCode = 1;
    logError("WEBHOOK_MEDIA_WORKER_FAILED", {
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
      logError("WEBHOOK_MEDIA_WORKER_FAILED", {
        reason: "close_resources",
        error: maskRabbitError(e),
      });
    }
    result.exitCode = exitCode;
    result.iterations = iterations;
    log("WEBHOOK_MEDIA_WORKER_STOPPED", {
      workerId: params.workerId,
      iterations,
      exitCode,
    });
  }
}
