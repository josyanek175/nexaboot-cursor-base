import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Copy,
  FileText,
  Loader2,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canManageCampaigns, actingUserFromAuth } from "@/lib/permissions";
import { previewEvolutionTemplate, EVOLUTION_TEMPLATE_VARIABLES } from "@/lib/campaign-template-variables";

type ChannelOption = { id: string; name: string; channel_type: string };

type EvolutionTemplate = {
  id: string;
  name: string;
  visible_body: string;
  description: string | null;
  active: boolean;
  footer: string | null;
  response_options: Array<{ n: number; label: string; intent: string }>;
  source_meta_template_name: string | null;
  variables: string[];
  updated_at: string;
};

type MetaTemplate = {
  id: string;
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  active: boolean;
  bodyText: string | null;
  buttons: string[];
  variables: string[];
};

export const Route = createFileRoute("/_app/campanhas/modelos")({
  component: CampanhasModelosPage,
});

function CampanhasModelosPage() {
  const { user, companyValid, hydrated } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
  const canManage = canManageCampaigns(actor) && companyValid;

  const [tab, setTab] = useState<"meta" | "evolution">("evolution");
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [metaChannelId, setMetaChannelId] = useState("");
  const [evolutionTemplates, setEvolutionTemplates] = useState<EvolutionTemplate[]>([]);
  const [metaTemplates, setMetaTemplates] = useState<MetaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingMeta, setSyncingMeta] = useState(false);
  const [editing, setEditing] = useState<EvolutionTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formFooter, setFormFooter] = useState("");
  const [saving, setSaving] = useState(false);

  const metaChannels = useMemo(
    () => channels.filter((c) => String(c.channel_type).toLowerCase() === "meta"),
    [channels],
  );

  const formPreview = useMemo(() => previewEvolutionTemplate(formBody), [formBody]);

  async function loadChannels() {
    const res = await fetch("/api/evolution/channels", { credentials: "include" });
    if (!res.ok) return;
    const data = (await res.json()) as { channels: ChannelOption[] };
    const list = (data.channels ?? []).filter((c) => {
      const t = String(c.channel_type).toLowerCase();
      return t === "meta" || t === "evolution";
    });
    setChannels(list);
    const firstMeta = list.find((c) => String(c.channel_type).toLowerCase() === "meta");
    if (firstMeta) setMetaChannelId(firstMeta.id);
  }

  async function loadEvolutionTemplates() {
    const res = await fetch("/api/campaigns/templates?includeInactive=1", { credentials: "include" });
    if (!res.ok) return;
    const data = (await res.json()) as { templates: EvolutionTemplate[] };
    setEvolutionTemplates(data.templates ?? []);
  }

  async function loadMetaTemplates(chId: string) {
    if (!chId) {
      setMetaTemplates([]);
      return;
    }
    const res = await fetch(
      `/api/meta/channels/${encodeURIComponent(chId)}/templates?approved=1`,
      { credentials: "include" },
    );
    if (!res.ok) {
      setMetaTemplates([]);
      return;
    }
    const data = (await res.json()) as { templates: MetaTemplate[] };
    setMetaTemplates(data.templates ?? []);
  }

  useEffect(() => {
    if (!canManage) return;
    setLoading(true);
    Promise.all([loadChannels(), loadEvolutionTemplates()])
      .finally(() => setLoading(false));
  }, [canManage]);

  useEffect(() => {
    if (tab === "meta" && metaChannelId) void loadMetaTemplates(metaChannelId);
  }, [tab, metaChannelId]);

  async function syncMeta() {
    if (!metaChannelId) return;
    setSyncingMeta(true);
    try {
      const res = await fetch(
        `/api/meta/channels/${encodeURIComponent(metaChannelId)}/templates/sync`,
        { method: "POST", credentials: "include" },
      );
      const j = (await res.json().catch(() => ({}))) as { synced?: number; approved?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.success(`Sincronizados ${j.synced ?? 0} (${j.approved ?? 0} aprovados)`);
      await loadMetaTemplates(metaChannelId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncingMeta(false);
    }
  }

  async function createFromMeta(tpl: MetaTemplate) {
    setSaving(true);
    try {
      const res = await fetch("/api/campaigns/templates/from-meta", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta_template_row_id: tpl.id }),
      });
      const j = (await res.json().catch(() => ({}))) as { template?: EvolutionTemplate; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.success("Versão Evolution criada");
      await loadEvolutionTemplates();
      setTab("evolution");
      if (j.template) {
        openEdit(j.template);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function openCreate() {
    setCreating(true);
    setEditing(null);
    setFormName("");
    setFormDescription("");
    setFormBody("Oi, {nome}! 😊");
    setFormFooter("");
  }

  function openEdit(t: EvolutionTemplate) {
    setCreating(false);
    setEditing(t);
    setFormName(t.name);
    setFormDescription(t.description ?? "");
    setFormBody(t.visible_body);
    setFormFooter(t.footer ?? "");
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  async function saveEvolutionTemplate() {
    if (!formName.trim() || !formBody.trim()) {
      toast.error("Nome e mensagem são obrigatórios");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: formName.trim(),
        message_body: formBody.trim(),
        description: formDescription.trim() || undefined,
        footer: formFooter.trim() || undefined,
        channel_type: "evolution" as const,
      };
      const url = editing
        ? `/api/campaigns/templates/${encodeURIComponent(editing.id)}`
        : "/api/campaigns/templates";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success(editing ? "Modelo atualizado" : "Modelo criado");
      closeForm();
      await loadEvolutionTemplates();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(t: EvolutionTemplate) {
    const res = await fetch(`/api/campaigns/templates/${encodeURIComponent(t.id)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !t.active }),
    });
    if (!res.ok) {
      toast.error("Não foi possível alterar o status");
      return;
    }
    await loadEvolutionTemplates();
  }

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Sem permissão para gerenciar modelos de campanha.
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
          <FileText className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Modelos de campanha</h1>
            <p className="text-xs text-muted-foreground">
              Meta (sincronizados) e Evolution (editáveis pela empresa)
            </p>
          </div>
        </div>
        {tab === "evolution" && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo modelo Evolution
          </button>
        )}
      </header>

      <div className="flex gap-2 border-b border-border px-6 py-2">
        <button
          type="button"
          onClick={() => setTab("evolution")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === "evolution" ? "bg-whatsapp text-whatsapp-foreground" : "text-muted-foreground hover:bg-accent"
          }`}
        >
          Evolution
        </button>
        <button
          type="button"
          onClick={() => setTab("meta")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === "meta" ? "bg-whatsapp text-whatsapp-foreground" : "text-muted-foreground hover:bg-accent"
          }`}
        >
          Meta
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : tab === "meta" ? (
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block flex-1 min-w-[200px]">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Canal Meta</span>
                <select
                  value={metaChannelId}
                  onChange={(e) => setMetaChannelId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {metaChannels.length === 0 && <option value="">Nenhum canal Meta</option>}
                  {metaChannels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void syncMeta()}
                disabled={syncingMeta || !metaChannelId}
                className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
              >
                {syncingMeta ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sincronizar
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Templates Meta são somente leitura (aprovados pela Meta). Use &quot;Criar versão Evolution&quot; para reutilizar o conteúdo.
            </p>
            {metaTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum template aprovado. Sincronize o canal Meta.</p>
            ) : (
              <div className="space-y-3">
                {metaTemplates.map((tpl) => (
                  <div key={tpl.id} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="font-medium">{tpl.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          {tpl.language} · {tpl.category ?? "—"} · {tpl.status}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void createFromMeta(tpl)}
                        className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-60"
                      >
                        <Copy className="h-3.5 w-3.5" /> Criar versão Evolution
                      </button>
                    </div>
                    <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">
                      {tpl.bodyText ?? "—"}
                    </pre>
                    {tpl.buttons.length > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Botões: {tpl.buttons.join(" · ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-4">
            {(creating || editing) && (
              <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                <h3 className="font-medium">{editing ? "Editar modelo" : "Novo modelo Evolution"}</h3>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Nome interno"
                  className="w-full rounded-md border border-input px-3 py-2 text-sm"
                />
                <input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Descrição (opcional)"
                  className="w-full rounded-md border border-input px-3 py-2 text-sm"
                />
                <textarea
                  value={formBody}
                  onChange={(e) => setFormBody(e.target.value)}
                  rows={6}
                  placeholder="Mensagem com variáveis {nome}, {telefone}…"
                  className="w-full rounded-md border border-input px-3 py-2 text-sm font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Variáveis: {EVOLUTION_TEMPLATE_VARIABLES.map((v) => `{${v.key}}`).join(", ")}
                </p>
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Preview</p>
                  <pre className="whitespace-pre-wrap text-sm">{formPreview}</pre>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void saveEvolutionTemplate()}
                    disabled={saving}
                    className="rounded-md bg-whatsapp px-3 py-2 text-sm text-whatsapp-foreground disabled:opacity-60"
                  >
                    {saving ? "Salvando…" : "Salvar"}
                  </button>
                  <button type="button" onClick={closeForm} className="rounded-md border px-3 py-2 text-sm">
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {evolutionTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum modelo Evolution. Crie um ou converta a partir da Meta.</p>
            ) : (
              evolutionTemplates.map((t) => (
                <div
                  key={t.id}
                  className={`rounded-lg border p-4 ${t.active ? "border-border bg-card" : "border-dashed opacity-60"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium">{t.name}</h3>
                      {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                      {t.source_meta_template_name && (
                        <p className="text-xs text-muted-foreground">Origem Meta: {t.source_meta_template_name}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => openEdit(t)} className="rounded p-1.5 hover:bg-accent">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => void toggleActive(t)} className="rounded p-1.5 hover:bg-accent">
                        {t.active ? <ToggleRight className="h-4 w-4 text-whatsapp" /> : <ToggleLeft className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">{t.visible_body}</pre>
                  {t.response_options.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Opções: {t.response_options.map((o) => `${o.n} - ${o.label}`).join(" · ")}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
