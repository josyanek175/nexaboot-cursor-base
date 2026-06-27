// Fonte única do usuário logado — autenticado via PostgreSQL (cookie httpOnly).
// Backend: /api/auth/login + /api/auth/me.
import { useMemo } from "react";
import { useAuth } from "./auth";
import { tenants, type Role } from "./mocks";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenant_id: string;
  tenant_name: string;
  avatarColor: string;
}

export const AUTH_SOURCE = "postgres-cookie-session";

/** Hook React — use dentro de componentes. */
export function useCurrentUser(): CurrentUser | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const t = tenants.find((x) => x.id === user.tenantId);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenant_id: user.tenantId,
      tenant_name: t?.name ?? user.tenantId,
      avatarColor: user.avatarColor,
    };
  }, [user]);
}

/** Snapshot fora de componentes — sem cache local, retorna null.
 *  Consumidores devem usar useCurrentUser() ou chamar /api/auth/me. */
export function getCurrentUserSnapshot(): CurrentUser | null {
  return null;
}

/** Permissão simples para gestão de grupos internos. */
export function canManageInternalGroups(role: Role | undefined): boolean {
  return role === "ADMIN_GERAL" || role === "ADMIN_EMPRESA" || role === "TI";
}
