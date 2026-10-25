import type { Tenant } from "./mocks";

/** Legacy UI consumers use the real company, never demo tenants. */
export function operationalCompanyId(companyId: string | null, valid: boolean): string {
  return valid && companyId ? companyId : "";
}
export function operationalTenant(
  companyId: string | null,
  companyName: string | null,
  valid: boolean,
): Tenant | null {
  const id = operationalCompanyId(companyId, valid);
  if (!id) return null;
  return {
    id,
    name: companyName || "Empresa selecionada",
    cnpj: "",
    // Compatibility fields; never grant plans or access through this projection.
    plan: "Free",
    status: "ativo",
    sharedAttendance: false,
  };
}
