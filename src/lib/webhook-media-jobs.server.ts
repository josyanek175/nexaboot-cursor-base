/**
 * Enfileiramento durável de mídia.
 *
 * O message-worker não baixa, não descriptografa e não guarda binário: ele
 * grava a mensagem, registra aqui o que é preciso para buscar o anexo depois e
 * segue. O download continua sendo trabalho de um media-worker próprio, que
 * ainda não existe.
 */

import type { InboxTx } from "@/lib/webhook-inbox-claim.server";
import type { WebhookProvider } from "@/lib/webhook-inbox-core";

export type MediaJobInput = {
  inboxId: string;
  messageId: string;
  provider: WebhookProvider;
  channelId: string | null;
  instanceName: string | null;
  externalMessageId: string | null;
  mediaType: string | null;
  mimeType: string | null;
  fileName: string | null;
  /** Só ponteiros para o provedor. Nunca base64, nunca texto da mensagem. */
  mediaReference: Record<string, unknown>;
};

export type EnsureMediaJobResult = {
  mediaJobId: string | null;
  created: boolean;
};

/**
 * Cria a tarefa de mídia se ela ainda não existir.
 *
 * Roda dentro da transação do processamento: ou a mensagem e a tarefa nascem
 * juntas, ou nenhuma das duas nasce. Uma mensagem com anexo e sem tarefa seria
 * um anexo que nunca chega.
 */
export async function ensureMediaJob(
  tx: InboxTx,
  params: MediaJobInput,
): Promise<EnsureMediaJobResult> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO public.webhook_media_jobs (
      inbox_id, message_id, provider, channel_id, instance_name,
      external_message_id, media_type, mime_type, file_name,
      media_reference, status
    ) VALUES (
      ${params.inboxId}::uuid,
      ${params.messageId}::uuid,
      ${params.provider},
      ${params.channelId}::uuid,
      ${params.instanceName},
      ${params.externalMessageId},
      ${params.mediaType},
      ${params.mimeType},
      ${params.fileName},
      ${JSON.stringify(params.mediaReference ?? {})}::jsonb,
      'pending'
    )
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
  `;

  if (inserted[0]) return { mediaJobId: inserted[0].id, created: true };

  const existing = await tx<{ id: string }[]>`
    SELECT id FROM public.webhook_media_jobs
    WHERE message_id = ${params.messageId}::uuid
    LIMIT 1
  `;
  return { mediaJobId: existing[0]?.id ?? null, created: false };
}

// ---------------------------------------------------------------------------
// Referências por provedor
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Ponteiros da Evolution para baixar depois.
 *
 * O endpoint `/chat/getBase64FromMediaMessage` exige o nó original da mensagem,
 * então guardamos as chaves de criptografia e a URL — que são ponteiros, não
 * conteúdo. `jpegThumbnail` e qualquer campo com o binário embutido ficam de
 * fora: o payload bruto completo já está preservado na inbox.
 */
export function buildEvolutionMediaReference(rawMessage: unknown): Record<string, unknown> {
  const message = asRecord(rawMessage);
  const inner = asRecord(message.message);
  const key = asRecord(message.key);

  const mediaNodeName = [
    "imageMessage",
    "audioMessage",
    "videoMessage",
    "documentMessage",
    "stickerMessage",
  ].find((name) => inner[name] != null);

  const mediaNode = mediaNodeName ? asRecord(inner[mediaNodeName]) : {};

  return {
    strategy: "evolution_get_base64",
    messageKey: pickDefined(key, ["id", "remoteJid", "fromMe", "participant"]),
    mediaNode: mediaNodeName ?? null,
    media: pickDefined(mediaNode, [
      "url",
      "directPath",
      "mediaKey",
      "fileEncSha256",
      "fileSha256",
      "fileLength",
      "mimetype",
      "fileName",
      "seconds",
      "mediaKeyTimestamp",
    ]),
  };
}

/**
 * Meta entrega só o id da mídia; o download é um GET no Graph API usando o
 * token do canal. Nada sensível é guardado aqui.
 */
export function buildMetaMediaReference(mediaNode: unknown, mediaType: string | null) {
  const node = asRecord(mediaNode);
  return {
    strategy: "meta_graph_media",
    mediaType,
    media: pickDefined(node, ["id", "mime_type", "sha256", "filename", "caption", "voice"]),
  };
}
