// Envio de documento outbound Meta WhatsApp Cloud API (upload + send).

import { loadMetaAccessToken } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import { sanitizeMetaWebhookPayload } from "@/lib/meta-webhook-parse";
import { metaGraphApiVersion } from "@/lib/meta-media-download.server";
import { friendlyMetaSendError } from "@/lib/meta-send-message.server";

export type MetaDocumentSendInput = {
  channelId: string;
  companyId: string;
  phoneNumberId: string;
  toPhone: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  caption?: string | null;
};

export type MetaDocumentSendResult =
  | {
      ok: true;
      providerMessageId: string | null;
      mediaId: string;
      rawPayload: Record<string, unknown>;
    }
  | { ok: false; error: string; userMessage: string; errorCode?: string; httpStatus?: number };

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Upload binário para Graph API e retorna media_id. */
export async function uploadMetaDocumentMedia(
  token: string,
  phoneNumberId: string,
  buffer: Buffer,
  mimeType: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; mediaId: string } | { ok: false; error: string; errorCode?: string; httpStatus?: number }> {
  const graphVersion = metaGraphApiVersion();
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/media`;

  console.log("[META_DOCUMENT_UPLOAD_START]", {
    phoneNumberId,
    mimeType,
    size: buffer.length,
  });

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mimeType }),
    "upload",
  );

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const rawText = await res.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const errObj = readJsonRecord(parsed.error);
      const errorCode = errObj?.code != null ? String(errObj.code) : String(res.status);
      const errorMessage =
        errObj?.message != null ? String(errObj.message) : rawText.slice(0, 500) || "meta_upload_error";
      console.error("[META_DOCUMENT_UPLOAD_FAIL]", {
        status: res.status,
        errorCode,
        errorMessage: errorMessage.slice(0, 200),
      });
      return {
        ok: false,
        error: errorMessage,
        errorCode,
        httpStatus: res.status,
      };
    }

    const mediaId = typeof parsed.id === "string" ? parsed.id : null;
    if (!mediaId) {
      console.error("[META_DOCUMENT_UPLOAD_FAIL]", { error: "missing_media_id" });
      return { ok: false, error: "missing_media_id", httpStatus: res.status };
    }

    console.log("[META_DOCUMENT_UPLOAD_OK]", { mediaId, size: buffer.length });
    return { ok: true, mediaId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[META_DOCUMENT_UPLOAD_FAIL]", { error: error.slice(0, 200) });
    return { ok: false, error };
  }
}

/** Envia mensagem type=document referenciando media_id. */
export async function sendMetaDocumentMessage(
  token: string,
  phoneNumberId: string,
  toPhone: string,
  mediaId: string,
  fileName: string,
  caption: string | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<
  | { ok: true; providerMessageId: string | null; raw: Record<string, unknown> }
  | { ok: false; error: string; userMessage: string; errorCode?: string; httpStatus?: number }
> {
  const graphVersion = metaGraphApiVersion();
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  const toDigits = toPhone.replace(/\D/g, "");

  console.log("[META_DOCUMENT_SEND_START]", {
    phoneNumberId,
    to: toDigits.replace(/\d(?=\d{4})/g, "*"),
    mediaId,
    fileName,
  });

  const document: Record<string, unknown> = {
    id: mediaId,
    filename: fileName,
  };
  if (caption?.trim()) document.caption = caption.trim();

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toDigits,
    type: "document",
    document,
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const rawText = await res.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const errObj = readJsonRecord(parsed.error);
      const errorCode = errObj?.code != null ? String(errObj.code) : String(res.status);
      const errorMessage =
        errObj?.message != null ? String(errObj.message) : rawText.slice(0, 500) || "meta_send_error";
      console.error("[META_DOCUMENT_SEND_FAIL]", {
        status: res.status,
        errorCode,
        errorMessage: errorMessage.slice(0, 200),
      });
      return {
        ok: false,
        error: errorMessage,
        errorCode,
        userMessage: friendlyMetaSendError(errorCode, errorMessage),
        httpStatus: res.status,
      };
    }

    const messages = parsed.messages as Array<{ id?: string }> | undefined;
    const providerMessageId = messages?.[0]?.id ?? null;

    console.log("[META_DOCUMENT_SEND_OK]", { providerMessageId, mediaId });

    return {
      ok: true,
      providerMessageId,
      raw: sanitizeMetaWebhookPayload(parsed) as Record<string, unknown>,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[META_DOCUMENT_SEND_FAIL]", { error: error.slice(0, 200) });
    return {
      ok: false,
      error,
      userMessage: "Não foi possível enviar o documento",
    };
  }
}

/** Fluxo completo: token → upload → send. */
export async function sendMetaDocument(
  input: MetaDocumentSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<MetaDocumentSendResult> {
  const token = await loadMetaAccessToken(input.channelId, input.companyId, {
    phoneNumberId: input.phoneNumberId,
    source: "document_send",
  });
  if (!token) {
    return {
      ok: false,
      error: "missing_token",
      userMessage: "Token Meta inválido ou expirado. Reconfigure o access token do canal.",
      errorCode: "190",
    };
  }

  const upload = await uploadMetaDocumentMedia(
    token,
    input.phoneNumberId,
    input.buffer,
    input.mimeType,
    fetchFn,
  );
  if (!upload.ok) {
    return {
      ok: false,
      error: upload.error,
      userMessage: friendlyMetaSendError(upload.errorCode ?? null, upload.error),
      errorCode: upload.errorCode,
      httpStatus: upload.httpStatus,
    };
  }

  const send = await sendMetaDocumentMessage(
    token,
    input.phoneNumberId,
    input.toPhone,
    upload.mediaId,
    input.fileName,
    input.caption,
    fetchFn,
  );
  if (!send.ok) {
    return send;
  }

  const rawPayload = sanitizeMetaWebhookPayload({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.toPhone.replace(/\D/g, ""),
    type: "document",
    document: {
      id: upload.mediaId,
      filename: input.fileName,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
    },
    meta_message_id: send.providerMessageId,
  }) as Record<string, unknown>;

  return {
    ok: true,
    providerMessageId: send.providerMessageId,
    mediaId: upload.mediaId,
    rawPayload,
  };
}
