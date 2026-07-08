// Provider Meta WhatsApp Cloud API — envio server-side via Graph API.
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
    channel: WhatsAppChannelRecord,
    to: string,
    body: string,
  ): Promise<ProviderSendResult> {
    const phoneNumberId = channel.phoneNumberId?.trim();
    if (!phoneNumberId) {
      return { ok: false, error: "missing_phone_number_id" };
    }

    const token = await loadMetaAccessToken(channel.id, channel.companyId);
    if (!token) {
      return { ok: false, error: "missing_access_token", errorCode: "missing_access_token" };
    }

    const toDigits = to.replace(/\D/g, "");
    const graphVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v20.0";
    const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;

    console.log("[META_SEND_START]", {
      channelId: channel.id,
      companyId: channel.companyId,
    });
    console.log("[META_SEND_PHONE_NUMBER_ID]", { phoneNumberId });
    console.log("[META_SEND_INSTANCE]", { phoneNumberId, wabaId: channel.wabaId ?? null });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toDigits,
          type: "text",
          text: { preview_url: false, body },
        }),
      });

      const raw = await res.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }

      if (!res.ok) {
        const errObj = parsed.error as Record<string, unknown> | undefined;
        const errorCode = errObj?.code != null ? String(errObj.code) : String(res.status);
        const errorMessage =
          errObj?.message != null ? String(errObj.message) : raw.slice(0, 500) || "meta_api_error";
        console.error("[META_SEND_ERROR]", { status: res.status, errorCode, errorMessage });
        return { ok: false, error: "meta_api_error", errorCode, errorMessage };
      }

      const messages = parsed.messages as Array<{ id?: string }> | undefined;
      const providerMessageId = messages?.[0]?.id ?? null;
      console.log("[META_SEND_RESPONSE]", { status: res.status, providerMessageId });
      return { ok: true, providerMessageId };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("[META_SEND_ERROR]", { message: errorMessage });
      return { ok: false, error: "meta_fetch_failed", errorMessage };
    }
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
