/**
 * Testes da ETAPA 3: message-worker idempotente (Evolution + Meta).
 *
 * Nenhum teste exige RabbitMQ ou PostgreSQL reais. O banco e o broker são
 * fakes em memória. O teste de integração opcional fica em
 * test-webhook-message-worker-integration.mjs.
 *
 *   npx tsx scripts/test-webhook-message-worker.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  classifyProcessingError,
  computeMessageRetryDelayMs,
  computeQueueLagMs,
  conversationAdvisoryLockKey,
  detectWebhookConfigIssues,
  isLegacyProcessingActive,
  isWebhookLegacyProcessingEnabled,
  isWebhookOutboxPublisherEnabled,
  isWebhookRabbitProcessingEnabled,
  parseInboxEnvelope,
  PermanentWebhookProcessingError,
  readWebhookMessageConfig,
  shouldDeadLetterMessage,
  TemporaryWebhookProcessingError,
  WEBHOOK_MESSAGE_DEFAULT_LEASE_MS,
  WEBHOOK_MESSAGE_DEFAULT_MAX_ATTEMPTS,
  WEBHOOK_MESSAGE_DEFAULT_PREFETCH,
  WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS,
} from "../src/lib/webhook-message-core.ts";
import { markInboxProcessedTx } from "../src/lib/webhook-inbox-claim.server.ts";
import {
  buildEvolutionMediaReference,
  buildMetaMediaReference,
  ensureMediaJob,
} from "../src/lib/webhook-media-jobs.server.ts";
import {
  processEvolutionInboxEvent,
  processEvolutionMessageNode,
} from "../src/lib/webhook-evolution-processing.server.ts";
import { processInboxMessage } from "../src/lib/webhook-message-worker.server.ts";
import { runWebhookMessageWorkerLoop } from "../src/lib/webhook-message-worker-loop.server.ts";
import { getMessageWorkerHealthSnapshot } from "../src/lib/webhook-message-health.ts";
import { OUTBOX_MESSAGE_SCHEMA_VERSION } from "../src/lib/webhook-outbox-core.ts";
import { processMetaInboxEvent } from "../src/lib/webhook-meta-processing.server.ts";
import {
  nextMessageStatus,
  processMetaStatusUpdates,
} from "../src/lib/webhook-meta-status.server.ts";
import { processInboxRetryBatch } from "../src/lib/webhook-inbox-retry.server.ts";

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
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Fake de domínio (inbox + CRM + media jobs)
// ---------------------------------------------------------------------------

function createDomainStore() {
  return {
    channels: [],
    contacts: [],
    conversations: [],
    messages: [],
    mediaJobs: [],
    campaignJobs: [],
    inbox: [],
    locks: new Set(),
  };
}

function makeDomainSql(store) {
  const state = { queries: [], begins: 0, commits: 0, rollbacks: 0, httpCalls: 0 };

  const run = async (strings, values) => {
    const text = strings.join("|");
    state.queries.push(text);

    if (text.includes("pg_advisory_xact_lock")) {
      const key = String(values[0]);
      store.locks.add(key);
      return [{ pg_advisory_xact_lock: true }];
    }

    if (text.includes("FROM public.whatsapp_channels") && text.includes("evolution")) {
      const instance = values[0];
      const found = store.channels.find(
        (c) => c.evolution_instance_name === instance && c.channel_type === "evolution",
      );
      return found
        ? [
            {
              id: found.id,
              company_id: found.company_id,
              evolution_instance_name: found.evolution_instance_name,
              name: found.name,
            },
          ]
        : [];
    }

    if (text.includes("FROM public.whatsapp_channels") && text.includes("meta")) {
      const phoneNumberId = values[0];
      const found = store.channels.find(
        (c) => c.phone_number_id === phoneNumberId && c.channel_type === "meta",
      );
      if (!found || !found.company_id) return [];
      return [
        {
          id: found.id,
          company_id: found.company_id,
          phone_number_id: found.phone_number_id,
        },
      ];
    }

    if (text.includes("UPDATE public.whatsapp_channels") && text.includes("last_webhook_at")) {
      return [];
    }

    if (text.includes("UPDATE public.whatsapp_channels") && text.includes("status")) {
      return [];
    }

    if (text.includes("FROM public.contacts") && text.includes("phone_match")) {
      const [companyId, phoneMatch] = values;
      const found = store.contacts
        .filter((c) => c.company_id === companyId && c.phone_match === phoneMatch)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return found.slice(0, 1).map((c) => ({
        id: c.id,
        name: c.name,
        name_source: c.name_source,
        status: c.status,
      }));
    }

    if (text.includes("INSERT INTO public.contacts")) {
      const [companyId, phone, phoneMatch, name, nameSource, externalJid] = values;
      const exists = store.contacts.find(
        (c) => c.company_id === companyId && c.phone_match === phoneMatch,
      );
      if (exists) {
        const err = new Error("duplicate key");
        err.code = "23505";
        throw err;
      }
      const row = {
        id: randomUUID(),
        company_id: companyId,
        phone,
        phone_match: phoneMatch,
        name,
        name_source: nameSource,
        external_jid: externalJid,
        status: "ativo",
        created_at: new Date().toISOString(),
      };
      store.contacts.push(row);
      return [{ id: row.id }];
    }

    if (text.includes("UPDATE public.contacts")) {
      return [];
    }

    if (text.includes("FROM public.conversations") && text.includes("whatsapp_channel_id")) {
      const [companyId, channelId, contactId] = values;
      const found = store.conversations
        .filter(
          (c) =>
            c.company_id === companyId &&
            c.whatsapp_channel_id === channelId &&
            c.contact_id === contactId &&
            c.status !== "merged" &&
            c.status !== "archived",
        )
        .sort((a, b) => (a.status === "open" ? -1 : 1));
      return found.slice(0, 1).map((c) => ({ id: c.id, status: c.status }));
    }

    if (text.includes("INSERT INTO public.conversations")) {
      const [companyId, contactId, channelId] = values;
      const row = {
        id: randomUUID(),
        company_id: companyId,
        contact_id: contactId,
        whatsapp_channel_id: channelId,
        status: "open",
        unread_count: 1,
        last_message: null,
        last_message_at: new Date().toISOString(),
      };
      store.conversations.push(row);
      return [{ id: row.id }];
    }

    if (text.includes("UPDATE public.conversations") && text.includes("unread_count")) {
      const conversationId = values[values.length - 1];
      const lastMessage = values[0];
      const fromMe = typeof values[1] === "boolean" ? values[1] : false;
      const conv = store.conversations.find((c) => c.id === conversationId);
      if (conv) {
        conv.last_message = lastMessage;
        conv.last_message_at = new Date().toISOString();
        if (!fromMe) conv.unread_count = (conv.unread_count ?? 0) + 1;
      }
      return [];
    }

    if (text.includes("UPDATE public.conversations") && text.includes("status = 'open'")) {
      return [];
    }

    if (text.includes("INSERT INTO public.messages")) {
      const conversationId = values[0];
      const externalId = values[1];
      const externalMessageId = values[2];
      const exists = store.messages.find(
        (m) =>
          m.conversation_id === conversationId &&
          m.external_message_id === externalMessageId &&
          externalMessageId != null,
      );
      if (exists) return [];
      const row = {
        id: randomUUID(),
        conversation_id: conversationId,
        external_id: externalId,
        external_message_id: externalMessageId,
        direction: values[3],
        message_type: values[4],
        message_text: values[5],
        from_me: values[6],
        status: values[6] === true ? "pending" : "received",
        media_status: null,
        media_base64: values[13] ?? null,
        media_error: null,
        created_at: new Date().toISOString(),
      };
      store.messages.push(row);
      return [{ id: row.id }];
    }

    if (
      text.includes("FROM public.messages") &&
      text.includes("external_message_id") &&
      text.includes("ORDER BY created_at")
    ) {
      // Meta status: lookup global por external_message_id
      const externalMessageId = values[0];
      const found = store.messages
        .filter((m) => m.external_message_id === externalMessageId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return found.slice(0, 1).map((m) => ({ id: m.id, status: m.status ?? null }));
    }

    if (text.includes("FROM public.messages") && text.includes("external_message_id")) {
      const [conversationId, externalMessageId] = values;
      const found = store.messages.find(
        (m) =>
          m.conversation_id === conversationId && m.external_message_id === externalMessageId,
      );
      return found ? [{ id: found.id }] : [];
    }

    if (
      text.includes("UPDATE public.messages") &&
      text.includes("status = 'error'") &&
      text.includes("media_error")
    ) {
      const [safeError, messageId] = values;
      const msg = store.messages.find((m) => m.id === messageId);
      if (msg && msg.status !== "read" && msg.status !== "delivered") {
        msg.status = "error";
        if (msg.media_error == null) msg.media_error = safeError;
      }
      return [];
    }

    if (
      text.includes("UPDATE public.messages") &&
      text.includes("SET status") &&
      !text.includes("media_status")
    ) {
      const [nextStatus, messageId] = values;
      const msg = store.messages.find((m) => m.id === messageId);
      if (msg) msg.status = nextStatus;
      return [];
    }

    if (text.includes("UPDATE public.messages") && text.includes("media_status")) {
      const [mediaStatus, messageId] = values;
      const msg = store.messages.find((m) => m.id === messageId);
      if (msg && msg.media_status == null) msg.media_status = mediaStatus;
      return [];
    }

    if (text.includes("UPDATE public.messages") && text.includes("media_url")) {
      return [];
    }

    if (text.includes("INSERT INTO public.webhook_campaign_jobs")) {
      const messageId = values[1];
      const exists = store.campaignJobs.find((j) => j.message_id === messageId);
      if (exists) return [];
      const row = {
        id: randomUUID(),
        inbox_id: values[0],
        message_id: messageId,
        campaign_id: values[2],
        company_id: values[3],
        channel_id: values[4],
        conversation_id: values[5],
        external_message_id: values[6],
        phone: values[7],
        response_text: values[8],
        allow_empty_text: values[9],
        status: "pending",
        attempts: 0,
        available_at: new Date().toISOString(),
        last_error: null,
        processed_at: null,
      };
      store.campaignJobs.push(row);
      return [{ id: row.id }];
    }

    if (text.includes("FROM public.webhook_campaign_jobs") && text.includes("message_id")) {
      const messageId = values[0];
      const found = store.campaignJobs.find((j) => j.message_id === messageId);
      return found ? [{ id: found.id }] : [];
    }

    if (
      text.includes("UPDATE public.webhook_campaign_jobs") &&
      text.includes("'processed'")
    ) {
      const campaignJobId = values[0];
      const job = store.campaignJobs.find((j) => j.id === campaignJobId);
      if (!job || !["pending", "processing", "retry"].includes(job.status)) return [];
      job.status = "processed";
      job.processed_at = new Date().toISOString();
      job.last_error = null;
      return [{ id: job.id }];
    }

    if (text.includes("UPDATE public.webhook_campaign_jobs") && text.includes("'retry'")) {
      const [error, delayMs, campaignJobId] = values.length === 3
        ? [values[0], values[1], values[2]]
        : [values[1], values[0], values[2]];
      // markCampaignJobRetry: error, delayMs via make_interval, campaignJobId
      // SQL order: delayMs in make_interval, error, campaignJobId
      const id = values[values.length - 1];
      const delay = values[0];
      const err = values[1];
      const job = store.campaignJobs.find((j) => j.id === id);
      if (!job || !["pending", "processing", "retry"].includes(job.status)) return [];
      job.status = "retry";
      job.attempts = (job.attempts ?? 0) + 1;
      job.available_at = new Date(Date.now() + Number(delay)).toISOString();
      job.last_error = err;
      return [{ id: job.id }];
    }

    if (text.includes("INSERT INTO public.webhook_media_jobs")) {
      const messageId = values[1];
      const exists = store.mediaJobs.find((j) => j.message_id === messageId);
      if (exists) return [];
      const row = {
        id: randomUUID(),
        inbox_id: values[0],
        message_id: messageId,
        provider: values[2],
        status: "pending",
      };
      store.mediaJobs.push(row);
      return [{ id: row.id }];
    }

    if (text.includes("FROM public.webhook_media_jobs")) {
      const messageId = values[0];
      const found = store.mediaJobs.find((j) => j.message_id === messageId);
      return found ? [{ id: found.id }] : [];
    }

    if (text.includes("UPDATE public.webhook_inbox") && text.includes("'processed'")) {
      const [inboxId, workerId] = values;
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return [];
      row.status = "processed";
      row.processed_at = new Date().toISOString();
      row.locked_at = null;
      row.locked_by = null;
      row.lease_expires_at = null;
      return [{ id: row.id }];
    }

    if (text.includes("UPDATE public.webhook_inbox") && text.includes("'processing'")) {
      const [workerId, leaseMs, inboxId] = values;
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row) return [];
      const now = Date.now();
      const leaseExpired =
        row.lease_expires_at == null || new Date(row.lease_expires_at).getTime() < now;
      const available =
        !row.available_at || new Date(row.available_at).getTime() <= now;
      const eligible =
        (["pending", "queued", "retry"].includes(row.status) && available) ||
        (row.status === "processing" && leaseExpired);
      if (!eligible) return [];
      if (row._claimLocked) return [];
      row._claimLocked = true;
      row.status = "processing";
      row.attempts = (row.attempts ?? 0) + 1;
      row.locked_by = workerId;
      row.locked_at = new Date().toISOString();
      row.lease_expires_at = new Date(now + Number(leaseMs)).toISOString();
      row._claimLocked = false;
      return [
        {
          id: row.id,
          provider: row.provider,
          event_type: row.event_type,
          company_id: row.company_id,
          channel_id: row.channel_id,
          instance_name: row.instance_name,
          external_event_id: row.external_event_id,
          external_message_id: row.external_message_id,
          conversation_key: row.conversation_key,
          payload: row.payload,
          attempts: row.attempts,
          received_at: row.received_at,
        },
      ];
    }

    if (
      text.includes("SELECT status, attempts, locked_by, lease_expires_at") ||
      (text.includes("FROM public.webhook_inbox") && text.includes("available_in_ms"))
    ) {
      const inboxId = values[0];
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row) return [];
      const availableInMs = row.available_at
        ? new Date(row.available_at).getTime() - Date.now()
        : 0;
      return [
        {
          status: row.status,
          attempts: row.attempts ?? 0,
          locked_by: row.locked_by ?? null,
          lease_expires_at: row.lease_expires_at ?? null,
          available_in_ms: availableInMs,
        },
      ];
    }

    if (text.includes("UPDATE public.webhook_inbox") && text.includes("'retry'")) {
      const inboxId = values.find((v) => typeof v === "string" && v.includes("-"));
      // markRetry: delayMs, error, workerId, inboxId — ordem no SQL
      const delayMs = values[0];
      const error = values[1];
      const workerId = values[2];
      const id = values[3];
      const row = store.inbox.find((r) => r.id === id);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return [];
      row.status = "retry";
      row.last_error = error;
      row.available_at = new Date(Date.now() + Number(delayMs)).toISOString();
      row.locked_by = null;
      row.locked_at = null;
      row.lease_expires_at = null;
      return [{ id: row.id }];
    }

    if (text.includes("UPDATE public.webhook_inbox") && text.includes("'dead_letter'")) {
      const error = values[0];
      const workerId = values[1];
      const id = values[2];
      const row = store.inbox.find((r) => r.id === id);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return [];
      row.status = "dead_letter";
      row.last_error = error;
      row.locked_by = null;
      row.locked_at = null;
      row.lease_expires_at = null;
      return [{ id: row.id }];
    }

    if (text.includes("count(*) FILTER") && text.includes("webhook_inbox")) {
      const count = (status) => store.inbox.filter((r) => r.status === status).length;
      return [
        {
          pending: count("pending"),
          queued: count("queued"),
          processing: count("processing"),
          retry: count("retry"),
          dead_letter: count("dead_letter"),
          processed: count("processed"),
          oldest_pending_age_ms: null,
        },
      ];
    }

    if (text.includes("count(*) FILTER") && text.includes("webhook_media_jobs")) {
      const count = (status) => store.mediaJobs.filter((j) => j.status === status).length;
      return [
        {
          pending: count("pending"),
          processing: count("processing"),
          retry: count("retry"),
          dead_letter: count("dead_letter"),
        },
      ];
    }

    return [];
  };

  const sql = Object.assign(
    (strings, ...values) => run(strings, values),
    {
      begin: async (fn) => {
        state.begins += 1;
        const snapshot = {
          contacts: store.contacts.map((c) => ({ ...c })),
          conversations: store.conversations.map((c) => ({ ...c })),
          messages: store.messages.map((m) => ({ ...m })),
          mediaJobs: store.mediaJobs.map((j) => ({ ...j })),
          // A inbox NÃO entra no rollback: o claim é um UPDATE autocommit
          // separado, exatamente como no PostgreSQL real.
        };
        try {
          const tx = (strings, ...values) => run(strings, values);
          const result = await fn(tx);
          state.commits += 1;
          return result;
        } catch (e) {
          store.contacts.length = 0;
          store.contacts.push(...snapshot.contacts);
          store.conversations.length = 0;
          store.conversations.push(...snapshot.conversations);
          store.messages.length = 0;
          store.messages.push(...snapshot.messages);
          store.mediaJobs.length = 0;
          store.mediaJobs.push(...snapshot.mediaJobs);
          state.rollbacks += 1;
          throw e;
        }
      },
    },
  );

  return { sql, state };
}

function createMemoryClaimRepo(store) {
  return {
    async claim({ inboxId, workerId, leaseMs }) {
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row) return { outcome: "not_found" };
      if (row.status === "processed") {
        return { outcome: "already_processed", attempts: row.attempts ?? 0 };
      }
      if (row.status === "dead_letter") {
        return { outcome: "dead_letter", attempts: row.attempts ?? 0 };
      }
      const now = Date.now();
      const availableInMs = row.available_at
        ? new Date(row.available_at).getTime() - now
        : 0;
      if (
        ["pending", "queued", "retry"].includes(row.status) &&
        availableInMs > 0
      ) {
        return { outcome: "not_yet_available", availableInMs: Math.ceil(availableInMs) };
      }
      const leaseExpired =
        row.lease_expires_at == null || new Date(row.lease_expires_at).getTime() < now;
      const eligible =
        ["pending", "queued", "retry"].includes(row.status) ||
        (row.status === "processing" && leaseExpired);
      if (!eligible) {
        return {
          outcome: "lease_conflict",
          lockedBy: row.locked_by ?? null,
          leaseExpiresAt: row.lease_expires_at ?? null,
        };
      }
      if (row._busy) {
        return {
          outcome: "lease_conflict",
          lockedBy: row.locked_by ?? null,
          leaseExpiresAt: row.lease_expires_at ?? null,
        };
      }
      row._busy = true;
      row.status = "processing";
      row.attempts = (row.attempts ?? 0) + 1;
      row.locked_by = workerId;
      row.locked_at = new Date().toISOString();
      row.lease_expires_at = new Date(now + leaseMs).toISOString();
      row._busy = false;
      return {
        outcome: "claimed",
        row: {
          id: row.id,
          provider: row.provider,
          eventType: row.event_type,
          companyId: row.company_id,
          channelId: row.channel_id,
          instanceName: row.instance_name,
          externalEventId: row.external_event_id,
          externalMessageId: row.external_message_id,
          conversationKey: row.conversation_key,
          payload: row.payload,
          attempts: row.attempts,
          receivedAt: row.received_at,
        },
      };
    },
    async markRetry({ inboxId, workerId, error, delayMs }) {
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return false;
      row.status = "retry";
      row.last_error = error;
      row.available_at = new Date(Date.now() + delayMs).toISOString();
      row.locked_by = null;
      row.locked_at = null;
      row.lease_expires_at = null;
      return true;
    },
    async markDeadLetter({ inboxId, workerId, error }) {
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return false;
      row.status = "dead_letter";
      row.last_error = error;
      row.locked_by = null;
      row.locked_at = null;
      row.lease_expires_at = null;
      return true;
    },
    async releaseClaim({ inboxId, workerId }) {
      const row = store.inbox.find((r) => r.id === inboxId);
      if (!row || row.status !== "processing" || row.locked_by !== workerId) return false;
      row.status = "retry";
      row.attempts = Math.max(0, (row.attempts ?? 1) - 1);
      row.available_at = new Date().toISOString();
      row.locked_by = null;
      return true;
    },
    async countInboxByStatus() {
      const count = (s) => store.inbox.filter((r) => r.status === s).length;
      return {
        pending: count("pending"),
        queued: count("queued"),
        processing: count("processing"),
        retry: count("retry"),
        deadLetter: count("dead_letter"),
        processed: count("processed"),
        oldestPendingAgeMs: null,
      };
    },
    async countMediaJobsByStatus() {
      const count = (s) => store.mediaJobs.filter((j) => j.status === s).length;
      return {
        pending: count("pending"),
        processing: count("processing"),
        retry: count("retry"),
        deadLetter: count("dead_letter"),
      };
    },
  };
}

const defaultConfig = readWebhookMessageConfig({});

function seedEvolutionChannel(store) {
  const channel = {
    id: randomUUID(),
    company_id: randomUUID(),
    evolution_instance_name: "nexa-01",
    name: "Canal Evolution",
    channel_type: "evolution",
  };
  store.channels.push(channel);
  return channel;
}

function metaStatusPayload(statuses) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              statuses: Array.isArray(statuses) ? statuses : [statuses],
            },
          },
        ],
      },
    ],
  };
}

function evolutionPayload(overrides = {}) {
  return {
    event: "messages.upsert",
    instance: "nexa-01",
    data: {
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: false,
        id: "WAMID-A",
      },
      pushName: "Cliente",
      message: { conversation: "ola" },
      ...overrides.data,
    },
    ...overrides,
  };
}

function mediaEvolutionPayload() {
  return evolutionPayload({
    data: {
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: false,
        id: "WAMID-MEDIA",
      },
      pushName: "Cliente",
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          caption: "foto",
          url: "https://mmg.example/file",
          mediaKey: "abc",
        },
      },
    },
  });
}

function makeEnvelope(inboxId, extra = {}) {
  return {
    schemaVersion: OUTBOX_MESSAGE_SCHEMA_VERSION,
    inboxId,
    provider: "evolution",
    eventType: "messages.upsert",
    conversationKey: "5511999999999@s.whatsapp.net",
    receivedAt: new Date().toISOString(),
    ...extra,
  };
}

function seedInbox(store, payload, extras = {}) {
  const row = {
    id: randomUUID(),
    provider: "evolution",
    event_type: "messages.upsert",
    company_id: null,
    channel_id: null,
    instance_name: "nexa-01",
    external_event_id: null,
    external_message_id: payload?.data?.key?.id ?? "WAMID-A",
    conversation_key: payload?.data?.key?.remoteJid ?? "5511999999999@s.whatsapp.net",
    payload,
    status: "pending",
    attempts: 0,
    available_at: new Date().toISOString(),
    locked_by: null,
    locked_at: null,
    lease_expires_at: null,
    received_at: new Date().toISOString(),
    ...extras,
  };
  store.inbox.push(row);
  return row;
}

// ===========================================================================
// 1. Núcleo puro
// ===========================================================================

{
  assert(
    "flag rabbit processing default false",
    isWebhookRabbitProcessingEnabled({}) === false,
  );
  assert(
    "flag outbox publisher default false",
    isWebhookOutboxPublisherEnabled({}) === false,
  );
  assert(
    "flag legacy processing default true",
    isWebhookLegacyProcessingEnabled({}) === true,
  );
  assert(
    "legado ativo quando durable off",
    isLegacyProcessingActive({}) === true,
  );
  assert(
    "legado inativo quando durable on",
    isLegacyProcessingActive({ WEBHOOK_DURABLE_INBOX_ENABLED: "true" }) === false,
  );

  const danger = detectWebhookConfigIssues({
    WEBHOOK_RABBITMQ_PROCESSING_ENABLED: "true",
    WEBHOOK_LEGACY_PROCESSING_ENABLED: "true",
  });
  assert(
    "config perigosa legado+worker detectada",
    danger.some((i) => i.code === "legacy_and_worker_active" && i.severity === "danger"),
  );

  const cfg = readWebhookMessageConfig({});
  assert("prefetch default", cfg.prefetch === WEBHOOK_MESSAGE_DEFAULT_PREFETCH);
  assert("maxAttempts default", cfg.maxAttempts === WEBHOOK_MESSAGE_DEFAULT_MAX_ATTEMPTS);
  assert("lease default", cfg.leaseMs === WEBHOOK_MESSAGE_DEFAULT_LEASE_MS);
  assert(
    "parked interval longo",
    WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS >= 30_000,
  );

  const delays = Array.from({ length: 20 }, (_, i) =>
    computeMessageRetryDelayMs(i + 1, cfg, () => 0.5),
  );
  assert(
    "backoff cresce e respeita teto",
    delays[0] >= cfg.baseRetryMs && delays.at(-1) <= cfg.maxRetryMs,
  );
  assert("dead letter no teto", shouldDeadLetterMessage(cfg.maxAttempts, cfg) === true);
  assert("ainda nao dead letter", shouldDeadLetterMessage(cfg.maxAttempts - 1, cfg) === false);

  assert(
    "temporary classifica timeout",
    classifyProcessingError(new Error("connection timeout")) === "temporary",
  );
  assert(
    "permanent classifica PermanentWebhookProcessingError",
    classifyProcessingError(new PermanentWebhookProcessingError("bad")) === "permanent",
  );
  assert(
    "temporary classifica TemporaryWebhookProcessingError",
    classifyProcessingError(new TemporaryWebhookProcessingError("busy")) === "temporary",
  );

  const ok = parseInboxEnvelope(
    JSON.stringify(makeEnvelope("11111111-1111-4111-8111-111111111111")),
  );
  assert("envelope valido", ok.ok === true && ok.envelope.inboxId.startsWith("1111"));

  for (const [raw, reason] of [
    ["{", "invalid_json"],
    [null, "not_an_object"],
    [{}, "missing_schema_version"],
    [{ schemaVersion: 99, inboxId: "11111111-1111-4111-8111-111111111111" }, "unsupported_schema_version"],
    [{ schemaVersion: 1 }, "missing_inbox_id"],
    [{ schemaVersion: 1, inboxId: "not-a-uuid" }, "invalid_inbox_id"],
  ]) {
    const parsed = parseInboxEnvelope(raw);
    assert(`envelope invalido: ${reason}`, parsed.ok === false && parsed.reason === reason);
  }

  assert(
    "queue lag calculavel",
    computeQueueLagMs(new Date(Date.now() - 5_000).toISOString(), Date.now()) >= 4_000,
  );
  const lockA = conversationAdvisoryLockKey("co-1", "jid-a");
  const lockB = conversationAdvisoryLockKey("co-1", "jid-b");
  const lockA2 = conversationAdvisoryLockKey("co-1", "jid-a");
  assert("advisory lock estavel", lockA === lockA2);
  assert("advisory lock distinto por conversa", lockA !== lockB);
  assert("sem conversa sem lock", conversationAdvisoryLockKey("co-1", null) === null);
}

// ===========================================================================
// 2. Worker estacionado
// ===========================================================================

{
  const logs = [];
  const result = await runWebhookMessageWorkerLoop({
    config: defaultConfig,
    rabbitConfig: { enabled: true, url: "amqp://x", exchange: "e", queue: "q", dlq: "d", prefetch: 1, connectTimeoutMs: 1000, reconnectMinMs: 100, reconnectMaxMs: 1000 },
    workerId: "test-parked",
    processingEnabled: false,
    createSql: () => {
      throw new Error("nao deveria abrir sql estacionado");
    },
    sleep: async () => {},
    onSignals: false,
    maxIterations: 2,
    log: (tag, data) => logs.push({ tag, data }),
    logError: () => {},
  });
  assert("worker estacionado parked=true", result.parked === true);
  assert("worker estacionado exit 0", result.exitCode === 0);
  assert(
    "worker estacionado loga PARKED",
    logs.some((l) => l.tag === "WEBHOOK_MESSAGE_WORKER_PARKED"),
  );
  assert(
    "health enabled=false quando estacionado",
    getMessageWorkerHealthSnapshot().messageWorkerEnabled === false,
  );
}

// ===========================================================================
// 3. Envelope inválido / inbox inexistente
// ===========================================================================

{
  const store = createDomainStore();
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);

  const invalid = await processInboxMessage({
    rawMessage: Buffer.from("{"),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w1",
    ...silent,
  });
  assert("envelope invalido ACK", invalid.action === "ack");
  assert("envelope invalido nao processa inbox", store.inbox.length === 0);

  const missing = await processInboxMessage({
    rawMessage: makeEnvelope(randomUUID()),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w1",
    ...silent,
  });
  assert("inbox inexistente ACK", missing.action === "ack" && missing.reason === "inbox_not_found");
}

// ===========================================================================
// 4. Claim atômico / multi-worker / processed / lease
// ===========================================================================

{
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload);
  const repo = createMemoryClaimRepo(store);

  const a = await repo.claim({ inboxId: inbox.id, workerId: "w-a", leaseMs: 60_000 });
  const b = await repo.claim({ inboxId: inbox.id, workerId: "w-b", leaseMs: 60_000 });
  assert("claim atômico primeiro vence", a.outcome === "claimed");
  assert("claim atômico segundo perde", b.outcome === "lease_conflict");
  assert("attempts incrementou uma vez", inbox.attempts === 1);

  inbox.status = "processed";
  inbox.locked_by = null;
  const again = await repo.claim({ inboxId: inbox.id, workerId: "w-c", leaseMs: 60_000 });
  assert("processed reconhecido", again.outcome === "already_processed");

  const store2 = createDomainStore();
  const inbox2 = seedInbox(store2, payload, {
    status: "processing",
    locked_by: "dead-worker",
    lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    attempts: 2,
  });
  const repo2 = createMemoryClaimRepo(store2);
  const recovered = await repo2.claim({
    inboxId: inbox2.id,
    workerId: "w-recover",
    leaseMs: 60_000,
  });
  assert("lease expirado permite recuperacao", recovered.outcome === "claimed");
  assert("attempts sobe na recuperacao", inbox2.attempts === 3);
}

// ===========================================================================
// 5. Processamento Evolution: idempotência, mídia, unread
// ===========================================================================

{
  const store = createDomainStore();
  const channel = seedEvolutionChannel(store);
  const { sql, state } = makeDomainSql(store);
  const inboxId = randomUUID();
  const payload = evolutionPayload();

  const first = await processEvolutionInboxEvent({
    sql,
    payload,
    media: { mode: "job", inboxId },
    ...silent,
  });
  assert("evolution process ok", first.status === "ok");
  assert("cria um contato", store.contacts.length === 1);
  assert("cria uma conversa", store.conversations.length === 1);
  assert("cria uma mensagem", store.messages.length === 1);
  assert("mensagem criada flag", first.messages[0].messageCreated === true);

  const unreadAfterFirst = store.conversations[0].unread_count;

  const second = await processEvolutionInboxEvent({
    sql,
    payload,
    media: { mode: "job", inboxId },
    ...silent,
  });
  assert("retry nao cria segundo contato", store.contacts.length === 1);
  assert("retry nao cria segunda conversa", store.conversations.length === 1);
  assert("retry nao cria segunda mensagem", store.messages.length === 1);
  assert("retry marca messageCreated=false", second.messages[0].messageCreated === false);
  assert(
    "unread_count nao incrementa duas vezes",
    store.conversations[0].unread_count === unreadAfterFirst,
  );
  assert(
    "campanha so na primeira",
    first.messages[0].campaignCandidate != null &&
      second.messages[0].campaignCandidate == null,
  );
  assert("nenhuma chamada HTTP no modo job", state.httpCalls === 0);
  assert("payload original permanece", JSON.stringify(payload).includes("ola"));
}

{
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const { sql } = makeDomainSql(store);
  const inboxId = randomUUID();
  const payload = mediaEvolutionPayload();

  const result = await processEvolutionInboxEvent({
    sql,
    payload,
    media: { mode: "job", inboxId },
    ...silent,
  });
  assert("midia processa mensagem", result.status === "ok" && store.messages.length === 1);
  assert("midia cria uma tarefa", store.mediaJobs.length === 1);
  assert("midia media_status pending", store.messages[0].media_status === "pending");
  assert("midia sem base64 no worker", store.messages[0].media_base64 == null);
  assert("midia job created", result.messages[0].mediaJobCreated === true);

  const again = await processEvolutionInboxEvent({
    sql,
    payload,
    media: { mode: "job", inboxId },
    ...silent,
  });
  assert("midia retry nao duplica tarefa", store.mediaJobs.length === 1);
  assert("midia job duplicate", again.messages[0].mediaJobCreated === false);

  const ref = buildEvolutionMediaReference(payload.data);
  assert(
    "referencia evolution sem conteudo binario",
    !JSON.stringify(ref).includes('"base64":') && ref.strategy === "evolution_get_base64",
  );
  assert("referencia meta tem strategy", buildMetaMediaReference({ id: "m1" }, "image").strategy === "meta_graph_media");
}

// ===========================================================================
// 6. ACK só depois do COMMIT / falha pós-COMMIT
// ===========================================================================

{
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload);
  const { sql, state } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);
  const campaigns = [];

  const disposition = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-ack",
    runCampaignJobs: async (c) => {
      campaigns.push(...c);
    },
    ...silent,
  });

  assert("processamento ACK", disposition.action === "ack" && disposition.reason === "processed");
  assert("inbox processed apos COMMIT", inbox.status === "processed");
  assert("houve begin+commit", state.begins === 1 && state.commits === 1);
  assert("tarefa de campanha criada na TX", store.campaignJobs.length === 1);
  assert("campanha otimizacao depois do commit", campaigns.length === 1);
  assert(
    "campaign job ainda pending ate otimizacao marcar",
    store.campaignJobs[0].status === "pending" || store.campaignJobs[0].status === "processed",
  );

  // Simula reentrega após COMMIT e antes do ACK.
  const redelivery = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-ack-2",
    runCampaignJobs: async (c) => {
      campaigns.push(...c);
    },
    ...silent,
  });
  assert(
    "falha apos COMMIT antes do ACK nao duplica",
    redelivery.action === "ack" && redelivery.reason === "already_processed",
  );
  assert("ainda uma mensagem", store.messages.length === 1);
  assert("campanha nao dispara de novo na reentrega", campaigns.length === 1);
  assert("uma unica tarefa de campanha", store.campaignJobs.length === 1);
  assert("payload ainda na inbox", store.inbox[0].payload?.data?.message?.conversation === "ola");
}

// ===========================================================================
// 7. Retry temporário / dead letter permanente / excesso
// ===========================================================================

{
  const store = createDomainStore();
  // Sem canal → TemporaryWebhookProcessingError channel_not_found
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload);
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);

  const retry = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: { ...defaultConfig, maxAttempts: 8, baseRetryMs: 10, maxRetryMs: 100 },
    workerId: "w-retry",
    random: () => 0,
    ...silent,
  });
  assert(
    "erro temporario ACK com retry duravel",
    retry.action === "ack" && retry.reason === "temporary_error_durable_retry",
  );
  assert("inbox em retry", inbox.status === "retry");
  assert("last_error preservado", typeof inbox.last_error === "string" && inbox.last_error.length > 0);
  assert("payload nao perdido no retry", inbox.payload?.event === "messages.upsert");
  assert("available_at no futuro", new Date(inbox.available_at).getTime() > Date.now() - 1000);
}

{
  const store = createDomainStore();
  const payload = { event: "messages.upsert", data: { key: { id: "x" } } }; // sem instance
  const inbox = seedInbox(store, payload, { instance_name: null });
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);

  const dead = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-perm",
    ...silent,
  });
  assert("erro permanente gera dead_letter ACK", dead.action === "ack" && dead.reason === "dead_letter");
  assert("status dead_letter", inbox.status === "dead_letter");
  assert("payload preservado no DL", inbox.payload?.event === "messages.upsert");
}

{
  const store = createDomainStore();
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload, { attempts: 7 });
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);

  const exhausted = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: { ...defaultConfig, maxAttempts: 8 },
    workerId: "w-max",
    ...silent,
  });
  // Sem canal → temporary, mas attempts chega a 8 (= max) → dead_letter
  assert(
    "excesso de tentativas gera dead_letter",
    exhausted.action === "ack" && exhausted.reason === "dead_letter",
  );
  assert("status dead_letter por max attempts", inbox.status === "dead_letter");
  assert("attempts no teto", inbox.attempts === 8);
}

// ===========================================================================
// 8. Ordem por conversa (advisory lock)
// ===========================================================================

{
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const { sql, state } = makeDomainSql(store);
  const payloadA = evolutionPayload({
    data: {
      key: { remoteJid: "5511111111111@s.whatsapp.net", fromMe: false, id: "A1" },
      message: { conversation: "a" },
    },
  });
  const payloadB = evolutionPayload({
    data: {
      key: { remoteJid: "5511222222222@s.whatsapp.net", fromMe: false, id: "B1" },
      message: { conversation: "b" },
    },
  });

  await Promise.all([
    processEvolutionInboxEvent({
      sql,
      payload: payloadA,
      media: { mode: "job", inboxId: randomUUID() },
      ...silent,
    }),
    processEvolutionInboxEvent({
      sql,
      payload: payloadB,
      media: { mode: "job", inboxId: randomUUID() },
      ...silent,
    }),
  ]);
  assert("duas conversas processam em paralelo (2 msgs)", store.messages.length === 2);
  assert("duas conversas distintas", store.conversations.length === 2);

  // Serialização: o motor chama advisory lock quando processInboxMessage roda.
  const inbox = seedInbox(store, payloadA);
  const repo = createMemoryClaimRepo(store);
  await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id, {
      conversationKey: payloadA.data.key.remoteJid,
    }),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-lock",
    runCampaignJobs: async () => {},
    ...silent,
  });
  assert(
    "mesma conversation_key usa advisory lock",
    state.queries.some((q) => q.includes("pg_advisory_xact_lock")),
  );
}

// ===========================================================================
// 9. ensureMediaJob + markInboxProcessedTx
// ===========================================================================

{
  const store = createDomainStore();
  const { sql } = makeDomainSql(store);
  const messageId = randomUUID();
  store.messages.push({ id: messageId, conversation_id: "c", external_message_id: "e" });

  const first = await ensureMediaJob(sql, {
    inboxId: randomUUID(),
    messageId,
    provider: "evolution",
    channelId: null,
    instanceName: "nexa-01",
    externalMessageId: "e",
    mediaType: "image",
    mimeType: "image/jpeg",
    fileName: null,
    mediaReference: { strategy: "evolution_get_base64" },
  });
  const second = await ensureMediaJob(sql, {
    inboxId: randomUUID(),
    messageId,
    provider: "evolution",
    channelId: null,
    instanceName: "nexa-01",
    externalMessageId: "e",
    mediaType: "image",
    mimeType: "image/jpeg",
    fileName: null,
    mediaReference: { strategy: "evolution_get_base64" },
  });
  assert("ensureMediaJob cria", first.created === true && first.mediaJobId != null);
  assert("ensureMediaJob duplicata", second.created === false && second.mediaJobId === first.mediaJobId);
}

// ===========================================================================
// 10. Garantias: campanha durável, Meta status, retry ACK, unicidade, rollback
// ===========================================================================

{
  // Falha da campanha após COMMIT não perde tarefa
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload);
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);

  const disposition = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-camp-fail",
    runCampaignJobs: async () => {
      throw new Error("campaign boom");
    },
    ...silent,
  });
  assert(
    "campanha pos-COMMIT falha ainda ACK processed",
    disposition.action === "ack" && disposition.reason === "processed",
  );
  assert("inbox processed mesmo com falha de campanha", inbox.status === "processed");
  assert("tarefa de campanha preservada", store.campaignJobs.length === 1);
  assert(
    "tarefa permanece pendente apos falha da otimizacao",
    store.campaignJobs[0].status === "pending",
  );

  const redelivery = await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-camp-fail-2",
    runCampaignJobs: async () => {
      throw new Error("should not run");
    },
    ...silent,
  });
  assert(
    "reentrega nao duplica resposta de campanha",
    redelivery.reason === "already_processed" && store.campaignJobs.length === 1,
  );
}

{
  // Retry durável não prende prefetch: ACK + republisher
  const store = createDomainStore();
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload, { status: "retry", available_at: new Date(0).toISOString() });
  const published = [];
  const retryRepo = {
    async claimReadyRetries({ batchSize }) {
      const ready = store.inbox
        .filter((r) => r.status === "retry" && new Date(r.available_at).getTime() <= Date.now())
        .slice(0, batchSize);
      for (const r of ready) {
        r.status = "queued";
        r.locked_by = "retry-w";
      }
      return ready.map((r) => ({
        id: r.id,
        provider: r.provider,
        eventType: r.event_type,
        conversationKey: r.conversation_key,
        receivedAt: r.received_at,
        attempts: r.attempts ?? 0,
      }));
    },
    async markQueuedAfterPublish({ id }) {
      const r = store.inbox.find((x) => x.id === id);
      if (!r) return false;
      r.locked_by = null;
      return true;
    },
    async releaseRetryClaim({ id }) {
      const r = store.inbox.find((x) => x.id === id);
      if (!r) return false;
      r.status = "retry";
      r.available_at = new Date().toISOString();
      r.locked_by = null;
      return true;
    },
  };
  const batch = await processInboxRetryBatch({
    repo: retryRepo,
    publisher: {
      publish: async (req) => {
        published.push(req);
      },
      close: async () => {},
      isConnected: () => true,
      getState: () => ({ connected: true, consecutiveFailures: 0, nextAttemptInMs: 0 }),
    },
    workerId: "retry-w",
    ...silent,
  });
  assert("republisher claima retry vencido", batch.claimed === 1 && batch.published === 1);
  assert("republisher publica referencia", published[0]?.body?.inboxId === inbox.id);
  assert("inbox fica queued apos republish", inbox.status === "queued");

  const consumerSrc = readSource("src/lib/rabbitmq-consumer.server.ts");
  assert(
    "consumer nao dorme no NACK de backoff",
    !consumerSrc.includes("requeueWithDelay") && consumerSrc.includes("requeueNow"),
  );
  assert(
    "worker ACK apos retry duravel",
    readSource("src/lib/webhook-message-worker.server.ts").includes(
      "temporary_error_durable_retry",
    ),
  );
}

{
  // Meta status: delivered/read idempotentes; before-message; failed; unknown
  const store = createDomainStore();
  const { sql } = makeDomainSql(store);
  const msgId = "wamid.OUT-1";
  store.messages.push({
    id: randomUUID(),
    conversation_id: randomUUID(),
    external_message_id: msgId,
    status: "sent",
    created_at: new Date().toISOString(),
    media_error: null,
  });

  const deliveredOnce = await processMetaStatusUpdates({
    sql,
    payload: metaStatusPayload({ id: msgId, status: "delivered", timestamp: "1" }),
    ...silent,
  });
  assert("delivered aplica uma vez", deliveredOnce.applied === 1 && store.messages[0].status === "delivered");

  const deliveredTwice = await processMetaStatusUpdates({
    sql,
    payload: metaStatusPayload({ id: msgId, status: "delivered", timestamp: "2" }),
    ...silent,
  });
  assert(
    "delivered repetido nao duplica efeito",
    deliveredTwice.applied === 0 && deliveredTwice.noop === 1 && store.messages[0].status === "delivered",
  );

  const readOnce = await processMetaStatusUpdates({
    sql,
    payload: metaStatusPayload({ id: msgId, status: "read", timestamp: "3" }),
    ...silent,
  });
  assert("read aplica", readOnce.applied === 1 && store.messages[0].status === "read");

  const readTwice = await processMetaStatusUpdates({
    sql,
    payload: metaStatusPayload({ id: msgId, status: "read", timestamp: "4" }),
    ...silent,
  });
  assert(
    "read repetido nao duplica efeito",
    readTwice.applied === 0 && readTwice.noop === 1 && store.messages[0].status === "read",
  );

  assert("nextMessageStatus monotono", nextMessageStatus("delivered", "sent") === null);
  assert("failed mapeia para error", nextMessageStatus("sent", "failed") === "error");
  assert("failed nao regride read", nextMessageStatus("read", "failed") === null);

  let beforeMessageErr = null;
  try {
    await processMetaStatusUpdates({
      sql,
      payload: metaStatusPayload({ id: "wamid.MISSING", status: "delivered" }),
      ...silent,
    });
  } catch (e) {
    beforeMessageErr = e;
  }
  assert(
    "status antes da mensagem gera Temporary",
    beforeMessageErr instanceof TemporaryWebhookProcessingError &&
      beforeMessageErr.code === "status_before_message",
  );

  store.messages.push({
    id: randomUUID(),
    conversation_id: randomUUID(),
    external_message_id: "wamid.FAIL-1",
    status: "sent",
    created_at: new Date().toISOString(),
    media_error: null,
  });
  await processMetaStatusUpdates({
    sql,
    payload: metaStatusPayload({
      id: "wamid.FAIL-1",
      status: "failed",
      errors: [{ code: 131026, title: "Message undeliverable", message: "token=SECRET-XYZ" }],
    }),
    ...silent,
  });
  const failedMsg = store.messages.find((m) => m.external_message_id === "wamid.FAIL-1");
  assert("failed marca error", failedMsg.status === "error");
  assert(
    "failed guarda codigo sem expor segredo",
    typeof failedMsg.media_error === "string" &&
      failedMsg.media_error.includes("131026") &&
      !failedMsg.media_error.includes("SECRET-XYZ"),
  );

  let unknownErr = null;
  try {
    await processMetaInboxEvent({
      sql,
      inboxId: randomUUID(),
      payload: {
        entry: [{ changes: [{ field: "something_new", value: { foo: 1 } }] }],
      },
      ...silent,
    });
  } catch (e) {
    unknownErr = e;
  }
  assert(
    "evento Meta desconhecido nao e processed silenciosamente",
    unknownErr instanceof PermanentWebhookProcessingError &&
      unknownErr.code === "unknown_meta_field",
  );

  // Status via worker: inbox fica retry, nunca processed sem efeito
  const store2 = createDomainStore();
  const statusPayload = metaStatusPayload({ id: "wamid.EARLY", status: "delivered" });
  const inboxStatus = seedInbox(store2, statusPayload, {
    provider: "meta",
    event_type: "whatsapp.status",
  });
  const { sql: sql2 } = makeDomainSql(store2);
  const repo2 = createMemoryClaimRepo(store2);
  const early = await processInboxMessage({
    rawMessage: makeEnvelope(inboxStatus.id, { provider: "meta" }),
    sql: sql2,
    repo: repo2,
    config: { ...defaultConfig, maxAttempts: 8, baseRetryMs: 10, maxRetryMs: 100 },
    workerId: "w-meta-status",
    random: () => 0,
    ...silent,
  });
  assert(
    "status Meta antecipado nao descartado",
    early.action === "ack" &&
      early.reason === "temporary_error_durable_retry" &&
      inboxStatus.status === "retry",
  );
  assert("inbox nao processed sem mensagem", inboxStatus.status !== "processed");
}

{
  // Unicidade de conversa: proposta + detecção
  const proposed = readSource("docs/migrations/20260809_conversations_unique_proposed.sql");
  assert(
    "proposta UNIQUE de conversa documentada",
    proposed.includes("conversations_company_channel_contact_active_uniq") &&
      proposed.includes("NÃO APLICAR"),
  );
  assert(
    "evolution detecta duplicidade de conversa",
    readSource("src/lib/webhook-evolution-processing.server.ts").includes(
      "CONVERSATION_DUPLICATE_DETECTED",
    ),
  );
  assert(
    "crm-inbound detecta duplicidade de conversa",
    readSource("src/lib/crm-inbound.server.ts").includes("CONVERSATION_DUPLICATE_DETECTED"),
  );
}

{
  // Rollback operacional vs destrutivo
  const docs = readSource("docs/webhook-durable-inbox.md");
  assert(
    "docs: rollback operacional por flags e primeira opcao",
    docs.includes("Rollback operacional") &&
      docs.includes("WEBHOOK_RABBITMQ_PROCESSING_ENABLED=false"),
  );
  assert(
    "docs: DROP TABLE apaga payload",
    /DROP TABLE/.test(docs) && /apaga|destrói|destrutivo|payload/i.test(docs),
  );
  assert(
    "docs: migrations destrutivas so apos backup",
    /backup|dump/i.test(docs),
  );
  assert(
    "docs: preservar inbox/outbox/jobs em incidente",
    /Preserve[\s\S]*webhook_inbox[\s\S]*webhook_outbox[\s\S]*webhook_campaign_jobs/i.test(docs) &&
      /Não use rollback SQL[\s\S]*destrutivo durante incidente/i.test(docs),
  );

  const inboxRollback = readSource("docs/migrations/20260808_webhook_inbox_rollback.sql");
  assert(
    "rollback inbox e DROP TABLE (destrutivo)",
    /DROP TABLE.*webhook_inbox/i.test(inboxRollback),
  );
  assert(
    "rollback campaign jobs avisa dump",
    /dump|backup/i.test(
      readSource("docs/migrations/20260809_webhook_campaign_jobs_rollback.sql"),
    ),
  );
}

{
  // Nenhuma inbox processed com efeito obrigatório faltando (campanha job na TX)
  const store = createDomainStore();
  seedEvolutionChannel(store);
  const payload = evolutionPayload();
  const inbox = seedInbox(store, payload);
  const { sql } = makeDomainSql(store);
  const repo = createMemoryClaimRepo(store);
  await processInboxMessage({
    rawMessage: makeEnvelope(inbox.id),
    sql,
    repo,
    config: defaultConfig,
    workerId: "w-effect",
    runCampaignJobs: async () => {},
    ...silent,
  });
  assert("inbox processed", inbox.status === "processed");
  assert(
    "efeito campanha existe antes/com processed",
    store.campaignJobs.length === 1 && store.messages.length === 1,
  );
}

// ===========================================================================
// 11. Verificações estáticas
// ===========================================================================

{
  const workerSrc = readSource("src/lib/webhook-message-worker.server.ts");
  const evoProc = readSource("src/lib/webhook-evolution-processing.server.ts");
  const metaProc = readSource("src/lib/webhook-meta-processing.server.ts");
  const entry = readSource("scripts/webhook-message-worker.ts");
  const pkg = readSource("package.json");
  const evoRoute = readSource("src/routes/api/public/webhooks/evolution.ts");
  const aliasRoute = readSource("src/routes/webhook/evolution.ts");
  const loopSrc = readSource("src/lib/webhook-message-worker-loop.server.ts");

  const entryNoComments = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(
    "entrypoint nao importa src/server.ts",
    !entryNoComments.includes("src/server.ts") &&
      !/from\s+["']@\/server["']/.test(entryNoComments),
  );
  assert(
    "package.json tem script message-worker",
    pkg.includes('"webhook:message-worker"'),
  );
  assert(
    "worker usa processEvolutionInboxEvent",
    workerSrc.includes("processEvolutionInboxEvent"),
  );
  assert(
    "worker usa processMetaInboxEvent",
    workerSrc.includes("processMetaInboxEvent"),
  );
  assert(
    "modo job nao chama downloadMediaFromEvolution",
    !/mode === \"job\"[\s\S]{0,200}downloadMediaFromEvolution/.test(evoProc) &&
      evoProc.includes('mode: "job"') === false
        ? evoProc.includes('params.media.mode === "inline"')
        : true,
  );
  assert(
    "download so no modo inline",
    evoProc.includes('params.media.mode === "inline"') &&
      evoProc.includes("downloadMediaFromEvolution"),
  );
  assert(
    "meta worker nao importa downloadMetaMedia",
    !metaProc.includes("downloadMetaMedia"),
  );
  assert(
    "rota legado usa processEvolutionInboxEvent",
    evoRoute.includes("processEvolutionInboxEvent"),
  );
  assert(
    "alias /webhook/evolution respeita flag",
    aliasRoute.includes("handleEvolutionWebhookRequest"),
  );
  assert(
    "migration media jobs existe",
    readSource("docs/migrations/20260809_webhook_media_jobs.sql").includes(
      "webhook_media_jobs",
    ),
  );
  assert(
    "migration stage3 inbox existe",
    readSource("docs/migrations/20260809_webhook_inbox_stage3.sql").includes(
      "conversation_key",
    ),
  );
  assert(
    "migration campaign jobs existe",
    readSource("docs/migrations/20260809_webhook_campaign_jobs.sql").includes(
      "webhook_campaign_jobs",
    ),
  );
  assert(
    "rollback media nao apaga inbox",
    !/DROP TABLE.*webhook_inbox/i.test(
      readSource("docs/migrations/20260809_webhook_media_jobs_rollback.sql"),
    ),
  );
  assert(
    "loop integra republisher de retry",
    loopSrc.includes("processInboxRetryBatch"),
  );
  assert(
    "campanha criada via ensureCampaignJob",
    evoProc.includes("ensureCampaignJob") && metaProc.includes("ensureCampaignJob"),
  );
  assert(
    "meta processa status",
    metaProc.includes("processMetaStatusUpdates"),
  );
}

// ===========================================================================
// Resultado
// ===========================================================================

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll webhook message-worker tests passed.");
