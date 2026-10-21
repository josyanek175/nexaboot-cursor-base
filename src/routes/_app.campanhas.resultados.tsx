import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ChartColumn, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  actingUserFromAuth,
  canAccessCampaignsModule,
  canViewCampaignCosts,
} from "@/lib/permissions";
import { resolveCostPeriod } from "@/lib/campaign-costs";

type Summary = {
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
};

type CampaignRow = {
  campaignId: string;
  campaignName: string;
  status: string;
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
  lastSentAt: string | null;
};

type Preset = "today" | "7d" | "month" | "prev_month" | "custom";

export const Route = createFileRoute("/_app/campanhas/resultados")({
  component: CampanhasResultadosPage,
});

function pct(n: number): string {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function formatDt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function CampanhasResultadosPage() {
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
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>({
    sentCount: 0,
    interactedCount: 0,
    interestedCount: 0,
    interactRate: 0,
    interestedRate: 0,
  });
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);

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
      const res = await fetch(`/api/campaigns/results?${params}`, {
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
        period: { from: string; to: string; preset: Preset };
      };
      setSummary(data.summary);
      setCampaigns(data.campaigns ?? []);
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
          : "Apenas gerente ou admin pode ver resultados de campanha.",
      );
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, companyId, companyValid, canAccess]);

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {error ?? "Sem permissão para ver resultados."}
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
          <ChartColumn className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Resultados</h1>
            <p className="text-xs text-muted-foreground">
              Disparos, quem interagiu e quem demonstrou interesse
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
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
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
            Interagiram = qualquer resposta. Interessados = intenção positiva classificada
            no atendimento da campanha.
          </p>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando resultados…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard label="Disparos" value={String(summary.sentCount)} />
              <StatCard label="Interagiram" value={String(summary.interactedCount)} />
              <StatCard label="Taxa interação" value={pct(summary.interactRate)} />
              <StatCard label="Interessados" value={String(summary.interestedCount)} emphasize />
              <StatCard label="Taxa interesse" value={pct(summary.interestedRate)} emphasize />
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left">Campanha</th>
                    <th className="px-4 py-3 text-right">Disparos</th>
                    <th className="px-4 py-3 text-right">Interagiram</th>
                    <th className="px-4 py-3 text-right">% interação</th>
                    <th className="px-4 py-3 text-right">Interessados</th>
                    <th className="px-4 py-3 text-right">% interesse</th>
                    <th className="px-4 py-3 text-left">Último envio</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
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
                        <td className="px-4 py-3 text-right tabular-nums">{row.sentCount}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {row.interactedCount}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {pct(row.interactRate)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium">
                          {row.interestedCount}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {pct(row.interestedRate)}
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
