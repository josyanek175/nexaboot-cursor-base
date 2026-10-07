/**
 * Montagem da Visão Geral a partir dos payloads já existentes
 * (results + costs + dispatch-blocks). Sem SQL novo. Sem USD nesta etapa
 * (cotação exigiria endpoint antigo ou API nova).
 */

export type ResultsSummaryLike = {
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
};

export type ResultsCampaignLike = {
  campaignId: string;
  campaignName: string;
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
  lastSentAt: string | null;
};

export type CostsSummaryLike = {
  totalSent: number;
  metaSent: number;
  evolutionSent: number;
  estimatedCostBrl: number;
};

export type CostsCampaignLike = {
  campaignId: string;
  estimatedCostBrl: number;
  lastSentAt: string | null;
};

/** Cards da Visão Geral — mesmos números das telas antigas. */
export function buildOverviewCards(opts: {
  results: ResultsSummaryLike;
  costs: CostsSummaryLike;
  blockedCount: number;
}) {
  const { results, costs, blockedCount } = opts;
  return {
    sentCount: results.sentCount,
    interactedCount: results.interactedCount,
    interestedCount: results.interestedCount,
    interactRate: results.interactRate,
    interestedRate: results.interestedRate,
    estimatedCostBrl: Number(costs.estimatedCostBrl) || 0,
    metaSent: costs.metaSent,
    evolutionSent: costs.evolutionSent,
    totalSentCosts: costs.totalSent,
    blockedCount,
  };
}

export type OverviewCampaignRow = {
  campaignId: string;
  campaignName: string;
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
  /** null = campanha sem linha em custos (não inventar 0). */
  estimatedCostBrl: number | null;
  lastSentAt: string | null;
};

/**
 * Tabela: base em Resultados; custo cruzado por campaignId (mesmo id nas duas APIs).
 * Sem match → custo null (UI "—").
 */
export function buildOverviewCampaignRows(opts: {
  resultsCampaigns: ResultsCampaignLike[];
  costsCampaigns: CostsCampaignLike[];
}): OverviewCampaignRow[] {
  const costById = new Map(
    opts.costsCampaigns.map((c) => [c.campaignId, c] as const),
  );
  return opts.resultsCampaigns.map((r) => {
    const cost = costById.get(r.campaignId);
    return {
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      sentCount: r.sentCount,
      interactedCount: r.interactedCount,
      interestedCount: r.interestedCount,
      interactRate: r.interactRate,
      interestedRate: r.interestedRate,
      estimatedCostBrl:
        cost != null ? Number(cost.estimatedCostBrl) || 0 : null,
      lastSentAt: r.lastSentAt ?? cost?.lastSentAt ?? null,
    };
  });
}

/** Top N campanhas por disparos (dados já carregados). */
export function buildTopCampaignsBySent(
  rows: OverviewCampaignRow[],
  limit = 8,
): { name: string; sentCount: number }[] {
  return [...rows]
    .sort((a, b) => b.sentCount - a.sentCount)
    .slice(0, limit)
    .map((r) => ({
      name:
        r.campaignName.length > 28
          ? `${r.campaignName.slice(0, 26)}…`
          : r.campaignName,
      sentCount: r.sentCount,
    }));
}

/** Paridade: totais da Visão Geral vs payloads das telas antigas. */
export function assertOverviewParity(opts: {
  results: ResultsSummaryLike;
  costs: CostsSummaryLike;
  blockedCount: number;
  cards: ReturnType<typeof buildOverviewCards>;
}): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const { results, costs, blockedCount, cards } = opts;
  if (cards.sentCount !== results.sentCount) {
    mismatches.push(
      `disparos: gerencial=${cards.sentCount} resultados=${results.sentCount}`,
    );
  }
  if (cards.interactedCount !== results.interactedCount) {
    mismatches.push(
      `interagiram: gerencial=${cards.interactedCount} resultados=${results.interactedCount}`,
    );
  }
  if (cards.interestedCount !== results.interestedCount) {
    mismatches.push(
      `interessados: gerencial=${cards.interestedCount} resultados=${results.interestedCount}`,
    );
  }
  if (cards.interactRate !== results.interactRate) {
    mismatches.push(
      `taxa interação: gerencial=${cards.interactRate} resultados=${results.interactRate}`,
    );
  }
  if (cards.interestedRate !== results.interestedRate) {
    mismatches.push(
      `taxa interesse: gerencial=${cards.interestedRate} resultados=${results.interestedRate}`,
    );
  }
  if (cards.estimatedCostBrl !== (Number(costs.estimatedCostBrl) || 0)) {
    mismatches.push(
      `custo BRL: gerencial=${cards.estimatedCostBrl} custos=${costs.estimatedCostBrl}`,
    );
  }
  if (cards.blockedCount !== blockedCount) {
    mismatches.push(
      `bloqueados: gerencial=${cards.blockedCount} bloqueados=${blockedCount}`,
    );
  }
  return { ok: mismatches.length === 0, mismatches };
}
