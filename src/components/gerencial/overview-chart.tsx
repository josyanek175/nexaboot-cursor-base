import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function OverviewChart({
  data,
}: {
  data: { name: string; sentCount: number }[];
}) {
  if (data.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">Top campanhas por disparos</h2>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Sem dados no período.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Top campanhas por disparos</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Ranking a partir dos dados já carregados (sem série diária)
      </p>
      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 48 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11 }}
              interval={0}
              angle={-28}
              textAnchor="end"
              height={60}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
            <Tooltip
              formatter={(value: number) => [
                value.toLocaleString("pt-BR"),
                "Disparos",
              ]}
            />
            <Bar dataKey="sentCount" fill="#008069" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
