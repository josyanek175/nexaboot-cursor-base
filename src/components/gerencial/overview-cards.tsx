import type { buildOverviewCards } from "@/lib/gerencial-overview";

type Cards = ReturnType<typeof buildOverviewCards>;

function moneyBrl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function pct(n: number): string {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function OverviewCards({ cards }: { cards: Cards }) {
  const items: { label: string; value: string; hint?: string }[] = [
    { label: "Disparos", value: String(cards.sentCount) },
    {
      label: "Interagiram",
      value: String(cards.interactedCount),
      hint: pct(cards.interactRate),
    },
    {
      label: "Interessados",
      value: String(cards.interestedCount),
      hint: pct(cards.interestedRate),
    },
    {
      label: "Custo estimado",
      value: moneyBrl(cards.estimatedCostBrl),
    },
    { label: "Bloqueados", value: String(cards.blockedCount) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="text-xs text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {item.value}
          </div>
          {item.hint ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {item.hint}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
