import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useGerencialPeriod } from "@/lib/gerencial-period";
import { gerencialFetchJson } from "@/lib/gerencial-fetch";
import { buildGerencialCsv, downloadGerencialCsv } from "@/lib/gerencial-csv";
import {
  buildCostComposition,
  buildTopCampaignsByCost,
  filterCampaignsByName,
  type GerencialCostPrices,
  type GerencialCostsCampaign,
  type GerencialCostsSummary,
} from "@/lib/gerencial-custos";
import { CustosKpiCards } from "@/components/gerencial/custos-kpi-cards";
import { CustosPricesCard } from "@/components/gerencial/custos-prices-card";
import { CustosCompositionChart } from "@/components/gerencial/custos-composition-chart";
import { CustosTopChart } from "@/components/gerencial/custos-top-chart";
import { CustosCampaignsTable } from "@/components/gerencial/custos-campaigns-table";

type CostsPayload = {
  summary: GerencialCostsSummary;
  campaigns: GerencialCostsCampaign[];
  prices: GerencialCostPrices;
};

export function CustosTab() {
  const { companyId } = useAuth();
  const { queryString, from, to } = useGerencialPeriod();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<GerencialCostsSummary | null>(null);
  const [campaigns, setCampaigns] = useState<GerencialCostsCampaign[]>([]);
  const [prices, setPrices] = useState<GerencialCostPrices | null>(null);
  const [search, setSearch] = useState("");

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const data = await gerencialFetchJson<CostsPayload>(
        `/api/campaigns/costs?${queryString}`,
      );
      setSummary(data.summary);
      setCampaigns(data.campaigns ?? []);
      setPrices(data.prices);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString, companyId]);

  const filtered = useMemo(
    () => filterCampaignsByName(campaigns, search),
    [campaigns, search],
  );

  const composition = useMemo(
    () => buildCostComposition(campaigns),
    [campaigns],
  );

  const topByCost = useMemo(
    () => buildTopCampaignsByCost(campaigns, 5),
    [campaigns],
  );

  function exportCsv() {
    const day = to || from || new Date().toISOString().slice(0, 10);
    const csv = buildGerencialCsv(filtered, [
      { header: "Campanha", value: (r) => r.campaignName },
      { header: "Canal", value: (r) => r.channelName ?? "" },
      {
        header: "Tipo",
        value: (r) => (r.channelType === "meta" ? "Meta" : "Evolution"),
      },
      { header: "Categoria", value: (r) => r.categoryLabel },
      { header: "Enviados", value: (r) => r.sentCount },
      { header: "Preço unitário BRL", value: (r) => r.unitPriceBrl },
      { header: "Custo estimado BRL", value: (r) => r.estimatedCostBrl },
      { header: "Último envio", value: (r) => r.lastSentAt ?? "" },
    ]);
    downloadGerencialCsv(`gerencial-custos-${day}.csv`, csv);
  }

  if (loading && !summary) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando custos…
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="rounded-[12px] border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-3 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!summary || !prices) {
    return (
      <div className="rounded-[12px] border border-border bg-white p-8 text-center text-sm text-muted-foreground shadow-sm">
        Não há custos de campanhas no período selecionado.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Período {from} → {to} · mesmos totais da tela Campanhas → Custos · BRL
          oficial
        </p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 rounded-[10px] border border-input bg-white px-3 py-2 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>

      {error ? (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}{" "}
          <button
            type="button"
            onClick={() => void reload()}
            className="ml-2 underline"
          >
            Tentar novamente
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando…
        </div>
      ) : null}

      <CustosKpiCards summary={summary} />

      <CustosPricesCard prices={prices} />

      <div className="grid gap-4 lg:grid-cols-2">
        <CustosCompositionChart slices={composition} />
        <CustosTopChart data={topByCost} />
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar campanha..."
          className="w-full rounded-[10px] border border-input bg-white py-2.5 pl-9 pr-3 text-sm shadow-sm outline-none ring-[#008069]/30 focus:ring-2"
        />
      </div>

      <CustosCampaignsTable rows={filtered} />
    </div>
  );
}
