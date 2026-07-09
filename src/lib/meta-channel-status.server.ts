// Consulta status operacional do canal Meta via Graph API (server-only).

import {
  loadMetaAccessTokenDetailed,
  metaTokenErrorCode,
  metaTokenUserMessage,
} from "@/lib/meta-access-token.server";
import {
  clearMetaChannelError,
  recordMetaChannelError,
} from "@/lib/meta-channels.server";
import type {
  MetaGraphErrorDetail,
  WhatsAppChannelRecord,
} from "@/lib/whatsapp/providers/whatsapp-provider.types";

const PHONE_FIELDS = "id,display_phone_number,verified_name,quality_rating,platform_type";

export type MetaChannelLiveStatusResult = {
  ok: boolean;
  graphData?: Record<string, unknown> | null;
  wabaPhoneNumbers?: unknown;
  metaError?: MetaGraphErrorDetail | null;
};

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v20.0";
}

function parseMetaGraphError(
  body: Record<string, unknown>,
  httpStatus: number,
  source: MetaGraphErrorDetail["source"],
): MetaGraphErrorDetail {
  const err = body.error as Record<string, unknown> | undefined;
  return {
    code: err?.code ?? httpStatus,
    type: err?.type != null ? String(err.type) : null,
    message: err?.message != null ? String(err.message) : null,
    error_subcode: err?.error_subcode ?? null,
    fbtrace_id: err?.fbtrace_id != null ? String(err.fbtrace_id) : null,
    httpStatus,
    source,
  };
}

async function graphGet(
  path: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const version = graphVersion();
  const url = `https://graph.facebook.com/${version}/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    body = { error: { message: raw.slice(0, 500) || "invalid_json" } };
  }
  return { ok: res.ok, status: res.status, body };
}

/** Consulta Graph API pelo phone_number_id; fallback em WABA /phone_numbers. */
export async function fetchMetaChannelLiveStatus(
  channel: WhatsAppChannelRecord,
): Promise<MetaChannelLiveStatusResult> {
  const phoneNumberId = channel.phoneNumberId?.trim() || null;
  const wabaId = channel.wabaId?.trim() || null;
  const businessId = channel.businessId?.trim() || null;
  const version = graphVersion();
  const tokenResult = await loadMetaAccessTokenDetailed(channel.id, channel.companyId, {
    phoneNumberId,
    source: "status",
  });
  const token = tokenResult.ok ? tokenResult.token : null;
  const hasToken = !!token;

  const urlSemToken = phoneNumberId
    ? `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=${PHONE_FIELDS}`
    : null;

  console.log("[META_STATUS_REQUEST]", {
    channelId: channel.id,
    companyId: channel.companyId,
    phoneNumberId,
    wabaId,
    businessId,
    hasToken,
    graphVersion: version,
    urlSemToken,
  });

  if (!phoneNumberId) {
    const metaError: MetaGraphErrorDetail = {
      code: "missing_phone_number_id",
      type: "local",
      message: "Canal Meta sem phone_number_id",
      source: "local",
    };
    console.error("[META_STATUS_ERROR]", metaError);
    await recordMetaChannelError(
      channel.id,
      channel.companyId,
      String(metaError.code),
      metaError.message ?? "missing_phone_number_id",
    );
    return { ok: false, metaError };
  }

  if (!token) {
    const reason = tokenResult.ok ? "secret_not_found" : tokenResult.reason;
    const metaError: MetaGraphErrorDetail = {
      code: metaTokenErrorCode(reason),
      type: "local",
      message: tokenResult.ok ? metaTokenUserMessage("secret_not_found") : metaTokenUserMessage(reason),
      source: "local",
      tokenReason: reason,
    };
    console.error("[META_STATUS_ERROR]", metaError);
    await recordMetaChannelError(
      channel.id,
      channel.companyId,
      String(metaError.code),
      metaError.message ?? "missing_access_token",
    );
    return { ok: false, metaError };
  }

  const phoneRes = await graphGet(
    `${encodeURIComponent(phoneNumberId)}?fields=${PHONE_FIELDS}`,
    token,
  );

  if (phoneRes.ok) {
    console.log("[META_STATUS_RESPONSE]", {
      status: phoneRes.status,
      ok: true,
      responseBody: phoneRes.body,
    });
    await clearMetaChannelError(channel.id, channel.companyId);
    return { ok: true, graphData: phoneRes.body };
  }

  const phoneError = parseMetaGraphError(phoneRes.body, phoneRes.status, "phone_number");
  console.error("[META_STATUS_ERROR]", {
    status: phoneRes.status,
    responseBody: phoneRes.body,
    errorMessage: phoneError.message,
    ...phoneError,
  });

  let wabaPhoneNumbers: unknown = null;
  if (wabaId) {
    const wabaRes = await graphGet(`${encodeURIComponent(wabaId)}/phone_numbers`, token);
    if (wabaRes.ok) {
      wabaPhoneNumbers = wabaRes.body;
      console.log("[META_STATUS_RESPONSE]", {
        status: wabaRes.status,
        ok: true,
        source: "waba_phone_numbers",
        responseBody: wabaRes.body,
      });
      const data = wabaRes.body.data as Array<Record<string, unknown>> | undefined;
      const match = data?.find((row) => String(row.id) === phoneNumberId);
      if (match) {
        await clearMetaChannelError(channel.id, channel.companyId);
        return {
          ok: true,
          graphData: match as Record<string, unknown>,
          wabaPhoneNumbers,
        };
      }
    } else {
      const wabaError = parseMetaGraphError(wabaRes.body, wabaRes.status, "waba_phone_numbers");
      console.error("[META_STATUS_ERROR]", {
        status: wabaRes.status,
        responseBody: wabaRes.body,
        errorMessage: wabaError.message,
        ...wabaError,
      });
    }
  }

  const errorMessage =
    phoneError.message ??
    `Graph API retornou HTTP ${phoneRes.status} para phone_number_id ${phoneNumberId}`;
  await recordMetaChannelError(
    channel.id,
    channel.companyId,
    String(phoneError.code ?? phoneRes.status),
    errorMessage,
  );

  return {
    ok: false,
    metaError: phoneError,
    wabaPhoneNumbers,
  };
}
