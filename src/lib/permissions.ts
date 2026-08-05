// Permissões centralizadas — espelha as RLS planejadas no Supabase.
// Ver: src/lib/session.tsx para a sessão atual.

import type { Role, User, Tenant } from "./mocks";
import { isPlatformRole } from "./platform-roles";

export { isPlatformRole };

export interface ActingUser {
  id: string;
  role: Role;
  tenantId: string;
}

/** O alvo está dentro do escopo de tenant do ator? */
export function inTenantScope(actor: ActingUser, targetTenantId: string): boolean {
  if (isPlatformRole(actor.role)) return true;
  return actor.tenantId === targetTenantId;
}

// ─── Usuários ────────────────────────────────────────────────────────────────
export function canViewUsersScreen(actor: ActingUser): boolean {
  // ATENDENTE e ATENDENTE_GERAL não acessam gestão de usuários.
  return actor.role !== "ATENDENTE" && actor.role !== "ATENDENTE_GERAL";
}

/** Pode criar/editar/bloquear/resetar senha de usuários (dentro do escopo). */
export function canManageUsers(actor: ActingUser): boolean {
  return (
    actor.role === "ADMIN_GERAL" ||
    actor.role === "TI" ||
    actor.role === "ADMIN_EMPRESA" ||
    actor.role === "GERENTE" ||
    actor.role === "SUPERVISOR"
  );
}

export function canEditUser(actor: ActingUser, target: User): boolean {
  if (!canManageUsers(actor)) return false;
  return inTenantScope(actor, target.tenantId);
}

/** Exclusão só por ADMIN_GERAL, TI ou ADMIN_EMPRESA (dentro do tenant). */
export function canDeleteUser(actor: ActingUser, target: User): boolean {
  if (target.id === actor.id) return false;
  if (!inTenantScope(actor, target.tenantId)) return false;
  return actor.role === "ADMIN_GERAL" || actor.role === "TI" || actor.role === "ADMIN_EMPRESA";
}

export function canBlockUser(actor: ActingUser, target: User): boolean {
  return canEditUser(actor, target) && target.id !== actor.id;
}

/** Reset administrativo de senha — qualquer perfil de gestão, dentro do tenant. */
export function canResetPassword(actor: ActingUser, target: User): boolean {
  if (!canManageUsers(actor)) return false;
  return inTenantScope(actor, target.tenantId);
}

// ─── Empresas ────────────────────────────────────────────────────────────────
export function canCreateTenant(actor: ActingUser): boolean {
  return (
    actor.role === "ADMIN_GERAL" || actor.role === "TI" || (actor.role as string) === "SUPER_ADMIN"
  );
}

export function canEditTenant(actor: ActingUser, target: Tenant): boolean {
  if (isPlatformRole(actor.role)) return true;
  return actor.role === "ADMIN_EMPRESA" && actor.tenantId === target.id;
}

/** Suspender/excluir empresa: somente perfis de plataforma. */
export function canSuspendTenant(actor: ActingUser): boolean {
  return (
    actor.role === "ADMIN_GERAL" || actor.role === "TI" || (actor.role as string) === "SUPER_ADMIN"
  );
}

/** Pode iniciar Meta Coexistence (Embedded Signup). Espelha server: SUPER_ADMIN/TI/ADMIN_EMPRESA. */
export function canManageMetaCoexistence(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI" || r === "ADMIN_EMPRESA";
}

// ─── Canais ──────────────────────────────────────────────────────────────────
export function canManageChannels(actor: ActingUser): boolean {
  return actor.role === "ADMIN_GERAL" || actor.role === "TI" || actor.role === "ADMIN_EMPRESA";
}

// ─── Integrações globais (Evolution, Meta, N8N, etc.) ───────────────────────
export function canManageIntegrations(actor: ActingUser): boolean {
  return actor.role === "ADMIN_GERAL" || actor.role === "TI";
}

// ─── Relatórios ─────────────────────────────────────────────────────────────
/** Relatórios genéricos (legado) — exclui apenas atendentes. */
export function canViewReports(actor: ActingUser): boolean {
  return actor.role !== "ATENDENTE" && actor.role !== "ATENDENTE_GERAL";
}

/**
 * Relatório/auditoria de conversas — exclusivo ADMIN_EMPRESA e GERENTE.
 * SUPERVISOR, TI, SUPER_ADMIN e demais perfis: sem acesso.
 */
export function canViewConversationReports(actor: ActingUser): boolean {
  return actor.role === "ADMIN_EMPRESA" || actor.role === "GERENTE";
}

/** Menu e módulo: perfil autorizado + empresa operacional válida. */
export function canAccessConversationReportsModule(
  actor: ActingUser,
  companyValid: boolean,
): boolean {
  if (!canViewConversationReports(actor)) return false;
  return companyValid;
}

// ─── Campanhas ───────────────────────────────────────────────────────────────
/** Visualizar módulo Campanhas — ATENDENTE incluído; ATENDENTE_GERAL permanece excluído. */
export function canViewCampaigns(actor: ActingUser): boolean {
  return actor.role !== "ATENDENTE_GERAL";
}

/** Criar/editar campanhas, público, disparo — inclui ATENDENTE (escopo da própria empresa). */
export function canManageCampaigns(actor: ActingUser): boolean {
  return (
    isPlatformRole(actor.role as string) ||
    actor.role === "ADMIN_EMPRESA" ||
    actor.role === "GERENTE" ||
    actor.role === "SUPERVISOR" ||
    actor.role === "ATENDENTE"
  );
}

/** Excluir campanha em rascunho — SUPERVISOR e ATENDENTE não podem. */
export function canDeleteCampaign(actor: ActingUser): boolean {
  return (
    isPlatformRole(actor.role as string) ||
    actor.role === "ADMIN_EMPRESA" ||
    actor.role === "GERENTE"
  );
}

/**
 * Pausar/retomar disparo.
 * ATENDENTE: somente campanhas que ele criou.
 * Demais perfis com manage: qualquer campanha da empresa (já escopada no backend).
 */
export function canPauseResumeCampaign(
  actor: ActingUser,
  createdByUserId: string | null | undefined,
): boolean {
  if (!canManageCampaigns(actor)) return false;
  if (actor.role !== "ATENDENTE") return true;
  const creator = String(createdByUserId ?? "").trim();
  return creator.length > 0 && creator === actor.id;
}

/** Menu e módulo Campanhas: perfil autorizado + empresa operacional válida. */
export function canAccessCampaignsModule(actor: ActingUser, companyValid: boolean): boolean {
  if (!canViewCampaigns(actor)) return false;
  return companyValid;
}

/** Normaliza ActingUser a partir do auth (role real do banco, incl. SUPER_ADMIN). */
export function actingUserFromAuth(user: {
  id: string;
  role: string;
  tenantId: string;
}): ActingUser {
  return {
    id: user.id,
    role: user.role as ActingUser["role"],
    tenantId: user.tenantId,
  };
}

// ─── Atendimento ─────────────────────────────────────────────────────────────
/** Admins/TI/Supervisores/Gerente/Atendente_Geral enxergam todas as conversas do tenant. */
export function canSeeAllConversations(actor: ActingUser): boolean {
  return (
    actor.role === "ADMIN_GERAL" ||
    actor.role === "TI" ||
    actor.role === "ADMIN_EMPRESA" ||
    actor.role === "GERENTE" ||
    actor.role === "SUPERVISOR" ||
    actor.role === "ATENDENTE_GERAL"
  );
}

/**
 * Regra unificada de visibilidade de conversa.
 * - Sempre exige tenant escopo (nenhuma empresa vê dados de outra).
 * - ATENDENTE: vê atribuídas a ele + fila (sem assignee) em open/waiting.
 *   Se tenant.sharedAttendance = true, vê também todas as conversas open/waiting do tenant.
 * - ATENDENTE_GERAL/SUPERVISOR/GERENTE/ADMIN_EMPRESA/ADMIN_GERAL/TI: vê todas do tenant.
 */
export function canViewConversation(
  actor: ActingUser,
  conv: { tenantId: string; assignedTo?: string; status: "open" | "waiting" | "finished" },
  tenant: { sharedAttendance: boolean },
): boolean {
  if (!inTenantScope(actor, conv.tenantId)) return false;
  if (canSeeAllConversations(actor)) return true;
  if (conv.assignedTo === actor.id) return true;
  const inQueue = !conv.assignedTo && (conv.status === "open" || conv.status === "waiting");
  if (inQueue) return true;
  if (tenant.sharedAttendance && (conv.status === "open" || conv.status === "waiting")) return true;
  return false;
}
