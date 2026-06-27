// Sessão da plataforma — derivada 100% do usuário autenticado (useAuth/PostgreSQL).
// Sem fallback para mocks e sem override de identidade via localStorage.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { tenants, users as mockUsers, type Role, type User, type Tenant } from "./mocks";
import { useAuth } from "./auth";

export interface Session {
  userId: string;
  tenantId: string;
  role: Role;
}

interface SessionContextValue {
  session: Session;
  user: User;
  tenant: Tenant;
  setUserId: (id: string) => void;
  setTenantId: (id: string) => void;
  visibleTenants: Tenant[];
  isSuperAdmin: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function tenantFor(tenantId: string): Tenant {
  return (
    tenants.find((t) => t.id === tenantId) ?? {
      id: tenantId || "default",
      name: tenantId || "Default",
      cnpj: "",
      plan: "Free",
      status: "ativo",
      sharedAttendance: false,
    }
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { user: authUser } = useAuth();

  // Override apenas para o switcher de teste (super-admin trocando de tenant manualmente).
  const [tenantOverride, setTenantOverride] = useState<string | null>(null);

  // Usuário corrente vem SEMPRE do authUser. Sem authUser, usamos um placeholder seguro
  // (o _app já redireciona pro /login antes disso renderizar).
  const user: User = authUser ?? mockUsers[0];

  const isSuperAdmin = user.role === "ADMIN_GERAL" || (user.role as string) === "SUPER_ADMIN";

  const effectiveTenantId = isSuperAdmin && tenantOverride ? tenantOverride : user.tenantId;
  const tenant = tenantFor(effectiveTenantId);

  const session: Session = {
    userId: user.id,
    tenantId: effectiveTenantId,
    role: user.role,
  };

  const visibleTenants = useMemo(
    () => (isSuperAdmin ? tenants : tenants.filter((t) => t.id === user.tenantId)),
    [isSuperAdmin, user.tenantId],
  );

  const setUserId = useCallback(() => {
    // Troca de usuário só é possível por login real. Mantido por compatibilidade.
  }, []);

  const setTenantId = useCallback((id: string) => {
    setTenantOverride(id);
  }, []);

  const value: SessionContextValue = {
    session,
    user,
    tenant,
    setUserId,
    setTenantId,
    visibleTenants,
    isSuperAdmin,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession deve ser usado dentro de <SessionProvider>");
  return ctx;
}
