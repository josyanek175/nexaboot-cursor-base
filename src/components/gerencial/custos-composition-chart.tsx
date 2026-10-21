import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatGerencialBrl } from "@/lib/gerencial-fetch";
import type { CategoryCompositionSlice } from "@/lib/gerencial-custos";

const COLORS: Record<CategoryCompositionSlice["key"], string> = {
  marketing: "#008069",
  utility: "#34B7A7",
  authentication: "#0B6E4F",
  other: "#94A3B8",
};

export function CustosCompositionChart({
  slices,
}: {
  slices: CategoryCompositionSlice[];
}) {
  const data = slices.filter((s) => s.costBrl > 0);
  const empty = data.length === 0;

  return (
    <section className="rounded-[12px] border border-border/80 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">
        Composição dos custos por categoria
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Soma do custo estimado das campanhas no período (frontend)
      </p>

      {empty ? (
        <p className="mt-10 text-center text-sm text-muted-foreground">
          Sem custo estimado no período para compor o gráfico.
        </p>
      ) : (
        <div className="mt-4 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          <div className="h-52 w-full sm:w-1/2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="costBrl"
                  nameKey="label"
                  innerRadius={52}
                  outerRadius={78}
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {data.map((entry) => (
                    <Cell key={entry.key} fill={COLORS[entry.key]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => formatGerencialBrl(value)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex-1 space-y-3">
            {data.map((s) => (
              <li key={s.key} className="flex items-start justify-between gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: COLORS[s.key] }}
                  />
                  <span className="font-medium">{s.label}</span>
                </div>
                <div className="text-right tabular-nums">
                  <div className="font-semibold">{formatGerencialBrl(s.costBrl)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {s.percent.toLocaleString("pt-BR", {
                      maximumFractionDigits: 1,
                    })}
                    %
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
