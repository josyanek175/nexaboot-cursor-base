// Webhook Meta WhatsApp Cloud API — validação, sanitização e auditoria.
// Nunca logar tokens, headers sensíveis ou payload bruto com segredos.

import { createHmac, timingSafeEqual } from "crypto";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { loadMetaChannelByPhoneNumberId } from "@/lib/whatsapp/whatsapp-provider-router.server";

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "access_token",
  "authorization",
  "token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "webhook_verify_token",
  "access_token_ciphertext",
]);

function metaAppVerifyToken(): string | null {
  const value = process.env.META_APP_VERIFY_TOKEN?.trim();
  return value || null;
}

function metaAppSecret(): string | null {
  const value = process.env.META_APP_SECRET?.trim();
  return value || null;
}

/** Sanitiza payload antes de persistir em meta_webhook_event_logs. */
export function sanitizeMetaWebhookPayload(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetaWebhookPayload(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitizeMetaWebhookPayload(nested, depth + 1);
    }
  }
  return out;
}

/** Extrai phone_number_id(s) do payload padrão da Meta Cloud API. */
export function extractMetaPhoneNumberIds(payload: unknown): string[] {
  const ids = new Set<string>();
  if (!payload || typeof payload !== "object") return [];

  const entries = Array.isArray((payload as Record<string, unknown>).entry)
    ? ((payload as Record<string, unknown>).entry as unknown[])
    : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as unknown[])
      : [];

    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const metadata = (value as Record<string, unknown>).metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const phoneNumberId = (metadata as Record<string, unknown>).phone_number_id;
      if (typeof phoneNumberId === "string" && phoneNumberId.trim()) {
        ids.add(phoneNumberId.trim());
      }
    }
  }

  return [...ids];
}

/** Extrai tipos de evento (fields) do payload Meta. */
export function extractMetaEventTypes(payload: unknown): string[] {
  const types = new Set<string>();
  if (!payload || typeof payload !== "object") return [];

  const objectType = (payload as Record<string, unknown>).object;
  if (typeof objectType === "string" && objectType.trim()) {
    types.add(objectType.trim());
  }

  const entries = Array.isArray((payload as Record<string, unknown>).entry)
    ? ((payload as Record<string, unknown>).entry as unknown[])
    : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as unknown[])
      : [];

    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const field = (change as Record<string, unknown>).field;
      if (typeof field === "string" && field.trim()) {
        types.add(field.trim());
      }
    }
  }

  return [...types];
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

  try {
    await insertMetaWebhookLog({
      companyId,
      channelId,
      phoneNumberId,
      eventType,
      signatureValid: true,
      processingStatus,
      httpStatus: 200,
      payload,
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
