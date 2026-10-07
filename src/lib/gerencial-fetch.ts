/** Fetch JSON autenticado usado pelas abas Gerencial (somente leitura/APIs antigas). */

export async function gerencialFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      detail?: string | null;
    };
    const base = j.message ?? j.error ?? `HTTP ${res.status}`;
    throw new Error(j.detail ? `${base} (${j.detail})` : base);
  }
  return (await res.json()) as T;
}

export function formatGerencialPct(n: number): string {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function formatGerencialBrl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatGerencialDt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return String(iso);
  }
}
