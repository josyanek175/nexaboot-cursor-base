/**
 * Período compartilhado das abas Gerencial (Visão Geral / Resultados / Custos / Bloqueados).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { resolveCostPeriod, type CampaignCostPeriodPreset } from "@/lib/campaign-costs";

export type GerencialPeriodPreset = CampaignCostPeriodPreset;

export type GerencialPeriodState = {
  preset: GerencialPeriodPreset;
  from: string;
  to: string;
  setPreset: (preset: GerencialPeriodPreset) => void;
  setFrom: (from: string) => void;
  setTo: (to: string) => void;
  applyPreset: (preset: Exclude<GerencialPeriodPreset, "custom">) => void;
  applyCustom: (from: string, to: string) => void;
  /** Query string pronta para as APIs existentes. */
  queryString: string;
};

const GerencialPeriodContext = createContext<GerencialPeriodState | null>(null);

export function GerencialPeriodProvider({ children }: { children: ReactNode }) {
  const initial = resolveCostPeriod({ preset: "month" });
  const [preset, setPreset] = useState<GerencialPeriodPreset>("month");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  const applyPreset = useCallback((next: Exclude<GerencialPeriodPreset, "custom">) => {
    const p = resolveCostPeriod({ preset: next });
    setPreset(next);
    setFrom(p.from);
    setTo(p.to);
  }, []);

  const applyCustom = useCallback((nextFrom: string, nextTo: string) => {
    const p = resolveCostPeriod({
      preset: "custom",
      from: nextFrom,
      to: nextTo,
    });
    setPreset("custom");
    setFrom(p.from);
    setTo(p.to);
  }, []);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      preset: preset === "custom" ? "custom" : preset,
      from,
      to,
    });
    return params.toString();
  }, [preset, from, to]);

  const value = useMemo(
    () => ({
      preset,
      from,
      to,
      setPreset,
      setFrom,
      setTo,
      applyPreset,
      applyCustom,
      queryString,
    }),
    [preset, from, to, applyPreset, applyCustom, queryString],
  );

  return (
    <GerencialPeriodContext.Provider value={value}>{children}</GerencialPeriodContext.Provider>
  );
}

export function useGerencialPeriod(): GerencialPeriodState {
  const ctx = useContext(GerencialPeriodContext);
  if (!ctx) {
    throw new Error("useGerencialPeriod deve ser usado dentro de GerencialPeriodProvider");
  }
  return ctx;
}
