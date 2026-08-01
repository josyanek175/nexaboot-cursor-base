/**
 * Schema puro do body de connect — testável sem DB/Graph.
 * Connect NÃO aceita code nem access_token.
 */
import { z } from "zod";

const ONBOARDING_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FORBIDDEN_CONNECT_FIELDS = [
  "code",
  "authorization_code",
  "access_token",
  "token",
] as const;

export function findForbiddenConnectField(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  for (const field of FORBIDDEN_CONNECT_FIELDS) {
    if (obj[field] != null) return field;
  }
  return null;
}

export const CoexistenceConnectBodySchema = z
  .object({
    onboarding_id: z.string().trim().regex(ONBOARDING_UUID_RE),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CoexistenceConnectBody = z.infer<typeof CoexistenceConnectBodySchema>;

/** DTO seguro de onboarding — nunca inclui token/code. */
export function assertSafeOnboardingDto(dto: Record<string, unknown>): boolean {
  const forbidden = ["access_token", "token", "code", "authorization_code", "access_token_ciphertext"];
  for (const key of forbidden) {
    if (key in dto) return false;
  }
  return typeof dto.onboarding_id === "string" && typeof dto.waba_id === "string";
}

export type CoexistenceOnboardingSafeDto = {
  onboarding_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  business_id: string | null;
  expires_at: string;
};

export function toSafeOnboardingDto(row: {
  id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  business_id: string | null;
  expires_at: Date | string;
}): CoexistenceOnboardingSafeDto {
  const expires =
    row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString();
  return {
    onboarding_id: row.id,
    waba_id: row.waba_id,
    phone_number_id: row.phone_number_id,
    display_phone_number: row.display_phone_number,
    business_id: row.business_id,
    expires_at: expires,
  };
}

function isPlatformRoleLocal(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI" || r === "ADMIN_GERAL";
}

/** Regras de autorização/estado do onboarding — testáveis sem DB. */
export function evaluateOnboardingAccess(params: {
  row: {
    company_id: string;
    user_id: string;
    expires_at: Date | string;
    consumed_at: Date | string | null;
    invalidated_at: Date | string | null;
    access_token_ciphertext: string | null;
  };
  companyId: string;
  userId: string;
  role: string | null | undefined;
  nowMs?: number;
}):
  | "ok"
  | "company_mismatch"
  | "user_mismatch"
  | "consumed"
  | "expired"
  | "missing_token" {
  const { row } = params;
  if (row.company_id !== params.companyId) return "company_mismatch";
  if (row.user_id !== params.userId && !isPlatformRoleLocal(params.role)) return "user_mismatch";
  if (row.consumed_at != null || row.invalidated_at != null) return "consumed";
  const now = params.nowMs ?? Date.now();
  const exp =
    row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
  if (exp <= now) return "expired";
  if (!row.access_token_ciphertext) return "missing_token";
  return "ok";
}

/**
 * Ordem obrigatória dentro da transação de /connect.
 * Consumo do onboarding é SEMPRE o último passo antes do commit.
 */
export const COEXISTENCE_CONNECT_TX_STEPS = [
  "begin",
  "select_onboarding_for_update",
  "validate_access",
  "decrypt_token_local",
  "lock_phone_number_id",
  "upsert_channel",
  "persist_vault_ciphertext",
  "mark_consumed_and_scrub",
  "commit",
] as const;
