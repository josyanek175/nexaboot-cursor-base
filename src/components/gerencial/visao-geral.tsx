import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useGerencialPeriod } from "@/lib/gerencial-period";
import {
  assertOverviewParity,
  buildOverviewCampaignRows,
  buildOverviewCards,
  buildTopCampaignsBySent,
  type CostsCampaignLike,
  type CostsSummaryLike,
  type ResultsCampaignLike,
  type ResultsSummaryLike,
} from "@/lib/gerencial-overview";
import { buildGerencialCsv, downloadGerencialCsv } from "@/lib/gerencial-csv";
import { OverviewCards } from "@/components/gerencial/overview-cards";
import { OverviewFunnel } from "@/components/gerencial/overview-funnel";
import { OverviewCampaignsTable } from "@/components/gerencial/overview-campaigns-table";
import { OverviewChart } from "@/components/gerencial/overview-chart";

type ResultsPayload = {
  summary: ResultsSummaryLike;
  campaigns: ResultsCampaignLike[];
};

type CostsPayload = {
  summary: CostsSummaryLike;
  campaigns: CostsCampaignLike[];
};

type BlocksPayload = {
  blocked: unknown[];
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
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

function moneyBrl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function VisaoGeral() {
  const { companyId } = useAuth();
  const { queryString, from, to } = useGerencialPeriod();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [costs, setCosts] = useState<CostsPayload | null>(null);
  const [blockedCount, setBlockedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [r, c, b] = await Promise.all([
          fetchJson<ResultsPayload>(`/api/campaigns/results?${queryString}`),
          fetchJson<CostsPayload>(`/api/campaigns/costs?${queryString}`),
          fetchJson<BlocksPayload>("/api/campaigns/dispatch-blocks"),
        ]);
        if (cancelled) return;
        setResults(r);
        setCosts(c);
        setBlockedCount(Array.isArray(b.blocked) ? b.blocked.length : 0);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [queryString, companyId]);

  const cards = useMemo(() => {
    if (!results || !costs) return null;
    return buildOverviewCards({
      results: results.summary,
      costs: costs.summary,
      blockedCount,
    });
  }, [results, costs, blockedCount]);

  const rows = useMemo(() => {
    if (!results || !costs) return [];
    return buildOverviewCampaignRows({
      resultsCampaigns: results.campaigns ?? [],
      costsCampaigns: costs.campaigns ?? [],
    });
  }, [results, costs]);

  const chartData = useMemo(() => buildTopCampaignsBySent(rows, 8), [rows]);

  const parity = useMemo(() => {
    if (!results || !costs || !cards) return null;
    return assertOverviewParity({
      results: results.summary,
      costs: costs.summary,
      blockedCount,
      cards,
    });
  }, [results, costs, cards, blockedCount]);

  function exportCsv() {
    const csv = buildGerencialCsv(rows, [
      { header: "Campanha", value: (r) => r.campaignName },
      { header: "Disparos", value: (r) => r.sentCount },
      { header: "Interagiram", value: (r) => r.interactedCount },
      { header: "% Interação", value: (r) => r.interactRate },
      { header: "Interessados", value: (r) => r.interestedCount },
      { header: "% Interesse", value: (r) => r.interestedRate },
      {
        header: "Custo R$",
        value: (r) =>
          r.estimatedCostBrl != null ? moneyBrl(r.estimatedCostBrl) : "",
      },
      { header: "Último envio", value: (r) => r.lastSentAt ?? "" },
    ]);
    downloadGerencialCsv(`gerencial-visao-geral_${from}_${to}.csv`, csv);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando visão geral…
      </div>
    );
  }

  if (error || !results || !costs || !cards) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {error ?? "Não foi possível montar a visão geral."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Período {from} → {to} · dados das telas Resultados, Custos e
          Bloqueados
        </p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>

      {parity && !parity.ok ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          Divergência vs payloads das telas antigas (regra não alterada):{" "}
          {parity.mismatches.join(" · ")}
        </div>
      ) : null}

      <OverviewCards cards={cards} />

      <div className="grid gap-4 lg:grid-cols-2">
        <OverviewFunnel results={results.summary} />
        <OverviewChart data={chartData} />
      </div>

      <OverviewCampaignsTable rows={rows} />
    </div>
  );
}
