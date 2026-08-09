/**
 * Abstração de armazenamento definitivo de mídia de webhooks.
 *
 * Providers:
 *   - local  → disco efêmero (somente DEV/teste; bloqueado em produção)
 *   - s3     → object storage S3-compatível (PutObject com stream + UNSIGNED-PAYLOAD
 *              ou multipart por partes; NUNCA readFile do objeto inteiro)
 *   - memory → mapa em RAM (somente testes unitários)
 *
 * Nenhuma credencial vai para log.
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  PermanentMediaProcessingError,
  TemporaryMediaProcessingError,
  sanitizeMediaFileName,
} from "@/lib/webhook-media-core";
import { InternalCapacityExceededError } from "@/lib/media-base64-stream.server";

export type MediaStorageProviderName = "local" | "s3" | "memory";

export type MediaStorageConfig = {
  provider: MediaStorageProviderName;
  bucket: string | null;
  region: string;
  endpoint: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  publicBaseUrl: string | null;
  forcePathStyle: boolean;
  localDir: string;
  /** Permitir local/memory em production (default false). */
  allowEphemeralLocal: boolean;
  /** Part size multipart S3 (bytes). */
  multipartPartBytes: number;
};

export type StoredMediaResult = {
  storageKey: string;
  mediaUrl: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
  fileName: string | null;
  /** false quando o provider é efêmero (local/memory). */
  durable: boolean;
};

export type MediaStorage = {
  provider: MediaStorageProviderName;
  isDurable: boolean;
  storeMediaStream: (params: {
    storageKey: string;
    body: NodeJS.ReadableStream | Readable;
    mimeType: string;
    fileName: string | null;
    contentLength?: number | null;
  }) => Promise<StoredMediaResult>;
  storeMediaFile: (params: {
    storageKey: string;
    filePath: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<StoredMediaResult>;
  exists: (storageKey: string) => Promise<boolean>;
  openReadStream: (storageKey: string) => Promise<NodeJS.ReadableStream>;
  getStoredMediaReference: (storageKey: string) => { storageKey: string; mediaUrl: string };
  deleteTemporaryMedia: (filePath: string) => Promise<void>;
};

function parseBooleanEnv(raw: string | undefined, fallback = false): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function readMediaStorageConfig(env: NodeJS.ProcessEnv = process.env): MediaStorageConfig {
  const providerRaw = (env.MEDIA_STORAGE_PROVIDER ?? "local").trim().toLowerCase();
  const provider: MediaStorageProviderName =
    providerRaw === "s3" || providerRaw === "memory" ? providerRaw : "local";
  return {
    provider,
    bucket: env.MEDIA_STORAGE_BUCKET?.trim() || null,
    region: env.MEDIA_STORAGE_REGION?.trim() || "auto",
    endpoint: env.MEDIA_STORAGE_ENDPOINT?.trim() || null,
    accessKeyId: env.MEDIA_STORAGE_ACCESS_KEY_ID?.trim() || null,
    secretAccessKey: env.MEDIA_STORAGE_SECRET_ACCESS_KEY?.trim() || null,
    publicBaseUrl: env.MEDIA_STORAGE_PUBLIC_BASE_URL?.trim() || null,
    forcePathStyle: parseBooleanEnv(env.MEDIA_STORAGE_FORCE_PATH_STYLE, true),
    localDir: env.MEDIA_STORAGE_LOCAL_DIR?.trim() || join(process.cwd(), ".media-storage"),
    allowEphemeralLocal: parseBooleanEnv(env.MEDIA_STORAGE_ALLOW_EPHEMERAL_LOCAL, false),
    multipartPartBytes: parsePositiveInt(env.MEDIA_STORAGE_MULTIPART_PART_BYTES, 8 * 1024 * 1024),
  };
}

/** Produção / EasyPanel / K8s — disco de container não é storage definitivo. */
export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  return (
    nodeEnv === "production" ||
    Boolean(env.EASYPANEL_PROJECT?.trim()) ||
    Boolean(env.KUBERNETES_SERVICE_HOST?.trim())
  );
}

/**
 * Bloqueia local/memory em produção salvo override explícito.
 * Disco de container NÃO é armazenamento definitivo.
 */
export function assertMediaStorageRuntimeAllowed(
  config: MediaStorageConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProductionLikeEnv(env)) return;
  if (config.provider === "s3") return;
  if (config.allowEphemeralLocal) {
    console.error("[MEDIA_STORAGE_EPHEMERAL_OVERRIDE]", {
      provider: config.provider,
      warning: "armazenamento efêmero permitido só por MEDIA_STORAGE_ALLOW_EPHEMERAL_LOCAL=true",
    });
    return;
  }
  throw new PermanentMediaProcessingError(
    "ephemeral_storage_blocked",
    `MEDIA_STORAGE_PROVIDER=${config.provider} bloqueado em produção. Use s3 ou defina MEDIA_STORAGE_ALLOW_EPHEMERAL_LOCAL=true (não recomendado).`,
  );
}

function buildPublicUrl(config: MediaStorageConfig, storageKey: string): string {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${storageKey.replace(/^\/+/, "")}`;
  }
  if (config.provider === "local") return `local://${storageKey}`;
  if (config.bucket) return `s3://${config.bucket}/${storageKey}`;
  return storageKey;
}

async function hashFileSha256(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buf.length;
    hash.update(buf);
  }
  return { checksum: hash.digest("hex"), sizeBytes };
}

const memoryStore = new Map<string, { bytes: Buffer; mimeType: string; fileName: string | null }>();

export function clearMemoryMediaStore(): void {
  memoryStore.clear();
}

/** Marcador para testes estáticos: o caminho S3 NÃO pode usar readFile do objeto. */
export const S3_UPLOAD_STRATEGY = "stream_or_multipart_no_readfile" as const;

export function createMediaStorage(
  config: MediaStorageConfig = readMediaStorageConfig(),
  deps: { fetchFn?: typeof fetch } = {},
): MediaStorage {
  assertMediaStorageRuntimeAllowed(config);
  const fetchFn = deps.fetchFn ?? fetch;
  const durable = config.provider === "s3";

  async function ensureLocalPath(storageKey: string): Promise<string> {
    const safe = storageKey.replace(/\.\./g, "_").replace(/^\/+/, "");
    const full = resolve(join(config.localDir, safe));
    if (!full.startsWith(resolve(config.localDir))) {
      throw new PermanentMediaProcessingError("invalid_storage_key", "storage_key fora do diretório");
    }
    await mkdir(dirname(full), { recursive: true });
    return full;
  }

  const api: MediaStorage = {
    provider: config.provider,
    isDurable: durable,

    getStoredMediaReference(storageKey) {
      return { storageKey, mediaUrl: buildPublicUrl(config, storageKey) };
    },

    async deleteTemporaryMedia(filePath) {
      try {
        await unlink(filePath);
      } catch {
        // best-effort
      }
    },

    async exists(storageKey) {
      if (config.provider === "memory") return memoryStore.has(storageKey);
      if (config.provider === "local") {
        try {
          await access(await ensureLocalPath(storageKey));
          return true;
        } catch {
          return false;
        }
      }
      try {
        const res = await s3SignedRequest(config, fetchFn, {
          method: "HEAD",
          storageKey,
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async openReadStream(storageKey) {
      if (config.provider === "memory") {
        const row = memoryStore.get(storageKey);
        if (!row) throw new TemporaryMediaProcessingError("storage_miss", "objeto ausente");
        return Readable.from(row.bytes);
      }
      if (config.provider === "local") {
        return createReadStream(await ensureLocalPath(storageKey));
      }
      const res = await s3SignedRequest(config, fetchFn, {
        method: "GET",
        storageKey,
      });
      if (!res.ok || !res.body) {
        throw new TemporaryMediaProcessingError("storage_unavailable", `GET s3 status ${res.status}`);
      }
      return Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    },

    async storeMediaFile(params) {
      const fileName = sanitizeMediaFileName(params.fileName);
      const { checksum, sizeBytes } = await hashFileSha256(params.filePath);

      if (config.provider === "memory") {
        // Somente testes — pode bufferizar.
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(params.filePath);
        memoryStore.set(params.storageKey, { bytes, mimeType: params.mimeType, fileName });
        return {
          storageKey: params.storageKey,
          mediaUrl: buildPublicUrl(config, params.storageKey),
          checksum,
          sizeBytes,
          mimeType: params.mimeType,
          fileName,
          durable: false,
        };
      }

      if (config.provider === "local") {
        const dest = await ensureLocalPath(params.storageKey);
        await pipeline(createReadStream(params.filePath), createWriteStream(dest));
        return {
          storageKey: params.storageKey,
          mediaUrl: buildPublicUrl(config, params.storageKey),
          checksum,
          sizeBytes,
          mimeType: params.mimeType,
          fileName,
          durable: false,
        };
      }

      // S3: stream/multipart — proibido readFile do arquivo inteiro.
      await s3UploadFileStreaming(config, fetchFn, {
        storageKey: params.storageKey,
        filePath: params.filePath,
        contentType: params.mimeType,
        sizeBytes,
        partBytes: config.multipartPartBytes,
      });

      return {
        storageKey: params.storageKey,
        mediaUrl: buildPublicUrl(config, params.storageKey),
        checksum,
        sizeBytes,
        mimeType: params.mimeType,
        fileName,
        durable: true,
      };
    },

    async storeMediaStream(params) {
      const tmpDir = join(config.localDir, ".tmp");
      await mkdir(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
      try {
        // Materializa em disco com backpressure do pipeline; checksum via re-leitura
        // em stream (não Buffer integral). Depois sobe para S3 por stream/multipart.
        await pipeline(params.body as Readable, createWriteStream(tmpPath));
        return await api.storeMediaFile({
          storageKey: params.storageKey,
          filePath: tmpPath,
          mimeType: params.mimeType,
          fileName: params.fileName,
        });
      } finally {
        await api.deleteTemporaryMedia(tmpPath);
      }
    },
  };

  return api;
}

type S3SignedParams = {
  method: "GET" | "PUT" | "HEAD" | "POST" | "DELETE";
  storageKey: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** UNSIGNED-PAYLOAD | hex sha256 | empty */
  payloadHash?: string;
};

function s3Urls(config: MediaStorageConfig, storageKey: string, query?: Record<string, string>) {
  const key = storageKey.replace(/^\/+/, "");
  const base =
    config.endpoint?.replace(/\/+$/, "") ??
    `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  const path =
    config.forcePathStyle || config.endpoint ? `/${config.bucket}/${key}` : `/${key}`;
  const qs = query
    ? "?" +
      Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
        .join("&")
    : "";
  const url =
    config.forcePathStyle || config.endpoint
      ? `${base}/${config.bucket}/${key}${qs}`
      : `${base}/${key}${qs}`;
  const host = config.endpoint ? new URL(config.endpoint).host : new URL(base).host;
  return { url, path, host, key };
}

async function s3SignedRequest(
  config: MediaStorageConfig,
  fetchFn: typeof fetch,
  params: S3SignedParams,
): Promise<Response> {
  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw new PermanentMediaProcessingError(
      "storage_misconfigured",
      "MEDIA_STORAGE S3 incompleto (bucket/credenciais)",
    );
  }

  const { url, path, host } = s3Urls(config, params.storageKey, params.query);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash =
    params.payloadHash ?? createHash("sha256").update("").digest("hex");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(params.headers ?? {}),
  };

  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(";");
  const canonicalHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .map((h) => `${h}:${headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]!.trim()}\n`)
    .join("");

  const canonicalQuery = params.query
    ? Object.keys(params.query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params.query![k])}`)
        .join("&")
    : "";

  const canonicalRequest = [
    params.method,
    path.startsWith("/") ? path : `/${path}`,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const kDate = createHmac("sha256", `AWS4${config.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(config.region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    return await fetchFn(url, {
      method: params.method,
      headers,
      body: params.body ?? undefined,
      signal: ctrl.signal,
      // @ts-expect-error Node fetch duplex for streamed body
      duplex: params.body ? "half" : undefined,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new TemporaryMediaProcessingError("storage_unavailable", "S3 upload timeout");
    }
    throw new TemporaryMediaProcessingError(
      "storage_unavailable",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload S3 sem Buffer integral do arquivo.
 * - arquivos ≤ partBytes: PutObject com body = ReadStream + UNSIGNED-PAYLOAD
 * - maiores: multipart; cada parte ≤ partBytes (Buffer por parte, nunca o arquivo todo)
 */
export async function s3UploadFileStreaming(
  config: MediaStorageConfig,
  fetchFn: typeof fetch,
  params: {
    storageKey: string;
    filePath: string;
    contentType: string;
    sizeBytes: number;
    partBytes: number;
  },
): Promise<void> {
  const partBytes = Math.max(5 * 1024 * 1024, params.partBytes);

  if (params.sizeBytes <= partBytes) {
    const stream = createReadStream(params.filePath);
    const body = Readable.toWeb(stream) as unknown as BodyInit;
    const res = await s3SignedRequest(config, fetchFn, {
      method: "PUT",
      storageKey: params.storageKey,
      payloadHash: "UNSIGNED-PAYLOAD",
      headers: {
        "content-length": String(params.sizeBytes),
        "content-type": params.contentType,
      },
      body,
    });
    if (!res.ok) {
      throw new TemporaryMediaProcessingError(
        "storage_unavailable",
        `PutObject stream falhou status ${res.status}`,
      );
    }
    return;
  }

  // Multipart
  const init = await s3SignedRequest(config, fetchFn, {
    method: "POST",
    storageKey: params.storageKey,
    query: { uploads: "" },
    headers: { "content-type": params.contentType },
    payloadHash: createHash("sha256").update("").digest("hex"),
  });
  if (!init.ok) {
    throw new TemporaryMediaProcessingError(
      "storage_unavailable",
      `CreateMultipartUpload status ${init.status}`,
    );
  }
  const initXml = await init.text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)?.[1];
  if (!uploadId) {
    throw new TemporaryMediaProcessingError("storage_unavailable", "UploadId ausente");
  }

  const parts: Array<{ partNumber: number; etag: string }> = [];
  let offset = 0;
  let partNumber = 1;

  try {
    while (offset < params.sizeBytes) {
      const end = Math.min(offset + partBytes, params.sizeBytes) - 1;
      const length = end - offset + 1;
      // Parte limitada (≤ partBytes), não o arquivo inteiro.
      const partBuf = Buffer.allocUnsafe(length);
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(params.filePath, { start: offset, end });
        let pos = 0;
        rs.on("data", (chunk: Buffer) => {
          chunk.copy(partBuf, pos);
          pos += chunk.length;
        });
        rs.on("end", () => resolve());
        rs.on("error", reject);
      });

      const partHash = createHash("sha256").update(partBuf).digest("hex");
      const res = await s3SignedRequest(config, fetchFn, {
        method: "PUT",
        storageKey: params.storageKey,
        query: { partNumber: String(partNumber), uploadId },
        payloadHash: partHash,
        headers: { "content-length": String(length) },
        body: new Uint8Array(partBuf),
      });
      if (!res.ok) {
        throw new TemporaryMediaProcessingError(
          "storage_unavailable",
          `UploadPart ${partNumber} status ${res.status}`,
        );
      }
      const etag = res.headers.get("etag") ?? res.headers.get("ETag") ?? `"part-${partNumber}"`;
      parts.push({ partNumber, etag });
      offset = end + 1;
      partNumber += 1;
    }

    const completeBody = `<CompleteMultipartUpload>${parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
    const completeHash = createHash("sha256").update(completeBody).digest("hex");
    const done = await s3SignedRequest(config, fetchFn, {
      method: "POST",
      storageKey: params.storageKey,
      query: { uploadId },
      payloadHash: completeHash,
      headers: {
        "content-type": "application/xml",
        "content-length": String(Buffer.byteLength(completeBody)),
      },
      body: completeBody,
    });
    if (!done.ok) {
      throw new TemporaryMediaProcessingError(
        "storage_unavailable",
        `CompleteMultipartUpload status ${done.status}`,
      );
    }
  } catch (e) {
    await s3SignedRequest(config, fetchFn, {
      method: "DELETE",
      storageKey: params.storageKey,
      query: { uploadId },
    }).catch(() => undefined);
    throw e;
  }
}

/** Grava stream HTTP em arquivo temporário com checksum e limites. */
export async function writeStreamToTempFile(params: {
  stream: Readable;
  tempPath: string;
  maxBytes: number;
  absoluteTimeoutMs: number;
  stallTimeoutMs: number;
  onProgress?: (bytes: number) => void;
  progressEveryBytes?: number;
}): Promise<{ sizeBytes: number; checksum: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let lastProgressLog = 0;
  const started = Date.now();
  let lastChunkAt = Date.now();

  await mkdir(dirname(params.tempPath), { recursive: true });
  const out = createWriteStream(params.tempPath);

  const absoluteTimer = setTimeout(() => {
    params.stream.destroy(new TemporaryMediaProcessingError("download_timeout", "timeout absoluto"));
    out.destroy();
  }, params.absoluteTimeoutMs);

  const stallTimer = setInterval(() => {
    if (Date.now() - lastChunkAt > params.stallTimeoutMs) {
      params.stream.destroy(new TemporaryMediaProcessingError("download_stall", "stall timeout"));
      out.destroy();
    }
  }, Math.min(1_000, Math.max(200, Math.floor(params.stallTimeoutMs / 3))));

  try {
    for await (const chunk of params.stream) {
      if (Date.now() - started > params.absoluteTimeoutMs) {
        throw new TemporaryMediaProcessingError("download_timeout", "timeout absoluto");
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      lastChunkAt = Date.now();
      sizeBytes += buf.length;
      if (sizeBytes > params.maxBytes) {
        throw new InternalCapacityExceededError(params.maxBytes);
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise<void>((resolveWrite) => out.once("drain", resolveWrite));
      }
      const every = params.progressEveryBytes ?? 5 * 1024 * 1024;
      if (sizeBytes - lastProgressLog >= every) {
        lastProgressLog = sizeBytes;
        params.onProgress?.(sizeBytes);
      }
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      out.end(() => resolveClose());
      out.on("error", rejectClose);
    });
    return { sizeBytes, checksum: hash.digest("hex") };
  } catch (e) {
    out.destroy();
    try {
      await unlink(params.tempPath);
    } catch {
      // ignore
    }
    throw e;
  } finally {
    clearTimeout(absoluteTimer);
    clearInterval(stallTimer);
  }
}

/** @deprecated Prefer streamDecodeJsonBase64FieldToFile — mantém string integral. */
export async function writeBase64ToTempFile(params: {
  base64: string;
  tempPath: string;
  maxBytes: number;
}): Promise<{ sizeBytes: number; checksum: string }> {
  const cleaned = params.base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await mkdir(dirname(params.tempPath), { recursive: true });
  const out = createWriteStream(params.tempPath);
  const chunkChars = 64 * 1024;
  try {
    for (let i = 0; i < cleaned.length; i += chunkChars) {
      const slice = cleaned.slice(i, i + chunkChars);
      const padded =
        slice.length % 4 === 0 ? slice : slice + "=".repeat((4 - (slice.length % 4)) % 4);
      const buf = Buffer.from(padded, "base64");
      sizeBytes += buf.length;
      if (sizeBytes > params.maxBytes) {
        throw new InternalCapacityExceededError(params.maxBytes);
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise<void>((resolveWrite) => out.once("drain", resolveWrite));
      }
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      out.end(() => resolveClose());
      out.on("error", rejectClose);
    });
    return { sizeBytes, checksum: hash.digest("hex") };
  } catch (e) {
    out.destroy();
    try {
      await unlink(params.tempPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function writeBytesFile(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export { InternalCapacityExceededError };
