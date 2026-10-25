// Perfis de plataforma NexaBoot — fonte única para API e frontend.
// Podem listar/gerir todas as empresas; não são limitados por company_id na tela /empresas.

export function isPlatformRole(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI" || r === "ADMIN_GERAL";
}

/** Provisionar uma nova empresa é uma ação exclusiva do dono da plataforma. */
export function canCreateCompany(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN";
}
