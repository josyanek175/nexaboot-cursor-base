import { useGerencialPeriod, type GerencialPeriodPreset } from "@/lib/gerencial-period";

const PRESETS: { id: Exclude<GerencialPeriodPreset, "custom">; label: string }[] = [
  { id: "today", label: "Hoje" },
  { id: "7d", label: "7 dias" },
  { id: "month", label: "Este mês" },
  { id: "prev_month", label: "Mês anterior" },
];

export function PeriodFilter() {
  const { preset, from, to, setPreset, setFrom, setTo, applyPreset, applyCustom } =
    useGerencialPeriod();

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-sm font-medium">Período</p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              preset === p.id
                ? "bg-whatsapp text-whatsapp-foreground"
                : "border border-border bg-background hover:bg-muted"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">De</span>
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPreset("custom");
              setFrom(e.target.value);
            }}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Até</span>
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPreset("custom");
              setTo(e.target.value);
            }}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => applyCustom(from, to)}
          className="rounded-md bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/80"
        >
          Aplicar
        </button>
      </div>
    </section>
  );
}
