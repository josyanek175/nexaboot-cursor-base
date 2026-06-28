// Webhook público da Evolution API — PostgreSQL externo (DATABASE_URL).
//
// Sem Supabase. Toda gravação usa postgres.js via src/lib/pg.server.ts.
// Armazenamento de mídia: base64 direto na coluna messages.media_base64
// (servido depois por /api/messages/:id/media).

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";

const PayloadSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

type Json = Record<string, unknown>;

type ChannelRow = {
  id: string;
  company_id: string;
  evolution_instance_name: string | null;
  name: string;
};

type ParsedMsg = {
  type: "text" | "image" | "audio" | "video" | "document" | "reaction";
  body?: string;
  mimeType?: string;
  fileName?: string;
  durationSeconds?: number;
  reactionEmoji?: string;
  reactionToId?: string;
};

function pickMessageType(msg: Json): ParsedMsg {
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

async function findChannelByInstance(instance: string): Promise<ChannelRow | null> {
  const s = sql();
  const rows = await s<ChannelRow[]>`
    SELECT id, company_id, evolution_instance_name, name
    FROM public.whatsapp_channels
    WHERE lower(channel_type) = 'evolution'
      AND evolution_instance_name = ${instance}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function upsertContact(
  companyId: string,
  phone: string,
  externalJid: string,
  name: string | undefined,
  fromMe: boolean,
): Promise<string> {
  const s = sql();
  const existing = await s<{ id: string; name: string | null }[]>`
    SELECT id, name FROM public.contacts
    WHERE company_id = ${companyId}::uuid AND phone = ${phone}
    LIMIT 1
  `;
  if (existing[0]) {
    const cur = existing[0].name;
    const isPlaceholder = !cur || cur.trim() === "" || cur === phone;
    // Regra: só atualiza nome quando fromMe=false e contato está sem nome real.
    if (!fromMe && name && name.trim() && isPlaceholder) {
      await s`UPDATE public.contacts SET name = ${name}, updated_at = now() WHERE id = ${existing[0].id}::uuid`;
    }
    return existing[0].id;
  }
  // Regra: nunca criar contato com nome próprio quando fromMe=true.
  const finalName = fromMe ? phone : (name && name.trim() ? name : phone);
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.contacts (company_id, phone, name, external_jid, contact_type)
    VALUES (${companyId}::uuid, ${phone}, ${finalName}, ${externalJid}, 'individual')
    ON CONFLICT (company_id, phone) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return inserted[0].id;
}

async function upsertConversation(
  companyId: string,
  channelId: string,
  contactId: string,
): Promise<string> {
  const s = sql();
  const existing = await s<{ id: string }[]>`
    SELECT id FROM public.conversations
    WHERE company_id = ${companyId}::uuid
      AND whatsapp_channel_id = ${channelId}::uuid
      AND contact_id = ${contactId}::uuid
      AND status = 'open'
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.conversations
      (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
    VALUES
      (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid, 'open', 1, now())
    RETURNING id
  `;
  return inserted[0].id;
}

type MediaResult = {
  base64: string | null;
  mimetype: string | null;
  error: string | null;
};

async function downloadMediaFromEvolution(
  rawMessage: any,
  fallbackMime: string | undefined,
): Promise<MediaResult> {
  const apiUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const key = rawMessage?.key ?? {};
  const externalId: string | undefined = key?.id;
  const instance: string | undefined = rawMessage?.instance ?? rawMessage?.instanceName;

  const endpointPath = instance ? `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}` : null;
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

    const parsed: any = (() => { try { return JSON.parse(text); } catch { return null; } })();
    let base64: string | null = parsed?.base64 ?? parsed?.data?.base64 ?? null;
    if (typeof base64 === "string" && base64.startsWith("data:")) {
      const comma = base64.indexOf(",");
      if (comma >= 0) base64 = base64.slice(comma + 1);
    }
    const mimetype: string = parsed?.mimetype ?? parsed?.mimeType ?? fallbackMime ?? "application/octet-stream";

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

    console.log("[MEDIA_WEBHOOK_DOWNLOAD_OK]", { externalId, mimetype, base64Length: base64.length });
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

async function handleMessagesUpsert(channel: ChannelRow, raw: Json, fullPayload: Json) {
  const msg = raw as any;
  const key = msg?.key ?? {};
  const remoteJid: string | undefined = key.remoteJid;
  const fromMe: boolean = key.fromMe === true;
  const pushName: string | undefined = msg?.pushName;

  if (!remoteJid) { console.log("[IGNORED_NO_REMOTE_JID]"); return; }
  if (remoteJid.endsWith("@g.us")) { console.log("[IGNORED_GROUP]", remoteJid); return; }

  const phone = remoteJid.replace("@s.whatsapp.net", "").replace("@lid", "").replace(/\D/g, "");
  if (!phone.startsWith("55") || phone.length < 12 || phone.length > 13) {
    console.log("[INVALID_PHONE_BLOCKED]", { remoteJid, phone });
    return;
  }

  console.log("[CONTACT_NORMALIZATION]", { fromMe, remoteJid, phone, pushName });
  const parsed = pickMessageType(msg);

  const contactId = await upsertContact(channel.company_id, phone, remoteJid, pushName, fromMe);
  console.log("[EVOLUTION_CONTACT_UPSERT]", { contactId, phone, fromMe });
  const conversationId = await upsertConversation(channel.company_id, channel.id, contactId);
  console.log("[EVOLUTION_CONVERSATION_UPSERT]", { conversationId, channelId: channel.id });

  let mediaBase64: string | null = null;
  let mimeType: string | null = parsed.mimeType ?? null;
  let mediaError: string | null = null;
  const isMedia = parsed.type !== "text" && parsed.type !== "reaction";

  if (isMedia) {
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
  }

  const externalId: string | null = key?.id ?? null;
  const direction = fromMe ? "out" : "in";
  const lastMessageText = parsed.body ?? (isMedia ? `[${parsed.type}]` : null);

  console.log("[WEBHOOK_MEDIA_DEBUG]", {
    messageType: parsed.type,
    mediaType: isMedia ? parsed.type : null,
    isMedia,
    hasEvolutionUrl: !!process.env.EVOLUTION_API_URL,
    hasEvolutionKey: !!process.env.EVOLUTION_API_KEY,
    instanceName: channel.evolution_instance_name,
    externalId,
  });

  if (isMedia && !mediaBase64 && !mediaError) {
    mediaError = "MEDIA_DOWNLOAD_NOT_EXECUTED_OR_FAILED";
  }

  const s = sql();
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload,
      media_type, media_mimetype, mime_type, media_filename,
      media_caption, media_base64, media_error, media_url, status,
      reaction_emoji, reaction_to_message_id
    ) VALUES (
      ${conversationId}::uuid, ${externalId}, ${externalId}, ${direction},
      ${parsed.type}, ${parsed.body ?? null}, ${fromMe}, ${fullPayload as any}::jsonb,
      ${isMedia ? parsed.type : null}, ${mimeType}, ${mimeType}, ${parsed.fileName ?? null},
      ${parsed.body ?? null}, ${mediaBase64}, ${mediaError}, ${null}, 'received',
      ${parsed.reactionEmoji ?? null}, ${parsed.reactionToId ?? null}
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;

  if (inserted[0]) {
    console.log("[EVOLUTION_MESSAGE_SAVED]", { messageId: inserted[0].id, conversationId, direction, type: parsed.type });
  }

  if (inserted[0] && mediaBase64) {
    // Após termos o id, gravamos uma URL servida pela própria API.
    const mediaUrl = `/api/messages/${inserted[0].id}/media`;
    await s`UPDATE public.messages SET media_url = ${mediaUrl} WHERE id = ${inserted[0].id}::uuid`;
  }

  await s`
    UPDATE public.conversations
    SET last_message = ${lastMessageText},
        last_message_at = now(),
        unread_count = CASE WHEN ${fromMe} THEN unread_count ELSE COALESCE(unread_count,0) + 1 END,
        updated_at = now()
    WHERE id = ${conversationId}::uuid
  `;
}

async function handleConnectionUpdate(channel: ChannelRow, raw: Json) {
  const s = sql();
  const state = (raw as any)?.state ?? (raw as any)?.connection;
  if (state === "open") {
    await s`UPDATE public.whatsapp_channels SET status = 'connected', last_connected_at = now() WHERE id = ${channel.id}::uuid`;
  } else if (state === "close") {
    await s`UPDATE public.whatsapp_channels SET status = 'disconnected' WHERE id = ${channel.id}::uuid`;
  }
}

/**
 * Lê o segredo do webhook em qualquer um dos formatos aceitos:
 * query ?token=, header x-webhook-secret ou header apikey.
 */
function readWebhookToken(request: Request): string {
  const url = new URL(request.url);
  return (
    url.searchParams.get("token") ||
    request.headers.get("x-webhook-secret") ||
    request.headers.get("apikey") ||
    ""
  );
}

/**
 * Validação central e obrigatória do EVOLUTION_WEBHOOK_SECRET.
 * Garante que NENHUM caminho chame a ingestão sem token válido.
 * Retorna null quando autorizado; uma Response de erro quando bloqueado.
 */
function checkWebhookAuth(request: Request): Response | null {
  console.log("[EVOLUTION_WEBHOOK_RECEIVED]");
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[EVOLUTION_WEBHOOK_AUTH_FAIL]", { reason: "secret_not_configured" });
    return Response.json({ error: "webhook_secret_not_configured" }, { status: 503 });
  }
  if (readWebhookToken(request) !== expected) {
    console.warn("[EVOLUTION_WEBHOOK_AUTH_FAIL]", { reason: "invalid_token" });
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  console.log("[EVOLUTION_WEBHOOK_AUTH_OK]");
  return null;
}

export async function handleEvolutionWebhookPOST(request: Request): Promise<Response> {
  // Segurança: validação obrigatória antes de qualquer leitura do corpo.
  const authError = checkWebhookAuth(request);
  if (authError) return authError;

  let body: z.infer<typeof PayloadSchema>;
  try {
    body = PayloadSchema.parse(await request.json());
  } catch (e) {
    console.log("[WEBHOOK_INVALID_PAYLOAD]", String(e));
    return new Response("Invalid payload", { status: 400 });
  }

  const event = body.event ?? "unknown";
  const instance = body.instance ?? (body as any)?.data?.instance;
  if (!instance) {
    console.log("[WEBHOOK_MISSING_INSTANCE]", event);
    return new Response("Missing instance", { status: 400 });
  }

  try {
    await ensureCrmSchema();
    const channel = await findChannelByInstance(String(instance));
    if (!channel) {
      console.log("[WEBHOOK_CHANNEL_NOT_FOUND]", { instance, event });
      return new Response("Channel not found", { status: 404 });
    }

    if (event === "messages.upsert" || event === "MESSAGES_UPSERT") {
      const items = Array.isArray((body as any).data) ? (body as any).data : [(body as any).data];
      for (const item of items) if (item) await handleMessagesUpsert(channel, item, body as Json);
    } else if (event === "connection.update" || event === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(channel, (body as any).data ?? body);
    }

    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[WEBHOOK_ERROR]", { event, instance, error: msg });
    return new Response("Server error", { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/webhooks/evolution")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ ok: true, service: "evolution-webhook" }), {
          headers: { "Content-Type": "application/json" },
        }),
      POST: async ({ request }) => handleEvolutionWebhookPOST(request),
    },
  },
});
