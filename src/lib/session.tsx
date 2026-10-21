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
  setUserId: (id: string) => void;
  setTenantId: (id: string) => void;
  visibleTenants: Tenant[];
  isSuperAdmin: boolean;
}
const SessionContext = createContext<SessionContextValue | null>(null);
const noIdentityOverride = () => {};
/** Identity and company always come from the authenticated server response. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { user, companyId, companyName } = useAuth();
  if (!user) return null;
  const tenantId = companyId ?? "";
  const tenant: Tenant = {
    id: tenantId,
    name: companyName ?? "Selecione uma empresa",
    cnpj: "",
    plan: "Free",
    status: "ativo",
    sharedAttendance: false,
  };
  const value: SessionContextValue = {
    session: { userId: user.id, tenantId, role: user.role },
    user: { ...user, tenantId },
    tenant,
    visibleTenants: tenantId ? [tenant] : [],
    isSuperAdmin: isPlatformRole(user.role),
    setUserId: noIdentityOverride,
    setTenantId: noIdentityOverride,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession deve ser usado dentro de SessionProvider");
  return value;
}
