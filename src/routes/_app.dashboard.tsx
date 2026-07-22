import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  MessageSquare,
  UserX,
  UserCheck,
  Clock,
  MessageCircle,
  CheckCircle2,
  Smartphone,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ArrowRightLeft,
  ExternalLink,
  Megaphone,
  Send,
  Reply,
  MessageCircleOff,
  ThumbsUp,
  ThumbsDown,
  Ban,
  XCircle,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
  head: () => ({ meta: [{ title: "Dashboard — NexaBoot" }] }),
});

type DashCards = {
  open: number;
  unassigned: number;
  mine: number;
  waiting_agent: number;
  waiting_client: number;
  finished_today: number;
};

type ChannelItem = {
  id: string;
  name: string;
  instance: string | null;
  status: string;
  phone: string | null;
};

type AttendantRow = {
  user_id: string;
  name: string;
  active_count: number;
  waiting_reply_count: number;
  last_activity_at: string | null;
};

type ChannelStats = {
  channel_id: string;
  name: string;
  open_count: number;
  unassigned_count: number;
  last_message: string | null;
  last_message_at: string | null;
};

type CriticalItem = {
  id: string;
  contact_name: string;
  phone: string | null;
  channel_name: string;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  is_mine: boolean;
  last_message: string | null;
  last_message_at: string | null;
  status: string;
};

type TransferItem = {
  notification_id: string;
  conversation_id: string;
  title: string;
  body: string | null;
  from_user_name: string | null;
  created_at: string;
  contact_name: string | null;
  phone: string | null;
  channel_name: string | null;
};

type RecentItem = CriticalItem & {
  channel_id: string;
};

type DashboardData = {
  scope: "company" | "attendant";
  role: string;
  cards: DashCards;
  channels: {
    total: number;
    connected: number;
    disconnected: number;
    items: ChannelItem[];
  };
  by_attendant: AttendantRow[];
  by_channel: ChannelStats[];
  critical: {
    unassigned: CriticalItem[];
    no_reply_15m: CriticalItem[];
    received_today: CriticalItem[];
    transferred_to_me: TransferItem[];
  };
  recent: RecentItem[];
  generated_at: string;
};

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "open") return "Aberta";
  if (s === "waiting" || s === "pending") return "Aguardando";
  if (s === "finished" || s === "closed" || s === "resolved") return "Finalizada";
  return status || "—";
}

function channelStatusLabel(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "connected") return "Conectado";
  if (s === "connecting" || s === "qrcode") return "Conectando";
  if (s === "error") return "Erro";
  return "Desconectado";
}

function channelStatusClass(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "connected") return "bg-whatsapp/10 text-whatsapp";
  if (s === "connecting" || s === "qrcode") return "bg-amber-500/15 text-amber-700";
  if (s === "error") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

function responsibleLabel(item: { is_mine?: boolean; assigned_user_name?: string | null; assigned_user_id?: string | null }) {
  if (item.is_mine) return "Você";
  if (item.assigned_user_id) return item.assigned_user_name || "Atendente";
  return "Sem responsável";
}

type CampaignMetrics = {
  periodDays: number;
  messagesSent: number;
  responsesReceived: number;
  noResponse: number;
  interested: number;
  notInterested: number;
  optOut: number;
  sendErrors: number;
};

type RecentCampaign = {
  id: string;
  name: string;
  status: string;
  totalSent: number;
  totalResponded: number;
  totalInterested: number;
  totalNoResponse: number;
  totalOptOut: number;
  createdAt: string;
};

const EMPTY_CAMPAIGN_METRICS: CampaignMetrics = {
  periodDays: 30,
  messagesSent: 0,
  responsesReceived: 0,
  noResponse: 0,
  interested: 0,
  notInterested: 0,
  optOut: 0,
  sendErrors: 0,
};

const campaignCards = [
  { label: "Mensagens enviadas", icon: Send, key: "messagesSent" as const, tone: "text-primary" },
  { label: "Respostas recebidas", icon: Reply, key: "responsesReceived" as const, tone: "text-whatsapp" },
  { label: "Sem resposta", icon: MessageCircleOff, key: "noResponse" as const, tone: "text-muted-foreground" },
  { label: "Interessados", icon: ThumbsUp, key: "interested" as const, tone: "text-whatsapp" },
  { label: "Não interessados", icon: ThumbsDown, key: "notInterested" as const, tone: "text-automation" },
  { label: "Opt-out", icon: Ban, key: "optOut" as const, tone: "text-destructive" },
  { label: "Erros de envio", icon: XCircle, key: "sendErrors" as const, tone: "text-destructive" },
] as const;

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "Em envio",
  paused: "Pausada",
  manual_paused: "Pausada manualmente",
  completed: "Concluída",
  canceled: "Cancelada",
  failed: "Falhou",
};

function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [campaignMetrics, setCampaignMetrics] = useState<CampaignMetrics>(EMPTY_CAMPAIGN_METRICS);
  const [recentCampaigns, setRecentCampaigns] = useState<RecentCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const res = (await apiGet("/dashboard")) as DashboardData;
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar dashboard");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadCampaigns = useCallback(async (silent = false) => {
    if (!silent) setCampaignsLoading(true);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch("/api/dashboard/campaigns", {
        credentials: "include",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        setCampaignMetrics(EMPTY_CAMPAIGN_METRICS);
        setRecentCampaigns([]);
        return;
      }

      const json = (await res.json()) as {
        metrics?: CampaignMetrics;
        recentCampaigns?: RecentCampaign[];
      };

      setCampaignMetrics(json.metrics ?? EMPTY_CAMPAIGN_METRICS);
      setRecentCampaigns(json.recentCampaigns ?? []);
    } catch {
      setCampaignMetrics(EMPTY_CAMPAIGN_METRICS);
      setRecentCampaigns([]);
    } finally {
      if (!silent) setCampaignsLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    void loadCampaigns(false);

    const id = setInterval(() => {
      load(true);
      void loadCampaigns(true);
    }, 20_000);

    return () => clearInterval(id);
  }, [load, loadCampaigns]);

  async function openTransfer(n: TransferItem) {
    try {
      await apiPost("/attendance/notifications", { conversationId: n.conversation_id });
    } catch {
      /* best-effort */
    }
    window.location.href = `/atendimento?c=${encodeURIComponent(n.conversation_id)}`;
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando dashboard…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => load(false)}
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!data) return null;

  const cards = [
    { label: "Atendimentos abertos", value: data.cards.open, icon: MessageSquare, tone: "text-whatsapp" },
    { label: "Sem responsável", value: data.cards.unassigned, icon: UserX, tone: "text-amber-600" },
    { label: "Meus atendimentos", value: data.cards.mine, icon: UserCheck, tone: "text-primary" },
    { label: "Aguardando atendente", value: data.cards.waiting_agent, icon: Clock, tone: "text-amber-600" },
    { label: "Aguardando cliente", value: data.cards.waiting_client, icon: MessageCircle, tone: "text-sky-600" },
    { label: "Finalizados hoje", value: data.cards.finished_today, icon: CheckCircle2, tone: "text-muted-foreground" },
  ];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Visão operacional do atendimento WhatsApp
            {data.scope === "attendant" ? " · foco nos seus atendimentos e fila sem responsável" : " · empresa inteira"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      {/* Campanhas */}
      <section className="mt-5">
        <div className="mb-3 flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Campanhas</h2>
            <p className="text-xs text-muted-foreground">
              Indicadores consolidados dos últimos {campaignMetrics.periodDays} dias
            </p>
          </div>
        </div>

        {campaignsLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando indicadores de campanhas…
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
            {campaignCards.map(({ label, icon: Icon, key, tone }) => (
              <div key={key} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
                </div>
                <div className="mt-2 text-2xl font-semibold tabular-nums">{campaignMetrics[key]}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Canais */}
        <Section
          title="Canais WhatsApp"
          subtitle={`${data.channels.connected} conectados · ${data.channels.disconnected} desconectados · ${data.channels.total} total`}
        >
          {data.channels.items.length === 0 ? (
            <Empty text="Nenhum canal cadastrado." />
          ) : (
            <ul className="divide-y divide-border">
              {data.channels.items.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">{c.name}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.instance || "—"}
                      {c.phone ? ` · ${c.phone}` : ""}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${channelStatusClass(c.status)}`}>
                    {channelStatusLabel(c.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Notificações / transferências */}
        <Section
          title="Transferências para mim"
          subtitle={
            data.critical.transferred_to_me.length
              ? `${data.critical.transferred_to_me.length} não lida(s)`
              : "Nenhuma pendente"
          }
        >
          {data.critical.transferred_to_me.length === 0 ? (
            <Empty text="Nenhuma transferência pendente." />
          ) : (
            <ul className="divide-y divide-border">
              {data.critical.transferred_to_me.map((n) => (
                <li key={n.notification_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <ArrowRightLeft className="h-3.5 w-3.5 text-primary" />
                      {n.contact_name || "Conversa transferida"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {n.from_user_name ? `De ${n.from_user_name}` : n.title}
                      {n.channel_name ? ` · ${n.channel_name}` : ""}
                      {" · "}
                      {formatTime(n.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openTransfer(n)}
                    className="shrink-0 rounded-md bg-whatsapp px-2.5 py-1.5 text-xs font-medium text-whatsapp-foreground hover:opacity-90"
                  >
                    Abrir
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Por atendente */}
        <Section title="Atendimentos por atendente">
          {data.by_attendant.length === 0 ? (
            <Empty text="Nenhum atendente ativo." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Atendente</th>
                    <th className="px-4 py-2 text-right font-medium">Ativas</th>
                    <th className="px-4 py-2 text-right font-medium">Aguardando</th>
                    <th className="px-4 py-2 text-right font-medium">Última atividade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.by_attendant.map((a) => (
                    <tr key={a.user_id}>
                      <td className="px-4 py-2.5 font-medium">{a.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.active_count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.waiting_reply_count}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {formatTime(a.last_activity_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Por canal */}
        <Section title="Atendimentos por canal">
          {data.by_channel.length === 0 ? (
            <Empty text="Nenhum canal com dados." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Canal</th>
                    <th className="px-4 py-2 text-right font-medium">Abertas</th>
                    <th className="px-4 py-2 text-right font-medium">Sem resp.</th>
                    <th className="px-4 py-2 text-right font-medium">Última mensagem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.by_channel.map((c) => (
                    <tr key={c.channel_id}>
                      <td className="px-4 py-2.5 font-medium">{c.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.open_count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.unassigned_count}</td>
                      <td className="max-w-[180px] truncate px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {c.last_message || "—"}
                        {c.last_message_at ? ` · ${formatTime(c.last_message_at)}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {/* Críticas */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CriticalList title="Sem responsável" icon={UserX} items={data.critical.unassigned} />
        <CriticalList title="Sem resposta há +15 min" icon={AlertTriangle} items={data.critical.no_reply_15m} />
        <CriticalList title="Recebidas hoje" icon={MessageSquare} items={data.critical.received_today} />
      </div>

      {/* Últimas conversas */}
      <div className="mt-5">
        <Section title="Últimas conversas" subtitle="Atalho para o atendimento">
          {data.recent.length === 0 ? (
            <Empty text="Nenhuma conversa ativa no momento." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Contato</th>
                    <th className="px-4 py-2 text-left font-medium">Canal</th>
                    <th className="px-4 py-2 text-left font-medium">Responsável</th>
                    <th className="px-4 py-2 text-left font-medium">Última mensagem</th>
                    <th className="px-4 py-2 text-left font-medium">Horário</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.recent.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{r.contact_name}</div>
                        <div className="text-xs text-muted-foreground">{r.phone || "—"}</div>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.channel_name}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            r.is_mine
                              ? "bg-whatsapp/15 text-whatsapp"
                              : r.assigned_user_id
                                ? "bg-amber-500/15 text-amber-700"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {responsibleLabel(r)}
                        </span>
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-2.5 text-muted-foreground">
                        {r.last_message || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {formatTime(r.last_message_at)}
                      </td>
                      <td className="px-4 py-2.5 text-xs">{statusLabel(r.status)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <a
                          href={`/atendimento?c=${encodeURIComponent(r.id)}`}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Abrir <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {/* Últimas campanhas */}
      <div className="mt-5">
        <Section title="Últimas campanhas" subtitle="Resumo dos disparos mais recentes">
          {campaignsLoading ? (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando campanhas…
            </div>
          ) : recentCampaigns.length === 0 ? (
            <Empty text="Nenhuma campanha cadastrada ainda." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Campanha</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Enviados</th>
                    <th className="px-4 py-2 text-right font-medium">Respondidos</th>
                    <th className="px-4 py-2 text-right font-medium">Interessados</th>
                    <th className="px-4 py-2 text-right font-medium">Sem resposta</th>
                    <th className="px-4 py-2 text-right font-medium">Opt-out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentCampaigns.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium">
                        <Link to="/campanhas/$id" params={{ id: c.id }} className="hover:underline">
                          {c.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <CampaignStatusBadge status={c.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.totalSent}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.totalResponded}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.totalInterested}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.totalNoResponse}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.totalOptOut}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Atualizado em {formatTime(data.generated_at)} · atualização automática a cada 20s
      </p>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function CriticalList({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: typeof AlertTriangle;
  items: CriticalItem[];
}) {
  return (
    <Section title={title} subtitle={`${items.length} conversa(s)`}>
      {items.length === 0 ? (
        <Empty text="Nenhuma no momento." />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {item.contact_name}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.channel_name} · {responsibleLabel(item)} · {formatTime(item.last_message_at)}
                </div>
              </div>
              <a
                href={`/atendimento?c=${encodeURIComponent(item.id)}`}
                className="shrink-0 text-xs text-whatsapp hover:underline"
              >
                Abrir
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CampaignStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    scheduled: "bg-automation/10 text-automation",
    running: "bg-primary/10 text-primary",
    paused: "bg-automation/10 text-automation",
    completed: "bg-whatsapp/10 text-whatsapp",
    canceled: "bg-muted text-muted-foreground",
    failed: "bg-destructive/10 text-destructive",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted text-muted-foreground"}`}>
      {CAMPAIGN_STATUS_LABEL[status] ?? status}
    </span>
  );
}
