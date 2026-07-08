// Roteador único de providers WhatsApp — escolhe Evolution ou Meta por canal.
// Garante isolamento multitenant via company_id em todas as consultas.

import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { evolutionProvider } from "@/lib/whatsapp/providers/evolution-provider.server";
import { mapMetaChannelRow } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import { metaWhatsAppProvider } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import type {
  WhatsAppChannelRecord,
  WhatsAppProvider,
  WhatsAppProviderKind,
} from "@/lib/whatsapp/providers/whatsapp-provider.types";
import {
  normalizeProviderKind,
  normalizeTokenStatus,
} from "@/lib/whatsapp/providers/whatsapp-provider.types";

type ChannelRow = {
  id: string;
  company_id: string;
  name: string | null;
  channel_type: string;
  evolution_instance_name: string | null;
  status: string;
  phone_number: string | null;
  display_name: string | null;
  display_phone_number: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  business_id: string | null;
  token_status: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_webhook_at: Date | string | null;
  last_connected_at: Date | string | null;
};

function mapEvolutionChannelRow(row: ChannelRow): WhatsAppChannelRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    channelType: "evolution",
    status: row.status,
    evolutionInstanceName: row.evolution_instance_name,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    displayPhoneNumber: row.display_phone_number,
    wabaId: null,
    phoneNumberId: null,
    businessId: null,
    tokenStatus: null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastWebhookAt: row.last_webhook_at ? String(row.last_webhook_at) : null,
    lastConnectedAt: row.last_connected_at ? String(row.last_connected_at) : null,
  };
}

function mapChannelRow(row: ChannelRow): WhatsAppChannelRecord | null {
  const kind = normalizeProviderKind(row.channel_type);
  if (kind === "meta") return mapMetaChannelRow(row as unknown as Record<string, unknown>);
  if (kind === "evolution") return mapEvolutionChannelRow(row);
  return null;
}

export function getProviderByKind(kind: WhatsAppProviderKind): WhatsAppProvider {
  if (kind === "meta") {
    console.log("[PROVIDER_ROUTER_SELECTED_META]");
    return metaWhatsAppProvider;
  }
  console.log("[PROVIDER_ROUTER_SELECTED_EVOLUTION]");
  return evolutionProvider;
}

/** Carrega canal ativo da empresa — nunca retorna segredos. */
export async function loadChannelForCompany(
  channelId: string,
  companyId: string,
): Promise<WhatsAppChannelRecord | null> {
  await ensureCrmSchema();
  const s = sql();
  const rows = await s<ChannelRow[]>`
    SELECT
      id, company_id, name, channel_type, evolution_instance_name, status,
      phone_number, display_name, display_phone_number,
      waba_id, phone_number_id, business_id, token_status,
      last_error_code, last_error_message, last_webhook_at, last_connected_at
    FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND active = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return mapChannelRow(row);
}

/** Resolve provider + canal com verificação de tenant. */
export async function resolveProviderForChannel(
  channelId: string,
  companyId: string,
): Promise<{ provider: WhatsAppProvider; channel: WhatsAppChannelRecord } | null> {
  const channel = await loadChannelForCompany(channelId, companyId);
  if (!channel) return null;
  return { provider: getProviderByKind(channel.channelType), channel };
}

/** Resolve canal Meta globalmente por phone_number_id (uso futuro no webhook). */
export async function loadMetaChannelByPhoneNumberId(
  phoneNumberId: string,
): Promise<WhatsAppChannelRecord | null> {
  await ensureCrmSchema();
  const s = sql();
  const rows = await s<ChannelRow[]>`
    SELECT
      id, company_id, name, channel_type, evolution_instance_name, status,
      phone_number, display_name, display_phone_number,
      waba_id, phone_number_id, business_id, token_status,
      last_error_code, last_error_message, last_webhook_at, last_connected_at
    FROM public.whatsapp_channels
    WHERE lower(channel_type) = 'meta'
      AND phone_number_id = ${phoneNumberId}
      AND upper(status) = 'ACTIVE'
      AND deleted_at IS NULL
      AND active = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return mapMetaChannelRow(row as unknown as Record<string, unknown>);
}

/** Verifica se phone_number_id já pertence a outra empresa (409 em registro futuro). */
export async function metaPhoneNumberIdOwner(
  phoneNumberId: string,
  excludeChannelId?: string,
): Promise<{ companyId: string; channelId: string } | null> {
  await ensureCrmSchema();
  const s = sql();
  const rows = excludeChannelId
    ? await s<{ company_id: string; id: string }[]>`
        SELECT company_id, id FROM public.whatsapp_channels
        WHERE phone_number_id = ${phoneNumberId}
          AND deleted_at IS NULL
          AND id <> ${excludeChannelId}::uuid
        LIMIT 1
      `
    : await s<{ company_id: string; id: string }[]>`
        SELECT company_id, id FROM public.whatsapp_channels
        WHERE phone_number_id = ${phoneNumberId}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  const row = rows[0];
  if (!row?.company_id) return null;
  return { companyId: row.company_id, channelId: row.id };
}

export { normalizeProviderKind, normalizeTokenStatus };
