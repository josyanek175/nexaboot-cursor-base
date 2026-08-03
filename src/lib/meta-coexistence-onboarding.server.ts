/**
 * Onboarding temporário Meta Coexistence — PostgreSQL com token cifrado.
 * Connect: claim + canal + vault + consumo na MESMA transação (FOR UPDATE).
 * Sem Graph API dentro da transação. Nunca logar code/token/ciphertext.
 */
import { randomBytes, randomUUID } from "crypto";
import { decryptToken, encryptToken, hasTokenEncryptionKey } from "@/lib/crypto/token-crypto.server";
import {
  evaluateOnboardingAccess,
  toSafeOnboardingDto,
} from "@/lib/meta-coexistence-connect-body";
import { sql } from "@/lib/pg.server";

export { toSafeOnboardingDto, evaluateOnboardingAccess };
export {
  COEXISTENCE_CONNECT_TX_STEPS,
} from "@/lib/meta-coexistence-connect-body";
export type { CoexistenceOnboardingSafeDto } from "@/lib/meta-coexistence-connect-body";

export const COEXISTENCE_ONBOARDING_TTL_MS = 10 * 60 * 1000;

export type CoexistenceOnboardingRecord = {
  id: string;
  company_id: string;
  user_id: string;
  access_token_ciphertext: string | null;
  token_expires_at: Date | string | null;
  waba_id: string;
  phone_number_id: string;
  business_id: string | null;
  display_phone_number: string | null;
  resulting_channel_id?: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  invalidated_at: Date | string | null;
};

export class CoexistenceConnectTxError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CoexistenceConnectTxError";
  }
}

let cachedHasOnboardingTable: boolean | null = null;

export async function coexistenceOnboardingTablesReady(): Promise<boolean> {
  if (cachedHasOnboardingTable != null) return cachedHasOnboardingTable;
  const s = sql();
  const rows = await s<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'meta_coexistence_onboardings'
    ) AS exists
  `;
  cachedHasOnboardingTable = Boolean(rows[0]?.exists);
  return cachedHasOnboardingTable;
}

export function resetCoexistenceOnboardingTableCache(): void {
  cachedHasOnboardingTable = null;
}

/** Gera state CSRF criptograficamente aleatório e persiste (TTL 10 min). */
export async function createCoexistenceCsrfState(
  companyId: string,
  userId: string,
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + COEXISTENCE_ONBOARDING_TTL_MS);
  const s = sql();
  await s`
    INSERT INTO public.meta_coexistence_csrf_states (state, company_id, user_id, expires_at)
    VALUES (${state}, ${companyId}::uuid, ${userId}::uuid, ${expiresAt})
  `;
  return state;
}

/**
 * Consome state CSRF (uso único). Retorna false se inválido/expirado/já usado/outra sessão.
 */
export async function consumeCoexistenceCsrfState(
  state: string,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const s = sql();
  const rows = await s<{ state: string }[]>`
    UPDATE public.meta_coexistence_csrf_states
    SET used_at = now()
    WHERE state = ${state}
      AND company_id = ${companyId}::uuid
      AND user_id = ${userId}::uuid
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING state
  `;
  return rows.length > 0;
}

export type CreateOnboardingInput = {
  companyId: string;
  userId: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  displayPhoneNumber: string | null;
};

/** Persiste onboarding com token cifrado. Não recebe/loga code. */
export async function createCoexistenceOnboarding(
  input: CreateOnboardingInput,
): Promise<CoexistenceOnboardingRecord> {
  if (!hasTokenEncryptionKey()) {
    throw new Error("missing_encryption_key");
  }
  const ciphertext = encryptToken(input.accessToken);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + COEXISTENCE_ONBOARDING_TTL_MS);
  const s = sql();
  const rows = await s<CoexistenceOnboardingRecord[]>`
    INSERT INTO public.meta_coexistence_onboardings (
      id, company_id, user_id, access_token_ciphertext, token_expires_at,
      waba_id, phone_number_id, business_id, display_phone_number, expires_at
    ) VALUES (
      ${id}::uuid,
      ${input.companyId}::uuid,
      ${input.userId}::uuid,
      ${ciphertext},
      ${input.tokenExpiresAt},
      ${input.wabaId},
      ${input.phoneNumberId},
      ${input.businessId},
      ${input.displayPhoneNumber},
      ${expiresAt}
    )
    RETURNING
      id, company_id, user_id, access_token_ciphertext, token_expires_at,
      waba_id, phone_number_id, business_id, display_phone_number,
      resulting_channel_id, created_at, expires_at, consumed_at, invalidated_at
  `;
  return rows[0];
}

export type ConnectTransactionalInput = {
  onboardingId: string;
  companyId: string;
  userId: string;
  role: string | null | undefined;
  /** Se omitido, usa display_phone_number do onboarding. */
  channelName?: string | null;
  embeddedSignupConfigId: string | null;
  /** Resultado da inscrição WABA (Graph fora da TX). */
  webhookSubscriptionStatus?: string | null;
  webhookSubscribedAt?: Date | null;
  verifiedName?: string | null;
};

export type ConnectTransactionalResult =
  | { ok: true; channelId: string; idempotent: boolean }
  | { ok: false; error: string };

/**
 * Connect atômico: FOR UPDATE → upsert canal → vault → consume.
 * Sem chamadas Graph. Em throw, postgres.js faz rollback (onboarding permanece utilizável).
 */
export async function completeCoexistenceConnectTransactional(
  input: ConnectTransactionalInput,
): Promise<ConnectTransactionalResult> {
  if (!hasTokenEncryptionKey()) {
    return { ok: false, error: "missing_encryption_key" };
  }

  const s = sql();

  try {
    const result = await s.begin(async (tx) => {
      const locked = await tx<CoexistenceOnboardingRecord[]>`
        SELECT
          id, company_id, user_id, access_token_ciphertext, token_expires_at,
          waba_id, phone_number_id, business_id, display_phone_number,
          resulting_channel_id, created_at, expires_at, consumed_at, invalidated_at
        FROM public.meta_coexistence_onboardings
        WHERE id = ${input.onboardingId}::uuid
        FOR UPDATE
      `;
      const row = locked[0];
      if (!row) {
        throw new CoexistenceConnectTxError("not_found");
      }

      // Replay idempotente: já consumido com canal criado para esta empresa.
      if (row.consumed_at != null && row.resulting_channel_id) {
        if (row.company_id !== input.companyId) {
          throw new CoexistenceConnectTxError("company_mismatch");
        }
        const channelOk = await tx<{ id: string }[]>`
          SELECT id FROM public.whatsapp_channels
          WHERE id = ${row.resulting_channel_id}::uuid
            AND company_id = ${input.companyId}::uuid
            AND lower(channel_type) = 'meta'
            AND deleted_at IS NULL
          LIMIT 1
        `;
        if (!channelOk[0]) {
          throw new CoexistenceConnectTxError("consumed");
        }
        return { channelId: channelOk[0].id, idempotent: true as const };
      }

      const access = evaluateOnboardingAccess({
        row,
        companyId: input.companyId,
        userId: input.userId,
        role: input.role,
      });
      if (access !== "ok") {
        throw new CoexistenceConnectTxError(access);
      }

      if (!row.waba_id || !row.phone_number_id) {
        throw new CoexistenceConnectTxError("onboarding_incomplete");
      }

      let accessToken: string;
      try {
        accessToken = decryptToken(row.access_token_ciphertext!);
      } catch {
        throw new CoexistenceConnectTxError("decrypt_failed");
      }

      // Lock por phone_number_id (evita corrida entre onboardings distintos).
      const phoneOwners = await tx<{ id: string; company_id: string }[]>`
        SELECT id, company_id FROM public.whatsapp_channels
        WHERE phone_number_id = ${row.phone_number_id}
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      const phoneOwner = phoneOwners[0];
      if (phoneOwner && phoneOwner.company_id !== input.companyId) {
        throw new CoexistenceConnectTxError("phone_number_id_belongs_to_another_company");
      }

      const tokenExpiresAt =
        row.token_expires_at != null ? new Date(String(row.token_expires_at)) : null;

      const channelName =
        input.channelName?.trim() ||
        input.verifiedName?.trim() ||
        row.display_phone_number ||
        `Meta Coexistence ${row.phone_number_id}`;

      const webhookStatus = input.webhookSubscriptionStatus ?? null;
      const webhookAt = input.webhookSubscribedAt ?? null;

      let channelId: string;

      if (phoneOwner && phoneOwner.company_id === input.companyId) {
        await tx`
          UPDATE public.whatsapp_channels
          SET name = ${channelName},
              display_name = ${channelName},
              channel_type = 'meta',
              status = 'ACTIVE',
              waba_id = ${row.waba_id},
              phone_number_id = ${row.phone_number_id},
              business_id = ${row.business_id},
              display_phone_number = ${row.display_phone_number},
              meta_connection_mode = 'coexistence',
              embedded_signup_config_id = ${input.embeddedSignupConfigId},
              coexistence_status = 'connected',
              onboarding_completed_at = now(),
              connected_at = COALESCE(connected_at, now()),
              webhook_subscription_status = ${webhookStatus},
              webhook_subscribed_at = ${webhookAt},
              token_expires_at = ${tokenExpiresAt},
              token_status = 'pending',
              active = true,
              deleted_at = NULL,
              updated_at = now()
          WHERE id = ${phoneOwner.id}::uuid
            AND company_id = ${input.companyId}::uuid
        `;
        channelId = phoneOwner.id;
      } else {
        try {
          const inserted = await tx<{ id: string }[]>`
            INSERT INTO public.whatsapp_channels (
              company_id, name, display_name, channel_type, status,
              waba_id, phone_number_id, business_id, display_phone_number,
              webhook_verify_token, token_status, active,
              meta_connection_mode, embedded_signup_config_id, coexistence_status,
              onboarding_completed_at, connected_at,
              webhook_subscription_status, webhook_subscribed_at, token_expires_at
            ) VALUES (
              ${input.companyId}::uuid,
              ${channelName},
              ${channelName},
              'meta',
              'ACTIVE',
              ${row.waba_id},
              ${row.phone_number_id},
              ${row.business_id},
              ${row.display_phone_number},
              NULL,
              'pending',
              true,
              'coexistence',
              ${input.embeddedSignupConfigId},
              'connected',
              now(),
              now(),
              ${webhookStatus},
              ${webhookAt},
              ${tokenExpiresAt}
            )
            RETURNING id
          `;
          channelId = inserted[0].id;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("idx_channels_meta_phone_number_id") || msg.includes("duplicate key")) {
            throw new CoexistenceConnectTxError("phone_number_id_already_exists");
          }
          // Colunas connected_at / webhook_subscribed_at podem faltar se migration parcial.
          if (msg.includes("connected_at") || msg.includes("webhook_subscribed_at")) {
            console.error("[META_COEXISTENCE_CREATE_FAIL]", { error: "migration_columns_missing" });
            throw new CoexistenceConnectTxError("migration_required");
          }
          console.error("[META_COEXISTENCE_CREATE_FAIL]", { error: "insert_failed" });
          throw new CoexistenceConnectTxError("create_failed");
        }
      }

      // Vault: só DB + encrypt local (Graph já validou no /exchange).
      const vaultCipher = encryptToken(accessToken.trim());
      await tx`
        DELETE FROM public.whatsapp_channel_secrets
        WHERE channel_id = ${channelId}::uuid
      `;
      await tx`
        INSERT INTO public.whatsapp_channel_secrets (
          channel_id, access_token_ciphertext, token_updated_at, updated_at
        ) VALUES (
          ${channelId}::uuid, ${vaultCipher}, now(), now()
        )
      `;
      await tx`
        UPDATE public.whatsapp_channels
        SET token_status = 'valid',
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = now()
        WHERE id = ${channelId}::uuid
          AND company_id = ${input.companyId}::uuid
      `;

      // Consumo somente após canal + vault OK (último passo da tx).
      const consumed = await tx<{ id: string }[]>`
        UPDATE public.meta_coexistence_onboardings
        SET consumed_at = now(),
            access_token_ciphertext = NULL,
            resulting_channel_id = ${channelId}::uuid
        WHERE id = ${input.onboardingId}::uuid
          AND company_id = ${input.companyId}::uuid
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > now()
        RETURNING id
      `;
      if (!consumed[0]) {
        throw new CoexistenceConnectTxError("consumed");
      }

      return { channelId, idempotent: false as const };
    });

    return { ok: true, channelId: result.channelId, idempotent: result.idempotent };
  } catch (e) {
    if (e instanceof CoexistenceConnectTxError) {
      return { ok: false, error: e.code };
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[META_COEXISTENCE_CONNECT_TX_FAIL]", { error: "tx_failed" });
    // Mensagem bruta pode conter detalhes de constraint — não incluir token.
    if (msg.includes("duplicate key") || msg.includes("idx_channels_meta_phone_number_id")) {
      return { ok: false, error: "phone_number_id_already_exists" };
    }
    return { ok: false, error: "create_failed" };
  }
}

/** Limpeza automática de CSRF/onboardings expirados (sem logar segredos). */
export async function cleanupExpiredCoexistenceOnboardings(): Promise<void> {
  const s = sql();
  await s`
    DELETE FROM public.meta_coexistence_csrf_states
    WHERE expires_at < now() - interval '1 hour'
       OR (used_at IS NOT NULL AND used_at < now() - interval '1 hour')
  `;
  await s`
    UPDATE public.meta_coexistence_onboardings
    SET access_token_ciphertext = NULL,
        invalidated_at = COALESCE(invalidated_at, now())
    WHERE access_token_ciphertext IS NOT NULL
      AND expires_at < now()
      AND consumed_at IS NULL
  `;
  await s`
    DELETE FROM public.meta_coexistence_onboardings
    WHERE expires_at < now() - interval '1 day'
  `;
}
