import { Link } from "@tanstack/react-router";
import type { OverviewCampaignRow } from "@/lib/gerencial-overview";

function pct(n: number): string {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function moneyBrl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

export function OverviewCampaignsTable({
  rows,
}: {
  rows: OverviewCampaignRow[];
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Desempenho por campanha</h2>
        <p className="text-xs text-muted-foreground">
          Resultados + custo BRL cruzado por id da campanha
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left">Campanha</th>
              <th className="px-4 py-3 text-right">Disparos</th>
              <th className="px-4 py-3 text-right">Interagiram</th>
              <th className="px-4 py-3 text-right">% Interação</th>
              <th className="px-4 py-3 text-right">Interessados</th>
              <th className="px-4 py-3 text-right">% Interesse</th>
              <th className="px-4 py-3 text-right">Custo R$</th>
              <th className="px-4 py-3 text-left">Último envio</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Nenhum disparo no período selecionado.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
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
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.sentCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.interactedCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {pct(row.interactRate)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {row.interestedCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {pct(row.interestedRate)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.estimatedCostBrl != null
                      ? moneyBrl(row.estimatedCostBrl)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDt(row.lastSentAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
