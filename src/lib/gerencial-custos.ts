/**
 * Agregações da aba Gerencial > Custos — só frontend, a partir do payload
 * de GET /api/campaigns/costs. Sem SQL / sem regra nova no backend.
 */

export type GerencialCostsSummary = {
  totalSent: number;
  metaSent: number;
  evolutionSent: number;
  estimatedCostBrl: number;
};

export type GerencialCostsCampaign = {
  campaignId: string;
  campaignName: string;
  channelType: string;
  channelName: string | null;
  categoryLabel: string;
  sentCount: number;
  unitPriceBrl: number;
  estimatedCostBrl: number;
  lastSentAt: string | null;
};

export type GerencialCostPrices = {
  marketingBrl: number;
  utilityBrl: number;
  authenticationBrl: number;
};

/** Custo médio = estimatedCostBrl / totalSent; totalSent 0 → null. */
export function avgCostPerSendBrl(summary: GerencialCostsSummary): number | null {
  const total = Number(summary.totalSent) || 0;
  if (total <= 0) return null;
  const cost = Number(summary.estimatedCostBrl) || 0;
  return Math.round((cost / total) * 100) / 100;
}

export type CategoryCompositionSlice = {
  key: "marketing" | "utility" | "authentication" | "other";
  label: string;
  costBrl: number;
  percent: number;
};

/**
 * Soma estimatedCostBrl por categoryLabel (Marketing / Utilidade / Autenticação).
 * Linhas Evolution (label "—") entram em "other" só se custo > 0.
 */
export function buildCostComposition(
  campaigns: GerencialCostsCampaign[],
): CategoryCompositionSlice[] {
  let marketing = 0;
  let utility = 0;
  let authentication = 0;
  let other = 0;

  for (const c of campaigns) {
    const cost = Number(c.estimatedCostBrl) || 0;
    if (cost <= 0) continue;
    const label = String(c.categoryLabel ?? "").trim();
    if (label === "Marketing") marketing += cost;
    else if (label === "Utilidade") utility += cost;
    else if (label === "Autenticação") authentication += cost;
    else other += cost;
  }

  const total = marketing + utility + authentication + other;
  const pct = (n: number) =>
    total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

  const slices: CategoryCompositionSlice[] = [
    { key: "marketing", label: "Marketing", costBrl: round2(marketing), percent: pct(marketing) },
    { key: "utility", label: "Utilidade", costBrl: round2(utility), percent: pct(utility) },
    {
      key: "authentication",
      label: "Autenticação",
      costBrl: round2(authentication),
      percent: pct(authentication),
    },
  ];
  if (other > 0) {
    slices.push({
      key: "other",
      label: "Outros",
      costBrl: round2(other),
      percent: pct(other),
    });
  }
  return slices.filter((s) => s.costBrl > 0 || total === 0);
}

export function buildTopCampaignsByCost(
  campaigns: GerencialCostsCampaign[],
  limit = 5,
): { name: string; costBrl: number; campaignId: string }[] {
  return [...campaigns]
    .sort(
      (a, b) =>
        (Number(b.estimatedCostBrl) || 0) - (Number(a.estimatedCostBrl) || 0),
    )
    .slice(0, limit)
    .map((c) => ({
      campaignId: c.campaignId,
      costBrl: Number(c.estimatedCostBrl) || 0,
      name:
        c.campaignName.length > 32
          ? `${c.campaignName.slice(0, 30)}…`
          : c.campaignName,
    }));
}

export function filterCampaignsByName(
  campaigns: GerencialCostsCampaign[],
  query: string,
): GerencialCostsCampaign[] {
  const q = query.trim().toLowerCase();
  if (!q) return campaigns;
  return campaigns.filter((c) =>
    String(c.campaignName ?? "")
      .toLowerCase()
      .includes(q),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
