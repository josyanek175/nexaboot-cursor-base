import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatGerencialBrl } from "@/lib/gerencial-fetch";

export function CustosTopChart({
  data,
}: {
  data: { name: string; costBrl: number }[];
}) {
  return (
    <section className="rounded-[12px] border border-border/80 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">
        Top campanhas por custo
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Ranking a partir do custo estimado já carregado (sem série diária)
      </p>

      {data.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted-foreground">
          Sem campanhas com custo no período.
        </p>
      ) : (
        <div className="mt-4 h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
              <XAxis
                type="number"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) =>
                  Number(v).toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                    maximumFractionDigits: 0,
                  })
                }
              />
              <YAxis
                type="category"
                dataKey="name"
                width={110}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                formatter={(value: number) => [
                  formatGerencialBrl(value),
                  "Custo estimado",
                ]}
              />
              <Bar dataKey="costBrl" fill="#008069" radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
