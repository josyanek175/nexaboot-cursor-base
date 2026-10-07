import type { ResultsSummaryLike } from "@/lib/gerencial-overview";

function pct(n: number): string {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function OverviewFunnel({ results }: { results: ResultsSummaryLike }) {
  const max = Math.max(results.sentCount, 1);
  const steps = [
    {
      label: "Disparos",
      value: results.sentCount,
      width: 100,
      rate: null as string | null,
    },
    {
      label: "Interagiram",
      value: results.interactedCount,
      width: Math.max(8, (results.interactedCount / max) * 100),
      rate: pct(results.interactRate),
    },
    {
      label: "Interessados",
      value: results.interestedCount,
      width: Math.max(8, (results.interestedCount / max) * 100),
      rate: pct(results.interestedRate),
    },
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Funil</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Mesmos totais da tela Resultados
      </p>
      <div className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <div key={step.label}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{step.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {step.value.toLocaleString("pt-BR")}
                {step.rate ? ` · ${step.rate}` : ""}
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-whatsapp transition-[width] duration-500"
                style={{
                  width: `${step.width}%`,
                  opacity: 1 - i * 0.18,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
