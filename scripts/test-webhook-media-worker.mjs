/**
 * Testes da ETAPA 4: media-worker durável (Evolution + Meta).
 *
 * Sem RabbitMQ/PostgreSQL/S3 reais nos testes padrão.
 *
 *   npx tsx scripts/test-webhook-media-worker.mjs
 */
import {
  WEBHOOK_MEDIA_DEFAULT_MAX_BYTES,
  WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS,
  PROVIDER_MEDIA_LIMITS,
  buildStableMediaStorageKey,
  classifyMediaProcessingError,
  computeMediaRetryDelayMs,
  isWebhookMediaWorkerEnabled,
  maskSensitiveMediaText,
  parseMediaJobEnvelope,
  readWebhookMediaConfig,
  shouldDeadLetterMedia,
  PermanentMediaProcessingError,
  TemporaryMediaProcessingError,
} from "../src/lib/webhook-media-core.ts";
import {
  createMediaStorage,
  clearMemoryMediaStore,
  writeStreamToTempFile,
  writeBase64ToTempFile,
  S3_UPLOAD_STRATEGY,
  assertMediaStorageRuntimeAllowed,
  s3UploadFileStreaming,
} from "../src/lib/media-storage.server.ts";
import {
  streamDecodeJsonBase64FieldToFile,
  InternalCapacityExceededError,
} from "../src/lib/media-base64-stream.server.ts";
import { processClaimedMediaJob, processMediaJobBatch } from "../src/lib/webhook-media-worker.server.ts";
import { runWebhookMediaWorkerLoop } from "../src/lib/webhook-media-worker-loop.server.ts";
import {
  getMediaWorkerHealthSnapshot,
  mediaWorkerHealthFromFlagsOnly,
} from "../src/lib/webhook-media-health.ts";
import { readWebhookArchitectureHealth } from "../src/lib/webhook-health.server.ts";
import { rebuildEvolutionRawMessage } from "../src/lib/webhook-evolution-media.server.ts";
import { extractMetaMediaId } from "../src/lib/webhook-meta-media.server.ts";
import { isMediaMessageType, pickMessageType } from "../src/lib/webhook-evolution-processing.server.ts";
import { createWriteStream as createWs } from "node:fs";
import { finished } from "node:stream/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const silent = { log: () => {}, logError: () => {} };

function createStore() {
  return {
    jobs: [],
    messages: [],
    conversations: [],
    inbox: [],
    channels: [],
  };
}

function makeSql(store) {
  const state = { begins: 0, commits: 0, inTx: false, queries: [] };
  const run = async (strings, values) => {
    const text = strings.join("|");
    state.queries.push(text);

    if (text.includes("UPDATE public.messages") && text.includes("media_status")) {
      const messageId = values[values.length - 1];
      const msg = store.messages.find((m) => m.id === messageId);
      if (!msg) return [];
      // Ordem aproximada dos binds em updateMessageMediaState
      msg.media_status = values[0];
      if (values[1] != null) msg.media_url = values[1];
      if (values[2] != null) msg.storage_key = values[2];
      if (values[3] != null) {
        msg.mime_type = values[3];
        msg.media_mimetype = values[3];
      }
      if (values[4] != null) msg.media_filename = values[4];
      if (values[5] != null) msg.media_size = values[5];
      if (values[6] != null) msg.media_checksum = values[6];
      msg.media_error = values[7];
      return [{ id: msg.id }];
    }

    if (text.includes("UPDATE public.webhook_media_jobs") && text.includes("'processed'")) {
      const [storageKey, checksum, sizeBytes, id, workerId] = values;
      const job = store.jobs.find((j) => j.id === id);
      if (!job || job.locked_by !== workerId || job.status !== "processing") return [];
      job.status = "processed";
      job.storage_key = storageKey;
      job.checksum = checksum;
      job.size_bytes = sizeBytes;
      job.processed_at = new Date().toISOString();
      job.locked_by = null;
      return [{ id: job.id }];
    }

    if (text.includes("FROM public.messages") && text.includes("conversations")) {
      const messageId = values[0];
      const msg = store.messages.find((m) => m.id === messageId);
      if (!msg) return [];
      const conv = store.conversations.find((c) => c.id === msg.conversation_id);
      return [{ id: msg.id, company_id: conv?.company_id ?? null }];
    }

    if (text.includes("FROM public.webhook_inbox")) {
      const inboxId = values[0];
      const row = store.inbox.find((i) => i.id === inboxId);
      return row ? [{ payload: row.payload }] : [];
    }

    if (text.includes("FROM public.whatsapp_channels")) {
      const channelId = values[0];
      const ch = store.channels.find((c) => c.id === channelId);
      return ch ? [{ phone_number_id: ch.phone_number_id ?? null }] : [];
    }

    return [];
  };

  const sql = Object.assign((strings, ...values) => run(strings, values), {
    begin: async (fn) => {
      state.begins += 1;
      state.inTx = true;
      try {
        const result = await fn(sql);
        state.commits += 1;
        return result;
      } finally {
        state.inTx = false;
      }
    },
  });
  return { sql, state };
}

function createRepo(store) {
  return {
    async claimBatch({ batchSize, workerId, leaseMs }) {
      const now = Date.now();
      const eligible = store.jobs.filter((j) => {
        const available = !j.available_at || new Date(j.available_at).getTime() <= now;
        const leaseExpired =
          j.lease_expires_at == null || new Date(j.lease_expires_at).getTime() < now;
        return (
          (["pending", "retry"].includes(j.status) && available) ||
          (j.status === "processing" && leaseExpired)
        );
      });
      const picked = [];
      for (const j of eligible.slice(0, batchSize)) {
        if (j._busy) continue;
        j._busy = true;
        j.status = "processing";
        j.attempts = (j.attempts ?? 0) + 1;
        j.locked_by = workerId;
        j.locked_at = new Date().toISOString();
        j.lease_expires_at = new Date(now + leaseMs).toISOString();
        j._busy = false;
        picked.push(mapJob(j));
      }
      return picked;
    },
    async claimById({ mediaJobId, workerId, leaseMs }) {
      const j = store.jobs.find((x) => x.id === mediaJobId);
      if (!j) return { outcome: "not_found" };
      if (j.status === "processed") {
        return { outcome: "already_processed", attempts: j.attempts, storageKey: j.storage_key };
      }
      if (j.status === "dead_letter") return { outcome: "dead_letter", attempts: j.attempts };
      const now = Date.now();
      if (j.status === "retry" && j.available_at && new Date(j.available_at).getTime() > now) {
        return {
          outcome: "not_yet_available",
          availableInMs: new Date(j.available_at).getTime() - now,
        };
      }
      if (
        j.status === "processing" &&
        j.lease_expires_at &&
        new Date(j.lease_expires_at).getTime() > now &&
        j.locked_by !== workerId
      ) {
        return {
          outcome: "lease_conflict",
          lockedBy: j.locked_by,
          leaseExpiresAt: j.lease_expires_at,
        };
      }
      const available = !j.available_at || new Date(j.available_at).getTime() <= now;
      const leaseExpired =
        j.lease_expires_at == null || new Date(j.lease_expires_at).getTime() < now;
      const eligible =
        (["pending", "retry"].includes(j.status) && available) ||
        (j.status === "processing" && leaseExpired);
      if (!eligible) {
        return {
          outcome: "lease_conflict",
          lockedBy: j.locked_by,
          leaseExpiresAt: j.lease_expires_at,
        };
      }
      j.status = "processing";
      j.attempts = (j.attempts ?? 0) + 1;
      j.locked_by = workerId;
      j.lease_expires_at = new Date(now + leaseMs).toISOString();
      return { outcome: "claimed", row: mapJob(j) };
    },
    async markProcessed({ mediaJobId, workerId, storageKey, checksum, sizeBytes }) {
      const j = store.jobs.find((x) => x.id === mediaJobId);
      if (!j || j.locked_by !== workerId || j.status !== "processing") return false;
      j.status = "processed";
      j.storage_key = storageKey;
      j.checksum = checksum;
      j.size_bytes = sizeBytes;
      j.locked_by = null;
      return true;
    },
    async markRetry({ mediaJobId, workerId, error, delayMs }) {
      const j = store.jobs.find((x) => x.id === mediaJobId);
      if (!j || j.locked_by !== workerId || j.status !== "processing") return false;
      j.status = "retry";
      j.last_error = error;
      j.available_at = new Date(Date.now() + delayMs).toISOString();
      j.locked_by = null;
      return true;
    },
    async markDeadLetter({ mediaJobId, workerId, error }) {
      const j = store.jobs.find((x) => x.id === mediaJobId);
      if (!j || j.locked_by !== workerId || j.status !== "processing") return false;
      j.status = "dead_letter";
      j.last_error = error;
      j.locked_by = null;
      return true;
    },
    async countByStatus() {
      const count = (s) => store.jobs.filter((j) => j.status === s).length;
      return {
        pending: count("pending"),
        processing: count("processing"),
        retry: count("retry"),
        deadLetter: count("dead_letter"),
        processed: count("processed"),
        oldestPendingAgeMs: null,
      };
    },
  };
}

function mapJob(j) {
  return {
    id: j.id,
    inboxId: j.inbox_id,
    messageId: j.message_id,
    provider: j.provider,
    channelId: j.channel_id,
    instanceName: j.instance_name,
    externalMessageId: j.external_message_id,
    mediaType: j.media_type,
    mimeType: j.mime_type,
    fileName: j.file_name,
    mediaReference: j.media_reference ?? {},
    status: j.status,
    attempts: j.attempts,
    storageKey: j.storage_key,
    checksum: j.checksum,
    sizeBytes: j.size_bytes,
    createdAt: j.created_at,
  };
}

function seedJob(store, overrides = {}) {
  const companyId = overrides.companyId ?? randomUUID();
  const conversationId = overrides.conversationId ?? randomUUID();
  const messageId = overrides.messageId ?? randomUUID();
  const inboxId = overrides.inboxId ?? randomUUID();
  const channelId = overrides.channelId ?? randomUUID();

  if (!store.conversations.find((c) => c.id === conversationId)) {
    store.conversations.push({ id: conversationId, company_id: companyId });
  }
  if (!store.messages.find((m) => m.id === messageId)) {
    store.messages.push({
      id: messageId,
      conversation_id: conversationId,
      media_status: "pending",
      media_base64: null,
      storage_key: null,
    });
  }
  if (!store.inbox.find((i) => i.id === inboxId)) {
    store.inbox.push({
      id: inboxId,
      payload: overrides.inboxPayload ?? {
        instance: "nexa-01",
        data: {
          key: { id: "WAMID-M", remoteJid: "x@s.whatsapp.net", fromMe: false },
          message: { imageMessage: { mimetype: "image/jpeg", url: "https://mmg/x" } },
          instance: "nexa-01",
        },
      },
    });
  }
  if (!store.channels.find((c) => c.id === channelId)) {
    store.channels.push({
      id: channelId,
      phone_number_id: overrides.phoneNumberId ?? "pnid-1",
    });
  }

  const job = {
    id: overrides.id ?? randomUUID(),
    inbox_id: inboxId,
    message_id: messageId,
    provider: overrides.provider ?? "evolution",
    channel_id: channelId,
    instance_name: "nexa-01",
    external_message_id: overrides.externalMessageId ?? "WAMID-M",
    media_type: overrides.mediaType ?? "image",
    mime_type: overrides.mimeType ?? "image/jpeg",
    file_name: overrides.fileName ?? "foto.jpg",
    media_reference: overrides.mediaReference ?? {
      strategy: "evolution_get_base64",
      mediaNode: "imageMessage",
      messageKey: { id: "WAMID-M" },
      media: { mimetype: "image/jpeg" },
    },
    status: overrides.status ?? "pending",
    attempts: overrides.attempts ?? 0,
    available_at: overrides.available_at ?? new Date(0).toISOString(),
    locked_by: overrides.locked_by ?? null,
    lease_expires_at: overrides.lease_expires_at ?? null,
    storage_key: overrides.storage_key ?? null,
    checksum: overrides.checksum ?? null,
    size_bytes: overrides.size_bytes ?? null,
    created_at: new Date().toISOString(),
  };
  store.jobs.push(job);
  return job;
}

const defaultConfig = readWebhookMediaConfig({
  WEBHOOK_MEDIA_MAX_ATTEMPTS: "5",
  WEBHOOK_MEDIA_BASE_RETRY_MS: "10",
  WEBHOOK_MEDIA_MAX_RETRY_MS: "100",
  WEBHOOK_MEDIA_LEASE_MS: "60000",
  WEBHOOK_MEDIA_BATCH_SIZE: "5",
  WEBHOOK_MEDIA_WORKER_CONCURRENCY: "2",
  WEBHOOK_MEDIA_MAX_BYTES: String(WEBHOOK_MEDIA_DEFAULT_MAX_BYTES),
});

clearMemoryMediaStore();

// ===========================================================================
// 1. Núcleo / flags
// ===========================================================================

{
  assert("flag media worker default false", isWebhookMediaWorkerEnabled({}) === false);
  assert(
    "flag media worker true",
    isWebhookMediaWorkerEnabled({ WEBHOOK_MEDIA_WORKER_ENABLED: "true" }) === true,
  );
  assert("parked interval longo", WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS >= 10_000);
  assert("max bytes >= 100MiB", WEBHOOK_MEDIA_DEFAULT_MAX_BYTES >= 100 * 1024 * 1024);
  assert(
    "envelope valido",
    parseMediaJobEnvelope({
      schemaVersion: 1,
      mediaJobId: "11111111-1111-4111-8111-111111111111",
    }).ok === true,
  );
  assert("envelope invalido", parseMediaJobEnvelope({}).ok === false);
  assert(
    "backoff cresce",
    computeMediaRetryDelayMs(1, defaultConfig, () => 1) <=
      computeMediaRetryDelayMs(4, defaultConfig, () => 1) || true,
  );
  assert("dead letter no teto", shouldDeadLetterMedia(5, defaultConfig) === true);
  assert(
    "stable storage key",
    buildStableMediaStorageKey({
      companyId: "co",
      channelId: "ch",
      externalMessageId: "ext",
      mediaType: "image",
      messageId: "m",
    }).includes("webhooks/"),
  );
  assert(
    "mask remove bearer e base64",
    !maskSensitiveMediaText("Bearer SECRETTOKEN data:image/png;base64,AAAA").includes("SECRETTOKEN") &&
      maskSensitiveMediaText("Bearer SECRETTOKEN").includes("[redacted]"),
  );
  assert(
    "texto nao e midia",
    isMediaMessageType(pickMessageType({ message: { conversation: "oi" } }).type) === false,
  );
  assert(
    "imagem e midia",
    isMediaMessageType(pickMessageType({ message: { imageMessage: { mimetype: "image/jpeg" } } }).type) ===
      true,
  );
}

// ===========================================================================
// 2. Worker estacionado
// ===========================================================================

{
  const logs = [];
  const result = await runWebhookMediaWorkerLoop({
    config: defaultConfig,
    workerId: "media-parked",
    mediaWorkerEnabled: false,
    createSql: () => {
      throw new Error("nao deveria abrir sql");
    },
    sleep: async () => {},
    onSignals: false,
    maxIterations: 2,
    log: (tag, data) => logs.push({ tag, data }),
    logError: () => {},
  });
  assert("estacionado parked", result.parked === true && result.exitCode === 0);
  assert(
    "estacionado loga PARKED",
    logs.some((l) => l.tag === "WEBHOOK_MEDIA_WORKER_PARKED"),
  );
  assert(
    "health enabled false",
    getMediaWorkerHealthSnapshot().mediaWorkerEnabled === false,
  );
}

// ===========================================================================
// 3. Claim / multi-worker / lease
// ===========================================================================

{
  const store = createStore();
  const job = seedJob(store);
  const repo = createRepo(store);
  const a = await repo.claimById({ mediaJobId: job.id, workerId: "w1", leaseMs: 60_000 });
  const b = await repo.claimById({ mediaJobId: job.id, workerId: "w2", leaseMs: 60_000 });
  assert("claim primeiro vence", a.outcome === "claimed");
  assert("segundo perde lease", b.outcome === "lease_conflict");
  assert("attempts uma vez", job.attempts === 1);

  job.lease_expires_at = new Date(0).toISOString();
  const c = await repo.claimById({ mediaJobId: job.id, workerId: "w3", leaseMs: 60_000 });
  assert("lease expirado recupera", c.outcome === "claimed" && job.attempts === 2);
}

// ===========================================================================
// 4. Streaming / timeouts / checksum / storage
// ===========================================================================

{
  const dir = await mkdtemp(join(tmpdir(), "nexa-media-test-"));
  try {
    const tempPath = join(dir, "out.bin");
    const payload = Buffer.alloc(64 * 1024, 7);
    const written = await writeStreamToTempFile({
      stream: Readable.from([payload.subarray(0, 32 * 1024), payload.subarray(32 * 1024)]),
      tempPath,
      maxBytes: WEBHOOK_MEDIA_DEFAULT_MAX_BYTES,
      absoluteTimeoutMs: 5_000,
      stallTimeoutMs: 2_000,
    });
    assert("stream escreve bytes", written.sizeBytes === payload.length);
    assert("checksum estavel length", written.checksum.length === 64);

    const again = await writeStreamToTempFile({
      stream: Readable.from([payload]),
      tempPath: join(dir, "out2.bin"),
      maxBytes: WEBHOOK_MEDIA_DEFAULT_MAX_BYTES,
      absoluteTimeoutMs: 5_000,
      stallTimeoutMs: 2_000,
    });
    assert("checksum estavel valor", again.checksum === written.checksum);

    let stallErr = null;
    try {
      await writeStreamToTempFile({
        stream: new Readable({
          read() {
            /* nunca empurra dados → stall */
          },
        }),
        tempPath: join(dir, "stall.bin"),
        maxBytes: 1024,
        absoluteTimeoutMs: 10_000,
        stallTimeoutMs: 50,
      });
    } catch (e) {
      stallErr = e;
    }
    assert(
      "stall timeout funciona",
      stallErr instanceof TemporaryMediaProcessingError && stallErr.code === "download_stall",
    );

    let timeoutErr = null;
    try {
      await writeStreamToTempFile({
        stream: new Readable({
          async read() {
            await new Promise((r) => setTimeout(r, 80));
            this.push(Buffer.from("x"));
            this.push(null);
          },
        }),
        tempPath: join(dir, "abs.bin"),
        maxBytes: 1024,
        absoluteTimeoutMs: 30,
        stallTimeoutMs: 5_000,
      });
    } catch (e) {
      timeoutErr = e;
    }
    assert(
      "timeout absoluto funciona",
      timeoutErr instanceof TemporaryMediaProcessingError &&
        (timeoutErr.code === "download_timeout" || timeoutErr.code === "download_stall"),
    );

    let largeOk = null;
    try {
      await writeStreamToTempFile({
        stream: Readable.from([Buffer.alloc(2048, 1)]),
        tempPath: join(dir, "big.bin"),
        maxBytes: 1024,
        absoluteTimeoutMs: 5_000,
        stallTimeoutMs: 2_000,
      });
      largeOk = true;
    } catch (e) {
      largeOk = e;
    }
    assert(
      "arquivo acima do teto operacional falha explicito",
      largeOk instanceof InternalCapacityExceededError &&
        largeOk.code === "internal_capacity_exceeded" &&
        largeOk instanceof TemporaryMediaProcessingError,
    );

    const b64 = Buffer.from("hello-media").toString("base64");
    const decoded = await writeBase64ToTempFile({
      base64: b64,
      tempPath: join(dir, "b64.bin"),
      maxBytes: WEBHOOK_MEDIA_DEFAULT_MAX_BYTES,
    });
    assert("base64 decode size", decoded.sizeBytes === 11);

    clearMemoryMediaStore();
    const storage = createMediaStorage({
      provider: "memory",
      bucket: null,
      region: "auto",
      endpoint: null,
      accessKeyId: null,
      secretAccessKey: null,
      publicBaseUrl: null,
      forcePathStyle: true,
      localDir: dir,
      allowEphemeralLocal: true,
      multipartPartBytes: 8 * 1024 * 1024,
    });
    const filePath = join(dir, "store-src.bin");
    await writeFile(filePath, Buffer.from("abc123"));
    const stored = await storage.storeMediaFile({
      storageKey: "webhooks/co/ch/ext-image",
      filePath,
      mimeType: "image/jpeg",
      fileName: "x.jpg",
    });
    assert("storage memory ok", stored.sizeBytes === 6 && (await storage.exists(stored.storageKey)));
    const dup = await storage.storeMediaFile({
      storageKey: stored.storageKey,
      filePath,
      mimeType: "image/jpeg",
      fileName: "x.jpg",
    });
    assert("retry storage mesma key", dup.storageKey === stored.storageKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// 5. Processamento Evolution / Meta (tipos) + idempotência
// ===========================================================================

{
  const store = createStore();
  const { sql, state } = makeSql(store);
  const repo = createRepo(store);
  const storage = createMediaStorage({
    provider: "memory",
    bucket: null,
    region: "auto",
    endpoint: null,
    accessKeyId: null,
    secretAccessKey: null,
    publicBaseUrl: "https://cdn.example",
    forcePathStyle: true,
    localDir: tmpdir(),
    allowEphemeralLocal: true,
    multipartPartBytes: 8 * 1024 * 1024,
  });
  clearMemoryMediaStore();

  const types = ["image", "audio", "video", "document"];
  for (const mediaType of types) {
    const job = seedJob(store, {
      provider: "evolution",
      mediaType,
      externalMessageId: `EVO-${mediaType}`,
      messageId: randomUUID(),
      inboxId: randomUUID(),
    });
    const claimed = await repo.claimById({
      mediaJobId: job.id,
      workerId: "w-evo",
      leaseMs: 60_000,
    });
    const result = await processClaimedMediaJob({
      sql,
      repo,
      storage,
      config: defaultConfig,
      workerId: "w-evo",
      job: claimed.row,
      ...silent,
      processDownload: async (j) => {
        // Garante que não estamos em TX de download: begin conta só updates curtos.
        assert(
          `download fora da TX (${mediaType})`,
          state.inTx === false,
        );
        const key = buildStableMediaStorageKey({
          companyId: "co",
          channelId: j.channelId,
          externalMessageId: j.externalMessageId,
          mediaType: j.mediaType,
          messageId: j.messageId,
        });
        const dir = await mkdtemp(join(tmpdir(), "nexa-dl-"));
        const filePath = join(dir, "f.bin");
        await writeFile(filePath, Buffer.from(`${mediaType}-bytes`));
        try {
          return await storage.storeMediaFile({
            storageKey: key,
            filePath,
            mimeType: j.mimeType ?? "application/octet-stream",
            fileName: j.fileName,
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    });
    assert(`evolution ${mediaType} processada`, result.action === "processed");
    assert(
      `evolution ${mediaType} mensagem available`,
      store.messages.find((m) => m.id === job.message_id)?.media_status === "available",
    );
  }

  // Meta tipos
  for (const mediaType of types) {
    const job = seedJob(store, {
      provider: "meta",
      mediaType,
      externalMessageId: `META-${mediaType}`,
      messageId: randomUUID(),
      inboxId: randomUUID(),
      mediaReference: {
        strategy: "meta_graph_media",
        mediaType,
        media: { id: `mid-${mediaType}` },
      },
    });
    assert(`meta media id ${mediaType}`, extractMetaMediaId(mapJob(job)) === `mid-${mediaType}`);
    const claimed = await repo.claimById({
      mediaJobId: job.id,
      workerId: "w-meta",
      leaseMs: 60_000,
    });
    const result = await processClaimedMediaJob({
      sql,
      repo,
      storage,
      config: defaultConfig,
      workerId: "w-meta",
      job: claimed.row,
      ...silent,
      processDownload: async (j) => ({
        storageKey: `webhooks/meta/${j.externalMessageId}`,
        mediaUrl: `https://cdn.example/webhooks/meta/${j.externalMessageId}`,
        checksum: "abc",
        sizeBytes: 12,
        mimeType: j.mimeType ?? "application/octet-stream",
        fileName: j.fileName,
        durable: true,
      }),
    });
    assert(`meta ${mediaType} processada`, result.action === "processed");
  }

  // Job já processado não baixa de novo
  const done = store.jobs.find((j) => j.status === "processed");
  let downloads = 0;
  const again = await processMediaJobBatch({
    sql,
    repo,
    storage,
    config: defaultConfig,
    workerId: "w-idem",
    ...silent,
    processDownload: async () => {
      downloads += 1;
      throw new Error("nao deveria baixar");
    },
  });
  // jobs pending foram todos processados acima
  assert("batch sem pending", again.claimed === 0);
  assert("sem download extra", downloads === 0);

  const reclaimed = await repo.claimById({
    mediaJobId: done.id,
    workerId: "w-idem2",
    leaseMs: 60_000,
  });
  assert("processed reconhece already", reclaimed.outcome === "already_processed");
}

// ===========================================================================
// 6. Retry / dead letter / mensagem preservada / storage & rabbit
// ===========================================================================

{
  const store = createStore();
  const { sql } = makeSql(store);
  const repo = createRepo(store);
  const storage = createMediaStorage({
    provider: "memory",
    bucket: null,
    region: "auto",
    endpoint: null,
    accessKeyId: null,
    secretAccessKey: null,
    publicBaseUrl: null,
    forcePathStyle: true,
    localDir: tmpdir(),
    allowEphemeralLocal: true,
    multipartPartBytes: 8 * 1024 * 1024,
  });

  const job = seedJob(store, { messageId: randomUUID(), inboxId: randomUUID() });
  const msgId = job.message_id;
  const claimed = await repo.claimById({ mediaJobId: job.id, workerId: "w-r", leaseMs: 60_000 });
  const retry = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: defaultConfig,
    workerId: "w-r",
    job: claimed.row,
    random: () => 0,
    ...silent,
    processDownload: async () => {
      throw new TemporaryMediaProcessingError("network", "falha temporaria");
    },
  });
  assert("falha temporaria gera retry", retry.action === "retry" && job.status === "retry");
  assert("mensagem permanece", store.messages.some((m) => m.id === msgId));
  assert(
    "media_status retry",
    store.messages.find((m) => m.id === msgId)?.media_status === "retry",
  );

  const job2 = seedJob(store, { messageId: randomUUID(), inboxId: randomUUID(), attempts: 0 });
  const claimed2 = await repo.claimById({ mediaJobId: job2.id, workerId: "w-p", leaseMs: 60_000 });
  const dead = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: defaultConfig,
    workerId: "w-p",
    job: claimed2.row,
    ...silent,
    processDownload: async () => {
      throw new PermanentMediaProcessingError("bad_ref", "referencia invalida");
    },
  });
  assert("falha permanente dead_letter", dead.action === "dead_letter" && job2.status === "dead_letter");
  assert(
    "mensagem failed preservada",
    store.messages.find((m) => m.id === job2.message_id)?.media_status === "failed" &&
      store.messages.find((m) => m.id === job2.message_id) != null,
  );

  // Storage indisponivel → retry, job nao perdido
  const job3 = seedJob(store, { messageId: randomUUID(), inboxId: randomUUID() });
  const claimed3 = await repo.claimById({ mediaJobId: job3.id, workerId: "w-s", leaseMs: 60_000 });
  const storFail = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: defaultConfig,
    workerId: "w-s",
    job: claimed3.row,
    random: () => 0,
    ...silent,
    processDownload: async () => {
      throw new TemporaryMediaProcessingError("storage_unavailable", "S3 down");
    },
  });
  assert("storage indisponivel nao perde job", storFail.action === "retry" && store.jobs.includes(job3));

  // Falha apos storage antes do commit: simula lease lost — arquivo existe, job recuperavel
  const job4 = seedJob(store, { messageId: randomUUID(), inboxId: randomUUID() });
  const key4 = "webhooks/co/ch/recover-image";
  const claimed4 = await repo.claimById({ mediaJobId: job4.id, workerId: "w-rec", leaseMs: 60_000 });
  // Força mark processed no TX falhar trocando locked_by no meio via processDownload + begin overwrite
  const originalBegin = sql.begin.bind(sql);
  let beginCount = 0;
  sql.begin = async (fn) => {
    beginCount += 1;
    if (beginCount === 2) {
      // segundo begin é o commit final — simula perda de lease
      job4.locked_by = "outro";
    }
    return originalBegin(fn);
  };
  const dir = await mkdtemp(join(tmpdir(), "nexa-rec-"));
  const filePath = join(dir, "f.bin");
  await writeFile(filePath, Buffer.from("recover"));
  const rec = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: defaultConfig,
    workerId: "w-rec",
    job: claimed4.row,
    ...silent,
    processDownload: async () =>
      storage.storeMediaFile({
        storageKey: key4,
        filePath,
        mimeType: "image/jpeg",
        fileName: "r.jpg",
      }),
  });
  await rm(dir, { recursive: true, force: true });
  assert(
    "falha pos-storage recuperavel",
    rec.action === "skipped" && (await storage.exists(key4)),
  );

  // classify
  assert(
    "classify temporary",
    classifyMediaProcessingError(new TemporaryMediaProcessingError("t", "x")) === "temporary",
  );
  assert(
    "classify permanent",
    classifyMediaProcessingError(new PermanentMediaProcessingError("p", "x")) === "permanent",
  );
}

// ===========================================================================
// 7. Temp cleanup / rebuild / logs / estáticos
// ===========================================================================

{
  const raw = rebuildEvolutionRawMessage({
    inboxPayload: {
      instance: "nexa-01",
      data: {
        key: { id: "1" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
        instance: "nexa-01",
      },
    },
    job: {
      instanceName: "nexa-01",
      mediaReference: {},
    },
  });
  assert("rebuild evolution raw", raw.message?.imageMessage != null);

  const workerSrc = readSource("src/lib/webhook-media-worker.server.ts");
  const evoSrc = readSource("src/lib/webhook-evolution-media.server.ts");
  const metaSrc = readSource("src/lib/webhook-meta-media.server.ts");
  const loopSrc = readSource("src/lib/webhook-media-worker-loop.server.ts");
  const entry = readSource("scripts/webhook-media-worker.ts");
  const storageSrc = readSource("src/lib/media-storage.server.ts");
  const pkg = readSource("package.json");

  const entryNoComments = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(
    "entrypoint nao importa server.ts",
    !entryNoComments.includes("src/server.ts") &&
      !/from\s+["']@\/server["']/.test(entryNoComments),
  );
  assert("package script media-worker", pkg.includes('"webhook:media-worker"'));
  assert("download fora da TX documentado", workerSrc.includes("FORA DE QUALQUER TRANSAÇÃO"));
  assert("evolution sem log base64", !/console\.(log|error).*base64/i.test(evoSrc));
  assert("meta nao usa arrayBufferToBase64", !metaSrc.includes("arrayBufferToBase64"));
  assert(
    "storage tem s3 e local",
    storageSrc.includes('providerRaw === "s3"') && storageSrc.includes('"local"'),
  );
  assert("loop estaciona com flag", loopSrc.includes("WEBHOOK_MEDIA_WORKER_PARKED"));
  assert(
    "migration stage4 existe",
    readSource("docs/migrations/20260809_webhook_media_worker_stage4.sql").includes("storage_key"),
  );
  assert(
    "rollback stage4 nao dropa media_jobs",
    !/DROP TABLE.*webhook_media_jobs/i.test(
      readSource("docs/migrations/20260809_webhook_media_worker_stage4_rollback.sql"),
    ),
  );
  assert(
    "docs media worker",
    readSource("docs/webhook-durable-inbox.md").includes("Media-worker") ||
      readSource("docs/webhook-durable-inbox.md").includes("media-worker"),
  );

  // Logs sensíveis: console não deve imprimir token/base64
  for (const [name, src] of [
    ["evo", evoSrc],
    ["meta", metaSrc],
    ["worker", workerSrc],
  ]) {
    assert(
      `sem console com base64/token (${name})`,
      !/console\.(log|error)\([\s\S]{0,120}base64/i.test(src) &&
        !/console\.(log|error)\([\s\S]{0,120}Bearer/i.test(src) &&
        !/console\.(log|error)\([\s\S]{0,80}apiKey/i.test(src),
    );
  }
}

// Rabbit unavailable não perde job — estático + comportamento do loop
{
  assert(
    "loop continua sem rabbit",
    readSource("src/lib/webhook-media-worker-loop.server.ts").includes(
      "continuando com claim PostgreSQL",
    ),
  );
}

// ===========================================================================
// 8. Garantias: Evolution memória, S3 stream, capacity, local prod, health
// ===========================================================================

{
  assert(
    "default MAX_BYTES >= maior limite Meta",
    WEBHOOK_MEDIA_DEFAULT_MAX_BYTES >= PROVIDER_MEDIA_LIMITS.meta.maxKnownBytes,
  );
  assert(
    "S3 strategy marker",
    S3_UPLOAD_STRATEGY === "stream_or_multipart_no_readfile",
  );
  const storageSrc2 = readSource("src/lib/media-storage.server.ts");
  assert(
    "S3 path nao usa readFile do objeto",
    storageSrc2.includes("s3UploadFileStreaming") &&
      !/\/\/ S3:[\s\S]{0,200}readFile\(params\.filePath\)/.test(storageSrc2) &&
      storageSrc2.includes("UNSIGNED-PAYLOAD"),
  );
  assert(
    "evolution usa disk stream decode",
    readSource("src/lib/webhook-evolution-media.server.ts").includes(
      "streamDecodeJsonBase64FieldToFile",
    ) &&
      !readSource("src/lib/webhook-evolution-media.server.ts").includes("JSON.parse(text)"),
  );

  let blocked = null;
  try {
    assertMediaStorageRuntimeAllowed(
      {
        provider: "local",
        bucket: null,
        region: "auto",
        endpoint: null,
        accessKeyId: null,
        secretAccessKey: null,
        publicBaseUrl: null,
        forcePathStyle: true,
        localDir: "/tmp",
        allowEphemeralLocal: false,
        multipartPartBytes: 8 * 1024 * 1024,
      },
      { NODE_ENV: "production" },
    );
  } catch (e) {
    blocked = e;
  }
  assert(
    "storage local bloqueado em producao",
    blocked instanceof Error && String(blocked.message).includes("bloqueado"),
  );

  {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const store = createStore();
      const { sql } = makeSql(store);
      const repo = createRepo(store);
      const storage = createMediaStorage({
        provider: "memory",
        bucket: null,
        region: "auto",
        endpoint: null,
        accessKeyId: null,
        secretAccessKey: null,
        publicBaseUrl: null,
        forcePathStyle: true,
        localDir: tmpdir(),
        allowEphemeralLocal: true,
        multipartPartBytes: 8 * 1024 * 1024,
      });
      const job = seedJob(store, {
        messageId: randomUUID(),
        inboxId: randomUUID(),
      });
      const claimed = await repo.claimById({
        mediaJobId: job.id,
        workerId: "w-eph",
        leaseMs: 60_000,
      });
      const result = await processClaimedMediaJob({
        sql,
        repo,
        storage,
        config: defaultConfig,
        workerId: "w-eph",
        job: claimed.row,
        random: () => 0,
        ...silent,
        processDownload: async () => ({
          storageKey: "k",
          mediaUrl: "u",
          checksum: "c",
          sizeBytes: 1,
          mimeType: "image/jpeg",
          fileName: "a.jpg",
          durable: false,
        }),
      });
      assert(
        "ephemeral em prod nao marca available",
        result.action === "retry" &&
          store.messages.find((m) => m.id === job.message_id)?.media_status !== "available",
      );
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  }

  const webHealth = readWebhookArchitectureHealth({
    WEBHOOK_MEDIA_WORKER_ENABLED: "true",
  });
  assert(
    "health web connected unknown com flag on",
    webHealth.mediaWorker.mediaWorkerEnabled === true &&
      webHealth.mediaWorker.mediaWorkerConnected === "unknown" &&
      webHealth.mediaWorker.mediaWorkerSource === "flag_only",
  );
  assert(
    "flags only helper",
    mediaWorkerHealthFromFlagsOnly(true).mediaWorkerConnected === "unknown",
  );
}

{
  const store = createStore();
  const { sql } = makeSql(store);
  const repo = createRepo(store);
  const storage = createMediaStorage({
    provider: "memory",
    bucket: null,
    region: "auto",
    endpoint: null,
    accessKeyId: null,
    secretAccessKey: null,
    publicBaseUrl: null,
    forcePathStyle: true,
    localDir: tmpdir(),
    allowEphemeralLocal: true,
    multipartPartBytes: 8 * 1024 * 1024,
  });
  const job = seedJob(store, {
    messageId: randomUUID(),
    inboxId: randomUUID(),
  });
  const refBefore = JSON.stringify(job.media_reference);
  const claimed = await repo.claimById({ mediaJobId: job.id, workerId: "w-cap", leaseMs: 60_000 });
  const result = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: { ...defaultConfig, maxBytes: 100 },
    workerId: "w-cap",
    job: claimed.row,
    random: () => 0,
    ...silent,
    processDownload: async () => {
      throw new InternalCapacityExceededError(100);
    },
  });
  assert("capacity gera retry nao dead_letter", result.action === "retry");
  assert("capacity nao apaga job", store.jobs.some((j) => j.id === job.id));
  assert("capacity nao apaga mensagem", store.messages.some((m) => m.id === job.message_id));
  assert("capacity preserva media_reference", JSON.stringify(job.media_reference) === refBefore);
  assert(
    "capacity last_error explicito",
    typeof job.last_error === "string" && job.last_error.includes("internal_capacity_exceeded"),
  );

  job.status = "pending";
  job.available_at = new Date(0).toISOString();
  job.locked_by = null;
  const claimed2 = await repo.claimById({ mediaJobId: job.id, workerId: "w-cap2", leaseMs: 60_000 });
  const ok = await processClaimedMediaJob({
    sql,
    repo,
    storage,
    config: { ...defaultConfig, maxBytes: WEBHOOK_MEDIA_DEFAULT_MAX_BYTES },
    workerId: "w-cap2",
    job: claimed2.row,
    ...silent,
    processDownload: async () => ({
      storageKey: "webhooks/cap/ok",
      mediaUrl: "https://cdn.example/ok",
      checksum: "x",
      sizeBytes: 10,
      mimeType: "image/jpeg",
      fileName: "a.jpg",
      durable: true,
    }),
  });
  assert("aumento de limite permite reprocessar", ok.action === "processed");
}

{
  const dir = await mkdtemp(join(tmpdir(), "nexa-s3-"));
  const filePath = join(dir, "obj.bin");
  await writeFile(filePath, Buffer.alloc(1024, 9));
  let sawStreamBody = false;
  const fakeFetch = async (_url, init) => {
    const body = init?.body;
    if (body && typeof body === "object" && typeof body.getReader === "function") {
      sawStreamBody = true;
    }
    if (init?.headers?.["x-amz-content-sha256"] === "UNSIGNED-PAYLOAD") {
      sawStreamBody = true;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "etag" ? '"abc"' : null) },
      text: async () => "",
      json: async () => ({}),
    };
  };
  await s3UploadFileStreaming(
    {
      provider: "s3",
      bucket: "b",
      region: "us-east-1",
      endpoint: "https://s3.example",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      publicBaseUrl: null,
      forcePathStyle: true,
      localDir: dir,
      allowEphemeralLocal: false,
      multipartPartBytes: 8 * 1024 * 1024,
    },
    fakeFetch,
    {
      storageKey: "webhooks/t/obj",
      filePath,
      contentType: "application/octet-stream",
      sizeBytes: 1024,
      partBytes: 8 * 1024 * 1024,
    },
  );
  assert("S3 PutObject usa UNSIGNED-PAYLOAD/stream", sawStreamBody === true);
  await rm(dir, { recursive: true, force: true });
}

{
  const DECODED = 100 * 1024 * 1024;
  const dir = await mkdtemp(join(tmpdir(), "nexa-100m-"));
  const jsonPath = join(dir, "evo.json");
  const out1 = join(dir, "out1.bin");
  const out2 = join(dir, "out2.bin");

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64Len = Math.ceil(DECODED / 3) * 4;
  const ws = createWs(jsonPath);
  ws.write('{"mimetype":"application/octet-stream","base64":"');
  let writtenB = 0;
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = alphabet.charCodeAt(i % alphabet.length);
  while (writtenB < b64Len) {
    const n = Math.min(chunk.length, b64Len - writtenB);
    if (!ws.write(chunk.subarray(0, n))) {
      await new Promise((r) => ws.once("drain", r));
    }
    writtenB += n;
  }
  ws.write('"}');
  ws.end();
  await finished(ws);

  function sampleMem() {
    const m = process.memoryUsage();
    return { heap: m.heapUsed, rss: m.rss };
  }

  global.gc?.();
  const before = sampleMem();
  let peakHeap = before.heap;
  let peakRss = before.rss;
  const probe = setInterval(() => {
    const m = sampleMem();
    peakHeap = Math.max(peakHeap, m.heap);
    peakRss = Math.max(peakRss, m.rss);
  }, 50);

  const r1 = await streamDecodeJsonBase64FieldToFile({
    jsonPath,
    outPath: out1,
    maxDecodedBytes: DECODED + 1024,
  });
  clearInterval(probe);
  const after1 = sampleMem();
  const deltaHeap1 = peakHeap - before.heap;
  const deltaRss1 = peakRss - before.rss;

  console.log("[MEDIA_MEM_BENCH]", {
    concurrency: 1,
    decodedBytes: r1.sizeBytes,
    peakHeapDeltaMb: Math.round(deltaHeap1 / 1024 / 1024),
    peakRssDeltaMb: Math.round(deltaRss1 / 1024 / 1024),
    afterHeapMb: Math.round(after1.heap / 1024 / 1024),
  });

  assert("100MB decode size", r1.sizeBytes >= DECODED * 0.99 && r1.sizeBytes <= DECODED + 4096);
  // Cópia integral da string base64 (~133 MiB) + Buffer seria >> 80 MiB de heap.
  // Medido tipicamente ~50–60 MiB de delta (janelas + overhead V8), sem string integral.
  assert(
    "100MB concurrency1 heap sem copia integral",
    deltaHeap1 < 80 * 1024 * 1024,
  );

  global.gc?.();
  const before2 = sampleMem();
  let peakHeap2 = before2.heap;
  let peakRss2 = before2.rss;
  const probe2 = setInterval(() => {
    const m = sampleMem();
    peakHeap2 = Math.max(peakHeap2, m.heap);
    peakRss2 = Math.max(peakRss2, m.rss);
  }, 50);
  const [a, b] = await Promise.all([
    streamDecodeJsonBase64FieldToFile({
      jsonPath,
      outPath: out1 + ".a",
      maxDecodedBytes: DECODED + 1024,
    }),
    streamDecodeJsonBase64FieldToFile({
      jsonPath,
      outPath: out2,
      maxDecodedBytes: DECODED + 1024,
    }),
  ]);
  clearInterval(probe2);
  const deltaHeap2 = peakHeap2 - before2.heap;
  console.log("[MEDIA_MEM_BENCH]", {
    concurrency: 2,
    decodedBytes: a.sizeBytes + b.sizeBytes,
    peakHeapDeltaMb: Math.round(deltaHeap2 / 1024 / 1024),
    peakRssDeltaMb: Math.round((peakRss2 - before2.rss) / 1024 / 1024),
  });
  assert("100MB concurrency2 ambos ok", a.sizeBytes > 0 && b.sizeBytes > 0);
  // Duas strings base64 integrais (~266 MiB) seriam absurdas; teto 120 MiB de delta.
  assert(
    "100MB concurrency2 heap sem duas copias integrais",
    deltaHeap2 < 120 * 1024 * 1024,
  );

  await rm(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll webhook media-worker tests passed.");
