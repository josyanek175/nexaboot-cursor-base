// Webhook Meta WhatsApp Cloud API — validação, sanitização e auditoria.
// Nunca logar tokens, headers sensíveis ou payload bruto com segredos.

import { createHmac, timingSafeEqual } from "crypto";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  buildMetaWebhookAuditPayload,
  extractMetaEventTypes,
  extractMetaPhoneNumberIds,
  extractMetaWebhookChanges,
  parseMetaWebhookPhones,
  sanitizeMetaWebhookPayload,
} from "@/lib/meta-webhook-parse";
import {
  diagnoseMetaChannelByPhoneNumberId,
  loadMetaChannelByPhoneNumberId,
} from "@/lib/whatsapp/whatsapp-provider-router.server";
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

  console.log("[META_WEBHOOK_GET_RECEIVED]", {
    mode,
    hasChallenge: !!challenge,
    hasVerifyToken: !!verifyToken,
  });

  const expected = metaAppVerifyToken();
  if (!expected) {
    console.log("[META_WEBHOOK_VERIFY_FAIL]", { reason: "missing_verify_token_env" });
    return new Response("Forbidden", { status: 403 });
  }

  if (mode === "subscribe" && verifyToken && challenge && verifyToken === expected) {
    console.log("[META_WEBHOOK_VERIFY_SUCCESS]", { mode });
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  console.log("[META_WEBHOOK_VERIFY_FAIL]", {
    mode,
    hasChallenge: !!challenge,
    tokenMatch: verifyToken === expected,
  });
  return new Response("Forbidden", { status: 403 });
}

function logMetaWebhookChanges(payload: unknown): void {
  for (const change of extractMetaWebhookChanges(payload)) {
    console.log("[META_WEBHOOK_CHANGE]", {
      field: change.field,
      phoneNumberId: change.phoneNumberId,
      messageCount: change.messageCount,
      statusCount: change.statusCount,
    });

    if (change.phoneNumberId) {
      console.log("[META_WEBHOOK_PHONE_NUMBER_ID]", { phoneNumberId: change.phoneNumberId });
    }

    if (change.messageCount > 0) {
      console.log("[META_WEBHOOK_MESSAGE_IN]", {
        phoneNumberId: change.phoneNumberId,
        messageIds: change.messageIds,
        count: change.messageCount,
      });
    }

    if (change.statusCount > 0) {
      console.log("[META_WEBHOOK_STATUS]", {
        phoneNumberId: change.phoneNumberId,
        statusIds: change.statusIds,
        count: change.statusCount,
      });
    }
  }
}

function hasValidCompanyId(companyId: string | null | undefined): companyId is string {
  return !!companyId && companyId.trim() !== "" && companyId !== "null";
}

function metaWebhookOkResponse(): Response {
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** POST — ingestão de eventos Meta. Sempre responde 200 para evitar reenvio infinito. */
export async function handleMetaWebhookPOST(request: Request): Promise<Response> {
  let rawBody = "";
  let payload: unknown = {};
  let signatureValid = false;
  let phoneNumberId: string | null = null;
  let channelId: string | null = null;
  let companyId: string | null = null;
  let eventType: string | null = null;
  let processingStatus = "ignored";
  let persistError: string | null = null;
  let auditPayload: Record<string, unknown> = { body: {} };

  try {
    rawBody = await request.text();
    const signatureHeader = request.headers.get("x-hub-signature-256");

    console.log("[META_WEBHOOK_RECEIVED]", {
      contentLength: rawBody.length,
      hasSignature: !!signatureHeader,
    });

    console.log("[META_WEBHOOK_POST_RECEIVED]", {
      contentLength: rawBody.length,
      hasSignature: !!signatureHeader,
    });

    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = { parse_error: true };
    }

    const phoneNumberIds = extractMetaPhoneNumberIds(payload);
    phoneNumberId = phoneNumberIds[0] ?? null;
    const eventTypes = extractMetaEventTypes(payload);
    eventType = eventTypes.length > 0 ? eventTypes.join(",") : null;
    const parsedPhones = parseMetaWebhookPhones(payload);
    const messageCount = parsedPhones.reduce((total, change) => total + change.messages.length, 0);

    auditPayload = buildMetaWebhookAuditPayload(payload, parsedPhones);
    logMetaWebhookChanges(payload);

    console.log("[META_WEBHOOK_POST_BODY]", {
      object: (payload as Record<string, unknown>)?.object ?? null,
      phoneNumberIds,
      changes: parsedPhones.length,
      messageCount,
      eventType,
    });

    if (phoneNumberId) {
      console.log("[META_WEBHOOK_PHONE_NUMBER_ID]", { phoneNumberId });
    }

    if (!metaAppSecret()) {
      console.error("[META_WEBHOOK_ERROR]", { reason: "missing_meta_app_secret", phoneNumberId });
      processingStatus = "error";
      persistError = "missing_meta_app_secret";
      await insertMetaWebhookLog({
        companyId: null,
        channelId: null,
        phoneNumberId,
        eventType,
        signatureValid: false,
        processingStatus,
        httpStatus: 200,
        payload: auditPayload,
        error: persistError,
      }).catch((e) => {
        console.error("[META_WEBHOOK_ERROR]", {
          reason: "audit_log_failed",
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return metaWebhookOkResponse();
    }

    if (!signatureHeader) {
      console.error("[META_WEBHOOK_ERROR]", {
        reason: "missing_signature",
        phoneNumberId,
        hint: "Meta sempre envia x-hub-signature-256; POST manual sem assinatura é ignorado",
      });
      processingStatus = "unauthorized";
      persistError = "missing_signature";
      await insertMetaWebhookLog({
        companyId: null,
        channelId: null,
        phoneNumberId,
        eventType,
        signatureValid: false,
        processingStatus,
        httpStatus: 200,
        payload: auditPayload,
        error: persistError,
      }).catch(() => undefined);
      return metaWebhookOkResponse();
    }

    signatureValid = validateMetaWebhookSignature(rawBody, signatureHeader);
    if (!signatureValid) {
      console.error("[META_WEBHOOK_ERROR]", {
        reason: "invalid_signature",
        phoneNumberId,
        hint: "Verifique META_APP_SECRET no EasyPanel vs App Secret no painel Meta",
      });
      processingStatus = "unauthorized";
      persistError = "invalid_signature";
      await insertMetaWebhookLog({
        companyId: null,
        channelId: null,
        phoneNumberId,
        eventType,
        signatureValid: false,
        processingStatus,
        httpStatus: 200,
        payload: auditPayload,
        error: persistError,
      }).catch((e) => {
        console.error("[META_WEBHOOK_ERROR]", {
          reason: "audit_log_failed",
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return metaWebhookOkResponse();
    }

    for (const change of parsedPhones) {
      for (const message of change.messages) {
        console.log("[META_MESSAGE_RECEIVED]", {
          phoneNumberId: change.phone_number_id,
          messageId: message.id,
          from: message.from.e164,
          type: message.type,
        });
      }
    }

    if (phoneNumberId) {
      const channel = await loadMetaChannelByPhoneNumberId(phoneNumberId);
      if (!channel) {
        const diagnosis = await diagnoseMetaChannelByPhoneNumberId(phoneNumberId);
        console.log("[META_WEBHOOK_CHANNEL_NOT_FOUND]", { phoneNumberId, diagnosis });
        console.log("[META_CHANNEL_NOT_FOUND]", { phoneNumberId, diagnosis });
      } else if (!hasValidCompanyId(channel.companyId)) {
        console.log("[META_WEBHOOK_COMPANY_NOT_FOUND]", {
          phoneNumberId,
          channelId: channel.id,
        });
        console.log("[META_CHANNEL_WITHOUT_COMPANY]", {
          phoneNumberId,
          channelId: channel.id,
        });
      } else {
        channelId = channel.id;
        companyId = channel.companyId;
        processingStatus = "processed";
        console.log("[META_CHANNEL_FOUND]", {
          phoneNumberId,
          channelId: channel.id,
          companyId: channel.companyId,
        });
        await touchChannelLastWebhookAt(channel.id);
      }
    }

    if (hasValidCompanyId(companyId) && channelId) {
      try {
        await ensureCrmSchema();
        const webhookBody = unwrapMetaWebhookBody(payload) ?? payload;
        const persistResult = await persistMetaInboundTextMessages(webhookBody);
        if (persistResult.saved > 0) {
          processingStatus = "persisted";
          console.log("[META_WEBHOOK_PERSISTED]", {
            phoneNumberId,
            channelId,
            companyId,
            saved: persistResult.saved,
            processed: persistResult.processed,
            skipped: persistResult.skipped,
            errors: persistResult.errors,
          });
        } else if (persistResult.processed === 0) {
          processingStatus = "processed";
        } else if (persistResult.errors > 0) {
          processingStatus = "persist_error";
          persistError = `errors=${persistResult.errors}`;
          console.error("[META_WEBHOOK_ERROR]", {
            reason: "persist_partial_failure",
            phoneNumberId,
            ...persistResult,
          });
        } else if (persistResult.skipped > 0) {
          processingStatus = "skipped";
        }
        console.log("[META_INBOUND_PERSIST]", persistResult);
      } catch (e) {
        persistError = e instanceof Error ? e.message : String(e);
        processingStatus = "persist_error";
        console.error("[META_WEBHOOK_ERROR]", { reason: "persist_failed", error: persistError, phoneNumberId });
      }
    }

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

    console.log("[META_WEBHOOK_POST_PROCESSED]", {
      phoneNumberId,
      channelId,
      processingStatus,
      persistError,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[META_WEBHOOK_ERROR]", { reason: "handler_exception", error });
    try {
      await insertMetaWebhookLog({
        companyId,
        channelId,
        phoneNumberId,
        eventType,
        signatureValid,
        processingStatus: "error",
        httpStatus: 200,
        payload: auditPayload,
        error,
      });
    } catch (logErr) {
      console.error("[META_WEBHOOK_ERROR]", {
        reason: "audit_log_failed",
        error: logErr instanceof Error ? logErr.message : String(logErr),
      });
    }
  }

  return metaWebhookOkResponse();
}
