// Normalização da resposta de autenticação (snake_case da API + camelCase legado).
import type { Role, User } from "./mocks";
import { isPlatformRole } from "./platform-roles";

/** Payload bruto de /api/auth/me ou /api/auth/login (aceita ambos os formatos). */
export type MeUserPayload = {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id?: string;
  tenantId?: string;
  company_id?: string | null;
  companyId?: string | null;
  company_name?: string | null;
  companyName?: string | null;
  company_valid?: boolean;
  companyValid?: boolean;
  platform_access?: boolean;
  platformAccess?: boolean;
};

export type AuthUser = User & {
  companyId: string | null;
  companyName: string | null;
  companyValid: boolean;
  platformAccess: boolean;
};

export function normalizeAuthUser(raw: MeUserPayload): AuthUser {
  const companyId = raw.company_id ?? raw.companyId ?? null;
  const companyName = raw.company_name ?? raw.companyName ?? null;
  const companyValid = raw.company_valid ?? raw.companyValid ?? false;
  const platformAccess =
    raw.platform_access ?? raw.platformAccess ?? isPlatformRole(raw.role);
  const tenantId = raw.tenant_id ?? raw.tenantId ?? "default";

  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    role: (raw.role as Role) ?? "ATENDENTE",
    tenantId,
    avatarColor: "#00a884",
    companyId,
    companyName,
    companyValid,
    platformAccess,
  };
}

/** Campos duplicados snake_case + camelCase para compatibilidade com clientes legados. */
export function buildAuthUserResponse(
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    tenant_id: string;
  },
  company: {
    companyId: string | null;
    companyName: string | null;
    companyValid: boolean;
  },
  platformAccess: boolean,
) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenant_id: user.tenant_id,
    company_id: company.companyId,
    company_name: company.companyName,
    company_valid: company.companyValid,
    platform_access: platformAccess,
    companyId: company.companyId,
    companyName: company.companyName,
    companyValid: company.companyValid,
    platformAccess,
  };
}
