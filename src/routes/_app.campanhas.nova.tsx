import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Megaphone, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
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

function NovaCampanhaPage() {
  const { user, companyValid } = useAuth();
  const navigate = useNavigate();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
  const canManage = canManageCampaigns(actor) && companyValid;

  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [sendIntervalMs, setSendIntervalMs] = useState(5000);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    fetch("/api/evolution/channels", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((data: { channels: ChannelOption[] }) => {
        const evo = (data.channels ?? []).filter(
          (ch) => String(ch.channel_type).toLowerCase() === "evolution",
        );
        setChannels(evo);
        if (evo[0]) setChannelId(evo[0].id);
      })
      .catch(() => {});
  }, [canManage]);

  if (!canManage) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Sem permissão para criar campanhas.</p>
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
          send_interval_ms: sendIntervalMs,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
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
            Salvar como rascunho — sem envio nesta fase
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
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Mensagem</span>
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            placeholder="Texto que será enviado aos contatos…"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Canal WhatsApp (Evolution)
          </span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
          >
            <option value="">Nenhum (definir depois)</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name} ({ch.status})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Intervalo entre envios (ms) — usado na fase de envio
          </span>
          <input
            type="number"
            min={1000}
            max={600000}
            step={1000}
            value={sendIntervalMs}
            onChange={(e) => setSendIntervalMs(Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
          />
        </label>

        <div className="flex justify-end gap-2 pt-4">
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
