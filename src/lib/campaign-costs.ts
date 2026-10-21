/**
 * Custos estimados de disparo de campanha (fase 1).
 * Preço atual em R$ × quantidade enviada (Meta). Evolution = R$ 0.
 */

export type MetaCostCategory = "marketing" | "utility" | "authentication";

export type CampaignCostPrices = {
  marketingBrl: number;
  utilityBrl: number;
  authenticationBrl: number;
};

/** Defaults aproximados tabela Meta Brasil (referência; gerente pode editar). */
export const DEFAULT_CAMPAIGN_COST_PRICES: CampaignCostPrices = {
  marketingBrl: 0.3217,
  utilityBrl: 0.035,
  authenticationBrl: 0.035,
};

export type CampaignCostPeriodPreset = "today" | "7d" | "month" | "prev_month" | "custom";

export function clampMoneyBrl(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  // até 4 casas para preço unitário
  return Math.round(n * 10_000) / 10_000;
}

export function normalizeCampaignCostPrices(raw: {
  marketingBrl?: unknown;
  utilityBrl?: unknown;
  authenticationBrl?: unknown;
}): CampaignCostPrices {
  return {
    marketingBrl: clampMoneyBrl(raw.marketingBrl, DEFAULT_CAMPAIGN_COST_PRICES.marketingBrl),
    utilityBrl: clampMoneyBrl(raw.utilityBrl, DEFAULT_CAMPAIGN_COST_PRICES.utilityBrl),
    authenticationBrl: clampMoneyBrl(
      raw.authenticationBrl,
      DEFAULT_CAMPAIGN_COST_PRICES.authenticationBrl,
    ),
  };
}

export function normalizeMetaCostCategory(raw: string | null | undefined): MetaCostCategory {
  const c = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (c === "UTILITY") return "utility";
  if (c === "AUTHENTICATION" || c === "AUTH") return "authentication";
  return "marketing";
}

export function unitPriceForCategory(
  category: MetaCostCategory | null,
  prices: CampaignCostPrices,
  channelType: "meta" | "evolution" | string,
): number {
  if (String(channelType).toLowerCase() !== "meta") return 0;
  if (!category) return prices.marketingBrl;
  if (category === "utility") return prices.utilityBrl;
  if (category === "authentication") return prices.authenticationBrl;
  return prices.marketingBrl;
}

export function estimateCostBrl(sentCount: number, unitPrice: number): number {
  const n = Math.max(0, Math.floor(sentCount));
  const total = n * unitPrice;
  return Math.round(total * 100) / 100;
}

/** Formata YYYY-MM-DD no fuso America/Sao_Paulo. */
export function formatDateInSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function resolveCostPeriod(opts: {
  preset?: CampaignCostPeriodPreset | string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): { from: string; to: string; preset: CampaignCostPeriodPreset } {
  const now = opts.now ?? new Date();
  const today = formatDateInSaoPaulo(now);
  const preset = (opts.preset as CampaignCostPeriodPreset) || "month";

  if (preset === "custom" || opts.from || opts.to) {
    const from = (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : today) as string;
    const to = (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : from) as string;
    return from <= to ? { from, to, preset: "custom" } : { from: to, to: from, preset: "custom" };
  }

  if (preset === "today") {
    return { from: today, to: today, preset: "today" };
  }

  if (preset === "7d") {
    const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: formatDateInSaoPaulo(start), to: today, preset: "7d" };
  }

  if (preset === "prev_month") {
    // Primeiro e último dia do mês anterior em SP (via partes zoned).
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear = m === 1 ? y - 1 : y;
    const from = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
    const to = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to, preset: "prev_month" };
  }

  // month (default): do dia 1 ao hoje
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return { from: `${y}-${m}-01`, to: today, preset: "month" };
}
