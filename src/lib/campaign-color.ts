/** Paleta e validação de cor de campanha (HEX #RRGGBB) — compartilhado client/server. */

export const DEFAULT_CAMPAIGN_COLOR = "#6B7280";

export const CAMPAIGN_COLOR_PALETTE = [
  "#2563EB",
  "#16A34A",
  "#7C3AED",
  "#EA580C",
  "#DC2626",
  "#CA8A04",
  "#DB2777",
  "#6B7280",
] as const;

export const CAMPAIGN_COLOR_HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function isValidCampaignColor(value: string | null | undefined): value is string {
  return typeof value === "string" && CAMPAIGN_COLOR_HEX_RE.test(value);
}

export function normalizeCampaignColor(value: string | null | undefined): string {
  if (isValidCampaignColor(value)) return value;
  return DEFAULT_CAMPAIGN_COLOR;
}
