/**
 * Helpers CSV seguros (UTF-8 BOM, ; , CSV Injection, timezone de apresentação).
 * Sem dependência de banco.
 */

export const CSV_EXPORT_TIMEZONE = "America/Sao_Paulo";

const CSV_INJECTION_RE = /^[=+\-@]/;

export function neutralizeCsvInjection(value: string): string {
  if (!value) return value;
  if (CSV_INJECTION_RE.test(value)) return `'${value}`;
  return value;
}

export function escapeCsvField(value: string): string {
  const safe = neutralizeCsvInjection(value);
  if (/[;"\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function formatCsvDateTime(
  value: Date | string | null | undefined,
  timeZone: string = CSV_EXPORT_TIMEZONE,
): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function joinCsvRow(cells: Array<string | null | undefined>): string {
  return cells.map((c) => escapeCsvField(String(c ?? ""))).join(";");
}
