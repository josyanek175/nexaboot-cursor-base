/**
 * Motor do media-worker.
 *
 * Ordem: claim → (fora da TX) download+storage → TX curta atualiza mensagem+job.
 * Download nunca ocorre dentro de transação PostgreSQL.
 */

import type { PgSql, SqlExecutor } from "@/lib/pg-types";
import { isProductionLikeEnv, type MediaStorage } from "@/lib/media-storage.server";
import {
  createSqlMediaClaimRepository,
  isSupportedMediaProvider,
  loadMediaJobContext,
  updateMessageMediaState,
  type MediaClaimRepository,
  type MediaJobRow,
} from "@/lib/webhook-media-claim.server";
import {
  MESSAGE_MEDIA_STATUS,
  PermanentMediaProcessingError,
  TemporaryMediaProcessingError,
  classifyMediaProcessingError,
  computeMediaRetryDelayMs,
  describeMediaProcessingError,
  shouldDeadLetterMedia,
  type WebhookMediaConfig,
} from "@/lib/webhook-media-core";
import { processEvolutionMediaJob } from "@/lib/webhook-evolution-media.server";
import { processMetaMediaJob } from "@/lib/webhook-meta-media.server";
import { incrementMediaWorkerCounters } from "@/lib/webhook-media-health";

type LogFn = (event: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (e, d) => console.log(`[${e}]`, d ?? {});
const defaultLogError: LogFn = (e, d) => console.error(`[${e}]`, d ?? {});

export type ProcessMediaJobResult = {
  action: "processed" | "retry" | "dead_letter" | "skipped";
  reason: string;
  mediaJobId: string;
  sizeBytes?: number;
};

export async function processClaimedMediaJob(params: {
  sql: PgSql;
  repo: MediaClaimRepository;
  storage: MediaStorage;
  config: WebhookMediaConfig;
  workerId: string;
  job: MediaJobRow;
  log?: LogFn;
  logError?: LogFn;
  now?: () => number;
  random?: () => number;
  /** Testes: substitui download Evolution/Meta. */
  processDownload?: (job: MediaJobRow, ctx: {
    companyId: string | null;
    phoneNumberId: string | null;
    inboxPayload: unknown;
  }) => Promise<{
    storageKey: string;
    mediaUrl: string;
    checksum: string;
    sizeBytes: number;
    mimeType: string;
    fileName: string | null;
  }>;
}): Promise<ProcessMediaJobResult> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;
  const now = params.now ?? Date.now;
  const random = params.random ?? Math.random;
  const startedAt = now();
  const job = params.job;

  log("MEDIA_JOB_CLAIMED", {
    mediaJobId: job.id,
    inboxId: job.inboxId,
    messageId: job.messageId,
    provider: job.provider,
    channelId: job.channelId,
    externalMessageId: job.externalMessageId,
    mediaType: job.mediaType,
    mimeType: job.mimeType,
    attempts: job.attempts,
  });

  try {
    if (!isSupportedMediaProvider(job.provider)) {
      throw new PermanentMediaProcessingError(
        "unknown_provider",
        `provider desconhecido: ${job.provider}`,
      );
    }

    // Marca mensagem como processing (TX curta, antes do download).
    await params.sql.begin(async (tx) => {
      const txSql = tx as unknown as SqlExecutor;
      await updateMessageMediaState(txSql, {
        messageId: job.messageId,
        mediaStatus: MESSAGE_MEDIA_STATUS.processing,
        mediaUrl: null,
        storageKey: null,
        mimeType: null,
        fileName: null,
        sizeBytes: null,
        checksum: null,
        mediaError: null,
      });
    });

    const ctx = await loadMediaJobContext(params.sql as unknown as SqlExecutor, {
      messageId: job.messageId,
      inboxId: job.inboxId,
      channelId: job.channelId,
    });

    if (!ctx.messageExists) {
      throw new PermanentMediaProcessingError(
        "message_missing",
        "mensagem ausente para media job",
      );
    }

    // DOWNLOAD FORA DE QUALQUER TRANSAÇÃO.
    const stored = params.processDownload
      ? await params.processDownload(job, ctx)
      : job.provider === "evolution"
        ? await processEvolutionMediaJob({
            sql: params.sql as unknown as SqlExecutor,
            job,
            companyId: ctx.companyId,
            inboxPayload: ctx.inboxPayload,
            storage: params.storage,
            config: params.config,
            log,
          })
        : await processMetaMediaJob({
            sql: params.sql as unknown as SqlExecutor,
            job,
            companyId: ctx.companyId,
            phoneNumberId: ctx.phoneNumberId,
            storage: params.storage,
            config: params.config,
            log,
          });

    const durable =
      "durable" in stored
        ? Boolean((stored as { durable?: boolean }).durable)
        : params.storage.isDurable;
    if (!durable) {
      log("MEDIA_STORAGE_EPHEMERAL", {
        mediaJobId: job.id,
        provider: params.storage.provider,
        warning: "storage não durável; disco de container não é definitivo",
      });
      // Em produção (mesmo com OVERRIDE), nunca afirmar available sem storage persistente.
      if (isProductionLikeEnv()) {
        throw new TemporaryMediaProcessingError(
          "ephemeral_storage_not_durable",
          "MEDIA_STORAGE_PROVIDER efêmero: não publica media_status=available. Use s3.",
        );
      }
    }

    // available apenas quando o arquivo está no storage configurado e, em prod, durável.
    const mediaUrl = `/api/messages/${job.messageId}/media`;
    const mediaStatus = MESSAGE_MEDIA_STATUS.available;

    // Commit curto: mensagem + job. Se falhar após storage, retry reusa o arquivo.
    const committed = await params.sql.begin(async (tx) => {
      const txSql = tx as unknown as SqlExecutor;
      await updateMessageMediaState(txSql, {
        messageId: job.messageId,
        mediaStatus,
        mediaUrl,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        fileName: stored.fileName,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        mediaError: null,
      });
      // Usa o mesmo executor da TX para o UPDATE do job (via SQL direto).
      const rows = await txSql<{ id: string }[]>`
        UPDATE public.webhook_media_jobs
        SET status = 'processed',
            storage_key = ${stored.storageKey},
            checksum = ${stored.checksum},
            size_bytes = ${stored.sizeBytes},
            processed_at = now(),
            last_error = NULL,
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${job.id}::uuid
          AND locked_by = ${params.workerId}
          AND status = 'processing'
        RETURNING id
      `;
      return rows.length > 0;
    });

    if (!committed) {
      logError("MEDIA_JOB_LEASE_CONFLICT", {
        mediaJobId: job.id,
        reason: "lease_lost_before_commit",
        storageKey: stored.storageKey,
      });
      // Arquivo já existe — próximo claim deve short-circuit via storage_key/exists.
      return { action: "skipped", reason: "lease_lost_after_storage", mediaJobId: job.id };
    }

    incrementMediaWorkerCounters({
      downloadedBytes: stored.sizeBytes,
      processed: 1,
    });

    const elapsedMs = now() - startedAt;
    log("MEDIA_JOB_PROCESSED", {
      mediaJobId: job.id,
      inboxId: job.inboxId,
      messageId: job.messageId,
      provider: job.provider,
      companyId: ctx.companyId,
      channelId: job.channelId,
      externalMessageId: job.externalMessageId,
      mediaType: job.mediaType,
      mimeType: stored.mimeType,
      attempts: job.attempts,
      elapsedMs,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      storageKey: stored.storageKey,
    });

    return {
      action: "processed",
      reason: "ok",
      mediaJobId: job.id,
      sizeBytes: stored.sizeBytes,
    };
  } catch (error) {
    return handleMediaFailure({
      error,
      job,
      params,
      log,
      logError,
      random,
      startedAt,
      now,
    });
  }
}

async function handleMediaFailure(args: {
  error: unknown;
  job: MediaJobRow;
  params: {
    sql: PgSql;
    repo: MediaClaimRepository;
    config: WebhookMediaConfig;
    workerId: string;
  };
  log: LogFn;
  logError: LogFn;
  random: () => number;
  startedAt: number;
  now: () => number;
}): Promise<ProcessMediaJobResult> {
  const { error, job, params, logError, random } = args;
  const kind = classifyMediaProcessingError(error);
  const description = describeMediaProcessingError(error);
  const elapsedMs = args.now() - args.startedAt;
  const exhausted = shouldDeadLetterMedia(job.attempts, params.config);
  const permanent = kind === "permanent" || exhausted;

  const mediaStatus = permanent ? MESSAGE_MEDIA_STATUS.failed : MESSAGE_MEDIA_STATUS.retry;

  await params.sql
    .begin(async (tx) => {
      const txSql = tx as unknown as SqlExecutor;
      await updateMessageMediaState(txSql, {
        messageId: job.messageId,
        mediaStatus,
        mediaUrl: null,
        storageKey: null,
        mimeType: null,
        fileName: null,
        sizeBytes: null,
        checksum: null,
        mediaError: description.slice(0, 500),
      });
    })
    .catch(() => undefined);

  if (permanent) {
    await params.repo.markDeadLetter({
      mediaJobId: job.id,
      workerId: params.workerId,
      error: description,
    });
    incrementMediaWorkerCounters({ failed: 1 });
    logError("MEDIA_JOB_DEAD_LETTER", {
      mediaJobId: job.id,
      messageId: job.messageId,
      provider: job.provider,
      attempts: job.attempts,
      elapsedMs,
      error: description,
      reason: exhausted && kind !== "permanent" ? "max_attempts" : "permanent_error",
    });
    return { action: "dead_letter", reason: description, mediaJobId: job.id };
  }

  const delayMs = computeMediaRetryDelayMs(job.attempts, params.config, random);
  await params.repo.markRetry({
    mediaJobId: job.id,
    workerId: params.workerId,
    error: description,
    delayMs,
  });
  logError("MEDIA_DOWNLOAD_RETRY", {
    mediaJobId: job.id,
    messageId: job.messageId,
    provider: job.provider,
    attempts: job.attempts,
    elapsedMs,
    delayMs,
    error: description,
  });
  return { action: "retry", reason: description, mediaJobId: job.id };
}

export async function processMediaJobById(params: {
  sql: PgSql;
  repo?: MediaClaimRepository;
  storage: MediaStorage;
  config: WebhookMediaConfig;
  workerId: string;
  mediaJobId: string;
  log?: LogFn;
  logError?: LogFn;
  processDownload?: ProcessMediaJobResult extends never ? never : Parameters<
    typeof processClaimedMediaJob
  >[0]["processDownload"];
}): Promise<ProcessMediaJobResult> {
  const repo = params.repo ?? createSqlMediaClaimRepository(params.sql);
  const claim = await repo.claimById({
    mediaJobId: params.mediaJobId,
    workerId: params.workerId,
    leaseMs: params.config.leaseMs,
  });

  if (claim.outcome === "already_processed") {
    (params.log ?? defaultLog)("MEDIA_JOB_ALREADY_PROCESSED", {
      mediaJobId: params.mediaJobId,
      storageKey: claim.storageKey,
    });
    return { action: "skipped", reason: "already_processed", mediaJobId: params.mediaJobId };
  }
  if (claim.outcome === "dead_letter") {
    return { action: "skipped", reason: "dead_letter", mediaJobId: params.mediaJobId };
  }
  if (claim.outcome === "not_found") {
    return { action: "skipped", reason: "not_found", mediaJobId: params.mediaJobId };
  }
  if (claim.outcome === "not_yet_available") {
    return { action: "skipped", reason: "not_yet_available", mediaJobId: params.mediaJobId };
  }
  if (claim.outcome === "lease_conflict") {
    (params.log ?? defaultLog)("MEDIA_JOB_LEASE_CONFLICT", {
      mediaJobId: params.mediaJobId,
      lockedBy: claim.lockedBy,
    });
    return { action: "skipped", reason: "lease_conflict", mediaJobId: params.mediaJobId };
  }

  return processClaimedMediaJob({
    sql: params.sql,
    repo,
    storage: params.storage,
    config: params.config,
    workerId: params.workerId,
    job: claim.row,
    log: params.log,
    logError: params.logError,
    processDownload: params.processDownload,
  });
}

export async function processMediaJobBatch(params: {
  sql: PgSql;
  repo?: MediaClaimRepository;
  storage: MediaStorage;
  config: WebhookMediaConfig;
  workerId: string;
  log?: LogFn;
  logError?: LogFn;
  processDownload?: Parameters<typeof processClaimedMediaJob>[0]["processDownload"];
}): Promise<{ claimed: number; results: ProcessMediaJobResult[] }> {
  const repo = params.repo ?? createSqlMediaClaimRepository(params.sql);
  const claimed = await repo.claimBatch({
    batchSize: params.config.batchSize,
    workerId: params.workerId,
    leaseMs: params.config.leaseMs,
  });

  const results: ProcessMediaJobResult[] = [];
  const concurrency = Math.max(1, params.config.concurrency);
  let index = 0;

  async function worker() {
    while (index < claimed.length) {
      const current = claimed[index++];
      const result = await processClaimedMediaJob({
        sql: params.sql,
        repo,
        storage: params.storage,
        config: params.config,
        workerId: params.workerId,
        job: current,
        log: params.log,
        logError: params.logError,
        processDownload: params.processDownload,
      });
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, () => worker()));
  return { claimed: claimed.length, results };
}
