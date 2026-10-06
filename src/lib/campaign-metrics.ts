/** Taxas e formatação para dashboards de Resultados e Tempo de espera. */

export function ratePercent(part: number, whole: number): number {
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return 0;
  return Math.round((Math.max(0, p) / w) * 1000) / 10;
}

export function averageSeconds(totalSeconds: number, count: number): number | null {
  const t = Number(totalSeconds);
  const n = Math.floor(Number(count));
  if (!Number.isFinite(t) || n <= 0) return null;
  return Math.round(t / n);
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
