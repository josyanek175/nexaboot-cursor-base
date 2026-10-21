/**
 * Export CSV isolado do Gerencial (frontend only).
 * Não reutiliza nem altera exports existentes de campanhas.
 */

export type GerencialCsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

function escapeCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildGerencialCsv<T>(
  rows: T[],
  columns: GerencialCsvColumn<T>[],
): string {
  const header = columns.map((c) => escapeCell(c.header)).join(";");
  const body = rows.map((row) =>
    columns.map((c) => escapeCell(c.value(row))).join(";"),
  );
  return [header, ...body].join("\r\n");
}

export function downloadGerencialCsv(filename: string, csv: string): void {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
