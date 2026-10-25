// Identity follows authentication; no demo accounts or local company override.
import { createContext, useContext, type ReactNode } from "react";
import type { Role, User, Tenant } from "./mocks";
import { useAuth } from "./auth";
import { isPlatformRole } from "./platform-roles";
export interface Session {
  userId: string;
  tenantId: string;
  role: Role;
}
interface SessionContextValue {
  session: Session;
  user: User;
  tenant: Tenant;
  isSuperAdmin: boolean;
}
const SessionContext = createContext<SessionContextValue | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const { user, tenant } = useAuth();
  if (!user) return null;
  const contextTenant: Tenant = tenant ?? {
    id: "",
    name: "Nenhuma empresa selecionada",
    cnpj: "",
    plan: "Free",
    status: "ativo",
    sharedAttendance: false,
  };
  return (
    <SessionContext.Provider
      value={{
        session: { userId: user.id, tenantId: tenant?.id ?? "", role: user.role },
        user,
        tenant: contextTenant,
        isSuperAdmin: isPlatformRole(user.role),
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession deve ser usado dentro de <SessionProvider>");
  return ctx;
}
