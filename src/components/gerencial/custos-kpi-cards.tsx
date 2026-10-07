import { formatGerencialBrl } from "@/lib/gerencial-fetch";
import type { GerencialCostsSummary } from "@/lib/gerencial-custos";
import { avgCostPerSendBrl } from "@/lib/gerencial-custos";

export function CustosKpiCards({ summary }: { summary: GerencialCostsSummary }) {
  const avg = avgCostPerSendBrl(summary);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <article className="rounded-[12px] border border-border/80 bg-white px-5 py-4 shadow-sm">
        <p className="text-xs font-medium text-muted-foreground">Custo estimado</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
          {formatGerencialBrl(summary.estimatedCostBrl)}
        </p>
        <p className="mt-3 text-[11px] text-muted-foreground">Custo médio por disparo</p>
        <p className="mt-0.5 text-sm font-medium tabular-nums text-[#008069]">
          {avg != null ? formatGerencialBrl(avg) : "—"}
        </p>
      </article>

      <Kpi
        title="Disparos totais"
        value={String(summary.totalSent)}
      />
      <Kpi title="Disparos Meta" value={String(summary.metaSent)} />
      <Kpi title="Disparos Evolution" value={String(summary.evolutionSent)} />
    </div>
  );
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <article className="rounded-[12px] border border-border/80 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
    </article>
  );
}
