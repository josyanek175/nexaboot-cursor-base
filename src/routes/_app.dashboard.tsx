import { createFileRoute } from "@tanstack/react-router";
import {
  MessageSquare, Clock, CheckCircle2, Timer, ArrowDownLeft, ArrowUpRight,
  Smartphone, Workflow, AlertTriangle,
} from "lucide-react";
import { dashboardMetrics, channels, conversations, getContact, getChannel, formatTime } from "@/lib/mocks";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
  head: () => ({ meta: [{ title: "Dashboard — NexaBoot" }] }),
});

const cards = [
  { label: "Conversas abertas", icon: MessageSquare, key: "openConversations", tone: "text-whatsapp" },
  { label: "Aguardando", icon: Clock, key: "waiting", tone: "text-automation" },
  { label: "Finalizadas hoje", icon: CheckCircle2, key: "finishedToday", tone: "text-primary" },
  { label: "Tempo médio resposta (min)", icon: Timer, key: "avgResponseMinutes", tone: "text-foreground" },
  { label: "Mensagens recebidas", icon: ArrowDownLeft, key: "messagesIn", tone: "text-whatsapp" },
  { label: "Mensagens enviadas", icon: ArrowUpRight, key: "messagesOut", tone: "text-primary" },
  { label: "Canais conectados", icon: Smartphone, key: "channelsConnected", tone: "text-whatsapp" },
  { label: "Automações N8N ativas", icon: Workflow, key: "activeAutomations", tone: "text-automation" },
  { label: "Erros de webhook (24h)", icon: AlertTriangle, key: "webhookErrors24h", tone: "text-destructive" },
] as const;

function DashboardPage() {
  const recent = [...conversations].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, 5);

  return (
    <div className="h-full overflow-y-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Visão geral do atendimento da sua empresa.</p>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {cards.map(({ label, icon: Icon, key, tone }) => (
          <div key={key} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Icon className={`h-4 w-4 ${tone}`} />
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {String(dashboardMetrics[key as keyof typeof dashboardMetrics])}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">Canais WhatsApp</div>
          <ul className="divide-y divide-border">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.phone} · {c.provider}</div>
                </div>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">Conversas recentes</div>
          <ul className="divide-y divide-border">
            {recent.map((cv) => {
              const ct = getContact(cv.contactId);
              const ch = getChannel(cv.channelId);
              return (
                <li key={cv.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-sm font-medium">{ct.name}</div>
                    <div className="text-xs text-muted-foreground">{ch.name} · {ch.provider}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatTime(cv.lastMessageAt)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    connected: "bg-whatsapp/10 text-whatsapp",
    pending: "bg-automation/10 text-automation",
    error: "bg-destructive/10 text-destructive",
    disconnected: "bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    connected: "Conectado", pending: "Pendente", error: "Erro", disconnected: "Desconectado",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}>{label[status]}</span>;
}
