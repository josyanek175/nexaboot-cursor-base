import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Megaphone, ArrowLeft, Loader2, Save, Users, Search, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canManageCampaigns, actingUserFromAuth, canAccessCampaignsModule } from "@/lib/permissions";
import { apiGet } from "@/lib/api";

type Campaign = {
  id: string;
  name: string;
  status: string;
  message_text: string | null;
  whatsapp_channel_id: string | null;
  schedule_date: string | null;
  window_start_time: string | null;
  window_end_time: string | null;
  send_mode: string;
  total_contacts: number;
  skipped_count: number;
  sent_count?: number;
  total_replied?: number;
  total_interested?: number;
  total_opt_out?: number;
  channel_name: string | null;
  channel_unavailable: boolean;
};

type CampaignContact = {
  id: string;
  phone: string;
  name: string | null;
  status: string;
  skip_reason: string | null;
  greeting_variant?: string | null;
  closing_variant?: string | null;
  responded_at?: string | null;
  response_text?: string | null;
  response_intent?: string | null;
};

type ContactPick = {
  id: string;
  name: string;
  phone: string;
};

type ChannelOption = {
  id: string;
  name: string;
  channel_type: string;
  status: string;
};

export const Route = createFileRoute("/_app/campanhas/$id")({
  component: EditarCampanhaPage,
});

function campaignApiMessage(status: number, body: { error?: string; message?: string }): string {
  if (status === 401) return "Sessão expirada. Faça login novamente.";
  if (status === 403) {
    if (body.error === "no_company") {
      return body.message ?? "Selecione uma empresa para gerenciar campanhas.";
    }
    if (body.error === "forbidden") {
      return body.message ?? "Seu perfil não tem permissão para acessar Campanhas.";
    }
    return body.message ?? "Sem permissão para acessar Campanhas.";
  }
  return body.message ?? "Não foi possível carregar a campanha.";
}

function EditarCampanhaPage() {
  const { id } = Route.useParams();
  const { user, companyValid, companyId } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
  const canAccess = canAccessCampaignsModule(actor, companyValid);
  const canManage = canManageCampaigns(actor) && companyValid;

  const [tab, setTab] = useState<"dados" | "publico">("dados");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [channels, setChannels] = useState<ChannelOption[]>([]);

  const [audience, setAudience] = useState<CampaignContact[]>([]);
  const [audienceTotal, setAudienceTotal] = useState(0);
  const [audienceLoading, setAudienceLoading] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<ContactPick[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pickerLoading, setPickerLoading] = useState(false);
  const [channelUnavailable, setChannelUnavailable] = useState(false);

  const isDraft = campaign?.status === "draft";

  const CHANNEL_UNAVAILABLE_MSG =
    "O canal selecionado não está mais disponível. Escolha outro canal antes de enviar.";

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCampaign = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, { credentials: "include" });
    if (res.status === 401 || res.status === 403) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(campaignApiMessage(res.status, j));
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { campaign: Campaign };
    setCampaign(data.campaign);
    setName(data.campaign.name);
    setMessageText(data.campaign.message_text ?? "");
    setChannelId(data.campaign.whatsapp_channel_id ?? "");
    setScheduleDate(
      data.campaign.schedule_date ? String(data.campaign.schedule_date).slice(0, 10) : "",
    );
    const start = data.campaign.window_start_time
      ? String(data.campaign.window_start_time).slice(0, 5)
      : "09:00";
    const end = data.campaign.window_end_time
      ? String(data.campaign.window_end_time).slice(0, 5)
      : "18:00";
    setWindowStart(start);
    setWindowEnd(end);
    setChannelUnavailable(data.campaign.channel_unavailable ?? false);
  }, [id]);

  const loadAudience = useCallback(async () => {
    setAudienceLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/contacts?limit=100`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        contacts: CampaignContact[];
        total: number;
      };
      setAudience(data.contacts ?? []);
      setAudienceTotal(data.total ?? 0);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAudienceLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoadError(null);
      try {
        await loadCampaign();
        const chRes = await fetch("/api/evolution/channels", { credentials: "include" });
        if (chRes.ok) {
          const chData = (await chRes.json()) as { channels: ChannelOption[] };
          setChannels(
            (chData.channels ?? []).filter(
              (ch) => String(ch.channel_type).toLowerCase() === "evolution",
            ),
          );
        }
        await loadAudience();
      } catch (e) {
        const msg = (e as Error).message;
        setLoadError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [canAccess, loadCampaign, loadAudience, companyId]);

  async function handleSave() {
    if (!canManage || !isDraft) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          message_text: messageText.trim() || null,
          whatsapp_channel_id: channelId || null,
          schedule_date: scheduleDate || null,
          window_start_time: windowStart || null,
          window_end_time: windowEnd || null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (j.error === "invalid_window") {
          throw new Error("Horário inicial e final não podem ser iguais.");
        }
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success("Campanha atualizada");
      await loadCampaign();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSchedule() {
    if (!canManage || !isDraft) return;
    if (!scheduleDate || !windowStart || !windowEnd) {
      toast.error("Informe data, horário inicial e horário final antes de agendar.");
      return;
    }
    if (!channelId) {
      toast.error("Selecione o canal de envio.");
      return;
    }
    if (!messageText.trim()) {
      toast.error("Informe a mensagem modelo.");
      return;
    }
    setScheduling(true);
    try {
      const saveRes = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          message_text: messageText.trim() || null,
          whatsapp_channel_id: channelId || null,
          schedule_date: scheduleDate || null,
          window_start_time: windowStart || null,
          window_end_time: windowEnd || null,
        }),
      });
      if (!saveRes.ok) {
        const j = (await saveRes.json().catch(() => ({}))) as { error?: string };
        if (j.error === "invalid_window") {
          throw new Error("Horário inicial e final não podem ser iguais.");
        }
        throw new Error(j.error ?? `HTTP ${saveRes.status}`);
      }

      const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/schedule`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const map: Record<string, string> = {
          no_pending_contacts: "Adicione contatos pendentes ao público antes de agendar.",
          missing_channel: "Selecione o canal de envio.",
          missing_message: "Informe a mensagem modelo.",
          missing_schedule_date: "Informe a data de envio.",
          missing_window: "Informe horário inicial e final.",
          not_schedulable: "Esta campanha não pode ser agendada.",
        };
        throw new Error(map[j.error ?? ""] ?? j.error ?? `HTTP ${res.status}`);
      }
      toast.success("Campanha agendada — o worker enviará no horário configurado");
      await loadCampaign();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
  }

  async function searchContacts(q: string) {
    setPickerLoading(true);
    try {
      const path = q.trim() ? `/contacts?q=${encodeURIComponent(q.trim())}` : "/contacts";
      const data = (await apiGet(path)) as {
        contacts: { id: string; name: string; phone: string }[];
      };
      setContactResults(
        (data.contacts ?? []).map((c) => ({
          id: c.id,
          name: c.name ?? "",
          phone: c.phone ?? "",
        })),
      );
    } catch {
      setContactResults([]);
    } finally {
      setPickerLoading(false);
    }
  }

  useEffect(() => {
    if (!pickerOpen) return;
    const t = setTimeout(() => searchContacts(contactSearch), 300);
    return () => clearTimeout(t);
  }, [pickerOpen, contactSearch]);

  function toggleSelect(contactId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  async function addSelectedContacts() {
    if (!canManage || !isDraft || selectedIds.size === 0) return;
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/contacts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as { added: number; skipped: number };
      toast.success(`${result.added} contato(s) adicionado(s)`);
      setPickerOpen(false);
      setSelectedIds(new Set());
      await loadCampaign();
      await loadAudience();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function removeContact(rowId: string) {
    if (!canManage || !isDraft) return;
    try {
      const res = await fetch(
        `/api/campaigns/${encodeURIComponent(id)}/contacts/${encodeURIComponent(rowId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Contato removido do público");
      await loadCampaign();
      await loadAudience();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          Sem permissão ou empresa ativa necessária para acessar Campanhas.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando campanha…
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {loadError ?? "Campanha não encontrada."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Link to="/campanhas" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Megaphone className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">{campaign.name}</h1>
            <p className="text-xs text-muted-foreground">
              {campaign.status === "draft"
                ? "Rascunho"
                : campaign.status === "scheduled"
                  ? "Agendada"
                  : campaign.status === "running"
                    ? "Enviando"
                    : campaign.status === "paused"
                      ? "Pausada (fora da janela)"
                      : campaign.status === "completed"
                        ? "Finalizada"
                        : campaign.status}
              {" · "}
              {campaign.total_contacts} no público (total)
              {campaign.skipped_count > 0 ? ` · ${campaign.skipped_count} ignorados` : ""}
              {" · "}Modo: Automático seguro
            </p>
          </div>
        </div>
        {canManage && isDraft && tab === "dados" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || scheduling}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar rascunho
            </button>
            <button
              type="button"
              onClick={handleSchedule}
              disabled={saving || scheduling}
              className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
            >
              {scheduling ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Agendar envio
            </button>
          </div>
        )}
      </header>

      <div className="flex gap-1 border-b border-border px-6">
        <button
          type="button"
          onClick={() => setTab("dados")}
          className={`px-4 py-2 text-sm ${tab === "dados" ? "border-b-2 border-whatsapp font-medium" : "text-muted-foreground"}`}
        >
          Dados da campanha
        </button>
        <button
          type="button"
          onClick={() => setTab("publico")}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm ${tab === "publico" ? "border-b-2 border-whatsapp font-medium" : "text-muted-foreground"}`}
        >
          <Users className="h-3.5 w-3.5" /> Público ({audienceTotal} total)
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === "dados" && (
          <div className="mx-auto max-w-lg space-y-4">
            {channelUnavailable && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {CHANNEL_UNAVAILABLE_MSG}
              </p>
            )}
            {!isDraft && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Esta campanha não está em rascunho e não pode ser editada nesta fase.
              </p>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Nome</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canManage || !isDraft}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Canal / número de envio
              </span>
              <select
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                disabled={!canManage || !isDraft}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
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
                Mensagem modelo (tags da planilha)
              </span>
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                disabled={!canManage || !isDraft}
                rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
                placeholder="Corpo principal. Use {nome} e outras tags da planilha."
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Saudação e fechamento variam automaticamente; o corpo principal é preservado.
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
                disabled={!canManage || !isDraft}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
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
                  disabled={!canManage || !isDraft}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
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
                  disabled={!canManage || !isDraft}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
                />
              </label>
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium">Modo de envio:</span> Automático seguro
            </div>
          </div>
        )}

        {tab === "publico" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Respondidos" value={campaign.total_replied ?? 0} />
              <StatCard label="Interessados" value={campaign.total_interested ?? 0} />
              <StatCard label="Opt-out" value={campaign.total_opt_out ?? 0} />
              <StatCard label="Enviados" value={campaign.sent_count ?? 0} />
            </div>
            <p className="text-xs text-muted-foreground">
              O público inclui todos os contatos adicionados ({campaign.total_contacts} total
              {campaign.skipped_count > 0 ? `, ${campaign.skipped_count} ignorados` : ""}).
            </p>
            {canManage && isDraft && (
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(true);
                  setContactSearch("");
                  searchContacts("");
                }}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
              >
                <Plus className="h-4 w-4" /> Adicionar contatos
              </button>
            )}

            {audienceLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando público…
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left">Nome</th>
                      <th className="px-4 py-3 text-left">Telefone</th>
                      <th className="px-4 py-3 text-left">Status</th>
                      <th className="px-4 py-3 text-left">Resposta</th>
                      <th className="px-4 py-3 text-left">Intenção</th>
                      {canManage && isDraft && <th className="px-4 py-3 text-right">Ações</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {audience.length === 0 ? (
                      <tr>
                        <td
                          colSpan={canManage && isDraft ? 6 : 5}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Nenhum contato no público desta campanha.
                        </td>
                      </tr>
                    ) : (
                      audience.map((row) => (
                        <tr key={row.id} className="border-t border-border">
                          <td className="px-4 py-3">{row.name ?? "—"}</td>
                          <td className="px-4 py-3 font-mono text-xs">{row.phone}</td>
                          <td className="px-4 py-3 text-xs">
                            {row.status === "skipped" ? (
                              <span className="text-amber-700" title={row.skip_reason ?? ""}>
                                {row.skip_reason === "invalid_phone"
                                  ? "Telefone inválido"
                                  : row.skip_reason === "opt_out"
                                    ? "Opt-out"
                                    : row.skip_reason === "contact_inactive"
                                      ? "Inativo"
                                      : "Ignorado"}
                              </span>
                            ) : row.status === "responded" ? (
                              <span className="text-primary">Respondido</span>
                            ) : row.status === "sent" ? (
                              <span className="text-whatsapp">Enviado</span>
                            ) : row.status === "failed" || row.status === "erro_envio" ? (
                              <span className="text-destructive">Erro envio</span>
                            ) : (
                              "Pendente"
                            )}
                          </td>
                          <td className="max-w-[200px] truncate px-4 py-3 text-xs text-muted-foreground">
                            {row.response_text || "—"}
                          </td>
                          <td className="px-4 py-3 text-xs">
                            {intentLabel(row.response_intent)}
                          </td>
                          {canManage && isDraft && (
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => removeContact(row.id)}
                                className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                title="Remover"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border p-4">
              <h2 className="text-lg font-semibold">Adicionar contatos ao público</h2>
              <div className="relative mt-3">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="Buscar por nome ou telefone…"
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {pickerLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Buscando…
                </div>
              ) : contactResults.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum contato encontrado.
                </p>
              ) : (
                contactResults.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleSelect(c.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.name || "Sem nome"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{c.phone}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-md px-3 py-2 text-sm hover:bg-accent"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={addSelectedContacts}
                disabled={selectedIds.size === 0}
                className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
              >
                Adicionar ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function intentLabel(intent?: string | null): string {
  if (!intent) return "—";
  if (intent === "interested") return "Interessado";
  if (intent === "not_interested") return "Sem interesse";
  if (intent === "opt_out") return "Opt-out";
  if (intent === "unknown") return "Outra";
  return intent;
}
