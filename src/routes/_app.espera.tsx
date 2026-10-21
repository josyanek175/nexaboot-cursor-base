import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { actingUserFromAuth, canViewCampaignCosts } from "@/lib/permissions";
import { resolveCostPeriod } from "@/lib/campaign-costs";
import { formatDurationSeconds } from "@/lib/campaign-metrics";

type Summary = {
  assumedCount: number;
  avgWaitSeconds: number | null;
  medianWaitSeconds: number | null;
  waitingNowCount: number;
};

type QueueRow = {
  conversationId: string;
  contactName: string | null;
  phone: string | null;
  waitingSeconds: number;
  lastInboundAt: string;
};

type AgentRow = {
  userId: string;
  userName: string | null;
  assumedCount: number;
  avgWaitSeconds: number | null;
};

type Preset = "today" | "7d" | "month" | "prev_month" | "custom";

export const Route = createFileRoute("/_app/espera")({
  component: TempoEsperaPage,
});

function formatDt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function TempoEsperaPage() {
  const { user, companyValid, companyId, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccess = companyValid && canViewCampaignCosts(actor);

  const initialPeriod = resolveCostPeriod({ preset: "month" });
  const [preset, setPreset] = useState<Preset>("month");
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>({
    assumedCount: 0,
    avgWaitSeconds: null,
    medianWaitSeconds: null,
    waitingNowCount: 0,
  });
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);

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
      const res = await fetch(`/api/dashboard/wait?${params}`, {
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
        queue: QueueRow[];
        agents: AgentRow[];
        period: { from: string; to: string; preset: Preset };
      };
      setSummary(data.summary);
      setQueue(data.queue ?? []);
      setAgents(data.agents ?? []);
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
        companyMessage ??
          (companyValid
            ? "Apenas gerente ou admin pode ver o tempo de espera."
            : "Selecione uma empresa ativa."),
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
          {error ?? "Sem permissão para ver tempo de espera."}
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
          <Clock className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Tempo de espera</h1>
            <p className="text-xs text-muted-foreground">
              Quanto o cliente espera até um atendente assumir a conversa
            </p>
          </div>
        </div>
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          Dashboard
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-auto p-6">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium">Período (atendimentos assumidos)</p>
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
            Média e mediana usam conversas assumidas no período (mensagem do cliente até
            assumir). A fila atual não entra na média.
          </p>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando espera…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Tempo médio"
                value={formatDurationSeconds(summary.avgWaitSeconds)}
                emphasize
              />
              <StatCard
                label="Mediana"
                value={formatDurationSeconds(summary.medianWaitSeconds)}
              />
              <StatCard label="Assumidas no período" value={String(summary.assumedCount)} />
              <StatCard label="Esperando agora" value={String(summary.waitingNowCount)} />
            </div>

            <section>
              <h2 className="mb-2 text-sm font-medium">Fila atual</h2>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left">Contato</th>
                      <th className="px-4 py-3 text-left">Telefone</th>
                      <th className="px-4 py-3 text-left">Esperando há</th>
                      <th className="px-4 py-3 text-left">Última msg cliente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.length === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Ninguém esperando atendente agora.
                        </td>
                      </tr>
                    ) : (
                      queue.map((row) => (
                        <tr key={row.conversationId} className="border-t border-border">
                          <td className="px-4 py-3">{row.contactName ?? "—"}</td>
                          <td className="px-4 py-3 font-mono text-xs">{row.phone ?? "—"}</td>
                          <td className="px-4 py-3 font-medium">
                            {formatDurationSeconds(row.waitingSeconds)}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {formatDt(row.lastInboundAt)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium">Por atendente (período)</h2>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left">Atendente</th>
                      <th className="px-4 py-3 text-right">Assumidas</th>
                      <th className="px-4 py-3 text-right">Espera média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.length === 0 ? (
                      <tr>
                        <td
                          colSpan={3}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Nenhuma conversa assumida no período.
                        </td>
                      </tr>
                    ) : (
                      agents.map((row) => (
                        <tr key={row.userId} className="border-t border-border">
                          <td className="px-4 py-3">{row.userName ?? "—"}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {row.assumedCount}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatDurationSeconds(row.avgWaitSeconds)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
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
