import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { useGerencialPeriod } from "@/lib/gerencial-period";
import {
  formatGerencialDt,
  formatGerencialPct,
  gerencialFetchJson,
} from "@/lib/gerencial-fetch";
import { buildGerencialCsv, downloadGerencialCsv } from "@/lib/gerencial-csv";

type Summary = {
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
};

type CampaignRow = {
  campaignId: string;
  campaignName: string;
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
  lastSentAt: string | null;
};

export function ResultadosTab() {
  const { companyId } = useAuth();
  const { queryString, from, to } = useGerencialPeriod();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await gerencialFetchJson<{
          summary: Summary;
          campaigns: CampaignRow[];
        }>(`/api/campaigns/results?${queryString}`);
        if (cancelled) return;
        setSummary(data.summary);
        setCampaigns(data.campaigns ?? []);
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

  function exportCsv() {
    const csv = buildGerencialCsv(campaigns, [
      { header: "Campanha", value: (r) => r.campaignName },
      { header: "Disparos", value: (r) => r.sentCount },
      { header: "Interagiram", value: (r) => r.interactedCount },
      { header: "% Interação", value: (r) => r.interactRate },
      { header: "Interessados", value: (r) => r.interestedCount },
      { header: "% Interesse", value: (r) => r.interestedRate },
      { header: "Último envio", value: (r) => r.lastSentAt ?? "" },
    ]);
    downloadGerencialCsv(`gerencial-resultados_${from}_${to}.csv`, csv);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando resultados…
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {error ?? "Não foi possível carregar resultados."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Mesmos critérios da tela Campanhas → Resultados · período {from} → {to}
        </p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={campaigns.length === 0}
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Interagiram = qualquer resposta. Interessados = intenção positiva classificada
        no atendimento da campanha.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Disparos" value={String(summary.sentCount)} />
        <StatCard label="Interagiram" value={String(summary.interactedCount)} />
        <StatCard label="Taxa interação" value={formatGerencialPct(summary.interactRate)} />
        <StatCard
          label="Interessados"
          value={String(summary.interestedCount)}
          emphasize
        />
        <StatCard
          label="Taxa interesse"
          value={formatGerencialPct(summary.interestedRate)}
          emphasize
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left">Campanha</th>
              <th className="px-4 py-3 text-right">Disparos</th>
              <th className="px-4 py-3 text-right">Interagiram</th>
              <th className="px-4 py-3 text-right">% interação</th>
              <th className="px-4 py-3 text-right">Interessados</th>
              <th className="px-4 py-3 text-right">% interesse</th>
              <th className="px-4 py-3 text-left">Último envio</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Nenhum disparo no período selecionado.
                </td>
              </tr>
            ) : (
              campaigns.map((row) => (
                <tr key={row.campaignId} className="border-t border-border">
                  <td className="px-4 py-3">
                    <Link
                      to="/campanhas/$id"
                      params={{ id: row.campaignId }}
                      className="font-medium text-whatsapp hover:underline"
                    >
                      {row.campaignName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{row.sentCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.interactedCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatGerencialPct(row.interactRate)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {row.interestedCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatGerencialPct(row.interestedRate)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatGerencialDt(row.lastSentAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${
          emphasize ? "text-whatsapp" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
