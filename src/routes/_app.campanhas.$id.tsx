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
  send_interval_ms: number;
  total_contacts: number;
  skipped_count: number;
  channel_name: string | null;
  channel_unavailable: boolean;
};

type CampaignContact = {
  id: string;
  phone: string;
  name: string | null;
  status: string;
  skip_reason: string | null;
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

  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [sendIntervalMs, setSendIntervalMs] = useState(5000);
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

  const loadCampaign = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { campaign: Campaign };
    setCampaign(data.campaign);
    setName(data.campaign.name);
    setMessageText(data.campaign.message_text ?? "");
    setChannelId(data.campaign.whatsapp_channel_id ?? "");
    setSendIntervalMs(data.campaign.send_interval_ms);
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
        toast.error((e as Error).message);
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
          send_interval_ms: sendIntervalMs,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
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
        <p className="text-sm text-muted-foreground">Campanha não encontrada.</p>
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
              Rascunho · {campaign.total_contacts} no público (total)
              {campaign.skipped_count > 0 ? ` · ${campaign.skipped_count} ignorados` : ""}
            </p>
          </div>
        </div>
        {canManage && isDraft && tab === "dados" && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar rascunho
          </button>
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
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Mensagem</span>
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                disabled={!canManage || !isDraft}
                rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Canal WhatsApp (Evolution)
              </span>
              <select
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                disabled={!canManage || !isDraft}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
              >
                <option value="">Nenhum</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} ({ch.status})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Intervalo entre envios (ms)
              </span>
              <input
                type="number"
                min={1000}
                max={600000}
                value={sendIntervalMs}
                onChange={(e) => setSendIntervalMs(Number(e.target.value))}
                disabled={!canManage || !isDraft}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp disabled:opacity-60"
              />
            </label>
          </div>
        )}

        {tab === "publico" && (
          <div className="space-y-4">
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
                      {canManage && isDraft && <th className="px-4 py-3 text-right">Ações</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {audience.length === 0 ? (
                      <tr>
                        <td
                          colSpan={canManage && isDraft ? 4 : 3}
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
                                Ignorado
                              </span>
                            ) : (
                              "Pendente"
                            )}
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
