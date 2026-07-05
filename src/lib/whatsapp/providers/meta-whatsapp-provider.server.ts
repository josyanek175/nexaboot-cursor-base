// Provider Meta WhatsApp Cloud API — stub server-side (sem envio de mensagens).
// Tokens ficam cifrados em whatsapp_channel_secrets; nunca expostos em logs/responses.

import { encryptToken, hasTokenEncryptionKey } from "@/lib/crypto/token-crypto.server";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import type {
  ProviderSendResult,
  ProviderStatusResult,
  TokenStatus,
  WhatsAppChannelRecord,
  WhatsAppProvider,
} from "@/lib/whatsapp/providers/whatsapp-provider.types";
import { normalizeTokenStatus } from "@/lib/whatsapp/providers/whatsapp-provider.types";

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly kind = "meta" as const;

  async getStatus(channel: WhatsAppChannelRecord): Promise<ProviderStatusResult> {
    const hasPhoneNumberId = !!channel.phoneNumberId?.trim();
    const tokenStatus = await this.resolveTokenStatus(channel.id, channel.tokenStatus);

    return {
      ok: hasPhoneNumberId,
      provider: this.kind,
      status: channel.status,
      tokenStatus,
      lastErrorCode: channel.lastErrorCode,
      lastErrorMessage: channel.lastErrorMessage,
      lastWebhookAt: channel.lastWebhookAt,
      configured: hasPhoneNumberId && tokenStatus === "valid",
      error: hasPhoneNumberId ? undefined : "missing_phone_number_id",
    };
  }

  async sendText(
    _channel: WhatsAppChannelRecord,
    _to: string,
    _body: string,
  ): Promise<ProviderSendResult> {
    return { ok: false, notImplemented: true, error: "not_implemented" };
  }

  /**
   * Persiste access token cifrado para um canal Meta da empresa.
   * Uso interno — rotas públicas devem chamar isto sem retornar o token.
   */
  async storeAccessToken(
    channelId: string,
    companyId: string,
    accessToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!hasTokenEncryptionKey()) {
      return { ok: false, error: "missing_encryption_key" };
    }

    const trimmed = accessToken.trim();
    if (!trimmed) {
      return { ok: false, error: "empty_token" };
    }

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
      return { ok: false, error: "channel_not_found" };
    }

    const ciphertext = encryptToken(trimmed);

    await s`
      INSERT INTO public.whatsapp_channel_secrets (channel_id, access_token_ciphertext, token_updated_at, updated_at)
      VALUES (${channelId}::uuid, ${ciphertext}, now(), now())
      ON CONFLICT (channel_id) DO UPDATE SET
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        token_updated_at = now(),
        updated_at = now()
    `;

    await s`
      UPDATE public.whatsapp_channels
      SET token_status = 'valid', updated_at = now()
      WHERE id = ${channelId}::uuid AND company_id = ${companyId}::uuid
    `;

    return { ok: true };
  }

  /** Indica se o canal possui token configurado, sem expor o valor. */
  async hasAccessToken(channelId: string, companyId: string): Promise<boolean> {
    await ensureCrmSchema();
    const s = sql();
    const rows = await s<{ has_token: boolean }[]>`
      SELECT (sec.access_token_ciphertext IS NOT NULL AND length(sec.access_token_ciphertext) > 0) AS has_token
      FROM public.whatsapp_channels ch
      LEFT JOIN public.whatsapp_channel_secrets sec ON sec.channel_id = ch.id
      WHERE ch.id = ${channelId}::uuid
        AND ch.company_id = ${companyId}::uuid
        AND lower(ch.channel_type) = 'meta'
        AND ch.deleted_at IS NULL
      LIMIT 1
    `;
    return !!rows[0]?.has_token;
  }

  private async resolveTokenStatus(
    channelId: string,
    stored: TokenStatus | null,
  ): Promise<TokenStatus> {
    if (
      stored === "valid" ||
      stored === "expired" ||
      stored === "revoked" ||
      stored === "pending"
    ) {
      return stored;
    }

    const hasToken = await this.hasAccessTokenById(channelId);
    return hasToken ? "valid" : "missing";
  }

  private async hasAccessTokenById(channelId: string): Promise<boolean> {
    await ensureCrmSchema();
    const s = sql();
    const rows = await s<{ has_token: boolean }[]>`
      SELECT (access_token_ciphertext IS NOT NULL AND length(access_token_ciphertext) > 0) AS has_token
      FROM public.whatsapp_channel_secrets
      WHERE channel_id = ${channelId}::uuid
      LIMIT 1
    `;
    return !!rows[0]?.has_token;
  }
}

export const metaWhatsAppProvider = new MetaWhatsAppProvider();

/** Decifra token apenas para uso interno server-side (ex.: envio futuro). Nunca logar retorno. */
export async function loadMetaAccessToken(
  channelId: string,
  companyId: string,
): Promise<string | null> {
  await ensureCrmSchema();
  const s = sql();

  const rows = await s<{ ciphertext: string | null }[]>`
    SELECT sec.access_token_ciphertext AS ciphertext
    FROM public.whatsapp_channels ch
    JOIN public.whatsapp_channel_secrets sec ON sec.channel_id = ch.id
    WHERE ch.id = ${channelId}::uuid
      AND ch.company_id = ${companyId}::uuid
      AND lower(ch.channel_type) = 'meta'
      AND ch.deleted_at IS NULL
    LIMIT 1
  `;

  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;

  const { decryptToken } = await import("@/lib/crypto/token-crypto.server");
  try {
    return decryptToken(ciphertext);
  } catch {
    return null;
  }
}

export function mapMetaChannelRow(row: Record<string, unknown>): WhatsAppChannelRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: row.name != null ? String(row.name) : null,
    channelType: "meta",
    status: String(row.status ?? "DISCONNECTED"),
    evolutionInstanceName: null,
    phoneNumber: row.phone_number != null ? String(row.phone_number) : null,
    displayName: row.display_name != null ? String(row.display_name) : null,
    displayPhoneNumber: row.display_phone_number != null ? String(row.display_phone_number) : null,
    wabaId: row.waba_id != null ? String(row.waba_id) : null,
    phoneNumberId: row.phone_number_id != null ? String(row.phone_number_id) : null,
    businessId: row.business_id != null ? String(row.business_id) : null,
    tokenStatus: normalizeTokenStatus(row.token_status != null ? String(row.token_status) : null),
    lastErrorCode: row.last_error_code != null ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message != null ? String(row.last_error_message) : null,
    lastWebhookAt: row.last_webhook_at != null ? String(row.last_webhook_at) : null,
    lastConnectedAt: row.last_connected_at != null ? String(row.last_connected_at) : null,
  };
}
