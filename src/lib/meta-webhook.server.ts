// Webhook Meta WhatsApp Cloud API — validação, sanitização e auditoria.
// Nunca logar tokens, headers sensíveis ou payload bruto com segredos.

import { createHmac, timingSafeEqual } from "crypto";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  buildMetaWebhookAuditPayload,
  extractMetaEventTypes,
  extractMetaPhoneNumberIds,
  parseMetaWebhookPhones,
  sanitizeMetaWebhookPayload,
} from "@/lib/meta-webhook-parse";
import { loadMetaChannelByPhoneNumberId } from "@/lib/whatsapp/whatsapp-provider-router.server";
import { persistMetaInboundTextMessages } from "@/lib/meta-inbound-message.server";
import { unwrapMetaWebhookBody } from "@/lib/meta-inbound-parse";

export type {
  MetaParsedPhoneField,
  MetaWebhookParsedChange,
} from "@/lib/meta-webhook-parse";
export {
  buildMetaWebhookAuditPayload,
  extractMetaEventTypes,
  extractMetaPhoneNumberIds,
  parseMetaPhoneField,
  parseMetaWebhookPhones,
  sanitizeMetaWebhookPayload,
} from "@/lib/meta-webhook-parse";

function metaAppVerifyToken(): string | null {
  const value = process.env.META_APP_VERIFY_TOKEN?.trim();
  return value || null;
}

function metaAppSecret(): string | null {
  const value = process.env.META_APP_SECRET?.trim();
  return value || null;
}

export function validateMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = metaAppSecret();
  if (!secret || !signatureHeader) return false;

  const match = signatureHeader.match(/^sha256=(.+)$/i);
  if (!match?.[1]) return false;

  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const receivedHex = match[1].trim();

  try {
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const receivedBuf = Buffer.from(receivedHex, "hex");
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

async function insertMetaWebhookLog(params: {
  companyId: string | null;
  channelId: string | null;
  phoneNumberId: string | null;
  eventType: string | null;
  signatureValid: boolean;
  processingStatus: string;
  httpStatus: number;
  payload: unknown;
  error?: string | null;
}): Promise<void> {
  await ensureCrmSchema();
  const s = sql();
  const safePayload = sanitizeMetaWebhookPayload(params.payload);

  await s`
    INSERT INTO public.meta_webhook_event_logs (
      company_id, channel_id, phone_number_id, event_type,
      signature_valid, processing_status, http_status, payload, error
    ) VALUES (
      ${params.companyId}::uuid,
      ${params.channelId}::uuid,
      ${params.phoneNumberId},
      ${params.eventType},
      ${params.signatureValid},
      ${params.processingStatus},
      ${params.httpStatus},
      ${JSON.stringify(safePayload)}::jsonb,
      ${params.error ?? null}
    )
  `;
}

async function touchChannelLastWebhookAt(channelId: string): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.whatsapp_channels
    SET last_webhook_at = now(), updated_at = now()
    WHERE id = ${channelId}::uuid
  `;
}

/** GET — verificação do webhook (hub.challenge). Usa apenas META_APP_VERIFY_TOKEN. */
export function handleMetaWebhookGET(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = metaAppVerifyToken();
  if (!expected) {
    return new Response("Forbidden", { status: 403 });
  }

  if (mode !== "subscribe" || !verifyToken || !challenge || verifyToken !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** POST — ingestão de eventos Meta com validação de assinatura. */
export async function handleMetaWebhookPOST(request: Request): Promise<Response> {
  if (!metaAppSecret()) {
    return new Response("Service unavailable", { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");

  if (!validateMetaWebhookSignature(rawBody, signatureHeader)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { parse_error: true };
  }

  const phoneNumberIds = extractMetaPhoneNumberIds(payload);
  const phoneNumberId = phoneNumberIds[0] ?? null;
  const eventTypes = extractMetaEventTypes(payload);
  const eventType = eventTypes.length > 0 ? eventTypes.join(",") : null;
  const parsedPhones = parseMetaWebhookPhones(payload);
  const auditPayload = buildMetaWebhookAuditPayload(payload, parsedPhones);

  let channelId: string | null = null;
  let companyId: string | null = null;
  let processingStatus = "ignored";

  if (phoneNumberId) {
    const channel = await loadMetaChannelByPhoneNumberId(phoneNumberId);
    if (channel) {
      channelId = channel.id;
      companyId = channel.companyId;
      processingStatus = "processed";
      await touchChannelLastWebhookAt(channel.id);
    }
  }

  let persistError: string | null = null;
  if (companyId && channelId) {
    try {
      await ensureCrmSchema();
      const webhookBody = unwrapMetaWebhookBody(payload) ?? payload;
      const persistResult = await persistMetaInboundTextMessages(webhookBody);
      if (persistResult.saved > 0) {
        processingStatus = "persisted";
      } else if (persistResult.processed === 0) {
        processingStatus = "processed";
      } else if (persistResult.errors > 0) {
        processingStatus = "persist_error";
        persistError = `errors=${persistResult.errors}`;
      }
      console.log("[META_INBOUND_PERSIST]", persistResult);
    } catch (e) {
      persistError = e instanceof Error ? e.message : String(e);
      processingStatus = "persist_error";
      console.error("[META_INBOUND_PERSIST_FAIL]", { error: persistError });
    }
  }

  try {
    await insertMetaWebhookLog({
      companyId,
      channelId,
      phoneNumberId,
      eventType,
      signatureValid: true,
      processingStatus,
      httpStatus: 200,
      payload: auditPayload,
      error: persistError,
    });
  } catch (e) {
    console.error("[META_WEBHOOK_LOG_FAIL]", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
