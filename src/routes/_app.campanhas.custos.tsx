import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CircleDollarSign,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  actingUserFromAuth,
  canAccessCampaignsModule,
  canViewCampaignCosts,
} from "@/lib/permissions";
import { resolveCostPeriod } from "@/lib/campaign-costs";

type Prices = {
  marketingBrl: number;
  utilityBrl: number;
  authenticationBrl: number;
};

type Summary = {
  totalSent: number;
  metaSent: number;
  evolutionSent: number;
  estimatedCostBrl: number;
};

type CampaignRow = {
  campaignId: string;
  campaignName: string;
  status: string;
  channelType: string;
  channelName: string | null;
  categoryLabel: string;
  sentCount: number;
  unitPriceBrl: number;
  estimatedCostBrl: number;
  lastSentAt: string | null;
};

type Preset = "today" | "7d" | "month" | "prev_month" | "custom";

export const Route = createFileRoute("/_app/campanhas/custos")({
  component: CampanhasCustosPage,
});

function money(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function CampanhasCustosPage() {
  const { user, companyValid, companyId, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccessModule = canAccessCampaignsModule(actor, companyValid);
  const canAccess = canAccessModule && canViewCampaignCosts(actor);

  const initialPeriod = resolveCostPeriod({ preset: "month" });
  const [preset, setPreset] = useState<Preset>("month");
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>({
    totalSent: 0,
    metaSent: 0,
    evolutionSent: 0,
    estimatedCostBrl: 0,
  });
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [prices, setPrices] = useState<Prices>({
    marketingBrl: 0.3217,
    utilityBrl: 0.035,
    authenticationBrl: 0.035,
  });
  const [draft, setDraft] = useState<Prices>(prices);
  const [canConfigure, setCanConfigure] = useState(false);

  function applyPreset(next: Preset) {
    setPreset(next);
    if (next === "custom") return;
    const p = resolveCostPeriod({ preset: next });
    setFrom(p.from);
    setTo(p.to);
  }

  async function reload(opts?: { from?: string; to?: string; preset?: Preset }) {
    setLoading(true);
    setError(null);
    const qFrom = opts?.from ?? from;
    const qTo = opts?.to ?? to;
    const qPreset = opts?.preset ?? preset;
    try {
      const params = new URLSearchParams({
        preset: qPreset === "custom" ? "custom" : qPreset,
        from: qFrom,
        to: qTo,
      });
      const res = await fetch(`/api/campaigns/costs?${params}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
          detail?: string | null;
        };
        const base = j.message ?? j.error ?? `HTTP ${res.status}`;
        throw new Error(j.detail ? `${base} (${j.detail})` : base);
      }
      const data = (await res.json()) as {
        summary: Summary;
        campaigns: CampaignRow[];
        prices: Prices;
        period: { from: string; to: string; preset: Preset };
        canConfigure?: boolean;
      };
      setSummary(data.summary);
      setCampaigns(data.campaigns ?? []);
      setPrices(data.prices);
      setDraft(data.prices);
      setCanConfigure(!!data.canConfigure);
      if (data.period) {
        setFrom(data.period.from);
        setTo(data.period.to);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canAccess) {
      setLoading(false);
      setError(
        !canAccessModule
          ? companyMessage ??
            (companyValid
              ? "Sem permissão para acessar Campanhas."
              : "Selecione uma empresa ativa.")
          : "Apenas gerente ou admin pode ver custos de campanha.",
      );
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, companyId, companyValid, canAccess]);

  async function savePrices() {
    if (!canConfigure) return;
    setSaving(true);
    try {
      const res = await fetch("/api/campaigns/costs", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
          detail?: string | null;
        };
        const base = j.message ?? j.error ?? `HTTP ${res.status}`;
        throw new Error(j.detail ? `${base} (${j.detail})` : base);
      }
      toast.success("Preços atualizados");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {error ?? "Sem permissão para ver custos."}
        </p>
      </div>
    );
  }

  const presets: { id: Preset; label: string }[] = [
    { id: "today", label: "Hoje" },
    { id: "7d", label: "7 dias" },
    { id: "month", label: "Este mês" },
    { id: "prev_month", label: "Mês anterior" },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <CircleDollarSign className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Custos</h1>
            <p className="text-xs text-muted-foreground">
              Disparos Meta e Evolution · custo estimado em R$ (tabela configurável)
            </p>
          </div>
        </div>
        <Link
          to="/campanhas"
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-auto p-6">
        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Período</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  applyPreset(p.id);
                  const next = resolveCostPeriod({ preset: p.id });
                  void reload({ preset: p.id, from: next.from, to: next.to });
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
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
              onClick={() => reload({ preset: "custom", from, to })}
              className="rounded-md bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/80"
            >
              Aplicar
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Estimativa com preço atual cadastrado. A fatura oficial da Meta pode variar
            (entrega, país, volume). Evolution não tem cobrança Cloud API.
          </p>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando custos…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Disparos totais" value={String(summary.totalSent)} />
              <StatCard label="Disparos Meta" value={String(summary.metaSent)} />
              <StatCard label="Disparos Evolution" value={String(summary.evolutionSent)} />
              <StatCard
                label="Custo estimado"
                value={money(summary.estimatedCostBrl)}
                emphasize
              />
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left">Campanha</th>
                    <th className="px-4 py-3 text-left">Canal</th>
                    <th className="px-4 py-3 text-left">Tipo</th>
                    <th className="px-4 py-3 text-left">Categoria</th>
                    <th className="px-4 py-3 text-right">Enviados</th>
                    <th className="px-4 py-3 text-right">Preço unit.</th>
                    <th className="px-4 py-3 text-right">Custo est.</th>
                    <th className="px-4 py-3 text-left">Último envio</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-8 text-center text-muted-foreground"
                      >
                        Nenhum disparo no período selecionado.
                      </td>
                    </tr>
                  ) : (
                    campaigns.map((row) => (
                      <tr key={row.campaignId} className="border-t border-border">
                        <td className="px-4 py-3">
                          <Link
                            to="/campanhas/$id"
                            params={{ id: row.campaignId }}
                            className="font-medium text-whatsapp hover:underline"
                          >
                            {row.campaignName}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {row.channelName ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          {row.channelType === "meta" ? "Meta" : "Evolution"}
                        </td>
                        <td className="px-4 py-3">{row.categoryLabel}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {row.sentCount}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {row.channelType === "meta"
                            ? money(row.unitPriceBrl)
                            : "R$ 0,00"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium">
                          {money(row.estimatedCostBrl)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatDt(row.lastSentAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-1 text-sm font-medium">Tabela de preços (R$)</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Valores de referência Meta Brasil. Ajuste quando a Meta atualizar a tabela.
            Evolution permanece R$ 0,00.
          </p>
          {canConfigure ? (
            <div className="flex flex-wrap items-end gap-3">
              <MoneyInput
                label="Marketing"
                value={draft.marketingBrl}
                onChange={(v) => setDraft((d) => ({ ...d, marketingBrl: v }))}
              />
              <MoneyInput
                label="Utilidade"
                value={draft.utilityBrl}
                onChange={(v) => setDraft((d) => ({ ...d, utilityBrl: v }))}
              />
              <MoneyInput
                label="Autenticação"
                value={draft.authenticationBrl}
                onChange={(v) => setDraft((d) => ({ ...d, authenticationBrl: v }))}
              />
              <button
                type="button"
                disabled={saving}
                onClick={savePrices}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Salvar preços
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>Marketing: {money(prices.marketingBrl)}</div>
              <div>Utilidade: {money(prices.utilityBrl)}</div>
              <div>Autenticação: {money(prices.authenticationBrl)}</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${
          emphasize ? "text-whatsapp" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="text-xs">
      <span className="mb-1 block text-muted-foreground">{label} (R$)</span>
      <input
        type="number"
        min={0}
        step="0.0001"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-32 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}
