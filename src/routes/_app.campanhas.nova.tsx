import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Megaphone, ArrowLeft, Loader2, ChevronRight, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canManageCampaigns, actingUserFromAuth } from "@/lib/permissions";
import { CampaignAudienceImport } from "@/components/campaign-audience-import";
import {
  parseSpreadsheetRow,
  previewMessage,
} from "@/lib/campaign-spreadsheet";

type ChannelOption = {
  id: string;
  name: string;
  channel_type: string;
  status: string;
};

type TemplateOption = {
  id: string;
  name: string;
  message_body: string;
  visible_body?: string;
};

type MetaTemplateOption = {
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

const CONTACT_FIELD_OPTIONS = [
  { value: "name", label: "Nome do contato" },
  { value: "phone", label: "Telefone" },
] as const;

const STEPS = [
  { id: 1, label: "Dados / modelo" },
  { id: 2, label: "Mensagem" },
  { id: 3, label: "Público" },
  { id: 4, label: "Agendamento" },
  { id: 5, label: "Revisão" },
] as const;

export const Route = createFileRoute("/_app/campanhas/nova")({
  component: NovaCampanhaPage,
  validateSearch: (s: Record<string, unknown>) => ({
    templateId: typeof s.templateId === "string" ? s.templateId : undefined,
    from: typeof s.from === "string" ? s.from : undefined,
  }),
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
  const { templateId: searchTemplateId, from: searchFrom } = Route.useSearch();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
  const canManage = canManageCampaigns(actor) && companyValid;

  const [step, setStep] = useState(1);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [audienceTotal, setAudienceTotal] = useState(0);

  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [saving, setSaving] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [metaTemplates, setMetaTemplates] = useState<MetaTemplateOption[]>([]);
  const [selectedMetaTemplateId, setSelectedMetaTemplateId] = useState("");
  const [metaVariableMappings, setMetaVariableMappings] = useState<Record<string, string>>({});
  const [channelTypeFilter, setChannelTypeFilter] = useState<"" | "meta" | "evolution">("");
  const [useCustomMessage, setUseCustomMessage] = useState(false);

  const filteredChannels = useMemo(() => {
    if (!channelTypeFilter) return channels;
    return channels.filter(
      (c) => String(c.channel_type).toLowerCase() === channelTypeFilter,
    );
  }, [channels, channelTypeFilter]);

  const activeEvolutionTemplates = useMemo(
    () => templates.filter((t) => t.visible_body ?? t.message_body),
    [templates],
  );
  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === channelId) ?? null,
    [channels, channelId],
  );
  const isMetaChannel =
    String(selectedChannel?.channel_type ?? "").toLowerCase() === "meta";
  const selectedMetaTemplate = useMemo(
    () => metaTemplates.find((t) => t.id === selectedMetaTemplateId) ?? null,
    [metaTemplates, selectedMetaTemplateId],
  );

  useEffect(() => {
    if (!canManage) return;
    setChannelsError(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    Promise.allSettled([
      fetch("/api/evolution/channels", { credentials: "include", signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) {
            setChannelsError("Não foi possível carregar os canais WhatsApp.");
            return { channels: [] as ChannelOption[] };
          }
          return r.json() as Promise<{ channels: ChannelOption[] }>;
        })
        .then((data) => {
          const list = (data.channels ?? []).filter((ch) => {
            const t = String(ch.channel_type).toLowerCase();
            return t === "evolution" || t === "meta";
          });
          setChannels(list);
        })
        .catch(() => setChannelsError("Não foi possível carregar os canais WhatsApp.")),
      fetch("/api/campaigns/templates", { credentials: "include", signal: controller.signal })
        .then(async (r) => (r.ok ? r.json() : { templates: [] }))
        .then((data: { templates: TemplateOption[] }) => setTemplates(data.templates ?? []))
        .catch(() => setTemplates([])),
    ]).finally(() => clearTimeout(timer));

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [canManage]);

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
    const data = (await res.json()) as { templates: MetaTemplateOption[] };
    setMetaTemplates(data.templates ?? []);
  }

  useEffect(() => {
    if (!isMetaChannel || !channelId) {
      setMetaTemplates([]);
      setSelectedMetaTemplateId("");
      setMetaVariableMappings({});
      return;
    }
    void loadMetaTemplates(channelId);
  }, [isMetaChannel, channelId]);

  function applyMetaTemplate(tpl: MetaTemplateOption | null) {
    if (!tpl) {
      setSelectedMetaTemplateId("");
      setMetaVariableMappings({});
      setMessageText("");
      return;
    }
    setSelectedMetaTemplateId(tpl.id);
    setMessageText(tpl.bodyText ?? "");
    const mappings: Record<string, string> = {};
    for (const v of tpl.variables) {
      mappings[v] = "name";
    }
    if (tpl.name === "abordagem_inicial_troca_refil") {
      mappings["1"] = "name";
    }
    if (tpl.variables.length === 0 && tpl.name === "abordagem_inicial_troca_refil") {
      mappings["1"] = "name";
    }
    setMetaVariableMappings(mappings);
  }

  async function syncMetaTemplates() {
    if (!channelId || !isMetaChannel) return;
    setSyncingMeta(true);
    try {
      const res = await fetch(
        `/api/meta/channels/${encodeURIComponent(channelId)}/templates/sync`,
        { method: "POST", credentials: "include" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        approved?: number;
        synced?: number;
      };
      if (!res.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        `Sincronizados ${j.synced ?? 0} modelos (${j.approved ?? 0} aprovados)`,
      );
      await loadMetaTemplates(channelId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncingMeta(false);
    }
  }

  useEffect(() => {
    if (searchTemplateId && templates.length) {
      const tpl = templates.find((t) => t.id === searchTemplateId);
      if (tpl) {
        setSelectedTemplateId(tpl.id);
        setMessageText(tpl.visible_body ?? tpl.message_body);
      }
    }
  }, [searchTemplateId, templates]);

  useEffect(() => {
    if (!searchFrom || campaignId) return;
    fetch(`/api/campaigns/${encodeURIComponent(searchFrom)}`, { credentials: "include" })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data: { campaign?: { name: string; message_text: string | null; whatsapp_channel_id: string | null } } | null) => {
        if (!data?.campaign) return;
        setName(`${data.campaign.name} — novo disparo`);
        setMessageText(data.campaign.message_text ?? "");
        if (data.campaign.whatsapp_channel_id) {
          setChannelId(data.campaign.whatsapp_channel_id);
        }
      })
      .catch(() => undefined);
  }, [searchFrom, campaignId]);

  function applyTemplate(id: string) {
    if (id === "__custom__") {
      setUseCustomMessage(true);
      setSelectedTemplateId("");
      return;
    }
    setUseCustomMessage(false);
    setSelectedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) setMessageText(tpl.visible_body ?? tpl.message_body);
  }

  function handleChannelTypeChange(type: "" | "meta" | "evolution") {
    setChannelTypeFilter(type);
    setChannelId("");
    setSelectedTemplateId("");
    setSelectedMetaTemplateId("");
    setMetaVariableMappings({});
    setMessageText("");
    setUseCustomMessage(false);
  }

  const localPreview = useMemo(() => {
    const sample = parseSpreadsheetRow(
      { nome: "Maria Silva", telefone: "5534999999999", produto: "Plano Pro" },
      0,
    );
    return previewMessage(messageText, sample);
  }, [messageText]);

  async function refreshAudienceCount(id: string) {
    const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/contacts?limit=1`, {
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as { total: number };
      setAudienceTotal(data.total ?? 0);
    }
  }

  async function persistCampaign(partial = false): Promise<string | null> {
    const payload = {
      name: name.trim(),
      message_text: messageText.trim() || null,
      whatsapp_channel_id: channelId || null,
      schedule_date: scheduleDate || null,
      window_start_time: windowStart ? toTimeInput(windowStart) : null,
      window_end_time: windowEnd ? toTimeInput(windowEnd) : null,
      template_id: isMetaChannel ? null : selectedTemplateId || null,
      source_campaign_id: searchFrom || null,
      message_type: isMetaChannel ? ("meta_template" as const) : ("text" as const),
      meta_template_id: isMetaChannel
        ? selectedMetaTemplate?.metaTemplateId ?? null
        : null,
      meta_template_name: isMetaChannel ? selectedMetaTemplate?.name ?? null : null,
      meta_language_code: isMetaChannel ? selectedMetaTemplate?.language ?? null : null,
      meta_variable_mappings: isMetaChannel ? metaVariableMappings : null,
    };

    if (campaignId) {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(campaignApiError(res.status, j));
      }
      return campaignId;
    }

    if (!name.trim()) throw new Error("Informe o nome da campanha");
    const res = await fetch("/api/campaigns", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(campaignApiError(res.status, j));
    }
    const data = (await res.json()) as { campaign: { id: string } };
    setCampaignId(data.campaign.id);
    if (!partial) await refreshAudienceCount(data.campaign.id);
    return data.campaign.id;
  }

  async function saveTemplateIfRequested() {
    if (!saveAsTemplate || !templateName.trim() || !messageText.trim()) return;
    const res = await fetch("/api/campaigns/templates", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: templateName.trim(),
        message_body: messageText.trim(),
      }),
    });
    if (res.ok) toast.success("Modelo salvo");
  }

  async function handleNext() {
    setSaving(true);
    try {
      if (step === 1) {
        if (!name.trim()) {
          toast.error("Informe o nome da campanha");
          return;
        }
        await persistCampaign(true);
        setStep(2);
      } else if (step === 2) {
        if (isMetaChannel) {
          if (!selectedMetaTemplate) {
            toast.error("Selecione um template aprovado da Meta");
            return;
          }
        } else if (!messageText.trim()) {
          toast.error("Informe a mensagem modelo");
          return;
        }
        await persistCampaign(true);
        if (!isMetaChannel) await saveTemplateIfRequested();
        setStep(3);
      } else if (step === 3) {
        const id = campaignId ?? (await persistCampaign(true));
        if (!id) return;
        await refreshAudienceCount(id);
        setStep(4);
      } else if (step === 4) {
        if (!scheduleDate || !windowStart || !windowEnd) {
          toast.error("Informe data e janela de envio");
          return;
        }
        await persistCampaign(true);
        setStep(5);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSchedule() {
    setSaving(true);
    try {
      const id = campaignId ?? (await persistCampaign());
      if (!id) return;
      if (audienceTotal < 1) {
        toast.error("Importe pelo menos um contato válido no público");
        return;
      }
      const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/schedule`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const map: Record<string, string> = {
          no_pending_contacts: "Importe contatos válidos antes de agendar.",
          missing_channel: "Selecione o canal de envio.",
          missing_message: "Informe a mensagem modelo.",
          missing_meta_template: "Selecione um template Meta aprovado.",
          missing_schedule_date: "Informe a data de envio.",
          missing_window: "Informe horário inicial e final.",
        };
        throw new Error(map[j.error ?? ""] ?? j.error ?? `HTTP ${res.status}`);
      }
      toast.success("Campanha agendada");
      navigate({ to: "/campanhas/$id", params: { id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-4">
        <Link to="/campanhas" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Megaphone className="h-5 w-5 text-whatsapp" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Nova campanha</h1>
          <p className="text-xs text-muted-foreground">Etapa {step} de 5 — {STEPS[step - 1].label}</p>
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-border bg-muted/20 px-4 py-2">
        {STEPS.map((s) => (
          <span
            key={s.id}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
              s.id === step
                ? "bg-whatsapp text-whatsapp-foreground"
                : s.id < step
                  ? "bg-muted text-muted-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {s.id}. {s.label}
          </span>
        ))}
      </nav>

      <div className="mx-auto w-full max-w-2xl flex-1 overflow-auto p-6 space-y-4">
        {step === 1 && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Nome da campanha</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
                placeholder="Ex.: Promoção de março"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Tipo de canal</span>
              <select
                value={channelTypeFilter}
                onChange={(e) =>
                  handleChannelTypeChange(e.target.value as "" | "meta" | "evolution")
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione Meta ou Evolution</option>
                <option value="meta">Meta (template oficial HSM)</option>
                <option value="evolution">Evolution (texto / modelos próprios)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Canal WhatsApp</span>
              {channelsError && <p className="mb-1 text-xs text-destructive">{channelsError}</p>}
              <select
                value={channelId}
                onChange={(e) => {
                  setChannelId(e.target.value);
                  setSelectedMetaTemplateId("");
                  setMetaVariableMappings({});
                  setSelectedTemplateId("");
                  setUseCustomMessage(false);
                  setMessageText("");
                }}
                disabled={!channelTypeFilter}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="">
                  {channelTypeFilter ? "Selecione o canal" : "Escolha o tipo acima primeiro"}
                </option>
                {filteredChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} · {String(ch.channel_type).toUpperCase()} ({ch.status})
                  </option>
                ))}
              </select>
            </label>
            {channelTypeFilter === "evolution" && activeEvolutionTemplates.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Modelo Evolution (opcional)
                </span>
                <select
                  value={useCustomMessage ? "__custom__" : selectedTemplateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Selecione —</option>
                  <option value="__custom__">Mensagem personalizada</option>
                  {activeEvolutionTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <Link to="/campanhas/modelos" className="mt-1 inline-block text-xs text-whatsapp underline">
                  Gerenciar modelos
                </Link>
              </label>
            )}
          </>
        )}

        {step === 2 && isMetaChannel && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Canal Meta: use apenas templates aprovados (HSM). Mensagem livre não é permitida
                fora da janela de 24h.
              </p>
              <button
                type="button"
                onClick={() => void syncMetaTemplates()}
                disabled={syncingMeta || !channelId}
                className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-60"
              >
                {syncingMeta && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Sincronizar modelos da Meta
              </button>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Template aprovado
              </span>
              <select
                value={selectedMetaTemplateId}
                onChange={(e) => {
                  const tpl = metaTemplates.find((t) => t.id === e.target.value) ?? null;
                  applyMetaTemplate(tpl);
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione o template</option>
                {metaTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language} · {t.category ?? "—"}
                  </option>
                ))}
              </select>
            </label>
            {selectedMetaTemplate && (
              <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Corpo</p>
                  <pre className="mt-1 whitespace-pre-wrap text-xs">
                    {selectedMetaTemplate.bodyText || "—"}
                  </pre>
                </div>
                {selectedMetaTemplate.buttons.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Botões (já no template)</p>
                    <ul className="mt-1 list-disc pl-4 text-xs">
                      {selectedMetaTemplate.buttons.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(selectedMetaTemplate.variables.length > 0 ||
                  selectedMetaTemplate.name === "abordagem_inicial_troca_refil") && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Mapeamento de variáveis
                    </p>
                    {(selectedMetaTemplate.variables.length
                      ? selectedMetaTemplate.variables
                      : ["1"]
                    ).map((v) => (
                      <label key={v} className="flex items-center gap-2 text-xs">
                        <span className="w-12 font-mono">{`{{${v}}}`}</span>
                        <select
                          value={metaVariableMappings[v] ?? "name"}
                          onChange={(e) =>
                            setMetaVariableMappings((prev) => ({
                              ...prev,
                              [v]: e.target.value,
                            }))
                          }
                          className="flex-1 rounded-md border border-input bg-background px-2 py-1"
                        >
                          {CONTACT_FIELD_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {step === 2 && !isMetaChannel && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Mensagem modelo</span>
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
                placeholder={"Olá {nome}, temos novidade sobre {produto}."}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Tags: {"{nome}"}, {"{telefone}"} e colunas extras da planilha.
                Saudação e fechamento variados são adicionados automaticamente.
              </p>
            </label>
            {localPreview && (
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Prévia (exemplo)</p>
                <pre className="whitespace-pre-wrap text-xs">{localPreview}</pre>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveAsTemplate}
                onChange={(e) => setSaveAsTemplate(e.target.checked)}
              />
              Salvar mensagem como modelo
            </label>
            {saveAsTemplate && (
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Nome do modelo"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            )}
          </>
        )}

        {step === 3 && campaignId && (
          <CampaignAudienceImport
            campaignId={campaignId}
            messageTemplate={isMetaChannel ? selectedMetaTemplate?.bodyText ?? "" : messageText}
            onImported={() => refreshAudienceCount(campaignId)}
          />
        )}

        {step === 3 && !campaignId && (
          <p className="text-sm text-muted-foreground">Salve os dados anteriores para importar o público.</p>
        )}

        {step === 4 && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Data de envio</span>
              <input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Horário inicial</span>
                <input
                  type="time"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Horário final</span>
                <input
                  type="time"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium">Modo de envio:</span> Automático seguro
            </div>
          </>
        )}

        {step === 5 && (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
            <h2 className="font-semibold">Revisão</h2>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Campanha</dt>
                <dd className="font-medium">{name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Público importado</dt>
                <dd className="font-medium tabular-nums">{audienceTotal}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Data</dt>
                <dd>{scheduleDate || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Janela</dt>
                <dd>
                  {windowStart} – {windowEnd}
                </dd>
              </div>
            </dl>
            {messageText && (
              <div className="rounded-md bg-muted/30 p-2 text-xs whitespace-pre-wrap">{messageText}</div>
            )}
          </div>
        )}

        <div className="flex justify-between gap-2 pt-4">
          <button
            type="button"
            disabled={step === 1 || saving}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Voltar
          </button>
          <div className="flex gap-2">
            {step < 5 ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleNext}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Continuar <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    try {
                      setSaving(true);
                      const id = campaignId ?? (await persistCampaign());
                      if (id) {
                        toast.success("Rascunho salvo");
                        navigate({ to: "/campanhas/$id", params: { id } });
                      }
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                >
                  Salvar rascunho
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSchedule}
                  className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Agendar envio
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
