import { isPlatformRole } from "./platform-roles";

export const COMPANY_USER_ROLES = [
  "ADMIN_EMPRESA",
  "GERENTE",
  "SUPERVISOR",
  "ATENDENTE_GERAL",
  "ATENDENTE",
  "USER",
];
export const PLATFORM_USER_ROLES = ["SUPER_ADMIN", "ADMIN_GERAL", "TI"];

export function canAssignUserRole(actorRole: string, nextRole: string): boolean {
  if (nextRole === "SUPER_ADMIN") return actorRole === "SUPER_ADMIN";
  return (
    COMPANY_USER_ROLES.includes(nextRole) ||
    (isPlatformRole(actorRole) && PLATFORM_USER_ROLES.includes(nextRole))
  );
}

export function canManageUserTarget(actorRole: string, targetRole: string): boolean {
  if (targetRole === "SUPER_ADMIN") return actorRole === "SUPER_ADMIN";
  return isPlatformRole(actorRole) || !isPlatformRole(targetRole);
}
