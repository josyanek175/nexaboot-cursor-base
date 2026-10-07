import { Link } from "@tanstack/react-router";
import { formatGerencialBrl, formatGerencialDt } from "@/lib/gerencial-fetch";
import type { GerencialCostsCampaign } from "@/lib/gerencial-custos";

export function CustosCampaignsTable({
  rows,
}: {
  rows: GerencialCostsCampaign[];
}) {
  return (
    <section className="overflow-hidden rounded-[12px] border border-border/80 bg-white shadow-sm">
      <div className="border-b border-border/80 px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">
          Custos por campanha
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Detalhamento dos custos no período selecionado
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-5 py-3 text-left font-medium">Campanha</th>
              <th className="px-4 py-3 text-left font-medium">Canal</th>
              <th className="px-4 py-3 text-left font-medium">Tipo</th>
              <th className="px-4 py-3 text-left font-medium">Categoria</th>
              <th className="px-4 py-3 text-right font-medium">Enviados</th>
              <th className="px-4 py-3 text-right font-medium">Preço unitário</th>
              <th className="px-4 py-3 text-right font-medium">Custo estimado</th>
              <th className="px-5 py-3 text-left font-medium">Último envio</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-10 text-center text-muted-foreground"
                >
                  Não há custos de campanhas no período selecionado.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.campaignId}
                  className="border-t border-border/70 hover:bg-muted/20"
                >
                  <td className="px-5 py-3">
                    <Link
                      to="/campanhas/$id"
                      params={{ id: row.campaignId }}
                      className="font-medium text-[#008069] hover:underline"
                    >
                      {row.campaignName || "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.channelName ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {row.channelType === "meta"
                      ? "Meta"
                      : row.channelType === "evolution"
                        ? "Evolution"
                        : row.channelType || "—"}
                  </td>
                  <td className="px-4 py-3">
                    {row.categoryLabel && row.categoryLabel !== "—"
                      ? row.categoryLabel
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Number.isFinite(row.sentCount) ? row.sentCount : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {row.channelType === "meta" &&
                    Number.isFinite(row.unitPriceBrl)
                      ? formatGerencialBrl(row.unitPriceBrl)
                      : row.channelType === "evolution"
                        ? formatGerencialBrl(0)
                        : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold">
                    {Number.isFinite(row.estimatedCostBrl)
                      ? formatGerencialBrl(row.estimatedCostBrl)
                      : "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    {formatGerencialDt(row.lastSentAt)}
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
