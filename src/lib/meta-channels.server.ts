// Helpers server-only para APIs de canais Meta — nunca expõem access_token.

import { hasTokenEncryptionKey } from "@/lib/crypto/token-crypto.server";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { metaWhatsAppProvider } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import { META_CHANNEL_STATUSES } from "@/lib/whatsapp/providers/whatsapp-provider.types";
import { metaPhoneNumberIdOwner } from "@/lib/whatsapp/whatsapp-provider-router.server";

export const META_CHANNEL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MetaChannelPublicTokenStatus = "configured" | "missing";

export type MetaChannelPublic = {
  id: string;
  company_id: string;
  name: string | null;
  channel_type: "meta";
  status: string;
  waba_id: string | null;
  phone_number_id: string | null;
  business_id: string | null;
  display_phone_number: string | null;
  token_status: MetaChannelPublicTokenStatus;
  webhook_verify_token: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_webhook_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MetaChannelStatusPublic = {
  id: string;
  status: string;
  phone_number_id: string | null;
  waba_id: string | null;
  display_phone_number: string | null;
  token_status: MetaChannelPublicTokenStatus;
  last_webhook_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type MetaChannelRow = {
  id: string;
  company_id: string;
  name: string | null;
  channel_type: string;
  status: string;
  waba_id: string | null;
  phone_number_id: string | null;
  business_id: string | null;
  display_phone_number: string | null;
  token_status: string | null;
  webhook_verify_token: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_webhook_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export function isMetaChannelStatus(value: string): boolean {
  return (META_CHANNEL_STATUSES as readonly string[]).includes(value);
}

export function toPublicTokenStatus(hasToken: boolean): MetaChannelPublicTokenStatus {
  return hasToken ? "configured" : "missing";
}

function ts(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return String(value);
}

export async function buildMetaChannelPublic(row: MetaChannelRow): Promise<MetaChannelPublic> {
  const hasToken = await metaWhatsAppProvider.hasAccessToken(row.id, row.company_id);
  return {
    id: row.id,
    company_id: row.company_id,
    name: row.name,
    channel_type: "meta",
    status: row.status,
    waba_id: row.waba_id,
    phone_number_id: row.phone_number_id,
    business_id: row.business_id,
    display_phone_number: row.display_phone_number,
    token_status: toPublicTokenStatus(hasToken),
    webhook_verify_token: row.webhook_verify_token,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    last_webhook_at: ts(row.last_webhook_at),
    created_at: ts(row.created_at)!,
    updated_at: ts(row.updated_at)!,
  };
}

export async function buildMetaChannelStatusPublic(
  row: MetaChannelRow,
): Promise<MetaChannelStatusPublic> {
  const hasToken = await metaWhatsAppProvider.hasAccessToken(row.id, row.company_id);
  return {
    id: row.id,
    status: row.status,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    display_phone_number: row.display_phone_number,
    token_status: toPublicTokenStatus(hasToken),
    last_webhook_at: ts(row.last_webhook_at),
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
  };
}

export async function listMetaChannelsForCompany(companyId: string): Promise<MetaChannelPublic[]> {
  await ensureCrmSchema();
  const s = sql();
  const rows = await s<MetaChannelRow[]>`
    SELECT
      id, company_id, name, channel_type, status,
      waba_id, phone_number_id, business_id, display_phone_number,
      token_status, webhook_verify_token,
      last_error_code, last_error_message, last_webhook_at,
      created_at, updated_at
    FROM public.whatsapp_channels
    WHERE company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
      AND deleted_at IS NULL
      AND active = true
    ORDER BY created_at DESC
  `;
  return Promise.all(rows.map((row) => buildMetaChannelPublic(row)));
}

export async function getMetaChannelRowForCompany(
  channelId: string,
  companyId: string,
): Promise<MetaChannelRow | null> {
  await ensureCrmSchema();
  const s = sql();
  const rows = await s<MetaChannelRow[]>`
    SELECT
      id, company_id, name, channel_type, status,
      waba_id, phone_number_id, business_id, display_phone_number,
      token_status, webhook_verify_token,
      last_error_code, last_error_message, last_webhook_at,
      created_at, updated_at
    FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
      AND deleted_at IS NULL
      AND active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Retorna 409 se phone_number_id já estiver em uso (global, deleted_at IS NULL). */
export async function assertMetaPhoneNumberIdAvailable(
  phoneNumberId: string,
  companyId: string,
  excludeChannelId?: string,
): Promise<Response | null> {
  const owner = await metaPhoneNumberIdOwner(phoneNumberId, excludeChannelId);
  if (owner && owner.companyId !== companyId) {
    return Response.json({ error: "phone_number_id_belongs_to_another_company" }, { status: 409 });
  }

  await ensureCrmSchema();
  const s = sql();
  const duplicate = excludeChannelId
    ? await s<{ id: string; company_id: string }[]>`
        SELECT id, company_id FROM public.whatsapp_channels
        WHERE phone_number_id = ${phoneNumberId}
          AND deleted_at IS NULL
          AND id <> ${excludeChannelId}::uuid
        LIMIT 1
      `
    : await s<{ id: string; company_id: string }[]>`
        SELECT id, company_id FROM public.whatsapp_channels
        WHERE phone_number_id = ${phoneNumberId}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  if (duplicate[0]) {
    if (duplicate[0].company_id !== companyId) {
      return Response.json({ error: "phone_number_id_belongs_to_another_company" }, { status: 409 });
    }
    return Response.json({ error: "phone_number_id_already_exists" }, { status: 409 });
  }

  return null;
}

export async function clearMetaChannelToken(
  channelId: string,
  companyId: string,
  reason = "manual_clear",
): Promise<Response | null> {
  await ensureCrmSchema();
  const s = sql();

  const rows = await s<{ id: string }[]>`
    SELECT id FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await s`
    DELETE FROM public.whatsapp_channel_secrets
    WHERE channel_id = ${channelId}::uuid
  `;

  await s`
    UPDATE public.whatsapp_channels
    SET token_status = 'missing',
        last_error_code = 'token_cleared',
        last_error_message = ${`Token removido (${reason}) para recadastro com a chave atual`},
        updated_at = now()
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
  `;

  console.log("[META_TOKEN_CLEARED]", { channelId, companyId, reason });
  return null;
}

export function ensureMetaTokenEncryptionConfigured(): Response | null {
  if (!hasTokenEncryptionKey()) {
    return Response.json({ error: "missing_encryption_key" }, { status: 503 });
  }
  return null;
}

export async function storeMetaAccessTokenSafe(
  channelId: string,
  companyId: string,
  accessToken: string,
): Promise<Response | null> {
  const result = await metaWhatsAppProvider.storeAccessToken(channelId, companyId, accessToken);
  if (!result.ok) {
    const status =
      result.error === "missing_encryption_key"
        ? 503
        : result.error === "token_graph_validation_failed"
          ? 400
          : 400;
    const message =
      result.error === "token_graph_validation_failed"
        ? "Token rejeitado pela Graph API. Verifique se pertence ao WABA/phone_number_id deste canal."
        : result.error === "missing_encryption_key"
          ? "META_TOKEN_ENCRYPTION_KEY não configurada no nexaboot-web."
          : (result.error ?? "token_store_failed");
    return Response.json({ error: result.error ?? "token_store_failed", message }, { status });
  }
  return null;
}

export async function recordMetaChannelError(
  channelId: string,
  companyId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await ensureCrmSchema();
  const s = sql();
  const safeMessage = errorMessage.length > 500 ? `${errorMessage.slice(0, 500)}…` : errorMessage;
  await s`
    UPDATE public.whatsapp_channels
    SET last_error_code = ${errorCode},
        last_error_message = ${safeMessage},
        updated_at = now()
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
  `;
}

export async function clearMetaChannelError(channelId: string, companyId: string): Promise<void> {
  await ensureCrmSchema();
  const s = sql();
  await s`
    UPDATE public.whatsapp_channels
    SET last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
  `;
}
