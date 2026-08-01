/**
 * Helpers aditivos para Meta Coexistence.
 * Não alteram o pipeline cloud_api; só são usados por endpoints gated pela feature flag.
 */
import { sql } from "@/lib/pg.server";
import {
  DEFAULT_META_CONNECTION_MODE,
  resolveMetaConnectionMode,
  type MetaConnectionMode,
} from "@/lib/meta-connection-mode";

let cachedHasModeColumn: boolean | null = null;

/** Detecta se a migration aditiva já foi aplicada (cache de processo). */
export async function whatsappChannelsHasMetaConnectionModeColumn(): Promise<boolean> {
  if (cachedHasModeColumn != null) return cachedHasModeColumn;
  const s = sql();
  const rows = await s<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'whatsapp_channels'
        AND column_name = 'meta_connection_mode'
    ) AS exists
  `;
  cachedHasModeColumn = Boolean(rows[0]?.exists);
  return cachedHasModeColumn;
}

/** Para testes: limpa cache da detecção de coluna. */
export function resetMetaConnectionModeColumnCache(): void {
  cachedHasModeColumn = null;
}

export async function readMetaConnectionModeFromRow(
  row: Record<string, unknown>,
): Promise<MetaConnectionMode> {
  if ("meta_connection_mode" in row) {
    return resolveMetaConnectionMode(row.meta_connection_mode);
  }
  const hasCol = await whatsappChannelsHasMetaConnectionModeColumn();
  if (!hasCol) return DEFAULT_META_CONNECTION_MODE;
  return DEFAULT_META_CONNECTION_MODE;
}

export type CoexistenceConnectInput = {
  companyId: string;
  name: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  displayPhoneNumber: string | null;
  accessToken: string;
  webhookVerifyToken: string | null;
  embeddedSignupConfigId: string | null;
  tokenExpiresAt: Date | null;
};

/**
 * INSERT de canal Meta coexistence.
 * Exige coluna meta_connection_mode (migration). Falha com migration_required se ausente.
 */
export async function insertMetaCoexistenceChannel(
  input: CoexistenceConnectInput,
): Promise<{ id: string } | { error: "migration_required" | "duplicate" | "create_failed"; detail?: string }> {
  const hasCol = await whatsappChannelsHasMetaConnectionModeColumn();
  if (!hasCol) {
    return { error: "migration_required" };
  }

  const s = sql();
  try {
    const inserted = await s<{ id: string }[]>`
      INSERT INTO public.whatsapp_channels (
        company_id, name, display_name, channel_type, status,
        waba_id, phone_number_id, business_id, display_phone_number,
        webhook_verify_token, token_status, active,
        meta_connection_mode, embedded_signup_config_id, coexistence_status,
        onboarding_completed_at, token_expires_at
      ) VALUES (
        ${input.companyId}::uuid,
        ${input.name},
        ${input.name},
        'meta',
        'ACTIVE',
        ${input.wabaId},
        ${input.phoneNumberId},
        ${input.businessId},
        ${input.displayPhoneNumber},
        ${input.webhookVerifyToken},
        'pending',
        true,
        'coexistence',
        ${input.embeddedSignupConfigId},
        'connected',
        now(),
        ${input.tokenExpiresAt}
      )
      RETURNING id
    `;
    return { id: inserted[0].id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("idx_channels_meta_phone_number_id") || msg.includes("duplicate key")) {
      return { error: "duplicate", detail: msg };
    }
    console.error("[META_COEXISTENCE_CREATE_FAIL]", { error: msg });
    return { error: "create_failed", detail: msg };
  }
}
