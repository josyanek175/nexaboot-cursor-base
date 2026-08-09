/**
 * Download e persistência de mídia Meta (Graph API) para o media-worker.
 *
 * Usa a mesma chave de criptografia de token do sistema
 * (loadMetaAccessTokenDetailed). Faz streaming do binário para arquivo
 * temporário — não converte para base64.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { SqlExecutor } from "@/lib/pg-types";
import type { MediaJobRow } from "@/lib/webhook-media-claim.server";
import type { MediaStorage, StoredMediaResult } from "@/lib/media-storage.server";
import { writeStreamToTempFile } from "@/lib/media-storage.server";
import { loadMetaAccessTokenDetailed } from "@/lib/meta-access-token.server";
import { metaGraphApiVersion } from "@/lib/meta-media-download.server";
import {
  PermanentMediaProcessingError,
  TemporaryMediaProcessingError,
  buildStableMediaStorageKey,
  sanitizeMediaFileName,
  type WebhookMediaConfig,
} from "@/lib/webhook-media-core";

type LogFn = (event: string, data?: Record<string, unknown>) => void;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function classifyTokenReason(reason: string): never {
  if (
    reason === "missing_encryption_key" ||
    reason === "secret_not_found" ||
    reason === "ciphertext_empty" ||
    reason === "channel_not_found"
  ) {
    throw new PermanentMediaProcessingError(`meta_token_${reason}`, reason);
  }
  if (reason === "decrypt_failed") {
    throw new TemporaryMediaProcessingError(`meta_token_${reason}`, reason);
  }
  throw new TemporaryMediaProcessingError("token_unavailable", reason);
}

export function extractMetaMediaId(job: MediaJobRow): string | null {
  const media = asRecord(job.mediaReference.media);
  return asString(media.id);
}

export async function processMetaMediaJob(params: {
  sql: SqlExecutor;
  job: MediaJobRow;
  companyId: string | null;
  phoneNumberId: string | null;
  storage: MediaStorage;
  config: WebhookMediaConfig;
  log?: LogFn;
  fetchFn?: typeof fetch;
  /** Testes: injeta token sem tocar no cofre. */
  accessToken?: string | null;
}): Promise<StoredMediaResult> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const fetchFn = params.fetchFn ?? fetch;
  const mediaId = extractMetaMediaId(params.job);

  if (!mediaId) {
    throw new PermanentMediaProcessingError("meta_missing_media_id", "media_reference sem media.id");
  }
  if (!params.job.channelId || !params.companyId) {
    throw new PermanentMediaProcessingError(
      "meta_missing_channel_company",
      "channelId/companyId ausentes para download Meta",
    );
  }
  if (!params.phoneNumberId) {
    throw new PermanentMediaProcessingError(
      "meta_missing_phone_number_id",
      "phone_number_id ausente no canal",
    );
  }

  const storageKey =
    params.job.storageKey ??
    buildStableMediaStorageKey({
      companyId: params.companyId,
      channelId: params.job.channelId,
      externalMessageId: params.job.externalMessageId ?? mediaId,
      mediaType: params.job.mediaType,
      messageId: params.job.messageId,
    });

  if (params.job.storageKey && (await params.storage.exists(params.job.storageKey))) {
    log("MEDIA_JOB_ALREADY_PROCESSED", {
      mediaJobId: params.job.id,
      storageKey: params.job.storageKey,
      reason: "storage_exists",
    });
    const ref = params.storage.getStoredMediaReference(params.job.storageKey);
    return {
      storageKey: params.job.storageKey,
      mediaUrl: ref.mediaUrl,
      checksum: params.job.checksum ?? "unknown",
      sizeBytes: params.job.sizeBytes ?? 0,
      mimeType: params.job.mimeType ?? "application/octet-stream",
      fileName: sanitizeMediaFileName(params.job.fileName),
      durable: params.storage.isDurable,
    };
  }

  let token = params.accessToken ?? null;
  if (!token) {
    const tokenResult = await loadMetaAccessTokenDetailed(params.job.channelId, params.companyId, {
      phoneNumberId: params.phoneNumberId,
      source: "webhook_media_worker",
    });
    if (!tokenResult.ok) classifyTokenReason(tokenResult.reason);
    token = tokenResult.token;
  }

  log("MEDIA_DOWNLOAD_START", {
    provider: "meta",
    mediaId,
    mediaType: params.job.mediaType,
  });

  const graphVersion = metaGraphApiVersion();
  const metadataUrl =
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}` +
    `?phone_number_id=${encodeURIComponent(params.phoneNumberId)}`;

  const metaRes = await fetchFn(metadataUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (metaRes.status === 429 || metaRes.status >= 500) {
    throw new TemporaryMediaProcessingError("meta_metadata_transient", `HTTP ${metaRes.status}`);
  }
  if (metaRes.status === 401 || metaRes.status === 403) {
    throw new TemporaryMediaProcessingError("meta_token_rejected", `HTTP ${metaRes.status}`);
  }
  if (metaRes.status === 404) {
    throw new PermanentMediaProcessingError("meta_media_removed", "mídia removida no Graph");
  }
  if (!metaRes.ok) {
    throw new TemporaryMediaProcessingError("meta_metadata_http", `HTTP ${metaRes.status}`);
  }

  const metaJson = asRecord(await metaRes.json().catch(() => ({})));
  if (metaJson.error) {
    const err = asRecord(metaJson.error);
    const code = err.code != null ? String(err.code) : "graph_error";
    throw new TemporaryMediaProcessingError("meta_graph_error", code);
  }

  const mediaUrl = asString(metaJson.url);
  const mimeType =
    asString(metaJson.mime_type) ?? params.job.mimeType ?? "application/octet-stream";
  if (!mediaUrl) {
    throw new TemporaryMediaProcessingError("meta_missing_url", "Graph sem URL temporária");
  }

  const binRes = await fetchFn(mediaUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (binRes.status === 429 || binRes.status >= 500) {
    throw new TemporaryMediaProcessingError("meta_binary_transient", `HTTP ${binRes.status}`);
  }
  if (!binRes.ok) {
    // URL temporária expirada costuma ser 403/401 → retry.
    if (binRes.status === 401 || binRes.status === 403) {
      throw new TemporaryMediaProcessingError("meta_url_expired", `HTTP ${binRes.status}`);
    }
    throw new TemporaryMediaProcessingError("meta_binary_http", `HTTP ${binRes.status}`);
  }
  if (!binRes.body) {
    throw new TemporaryMediaProcessingError("meta_empty_body", "binário vazio");
  }

  const tempPath = join(tmpdir(), `nexa-meta-media-${randomUUID()}.bin`);
  try {
    const nodeReadable = Readable.fromWeb(binRes.body as import("stream/web").ReadableStream);
    const written = await writeStreamToTempFile({
      stream: nodeReadable,
      tempPath,
      maxBytes: params.config.maxBytes,
      absoluteTimeoutMs: params.config.downloadTimeoutMs,
      stallTimeoutMs: params.config.stallTimeoutMs,
      progressEveryBytes: params.config.progressLogBytes,
      onProgress: (bytes) =>
        log("MEDIA_DOWNLOAD_PROGRESS", { provider: "meta", mediaId, sizeBytes: bytes }),
    });

    log("MEDIA_DOWNLOAD_SUCCESS", {
      provider: "meta",
      mediaId,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      mimeType,
    });

    log("MEDIA_STORAGE_START", {
      provider: "meta",
      storageKey,
      sizeBytes: written.sizeBytes,
    });
    const stored = await params.storage.storeMediaFile({
      storageKey,
      filePath: tempPath,
      mimeType,
      fileName: sanitizeMediaFileName(params.job.fileName),
    });
    log("MEDIA_STORAGE_SUCCESS", {
      provider: "meta",
      storageKey: stored.storageKey,
      checksum: stored.checksum,
      sizeBytes: stored.sizeBytes,
    });
    return stored;
  } finally {
    await params.storage.deleteTemporaryMedia(tempPath);
    log("MEDIA_TEMP_FILE_CLEANED", { provider: "meta", tempPath: "redacted" });
  }
}
