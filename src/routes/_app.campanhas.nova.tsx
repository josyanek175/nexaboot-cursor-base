import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Megaphone, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canManageCampaigns, actingUserFromAuth } from "@/lib/permissions";

type ChannelOption = {
  id: string;
  name: string;
  channel_type: string;
  status: string;
};

export const Route = createFileRoute("/_app/campanhas/nova")({
  component: NovaCampanhaPage,
});

function campaignApiError(status: number, body: { error?: string; message?: string }): string {
  if (status === 401) return "Sessão expirada. Faça login novamente.";
  if (status === 403) {
    if (body.error === "no_company") {
      return body.message ?? "Selecione uma empresa ativa antes de criar campanha.";
    }
    if (body.error === "forbidden") return "Sem permissão para criar campanhas.";
    return body.message ?? "Sem permissão para criar campanhas.";
  }
  if (body.error === "invalid_channel") return "Canal WhatsApp inválido para esta empresa.";
  if (body.error === "invalid_window") return "Horário inicial e final não podem ser iguais.";
  if (body.error === "invalid_input") return "Dados da campanha inválidos.";
  return body.message ?? "Não foi possível salvar a campanha. Tente novamente.";
}

function toTimeInput(v: string): string {
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return v;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function NovaCampanhaPage() {
  const { user, companyValid, hydrated } = useAuth();
  const navigate = useNavigate();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
  const canManage = canManageCampaigns(actor) && companyValid;

  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    setChannelsError(null);
    fetch("/api/evolution/channels", { credentials: "include" })
      .then(async (r) => {
        if (r.status === 401) {
          setChannelsError("Sessão expirada. Faça login novamente.");
          return { channels: [] as ChannelOption[] };
        }
        if (r.status === 403) {
          const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
          setChannelsError(
            j.error === "no_company"
              ? "Selecione uma empresa ativa antes de criar campanha."
              : "Sem permissão para listar canais desta empresa.",
          );
          return { channels: [] as ChannelOption[] };
        }
        if (!r.ok) {
          setChannelsError("Não foi possível carregar os canais WhatsApp.");
          return { channels: [] as ChannelOption[] };
        }
        return r.json() as Promise<{ channels: ChannelOption[] }>;
      })
      .then((data: { channels: ChannelOption[] }) => {
        const evo = (data.channels ?? []).filter(
          (ch) => String(ch.channel_type).toLowerCase() === "evolution",
        );
        setChannels(evo);
        if (evo[0]) setChannelId(evo[0].id);
      })
      .catch(() => setChannelsError("Não foi possível carregar os canais WhatsApp."));
  }, [canManage]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {!companyValid
            ? "Selecione uma empresa ativa antes de criar campanha."
            : "Sem permissão para criar campanhas."}
        </p>
      </div>
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Informe o nome da campanha");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          message_text: messageText.trim() || null,
          whatsapp_channel_id: channelId || null,
          schedule_date: scheduleDate || null,
          window_start_time: windowStart ? toTimeInput(windowStart) : null,
          window_end_time: windowEnd ? toTimeInput(windowEnd) : null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(campaignApiError(res.status, j));
      }
      const data = (await res.json()) as { campaign: { id: string } };
      toast.success("Campanha salva como rascunho");
      navigate({ to: "/campanhas/$id", params: { id: data.campaign.id } });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-4">
        <Link to="/campanhas" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Megaphone className="h-5 w-5 text-whatsapp" />
        <div>
          <h1 className="text-lg font-semibold">Nova campanha</h1>
          <p className="text-xs text-muted-foreground">
            Configure a mensagem e a janela de envio — o ritmo é automático
          </p>
        </div>
      </header>

      <form
        onSubmit={handleSave}
        className="mx-auto w-full max-w-lg flex-1 overflow-auto p-6 space-y-4"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Nome da campanha
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            placeholder="Ex.: Promoção de março"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Canal / número de envio (WhatsApp)
          </span>
          {channelsError ? (
            <p className="mb-2 text-xs text-destructive">{channelsError}</p>
          ) : null}
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
          >
            <option value="">Selecione o canal</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name} ({ch.status})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Mensagem modelo (use tags da planilha)
          </span>
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            placeholder={"Ex.: Temos uma condição especial para você.\nUse tags como {nome} ou {telefone}."}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            O sistema adiciona automaticamente uma saudação e um fechamento variados.
            Tags: {"{nome}"}, {"{telefone}"} e colunas da planilha.
          </p>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Data de envio
          </span>
          <input
            type="date"
            value={scheduleDate}
            onChange={(e) => setScheduleDate(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Horário inicial
            </span>
            <input
              type="time"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Horário final
            </span>
            <input
              type="time"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            />
          </label>
        </div>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">Modo de envio:</span> Automático seguro
        </div>

        <p className="text-xs text-muted-foreground">
          A lista de contatos (planilha/público) é definida na próxima tela, após salvar o rascunho.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Link to="/campanhas" className="rounded-md px-3 py-2 text-sm hover:bg-accent">
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Salvar rascunho
          </button>
        </div>
      </form>
    </div>
  );
}
