/**
 * Processamento de domínio dos webhooks da Meta para o message-worker.
 *
 * Reaproveita o parsing (`meta-inbound-parse`) e a camada CRM
 * (`crm-inbound.server`) que a rota legada já usa — a diferença é que aqui
 * tudo recebe o `sql` da transação e a mídia vira tarefa em vez de download.
 *
 * A validação de assinatura NÃO passa por aqui: ela acontece na ingestão, e um
 * evento só chega à inbox depois de aprovada. O worker processa apenas eventos
 * que já foram autenticados.
 */

import { persistMetaAttendanceMessage } from "@/lib/attendance-inbound.server";
import { extractMetaSmbMessageEchoes } from "@/lib/meta-inbound-parse";
import type { SqlExecutor } from "@/lib/pg-types";
import {
  bumpConversationAfterInboundMessage,
  insertInboundMediaMessage,
  insertInboundTextMessage,
  upsertInboundContact,
  upsertInboundConversation,
} from "@/lib/crm-inbound.server";
import {
  extractMetaInboundMediaMessages,
  extractMetaInboundTextMessages,
  metaInboundMediaPreviewLabel,
  unwrapMetaWebhookBody,
  type MetaInboundMediaMessage,
  type MetaInboundTextMessage,
} from "@/lib/meta-inbound-parse";
import { buildMetaMediaReference, ensureMediaJob } from "@/lib/webhook-media-jobs.server";
import { ensureCampaignJob } from "@/lib/webhook-campaign-jobs.server";
import type { CampaignCandidate } from "@/lib/webhook-campaign-hook.server";
import {
  classifyMetaInboxPayload,
  extractMetaStatusUpdates,
  processMetaStatusUpdates,
} from "@/lib/webhook-meta-status.server";
import { PermanentWebhookProcessingError } from "@/lib/webhook-message-core";

type LogFn = (event: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (event, data) => console.log(`[${event}]`, data ?? {});

export type MetaChannelRow = {
  id: string;
  companyId: string;
  phoneNumberId: string | null;
};

/**
 * Resolve o canal Meta com o `sql` da transação.
 *
 * Consulta própria (em vez de `loadMetaChannelByPhoneNumberId`) porque aquela
 * usa o pool global e devolve um registro completo do canal, do qual o worker
 * só precisa de id e empresa. Os filtros são os mesmos.
 */
export async function findMetaChannelByPhoneNumberId(
  sql: SqlExecutor,
  phoneNumberId: string,
): Promise<MetaChannelRow | null> {
  const rows = await sql<
    { id: string; company_id: string | null; phone_number_id: string | null }[]
  >`
    SELECT id, company_id, phone_number_id
    FROM public.whatsapp_channels
    WHERE lower(channel_type) = 'meta'
      AND phone_number_id = ${phoneNumberId}
      AND upper(status) = 'ACTIVE'
      AND deleted_at IS NULL
      AND active = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const companyId = (row.company_id ?? "").trim();
  if (!companyId || companyId === "null") return null;
  return { id: row.id, companyId, phoneNumberId: row.phone_number_id };
}

export type ProcessMetaMessageResult = {
  externalMessageId: string;
  contactId: string | null;
  conversationId: string | null;
  messageId: string | null;
  messageCreated: boolean;
  mediaJobId: string | null;
  mediaJobCreated: boolean;
  campaignJobId: string | null;
  campaignJobCreated: boolean;
  campaignCandidate: CampaignCandidate | null;
};

async function processTextMessage(params: {
  sql: SqlExecutor;
  channel: MetaChannelRow;
  msg: MetaInboundTextMessage;
  inboxId: string;
  log: LogFn;
}): Promise<ProcessMetaMessageResult> {
  const { sql, channel, msg, log } = params;

  const { contactId, conversationId, messageId } = await persistMetaAttendanceMessage(sql, {
    companyId: channel.companyId,
    channelId: channel.id,
    phone: msg.phone,
    externalMessageId: msg.externalMessageId,
    text: msg.textBody,
    rawPayload: msg.rawPayload,
  });

  if (!messageId) {
    log("META_INBOUND_DEDUP", {
      externalMessageId: msg.externalMessageId,
      conversationId,
    });
    return {
      externalMessageId: msg.externalMessageId,
      contactId,
      conversationId,
      messageId: null,
      messageCreated: false,
      mediaJobId: null,
      mediaJobCreated: false,
      campaignJobId: null,
      campaignJobCreated: false,
      campaignCandidate: null,
    };
  }

  const campaignCandidate: CampaignCandidate = {
    companyId: channel.companyId,
    channelId: channel.id,
    conversationId,
    phone: msg.phone,
    responseText: msg.textBody,
    allowEmptyText: false,
    inboundMessageId: messageId,
  };

  const job = await ensureCampaignJob(sql, {
    inboxId: params.inboxId,
    messageId,
    companyId: channel.companyId,
    channelId: channel.id,
    conversationId,
    externalMessageId: msg.externalMessageId,
    phone: msg.phone,
    responseText: msg.textBody,
    allowEmptyText: false,
  });
  log(job.created ? "WEBHOOK_CAMPAIGN_JOB_CREATED" : "WEBHOOK_CAMPAIGN_JOB_DUPLICATE", {
    campaignJobId: job.campaignJobId,
    messageId,
  });

  log("META_INBOUND_MESSAGE_SAVED", {
    messageId,
    conversationId,
    contactId,
    externalMessageId: msg.externalMessageId,
    messageType: msg.messageType,
  });

  return {
    externalMessageId: msg.externalMessageId,
    contactId,
    conversationId,
    messageId,
    messageCreated: true,
    mediaJobId: null,
    mediaJobCreated: false,
    campaignJobId: job.campaignJobId,
    campaignJobCreated: job.created,
    campaignCandidate,
  };
}

async function processMediaMessage(params: {
  sql: SqlExecutor;
  channel: MetaChannelRow;
  msg: MetaInboundMediaMessage;
  inboxId: string;
  log: LogFn;
}): Promise<ProcessMetaMessageResult> {
  const { sql, channel, msg, log } = params;

  const previewLabel = metaInboundMediaPreviewLabel(msg.mediaType);
  const messageText = msg.caption?.trim() || previewLabel;
  const { contactId, conversationId, messageId } = await persistMetaAttendanceMessage(sql, {
    companyId: channel.companyId,
    channelId: channel.id,
    phone: msg.phone,
    externalMessageId: msg.externalMessageId,
    text: messageText,
    rawPayload: { ...msg.rawPayload, meta_media_id: msg.mediaId, media_status: "pending" },
    media: {
      mediaType: msg.mediaType,
      messageText,
      caption: msg.caption,
      mimeType: msg.mimeHint,
      filename: msg.filename,
      mediaBase64: null,
      mediaError: null,
      mediaSize: null,
      rawPayload: msg.rawPayload,
    },
  });
  if (messageId)
    await sql`UPDATE public.messages SET media_status='pending' WHERE id=${messageId}::uuid`;

  if (!messageId) {
    log("META_INBOUND_DEDUP", {
      externalMessageId: msg.externalMessageId,
      conversationId,
      mediaType: msg.mediaType,
    });
    return {
      externalMessageId: msg.externalMessageId,
      contactId,
      conversationId,
      messageId: null,
      messageCreated: false,
      mediaJobId: null,
      mediaJobCreated: false,
      campaignJobId: null,
      campaignJobCreated: false,
      campaignCandidate: null,
    };
  }

  const job = await ensureMediaJob(sql, {
    inboxId: params.inboxId,
    messageId,
    provider: "meta",
    channelId: channel.id,
    instanceName: channel.phoneNumberId,
    externalMessageId: msg.externalMessageId,
    mediaType: msg.mediaType,
    mimeType: msg.mimeHint,
    fileName: msg.filename,
    mediaReference: buildMetaMediaReference(
      { id: msg.mediaId, mime_type: msg.mimeHint, filename: msg.filename },
      msg.mediaType,
    ),
  });
  log(job.created ? "MEDIA_JOB_CREATED" : "MEDIA_JOB_DUPLICATE", {
    mediaJobId: job.mediaJobId,
    messageId,
    mediaType: msg.mediaType,
  });

  const campaignCandidate: CampaignCandidate = {
    companyId: channel.companyId,
    channelId: channel.id,
    conversationId,
    phone: msg.phone,
    responseText: msg.caption ?? "",
    allowEmptyText: true,
    inboundMessageId: messageId,
  };
  const campaignJob = await ensureCampaignJob(sql, {
    inboxId: params.inboxId,
    messageId,
    companyId: channel.companyId,
    channelId: channel.id,
    conversationId,
    externalMessageId: msg.externalMessageId,
    phone: msg.phone,
    responseText: msg.caption ?? "",
    allowEmptyText: true,
  });
  log(campaignJob.created ? "WEBHOOK_CAMPAIGN_JOB_CREATED" : "WEBHOOK_CAMPAIGN_JOB_DUPLICATE", {
    campaignJobId: campaignJob.campaignJobId,
    messageId,
  });

  log("META_MEDIA_MESSAGE_SAVED", {
    channelId: channel.id,
    mediaType: msg.mediaType,
    internalMessageId: messageId,
    conversationId,
    mediaStatus: "pending",
  });

  return {
    externalMessageId: msg.externalMessageId,
    contactId,
    conversationId,
    messageId,
    messageCreated: true,
    mediaJobId: job.mediaJobId,
    mediaJobCreated: job.created,
    campaignJobId: campaignJob.campaignJobId,
    campaignJobCreated: campaignJob.created,
    campaignCandidate,
  };
}

export type MetaProcessingResult =
  | {
      status: "ok";
      companyId: string | null;
      channelId: string | null;
      phoneNumberId: string | null;
      messages: ProcessMetaMessageResult[];
      statusesApplied: number;
      statusesNoop: number;
    }
  | { status: "missing_phone_number_id" }
  | { status: "channel_not_found"; phoneNumberId: string };

/**
 * Transforma um evento Meta já persistido na inbox em contato/conversa/mensagem
 * e/ou atualização de status. Campos desconhecidos e status sem mensagem
 * correspondente NÃO viram processed silenciosamente.
 */
export async function processMetaInboxEvent(params: {
  sql: SqlExecutor;
  payload: unknown;
  inboxId: string;
  log?: LogFn;
}): Promise<MetaProcessingResult> {
  const log = params.log ?? defaultLog;
  const sql = params.sql;

  const body = unwrapMetaWebhookBody(params.payload) ?? params.payload;
  const classification = classifyMetaInboxPayload(body);

  if (
    classification.unknownFields.length > 0 &&
    !classification.hasMessages &&
    !classification.hasStatuses &&
    !classification.hasSmbEchoes
  ) {
    throw new PermanentWebhookProcessingError(
      "unknown_meta_field",
      `Campo Meta não suportado: ${classification.unknownFields.join(",")}`,
    );
  }

  const textMessages = extractMetaInboundTextMessages(body);
  const mediaMessages = extractMetaInboundMediaMessages(body);
  const statusUpdates = extractMetaStatusUpdates(body);
  const echoes = extractMetaSmbMessageEchoes(body);
  if (statusUpdates.some((update) => !update.phoneNumberId))
    throw new PermanentWebhookProcessingError(
      "missing_phone_number_id",
      "Status Meta sem identificação de canal.",
    );

  if (
    textMessages.length === 0 &&
    mediaMessages.length === 0 &&
    statusUpdates.length === 0 &&
    echoes.length === 0
  ) {
    if (classification.unknownFields.length > 0) {
      throw new PermanentWebhookProcessingError(
        "unknown_meta_field",
        `Campo Meta não suportado: ${classification.unknownFields.join(",")}`,
      );
    }
    throw new PermanentWebhookProcessingError(
      "empty_meta_event",
      "Evento Meta sem messages nem statuses reconhecíveis",
    );
  }

  const phoneNumberId =
    textMessages[0]?.phoneNumberId ??
    mediaMessages[0]?.phoneNumberId ??
    echoes[0]?.phoneNumberId ??
    statusUpdates[0]?.phoneNumberId ??
    null;

  const channels = new Map<string, MetaChannelRow>();
  for (const id of new Set(
    [...textMessages, ...mediaMessages, ...echoes, ...statusUpdates]
      .map((message) => message.phoneNumberId)
      .filter((id): id is string => !!id),
  )) {
    const found = await findMetaChannelByPhoneNumberId(sql, id);
    if (!found) return { status: "channel_not_found", phoneNumberId: id };
    channels.set(id, found);
  }
  const channel = phoneNumberId ? (channels.get(phoneNumberId) ?? null) : null;
  const messages: ProcessMetaMessageResult[] = [];
  for (const echo of echoes) {
    const target = channels.get(echo.phoneNumberId)!;
    await persistMetaAttendanceMessage(sql, {
      companyId: target.companyId,
      channelId: target.id,
      phone: echo.customerPhone,
      externalMessageId: echo.externalMessageId,
      text: echo.messageText ?? "[Mensagem do WhatsApp Business]",
      rawPayload: echo.rawPayload,
      echo: true,
      messageType: echo.messageType,
    });
  }
  for (const msg of textMessages)
    messages.push(
      await processTextMessage({
        sql,
        channel: channels.get(msg.phoneNumberId)!,
        msg,
        inboxId: params.inboxId,
        log,
      }),
    );
  for (const msg of mediaMessages)
    messages.push(
      await processMediaMessage({
        sql,
        channel: channels.get(msg.phoneNumberId)!,
        msg,
        inboxId: params.inboxId,
        log,
      }),
    );
  for (const target of channels.values())
    await sql`UPDATE public.whatsapp_channels SET last_webhook_at=now() WHERE id=${target.id}::uuid AND company_id=${target.companyId}::uuid`;

  let statusesApplied = 0;
  let statusesNoop = 0;
  if (statusUpdates.length > 0) {
    const statusResult = await processMetaStatusUpdates({ sql, payload: body, log });
    statusesApplied = statusResult.applied;
    statusesNoop = statusResult.noop;
  }

  return {
    status: "ok",
    companyId: channel?.companyId ?? null,
    channelId: channel?.id ?? null,
    phoneNumberId,
    messages,
    statusesApplied,
    statusesNoop,
  };
}
