import type { ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import { GerencialPeriodProvider } from "@/lib/gerencial-period";
import { GerencialTabs } from "@/components/gerencial/gerencial-tabs";
import { PeriodFilter } from "@/components/gerencial/period-filter";

export function GerencialLayout({ children }: { children: ReactNode }) {
  return (
    <GerencialPeriodProvider>
      <div className="flex h-full flex-col bg-muted/30">
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-whatsapp/10 text-whatsapp">
              <ChartColumn className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Gerencial</h1>
              <p className="text-xs text-muted-foreground">
                Indicadores e desempenho das campanhas
              </p>
            </div>
          </div>
          <div className="mt-4">
            <GerencialTabs />
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-auto p-4 md:p-6">
          <PeriodFilter />
          {children}
        </div>
      </div>
    </GerencialPeriodProvider>
  );
}
