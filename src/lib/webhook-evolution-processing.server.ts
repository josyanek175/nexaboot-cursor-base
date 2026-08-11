/**
 * Processamento de domínio dos webhooks da Evolution.
 *
 * Extraído da rota HTTP sem mudar a lógica: a rota legada continua chamando
 * exatamente estas funções, e o message-worker chama as mesmas com um `sql` de
 * transação. Nada aqui conhece `Request` ou `Response`.
 *
 * A única diferença entre os dois chamadores é a mídia:
 *   - `inline` (rota legada) baixa e descriptografa o anexo na hora, como hoje;
 *   - `job` (worker) grava a mensagem com media_status='pending' e enfileira o
 *     download, sem nenhuma chamada externa — o que permite rodar tudo dentro
 *     de uma transação curta.
 */

import type { SqlExecutor } from "@/lib/pg-types";
import { isValidE164Digits, normalizePhoneE164, normalizePhoneForMatch } from "@/lib/phone";
import { parseContactMessageNode } from "@/lib/whatsapp-contact-message";
import { buildEvolutionMediaReference, ensureMediaJob } from "@/lib/webhook-media-jobs.server";
import { ensureCampaignJob } from "@/lib/webhook-campaign-jobs.server";
import type { CampaignCandidate } from "@/lib/webhook-campaign-hook.server";

export type Json = Record<string, unknown>;

export type EvolutionChannelRow = {
  id: string;
  company_id: string;
  evolution_instance_name: string | null;
  name: string;
};

export type ParsedEvolutionMessage = {
  type: "text" | "image" | "audio" | "video" | "document" | "reaction" | "contact" | "contacts";
  body?: string;
  mimeType?: string;
  fileName?: string;
  durationSeconds?: number;
  reactionEmoji?: string;
  reactionToId?: string;
};

type LogFn = (event: string, data?: Record<string, unknown>) => void;

const defaultLog: LogFn = (event, data) => console.log(`[${event}]`, data ?? {});

// ---------------------------------------------------------------------------
// Parsing do envelope
// ---------------------------------------------------------------------------

export function pickMessageType(msg: Json): ParsedEvolutionMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (msg.message ?? {}) as any;
  // Reação (emoji) do WhatsApp — nunca tratar como "não suportada".
  if (m.reactionMessage) {
    const emoji = typeof m.reactionMessage.text === "string" ? m.reactionMessage.text : "";
    const reactionToId: string | undefined = m.reactionMessage.key?.id ?? undefined;
    return {
      type: "reaction",
      body: emoji ? `Reagiu com ${emoji}` : "Removeu a reação",
      reactionEmoji: emoji || undefined,
      reactionToId,
    };
  }
  // Contato(s) compartilhado(s) — contactMessage / contactsArrayMessage / vCard.
  const contactParsed = parseContactMessageNode(m);
  if (contactParsed) {
    return { type: contactParsed.type, body: contactParsed.body };
  }
  if (typeof m.conversation === "string") return { type: "text", body: m.conversation };
  if (m.extendedTextMessage?.text) return { type: "text", body: m.extendedTextMessage.text };
  if (m.imageMessage)
    return { type: "image", body: m.imageMessage.caption, mimeType: m.imageMessage.mimetype };
  if (m.audioMessage)
    return {
      type: "audio",
      mimeType: m.audioMessage.mimetype,
      durationSeconds: Number(m.audioMessage.seconds) || undefined,
    };
  if (m.videoMessage)
    return { type: "video", body: m.videoMessage.caption, mimeType: m.videoMessage.mimetype };
  if (m.documentMessage)
    return {
      type: "document",
      mimeType: m.documentMessage.mimetype,
      fileName: m.documentMessage.fileName,
    };
  return { type: "text", body: "[mensagem não suportada]" };
}

export function isMediaMessageType(type: ParsedEvolutionMessage["type"]): boolean {
  return type === "image" || type === "audio" || type === "video" || type === "document";
}

/** Nomes de evento aceitos, nas duas grafias que a Evolution usa. */
export function normalizeEvolutionEvent(event: string | null | undefined):
  | "messages.upsert"
  | "connection.update"
  | "other" {
  const value = (event ?? "").trim().toLowerCase();
  if (value === "messages.upsert" || value === "messages_upsert") return "messages.upsert";
  if (value === "connection.update" || value === "connection_update") return "connection.update";
  return "other";
}

// ---------------------------------------------------------------------------
// Resolução de canal e empresa
// ---------------------------------------------------------------------------

export async function findChannelByInstance(
  sql: SqlExecutor,
  instance: string,
): Promise<EvolutionChannelRow | null> {
  const rows = await sql<EvolutionChannelRow[]>`
    SELECT id, company_id, evolution_instance_name, name
    FROM public.whatsapp_channels
    WHERE lower(channel_type) = 'evolution'
      AND evolution_instance_name = ${instance}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Contato
// ---------------------------------------------------------------------------

export async function upsertContact(
  sql: SqlExecutor,
  params: {
    companyId: string;
    phone: string;
    externalJid: string;
    name: string | undefined;
    fromMe: boolean;
  },
  log: LogFn = defaultLog,
): Promise<string> {
  // Chave canônica tolerante ao nono dígito BR (com/sem 9 = mesmo contato).
  const phoneMatch = normalizePhoneForMatch(params.phone);
  // Um telefone = um único contato. Procura por phone_match (variante equivalente).
  // Prioriza o contato ATIVO; se só houver inativo/merged, reaproveita (nunca cria outro).
  const existing = await sql<
    { id: string; name: string | null; name_source: string | null; status: string | null }[]
  >`
    SELECT id, name, name_source, status FROM public.contacts
    WHERE company_id = ${params.companyId}::uuid AND phone_match = ${phoneMatch}
    ORDER BY (status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo') DESC,
             created_at ASC
    LIMIT 1
  `;
  if (existing[0]) {
    const c = existing[0];
    const cur = c.name;
    const isManual = c.name_source === "manual";
    const isPlaceholder = !cur || cur.trim() === "" || cur === params.phone;
    // Nome manual NUNCA é sobrescrito pelo pushName do WhatsApp. Só atualiza
    // quando não é manual E o nome atual é vazio/igual ao telefone/placeholder.
    if (!params.fromMe && params.name && params.name.trim() && !isManual && isPlaceholder) {
      await sql`
        UPDATE public.contacts
        SET name = ${params.name}, name_source = 'whatsapp', updated_at = now()
        WHERE id = ${c.id}::uuid
      `;
    }
    // Reaproveita contato inativo: reativa preservando todo o histórico.
    if (c.status === "inativo") {
      await sql`UPDATE public.contacts SET status = 'ativo', updated_at = now() WHERE id = ${c.id}::uuid`;
      log("CONTACT_REACTIVATED", { id: c.id });
    }
    return c.id;
  }
  // Novo contato automático. Regra: nunca usa nome próprio quando fromMe=true.
  const finalName = params.fromMe
    ? params.phone
    : params.name && params.name.trim()
      ? params.name
      : params.phone;
  const nameSource = !params.fromMe && params.name && params.name.trim() ? "whatsapp" : "auto";
  try {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO public.contacts
        (company_id, phone, phone_match, name, name_source, external_jid, contact_type)
      VALUES
        (${params.companyId}::uuid, ${params.phone}, ${phoneMatch}, ${finalName}, ${nameSource}, ${params.externalJid}, 'individual')
      RETURNING id
    `;
    return inserted[0].id;
  } catch (e) {
    // Corrida: outro processo criou o mesmo contato (variante). Reaproveita.
    const again = await sql<{ id: string }[]>`
      SELECT id FROM public.contacts
      WHERE company_id = ${params.companyId}::uuid AND phone_match = ${phoneMatch}
      ORDER BY (status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo') DESC,
               created_at ASC
      LIMIT 1
    `;
    if (again[0]) return again[0].id;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

export async function upsertConversation(
  sql: SqlExecutor,
  params: { companyId: string; channelId: string; contactId: string },
  log: LogFn = defaultLog,
): Promise<string> {
  // Um contato + um canal = uma única conversa principal. Reaproveita a conversa
  // existente em QUALQUER status (a mais recente). Nunca cria outra por diferença
  // de nome/pushName. Se estiver fechada, reabre ao chegar nova mensagem.
  const existing = await sql<{ id: string; status: string | null }[]>`
    SELECT id, status FROM public.conversations
    WHERE company_id = ${params.companyId}::uuid
      AND whatsapp_channel_id = ${params.channelId}::uuid
      AND contact_id = ${params.contactId}::uuid
      AND status IS DISTINCT FROM 'merged'
      AND status IS DISTINCT FROM 'archived'
    ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
  `;
  if (existing.length > 1) {
    // Bloqueador conhecido: sem UNIQUE no banco, duplicatas podem existir.
    // Usamos a principal e registramos para saneamento — não criamos a terceira.
    log("CONVERSATION_DUPLICATE_DETECTED", {
      companyId: params.companyId,
      channelId: params.channelId,
      contactId: params.contactId,
      count: existing.length,
      chosenId: existing[0].id,
      note: "Aplicar docs/migrations/20260809_conversations_unique_proposed.sql após dedup",
    });
  }
  if (existing[0]) {
    if (existing[0].status !== "open") {
      await sql`UPDATE public.conversations SET status = 'open', updated_at = now() WHERE id = ${existing[0].id}::uuid`;
    }
    return existing[0].id;
  }
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.conversations
      (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
    VALUES
      (${params.companyId}::uuid, ${params.contactId}::uuid, ${params.channelId}::uuid, 'open', 1, now())
    RETURNING id
  `;
  return inserted[0].id;
}

// ---------------------------------------------------------------------------
// Download de mídia (somente no modo inline da rota legada)
// ---------------------------------------------------------------------------

export type MediaResult = {
  base64: string | null;
  mimetype: string | null;
  error: string | null;
};

export async function downloadMediaFromEvolution(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawMessage: any,
  fallbackMime: string | undefined,
): Promise<MediaResult> {
  const apiUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const key = rawMessage?.key ?? {};
  const externalId: string | undefined = key?.id;
  const instance: string | undefined = rawMessage?.instance ?? rawMessage?.instanceName;

  const endpointPath = instance
    ? `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`
    : null;
  const baseErr = {
    endpoint: endpointPath,
    instance: instance ?? null,
    messageId: externalId ?? null,
    headers: { apikey: "EVOLUTION_API_KEY", "Content-Type": "application/json" },
    requestBody: { message: "<rawMessage>" },
  };

  if (!apiUrl || !apiKey || !instance || !externalId) {
    return {
      base64: null,
      mimetype: fallbackMime ?? null,
      error: JSON.stringify({
        reason: "missing_config",
        ...baseErr,
        hasApiUrl: !!apiUrl,
        hasApiKey: !!apiKey,
        hasInstance: !!instance,
        hasMessageId: !!externalId,
      }),
    };
  }

  console.log("[MEDIA_DECRYPT_START]", { instance, externalId });
  const url = `${apiUrl.replace(/\/+$/, "")}${endpointPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);

  try {
    console.log("[MEDIA_DECRYPT_REQUEST]", { url, instance, externalId });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ message: rawMessage }),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    console.log("[MEDIA_DECRYPT_RESPONSE]", { status: res.status, length: text.length });

    if (!res.ok) {
      return {
        base64: null,
        mimetype: fallbackMime ?? null,
        error: JSON.stringify({
          reason: "evolution_http_error",
          status: res.status,
          body: text.slice(0, 2000),
          ...baseErr,
        }),
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    let base64: string | null = parsed?.base64 ?? parsed?.data?.base64 ?? null;
    if (typeof base64 === "string" && base64.startsWith("data:")) {
      const comma = base64.indexOf(",");
      if (comma >= 0) base64 = base64.slice(comma + 1);
    }
    const mimetype: string =
      parsed?.mimetype ?? parsed?.mimeType ?? fallbackMime ?? "application/octet-stream";

    if (!base64 || base64.length < 50) {
      return {
        base64: null,
        mimetype,
        error: JSON.stringify({
          reason: "no_base64",
          status: res.status,
          body: text.slice(0, 2000),
          ...baseErr,
        }),
      };
    }

    console.log("[MEDIA_WEBHOOK_DOWNLOAD_OK]", {
      externalId,
      mimetype,
      base64Length: base64.length,
    });
    return { base64, mimetype, error: null };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[MEDIA_DECRYPT_FAIL]", { externalId, error: msg });
    return {
      base64: null,
      mimetype: fallbackMime ?? null,
      error: JSON.stringify({
        reason: isAbort ? "timeout" : "exception",
        error: msg,
        ...baseErr,
      }),
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Processamento de uma mensagem
// ---------------------------------------------------------------------------

/**
 * Como o anexo é tratado.
 *
 * `inline` reproduz a rota legada: baixa antes do INSERT e grava o base64 na
 * própria mensagem. `job` é o caminho do worker: nenhuma chamada externa, o
 * anexo vira tarefa em webhook_media_jobs.
 */
export type EvolutionMediaStrategy =
  | { mode: "inline" }
  | { mode: "job"; inboxId: string };

export type ProcessEvolutionMessageResult = {
  skipped: "no_remote_jid" | "group" | "invalid_phone" | null;
  contactId: string | null;
  conversationId: string | null;
  messageId: string | null;
  /** false quando a mensagem já existia (reentrega ou retry). */
  messageCreated: boolean;
  mediaJobId: string | null;
  mediaJobCreated: boolean;
  campaignJobId: string | null;
  campaignJobCreated: boolean;
  /** Preenchido quando o inbound merece consulta de campanha. */
  campaignCandidate: {
    companyId: string;
    channelId: string;
    conversationId: string;
    phone: string;
    responseText: string | null;
    allowEmptyText: boolean;
    inboundMessageId: string;
  } | null;
};

export async function processEvolutionMessageNode(params: {
  sql: SqlExecutor;
  channel: EvolutionChannelRow;
  /** Um item de `data` do webhook. */
  node: Json;
  /** Corpo completo, gravado como raw_payload (igual ao fluxo legado). */
  fullPayload: Json;
  media: EvolutionMediaStrategy;
  log?: LogFn;
}): Promise<ProcessEvolutionMessageResult> {
  const log = params.log ?? defaultLog;
  const sql = params.sql;
  const channel = params.channel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = params.node as any;
  const key = msg?.key ?? {};
  const remoteJid: string | undefined = key.remoteJid;
  const fromMe: boolean = key.fromMe === true;
  const pushName: string | undefined = msg?.pushName;

  const empty: ProcessEvolutionMessageResult = {
    skipped: null,
    contactId: null,
    conversationId: null,
    messageId: null,
    messageCreated: false,
    mediaJobId: null,
    mediaJobCreated: false,
    campaignJobId: null,
    campaignJobCreated: false,
    campaignCandidate: null,
  };

  if (!remoteJid) {
    log("IGNORED_NO_REMOTE_JID");
    return { ...empty, skipped: "no_remote_jid" };
  }
  if (remoteJid.endsWith("@g.us")) {
    log("IGNORED_GROUP", { remoteJid });
    return { ...empty, skipped: "group" };
  }

  const phone = normalizePhoneE164(remoteJid, { defaultCountry: "BR" });
  if (!isValidE164Digits(phone)) {
    log("INVALID_PHONE_BLOCKED", { remoteJid, phone });
    return { ...empty, skipped: "invalid_phone" };
  }

  log("CONTACT_NORMALIZATION", { fromMe, remoteJid, phone, pushName });
  const parsed = pickMessageType(msg);

  const contactId = await upsertContact(
    sql,
    { companyId: channel.company_id, phone, externalJid: remoteJid, name: pushName, fromMe },
    log,
  );
  log("EVOLUTION_CONTACT_UPSERT", { contactId, phone, fromMe });
  const conversationId = await upsertConversation(
    sql,
    {
      companyId: channel.company_id,
      channelId: channel.id,
      contactId,
    },
    log,
  );
  log("EVOLUTION_CONVERSATION_UPSERT", { conversationId, channelId: channel.id });

  const isMedia = isMediaMessageType(parsed.type);
  let mediaBase64: string | null = null;
  let mimeType: string | null = parsed.mimeType ?? null;
  let mediaError: string | null = null;
  let mediaStatus: string | null = null;

  if (isMedia && params.media.mode === "inline") {
    // Inclui o nome da instância no payload para o helper resolver o endpoint.
    const enriched = { ...msg, instance: channel.evolution_instance_name };
    const r = await downloadMediaFromEvolution(enriched, parsed.mimeType);
    if (r.base64) {
      mediaBase64 = r.base64;
      mimeType = r.mimetype ?? mimeType;
    } else {
      mediaError = r.error;
      mimeType = r.mimetype ?? mimeType;
    }
    if (!mediaBase64 && !mediaError) {
      mediaError = "MEDIA_DOWNLOAD_NOT_EXECUTED_OR_FAILED";
    }
  } else if (isMedia) {
    // Modo job: o anexo ainda não existe localmente, e isso não é um erro.
    mediaStatus = "pending";
  }

  const externalId: string | null = key?.id ?? null;
  const direction = fromMe ? "out" : "in";
  const lastMessageText = parsed.body ?? (isMedia ? `[${parsed.type}]` : null);

  log("WEBHOOK_MEDIA_DEBUG", {
    messageType: parsed.type,
    mediaType: isMedia ? parsed.type : null,
    isMedia,
    mediaMode: params.media.mode,
    instanceName: channel.evolution_instance_name,
    externalId,
  });

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload,
      media_type, media_mimetype, mime_type, media_filename,
      media_caption, media_base64, media_error, media_url, status,
      reaction_emoji, reaction_to_message_id
    ) VALUES (
      ${conversationId}::uuid, ${externalId}, ${externalId}, ${direction},
      ${parsed.type}, ${parsed.body ?? null}, ${fromMe}, ${params.fullPayload}::jsonb,
      ${isMedia ? parsed.type : null}, ${mimeType}, ${mimeType}, ${parsed.fileName ?? null},
      ${parsed.body ?? null}, ${mediaBase64}, ${mediaError}, ${null}, 'received',
      ${parsed.reactionEmoji ?? null}, ${parsed.reactionToId ?? null}
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;

  let messageId = inserted[0]?.id ?? null;
  const messageCreated = !!inserted[0];

  if (messageCreated) {
    log("EVOLUTION_MESSAGE_SAVED", {
      messageId,
      conversationId,
      direction,
      type: parsed.type,
    });
  } else if (externalId) {
    // Reentrega da mesma mensagem. Recupera o id para poder reparar etapas
    // que porventura não tenham sido concluídas (a tarefa de mídia, por
    // exemplo) sem criar nada em duplicidade.
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM public.messages
      WHERE conversation_id = ${conversationId}::uuid
        AND external_message_id = ${externalId}
      LIMIT 1
    `;
    messageId = existing[0]?.id ?? null;
  }

  if (messageCreated && mediaBase64 && messageId) {
    // Após termos o id, gravamos uma URL servida pela própria API.
    const mediaUrl = `/api/messages/${messageId}/media`;
    await sql`UPDATE public.messages SET media_url = ${mediaUrl} WHERE id = ${messageId}::uuid`;
  }

  let mediaJobId: string | null = null;
  let mediaJobCreated = false;
  if (isMedia && params.media.mode === "job" && messageId) {
    // media_status fica FORA do INSERT de propósito: assim a rota legada, que
    // nunca entra aqui, continua funcionando sem a coluna nova — a migration
    // da etapa 3 vira pré-requisito só do worker, não do web.
    if (mediaStatus) {
      await sql`
        UPDATE public.messages
        SET media_status = ${mediaStatus}
        WHERE id = ${messageId}::uuid AND media_status IS NULL
      `;
    }

    const job = await ensureMediaJob(sql, {
      inboxId: params.media.inboxId,
      messageId,
      provider: "evolution",
      channelId: channel.id,
      instanceName: channel.evolution_instance_name,
      externalMessageId: externalId,
      mediaType: parsed.type,
      mimeType,
      fileName: parsed.fileName ?? null,
      mediaReference: buildEvolutionMediaReference({
        ...msg,
        instance: channel.evolution_instance_name,
      }),
    });
    mediaJobId = job.mediaJobId;
    mediaJobCreated = job.created;
    log(job.created ? "MEDIA_JOB_CREATED" : "MEDIA_JOB_DUPLICATE", {
      mediaJobId,
      messageId,
      mediaType: parsed.type,
    });
  }

  // A conversa só avança quando a mensagem é nova. Reprocessar um evento já
  // gravado não pode somar unread_count de novo nem reescrever a última
  // mensagem com um texto antigo.
  if (messageCreated) {
    await sql`
      UPDATE public.conversations
      SET last_message = ${lastMessageText},
          last_message_at = now(),
          unread_count = CASE WHEN ${fromMe} THEN unread_count ELSE COALESCE(unread_count,0) + 1 END,
          updated_at = now()
      WHERE id = ${conversationId}::uuid
    `;
  }

  // Resposta a disparo de campanha (texto ou mídia).
  // No modo job (worker): a tarefa nasce NA MESMA transação. O processamento
  // imediato pós-COMMIT é só otimização.
  // No modo inline (legado): devolve o candidato para a rota chamar o hook
  // como sempre fez — sem tabela de jobs (inbox pode não existir).
  let campaignCandidate: ProcessEvolutionMessageResult["campaignCandidate"] = null;
  let campaignJobId: string | null = null;
  let campaignJobCreated = false;
  if (!fromMe && messageCreated && messageId) {
    const isText = parsed.type === "text" && !!parsed.body;
    const isMediaReply = ["image", "audio", "document", "video"].includes(parsed.type);
    if (isText || isMediaReply) {
      campaignCandidate = {
        companyId: channel.company_id,
        channelId: channel.id,
        conversationId,
        phone,
        responseText: isText ? parsed.body! : (parsed.body ?? null),
        allowEmptyText: isMediaReply,
        inboundMessageId: messageId,
      };
      if (params.media.mode === "job") {
        const job = await ensureCampaignJob(sql, {
          inboxId: params.media.inboxId,
          messageId,
          companyId: channel.company_id,
          channelId: channel.id,
          conversationId,
          externalMessageId: externalId,
          phone,
          responseText: campaignCandidate.responseText,
          allowEmptyText: campaignCandidate.allowEmptyText,
        });
        campaignJobId = job.campaignJobId;
        campaignJobCreated = job.created;
        log(job.created ? "WEBHOOK_CAMPAIGN_JOB_CREATED" : "WEBHOOK_CAMPAIGN_JOB_DUPLICATE", {
          campaignJobId,
          messageId,
        });
      }
    }
  }

  return {
    skipped: null,
    contactId,
    conversationId,
    messageId,
    messageCreated,
    mediaJobId,
    mediaJobCreated,
    campaignJobId,
    campaignJobCreated,
    campaignCandidate,
  };
}

// ---------------------------------------------------------------------------
// Processamento do evento inteiro
// ---------------------------------------------------------------------------

export type EvolutionProcessingResult =
  | {
      status: "ok";
      companyId: string;
      channelId: string;
      instance: string;
      event: string;
      messages: ProcessEvolutionMessageResult[];
    }
  | { status: "missing_instance" }
  | { status: "channel_not_found"; instance: string; event: string }
  | { status: "channel_without_company"; instance: string; channelId: string; event: string };

/**
 * Resolve canal e empresa e despacha o evento.
 *
 * É o mesmo caminho para a rota legada e para o worker; o que muda é só o
 * `sql` (pool em autocommit ou transação) e a estratégia de mídia. Nenhuma
 * `Response` é construída aqui — quem chamou decide o que fazer com o
 * resultado.
 */
export async function processEvolutionInboxEvent(params: {
  sql: SqlExecutor;
  payload: Json;
  media: EvolutionMediaStrategy;
  log?: LogFn;
}): Promise<EvolutionProcessingResult> {
  const log = params.log ?? defaultLog;
  const sql = params.sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = params.payload as any;

  const event = typeof body?.event === "string" ? body.event : "unknown";
  const instance = body?.instance ?? body?.data?.instance;
  if (!instance) {
    log("WEBHOOK_MISSING_INSTANCE", { event });
    return { status: "missing_instance" };
  }

  const channel = await findChannelByInstance(sql, String(instance));
  if (!channel) {
    log("WEBHOOK_CHANNEL_NOT_FOUND", { instance, event });
    return { status: "channel_not_found", instance: String(instance), event };
  }

  // Isolamento oficial por company_id: a empresa é SEMPRE derivada do canal
  // (whatsapp_channels.company_id). Se o canal não tiver empresa válida, o
  // webhook é IGNORADO — nunca cria contato/conversa/mensagem, nunca usa
  // Empresa Padrão, nunca usa tenant_id.
  if (!channel.company_id) {
    log("WEBHOOK_CHANNEL_WITHOUT_COMPANY", {
      instance,
      channelId: channel.id,
      event,
      note: "Canal sem empresa vinculada. Webhook ignorado.",
    });
    return {
      status: "channel_without_company",
      instance: String(instance),
      channelId: channel.id,
      event,
    };
  }

  const messages: ProcessEvolutionMessageResult[] = [];
  const kind = normalizeEvolutionEvent(event);

  if (kind === "messages.upsert") {
    const items = Array.isArray(body.data) ? body.data : [body.data];
    for (const item of items) {
      if (!item) continue;
      messages.push(
        await processEvolutionMessageNode({
          sql,
          channel,
          node: item as Json,
          fullPayload: params.payload,
          media: params.media,
          log,
        }),
      );
    }
  } else if (kind === "connection.update") {
    await handleConnectionUpdate(sql, channel, (body.data ?? body) as Json);
  }

  return {
    status: "ok",
    companyId: channel.company_id,
    channelId: channel.id,
    instance: String(instance),
    event,
    messages,
  };
}

export async function handleConnectionUpdate(
  sql: SqlExecutor,
  channel: EvolutionChannelRow,
  raw: Json,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (raw as any)?.state ?? (raw as any)?.connection;
  if (state === "open") {
    await sql`UPDATE public.whatsapp_channels SET status = 'connected', last_connected_at = now() WHERE id = ${channel.id}::uuid`;
  } else if (state === "close") {
    await sql`UPDATE public.whatsapp_channels SET status = 'disconnected' WHERE id = ${channel.id}::uuid`;
  }
}
