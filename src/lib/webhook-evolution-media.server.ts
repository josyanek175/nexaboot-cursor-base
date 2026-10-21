/**
 * Download e persistência de mídia Evolution para o media-worker.
 *
 * Não usa Request/Response. Reconstrói o nó da mensagem a partir do payload
 * preservado na inbox + media_reference. Nunca loga base64 nem apikey.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { unlink } from "node:fs/promises";
import type { SqlExecutor } from "@/lib/pg-types";
import type { MediaJobRow } from "@/lib/webhook-media-claim.server";
import type { MediaStorage, StoredMediaResult } from "@/lib/media-storage.server";
import { writeStreamToTempFile } from "@/lib/media-storage.server";
import {
  peekJsonMimeType,
  streamDecodeJsonBase64FieldToFile,
} from "@/lib/media-base64-stream.server";
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

/**
 * Reconstrói o rawMessage esperado por /chat/getBase64FromMediaMessage.
 * Prefere o payload bruto da inbox; cai no media_reference se necessário.
 */
export function rebuildEvolutionRawMessage(params: {
  inboxPayload: unknown;
  job: MediaJobRow;
}): Record<string, unknown> {
  const payload = asRecord(params.inboxPayload);
  const data = asRecord(payload.data);
  if (data.key || data.message) {
    return {
      ...data,
      instance: params.job.instanceName ?? payload.instance ?? data.instance,
      instanceName: params.job.instanceName ?? payload.instance ?? data.instanceName,
    };
  }

  const ref = params.job.mediaReference;
  const messageKey = asRecord(ref.messageKey);
  const media = asRecord(ref.media);
  const mediaNode = typeof ref.mediaNode === "string" ? ref.mediaNode : "imageMessage";
  return {
    key: messageKey,
    instance: params.job.instanceName,
    instanceName: params.job.instanceName,
    message: {
      [mediaNode]: media,
    },
  };
}

export type EvolutionMediaDownloadDeps = {
  fetchFn?: typeof fetch;
  apiUrl?: string | null;
  apiKey?: string | null;
};

/**
 * Baixa mídia Evolution com memória controlada.
 *
 * Caminho real (documentado):
 * 1. POST /chat/getBase64FromMediaMessage/{instance}
 * 2. Corpo HTTP → arquivo .json via stream (backpressure; não response.text/json)
 * 3. Varredura do arquivo em disco pelo campo "base64" (sem JSON.parse integral)
 * 4. Decodificação base64 em janelas de ~64 KiB → arquivo binário temporário
 * 5. Checksum SHA-256 durante o decode
 *
 * A API Evolution obriga JSON/base64: o arquivo .json em disco terá ~4/3 do
 * tamanho binário. O que evitamos é manter string base64 + Buffer decodificado
 * integrais simultâneos no heap.
 */
export async function downloadEvolutionMediaToTempFile(params: {
  rawMessage: Record<string, unknown>;
  instanceName: string | null;
  mimeHint: string | null;
  config: WebhookMediaConfig;
  tempPath: string;
  log?: LogFn;
  deps?: EvolutionMediaDownloadDeps;
}): Promise<{ mimeType: string; sizeBytes: number; checksum: string }> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const apiUrl = params.deps?.apiUrl ?? process.env.EVOLUTION_API_URL;
  const apiKey = params.deps?.apiKey ?? process.env.EVOLUTION_API_KEY;
  const instance =
    params.instanceName ??
    (typeof params.rawMessage.instance === "string" ? params.rawMessage.instance : null);
  const fetchFn = params.deps?.fetchFn ?? fetch;

  if (!apiUrl || !apiKey || !instance) {
    throw new PermanentMediaProcessingError(
      "evolution_config_missing",
      "EVOLUTION_API_URL/KEY ou instance ausentes",
    );
  }

  const endpoint = `${apiUrl.replace(/\/+$/, "")}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`;
  log("MEDIA_DOWNLOAD_START", {
    provider: "evolution",
    instance,
    strategy: "evolution_get_base64_disk_stream",
  });

  const ctrl = new AbortController();
  const absoluteTimer = setTimeout(() => ctrl.abort(), params.config.downloadTimeoutMs);
  const jsonTemp = `${params.tempPath}.json`;

  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ message: params.rawMessage }),
      signal: ctrl.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      throw new TemporaryMediaProcessingError(
        "evolution_http_transient",
        `Evolution HTTP ${res.status}`,
      );
    }
    if (!res.ok) {
      throw new PermanentMediaProcessingError(
        "evolution_http_error",
        `Evolution HTTP ${res.status}`,
      );
    }

    if (!res.body) {
      throw new TemporaryMediaProcessingError("evolution_empty_body", "resposta sem body");
    }

    // JSON da Evolution cabe ~4/3 do binário + overhead. Teto do arquivo JSON
    // = maxBytes * 2 para acomodar base64, sem carregar no heap.
    const nodeReadable = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    await writeStreamToTempFile({
      stream: nodeReadable,
      tempPath: jsonTemp,
      maxBytes: Math.max(params.config.maxBytes * 2, params.config.maxBytes + 1024 * 1024),
      absoluteTimeoutMs: params.config.downloadTimeoutMs,
      stallTimeoutMs: params.config.stallTimeoutMs,
      progressEveryBytes: params.config.progressLogBytes,
      onProgress: (bytes) =>
        log("MEDIA_DOWNLOAD_PROGRESS", { provider: "evolution", phase: "json_to_disk", sizeBytes: bytes }),
    });

    const mimeType = await peekJsonMimeType(jsonTemp, params.mimeHint);
    const written = await streamDecodeJsonBase64FieldToFile({
      jsonPath: jsonTemp,
      outPath: params.tempPath,
      maxDecodedBytes: params.config.maxBytes,
    });

    log("MEDIA_DOWNLOAD_SUCCESS", {
      provider: "evolution",
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      mimeType,
      strategy: "disk_stream_decode",
    });
    return { mimeType, sizeBytes: written.sizeBytes, checksum: written.checksum };
  } catch (e) {
    if (e instanceof PermanentMediaProcessingError || e instanceof TemporaryMediaProcessingError) {
      throw e;
    }
    if (e instanceof Error && e.name === "AbortError") {
      throw new TemporaryMediaProcessingError("download_timeout", "timeout absoluto Evolution");
    }
    throw new TemporaryMediaProcessingError(
      "evolution_download_failed",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(absoluteTimer);
    await unlink(jsonTemp).catch(() => undefined);
  }
}

export async function processEvolutionMediaJob(params: {
  sql: SqlExecutor;
  job: MediaJobRow;
  companyId: string | null;
  inboxPayload: unknown;
  storage: MediaStorage;
  config: WebhookMediaConfig;
  log?: LogFn;
  deps?: EvolutionMediaDownloadDeps;
}): Promise<StoredMediaResult> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const storageKey =
    params.job.storageKey ??
    buildStableMediaStorageKey({
      companyId: params.companyId,
      channelId: params.job.channelId,
      externalMessageId: params.job.externalMessageId,
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

  const rawMessage = rebuildEvolutionRawMessage({
    inboxPayload: params.inboxPayload,
    job: params.job,
  });
  const tempPath = join(tmpdir(), `nexa-media-${randomUUID()}.bin`);

  try {
    const downloaded = await downloadEvolutionMediaToTempFile({
      rawMessage,
      instanceName: params.job.instanceName,
      mimeHint: params.job.mimeType,
      config: params.config,
      tempPath,
      log,
      deps: params.deps,
    });

    log("MEDIA_STORAGE_START", {
      provider: "evolution",
      storageKey,
      sizeBytes: downloaded.sizeBytes,
    });
    const stored = await params.storage.storeMediaFile({
      storageKey,
      filePath: tempPath,
      mimeType: downloaded.mimeType,
      fileName: sanitizeMediaFileName(params.job.fileName),
    });
    log("MEDIA_STORAGE_SUCCESS", {
      provider: "evolution",
      storageKey: stored.storageKey,
      checksum: stored.checksum,
      sizeBytes: stored.sizeBytes,
    });
    return stored;
  } finally {
    await params.storage.deleteTemporaryMedia(tempPath);
    log("MEDIA_TEMP_FILE_CLEANED", { provider: "evolution", tempPath: "redacted" });
  }
}
