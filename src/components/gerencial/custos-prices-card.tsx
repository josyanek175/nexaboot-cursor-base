import { formatGerencialBrl } from "@/lib/gerencial-fetch";
import type { GerencialCostPrices } from "@/lib/gerencial-custos";

/** Somente leitura — preços vindos do GET /api/campaigns/costs. */
export function CustosPricesCard({ prices }: { prices: GerencialCostPrices }) {
  return (
    <section className="rounded-[12px] border border-border/80 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">
        Configuração de preços
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Valores de referência atuais (somente leitura nesta aba)
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <PriceCell label="Marketing" value={prices.marketingBrl} />
        <PriceCell label="Utilidade" value={prices.utilityBrl} />
        <PriceCell label="Autenticação" value={prices.authenticationBrl} />
      </div>
    </section>
  );
}

function PriceCell({ label, value }: { label: string; value: number }) {
  const n = Number.isFinite(Number(value)) ? Number(value) : null;
  return (
    <div className="rounded-[10px] bg-muted/40 px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums">
        {n != null ? formatGerencialBrl(n) : "—"}
      </p>
    </div>
  );
}
