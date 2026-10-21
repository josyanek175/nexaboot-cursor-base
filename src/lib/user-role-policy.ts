import { isPlatformRole } from "./platform-roles";

const companyRoles = new Set([
  "ADMIN",
  "USER",
  "ADMIN_EMPRESA",
  "GERENTE",
  "SUPERVISOR",
  "ATENDENTE_GERAL",
  "ATENDENTE",
]);

/** Company administrators cannot create or take over a platform identity. */
export function canAssignUserRole(actorRole: string, requestedRole: string): boolean {
  if (requestedRole !== requestedRole.toUpperCase()) return false;
  if (!companyRoles.has(requestedRole) && !isPlatformRole(requestedRole)) return false;
  return isPlatformRole(actorRole) || companyRoles.has(requestedRole);
}
export function canManageUserIdentity(actorRole: string, targetRole: string): boolean {
  return isPlatformRole(actorRole) || !isPlatformRole(targetRole);
}
