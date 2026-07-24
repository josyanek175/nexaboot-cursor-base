// Download de mídia inbound Meta WhatsApp Cloud API (Graph API).
// Nunca logar token nem URL assinada completa.

import { loadMetaAccessTokenDetailed } from "@/lib/meta-access-token.server";

export function metaGraphApiVersion(): string {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
}

export type MetaMediaDownloadParams = {
  channelId: string;
  companyId: string;
  phoneNumberId: string;
  mediaId: string;
  messageId: string;
  mediaType: string;
};

export type MetaMediaDownloadResult =
  | {
      ok: true;
      base64: string;
      mimeType: string;
      fileSize: number;
      filename: string | null;
    }
  | {
      ok: false;
      error: string;
    };

function sanitizeMetaMediaError(reason: string, extra?: Record<string, unknown>): string {
  const payload = { reason, ...extra };
  try {
    return JSON.stringify(payload);
  } catch {
    return reason;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Baixa mídia Meta via Graph API (metadados + binário). */
export async function downloadMetaMediaWithToken(
  token: string,
  params: Omit<MetaMediaDownloadParams, never> & { mimeHint?: string | null; filenameHint?: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<MetaMediaDownloadResult & { filename: string | null }> {
  const { channelId, companyId, phoneNumberId, mediaId, messageId, mediaType, mimeHint, filenameHint } =
    params;

  console.log("[META_MEDIA_DOWNLOAD_START]", {
    channelId,
    companyId,
    mediaId,
    messageId,
    mediaType,
    mimeType: mimeHint ?? null,
    size: null,
  });

  const graphVersion = metaGraphApiVersion();
  const metadataUrl =
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}` +
    `?phone_number_id=${encodeURIComponent(phoneNumberId)}`;

  const metaRes = await fetchFn(metadataUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const metaText = await metaRes.text().catch(() => "");

  if (!metaRes.ok) {
    const error = sanitizeMetaMediaError("metadata_http_error", {
      status: metaRes.status,
      body: metaText.slice(0, 500),
    });
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType: mimeHint ?? null,
      size: null,
      error: "metadata_http_error",
      status: metaRes.status,
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  let metaJson: Record<string, unknown>;
  try {
    metaJson = JSON.parse(metaText) as Record<string, unknown>;
  } catch {
    const error = sanitizeMetaMediaError("metadata_invalid_json");
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType: mimeHint ?? null,
      size: null,
      error: "metadata_invalid_json",
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  const graphError = readJsonRecord(metaJson.error);
  if (graphError) {
    const error = sanitizeMetaMediaError("metadata_graph_error", {
      code: graphError.code ?? null,
      message: readString(graphError.message),
    });
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType: mimeHint ?? null,
      size: null,
      error: "metadata_graph_error",
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  const mediaUrl = readString(metaJson.url);
  const mimeType = readString(metaJson.mime_type) ?? mimeHint ?? "application/octet-stream";
  const fileSizeRaw = metaJson.file_size;
  const fileSize =
    typeof fileSizeRaw === "number" && Number.isFinite(fileSizeRaw) ? fileSizeRaw : 0;

  if (!mediaUrl) {
    const error = sanitizeMetaMediaError("metadata_missing_url");
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType,
      size: fileSize || null,
      error: "metadata_missing_url",
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  console.log("[META_MEDIA_METADATA_OK]", {
    channelId,
    companyId,
    mediaId,
    messageId,
    mediaType,
    mimeType,
    size: fileSize || null,
  });

  const binRes = await fetchFn(mediaUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!binRes.ok) {
    const error = sanitizeMetaMediaError("binary_http_error", {
      status: binRes.status,
    });
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType,
      size: fileSize || null,
      error: "binary_http_error",
      status: binRes.status,
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  const buffer = await binRes.arrayBuffer();
  if (!buffer.byteLength) {
    const error = sanitizeMetaMediaError("binary_empty");
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType,
      size: 0,
      error: "binary_empty",
    });
    return { ok: false, error, filename: filenameHint ?? null };
  }

  const base64 = arrayBufferToBase64(buffer);
  const resolvedSize = fileSize > 0 ? fileSize : buffer.byteLength;

  console.log("[META_MEDIA_DOWNLOAD_OK]", {
    channelId,
    companyId,
    mediaId,
    messageId,
    mediaType,
    mimeType,
    size: resolvedSize,
  });

  return {
    ok: true,
    base64,
    mimeType,
    fileSize: resolvedSize,
    filename: filenameHint ?? null,
  };
}

/** Baixa mídia Meta usando token cifrado do canal. */
export async function downloadMetaMedia(
  params: MetaMediaDownloadParams & { mimeHint?: string | null; filenameHint?: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<MetaMediaDownloadResult & { filename: string | null }> {
  const { channelId, companyId, phoneNumberId, mediaId, messageId, mediaType } = params;

  const tokenResult = await loadMetaAccessTokenDetailed(channelId, companyId, {
    phoneNumberId,
    source: "meta_media_download",
  });

  if (!tokenResult.ok) {
    const error = sanitizeMetaMediaError("token_unavailable", {
      reason: tokenResult.reason,
    });
    console.error("[META_MEDIA_DOWNLOAD_FAIL]", {
      channelId,
      companyId,
      mediaId,
      messageId,
      mediaType,
      mimeType: params.mimeHint ?? null,
      size: null,
      error: tokenResult.reason,
    });
    return { ok: false, error, filename: params.filenameHint ?? null };
  }

  return downloadMetaMediaWithToken(tokenResult.token, params, fetchFn);
}
