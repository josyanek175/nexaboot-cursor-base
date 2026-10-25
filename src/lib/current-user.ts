// Fonte única do usuário logado — autenticado via PostgreSQL (cookie httpOnly).
// Backend: /api/auth/login + /api/auth/me.
import { useMemo } from "react";
import { useAuth } from "./auth";
import type { Role } from "./mocks";
import { isPlatformRole } from "./platform-roles";

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
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenant_id: user.companyValid ? (user.companyId ?? "") : "",
      tenant_name: user.companyValid
        ? (user.companyName ?? "Empresa selecionada")
        : "Nenhuma empresa selecionada",
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
  return isPlatformRole(role) || role === "ADMIN_EMPRESA";
}
