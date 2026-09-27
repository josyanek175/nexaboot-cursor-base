import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { emptyDefinition, type FlowDefinition, type FlowKind, type FlowStatus, type FlowStep } from "@/lib/automation-flow";

export const Route = createFileRoute("/_app/fluxos")({
  component: FluxosPage,
  head: () => ({ meta: [{ title: "Fluxos — NexaBoot" }] }),
});

type Channel = { id: string; name: string; channelType: string; status: string };
type Template = { name: string; language: string; bodyText: string | null; buttons: string[] };
type FlowCard = {
  id: string;
  name: string;
  kind: FlowKind;
  status: FlowStatus;
  definition: FlowDefinition;
  dispatch_channel_id: string | null;
  meta_template_name: string | null;
  meta_template_language: string | null;
  channel_ids: string[];
};

const STEP_LABEL: Record<FlowStep["type"], string> = {
  buttons: "Mensagem com botões",
  ask_text: "Pedir um texto",
  condition: "Se a resposta for…",
  reminder: "Lembrete",
  transfer: "Passar para o atendente",
  end: "Encerrar",
};

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

function blankStep(type: FlowStep["type"]): FlowStep {
  const id = newId();
  if (type === "buttons") return { id, type, text: "", buttons: [{ id: newId(), label: "Opção 1", next: null }] };
  if (type === "ask_text") return { id, type, text: "", saveAs: "", next: null };
  if (type === "condition") return { id, type, match: "sim", yesNext: null, noNext: null };
  if (type === "reminder") return { id, type, text: "", options: [{ id: newId(), label: "15 dias", days: 15, next: null }] };
  if (type === "transfer") return { id, type, text: "Vou te passar para um atendente." };
  return { id, type: "end", text: "" };
}

function FluxosPage() {
  const [flows, setFlows] = useState<FlowCard[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<FlowCard | null>(null);
  const [phase, setPhase] = useState<"draw" | "assign">("draw");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [flowRes, channelRes] = await Promise.all([
      fetch("/api/automation-flows", { credentials: "include" }),
      fetch("/api/automation-flows?view=channels", { credentials: "include" }),
    ]);
    if (flowRes.ok) setFlows(((await flowRes.json()) as { flows: FlowCard[] }).flows ?? []);
    if (channelRes.ok) setChannels(((await channelRes.json()) as { channels: Channel[] }).channels ?? []);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  if (editing) {
    return (
      <FlowEditor
        key={editing.id || "novo"}
        flow={editing}
        channels={channels}
        phase={phase}
        onPhase={setPhase}
        onClose={() => {
          setEditing(null);
          setPhase("draw");
          void reload();
        }}
      />
    );
  }

  return (
    <div className="min-h-full bg-[radial-gradient(ellipse_at_top,_rgba(37,211,102,0.16),_transparent_55%)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-whatsapp">Atendimento automático</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Fluxos</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Desenhe a conversa primeiro. Os números ativos da empresa entram só no passo seguinte.
            </p>
          </div>
          <button
            className="rounded-full bg-whatsapp px-5 py-2.5 text-sm font-semibold text-whatsapp-foreground shadow-lg shadow-whatsapp/30"
            onClick={() => {
              setPhase("draw");
              setEditing({
                id: "",
                name: "",
                kind: "attendance",
                status: "draft",
                definition: emptyDefinition(),
                dispatch_channel_id: null,
                meta_template_name: null,
                meta_template_language: null,
                channel_ids: [],
              });
            }}
          >
            Novo fluxo
          </button>
        </div>
        {loading && <p className="text-sm text-muted-foreground">Carregando os fluxos…</p>}
        {!loading && flows.length === 0 && (
          <div className="rounded-3xl border border-dashed border-whatsapp/40 bg-card/80 p-10 text-center">
            <p className="text-lg font-medium">Nenhum fluxo ainda</p>
            <p className="mt-1 text-sm text-muted-foreground">Comece pelo desenho. A escolha do telefone fica para depois.</p>
          </div>
        )}
        <ul className="grid gap-3 md:grid-cols-2">
          {flows.map((flow) => (
            <li key={flow.id} className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">{flow.name}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-medium">
                    <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-emerald-800">
                      {flow.kind === "attendance" ? "Atendimento" : "Vendas"}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">{statusLabel(flow.status)}</span>
                    {flow.kind === "attendance" && (
                      <span className="rounded-full bg-sky-500/15 px-2 py-1 text-sky-800">
                        {flow.channel_ids.length} número(s)
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium"
                  onClick={() => {
                    setPhase("draw");
                    setEditing(flow);
                  }}
                >
                  Editar desenho
                </button>
                <button
                  className="rounded-full bg-whatsapp/15 px-3 py-1.5 text-xs font-semibold text-whatsapp"
                  onClick={() => {
                    setPhase("assign");
                    setEditing(flow);
                  }}
                >
                  Atribuir números
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function statusLabel(status: FlowStatus) {
  if (status === "active") return "Ativo";
  if (status === "paused") return "Pausado";
  return "Rascunho";
}

function FlowEditor({
  flow,
  channels,
  phase,
  onPhase,
  onClose,
}: {
  flow: FlowCard;
  channels: Channel[];
  phase: "draw" | "assign";
  onPhase: (phase: "draw" | "assign") => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(flow);
  const [selected, setSelected] = useState<string | null>(flow.definition?.entryStepId ?? flow.definition?.steps?.[0]?.id ?? null);

  useEffect(() => {
    setDraft(flow);
    setSelected(flow.definition?.entryStepId ?? flow.definition?.steps?.[0]?.id ?? null);
  }, [flow]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [saving, setSaving] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);

  const steps = draft.definition?.steps ?? [];
  const current = steps.find((step) => step.id === selected) ?? null;
  const dispatchChannel = channels.find((channel) => channel.id === draft.dispatch_channel_id);

  useEffect(() => {
    if (draft.kind !== "sales" || dispatchChannel?.channelType !== "meta" || !draft.dispatch_channel_id) {
      setTemplates([]);
      return;
    }
    void fetch(`/api/automation-flows?view=templates&channelId=${draft.dispatch_channel_id}`, {
      credentials: "include",
    }).then(async (res) => {
      if (!res.ok) return;
      setTemplates(((await res.json()) as { templates: Template[] }).templates ?? []);
    });
  }, [draft.kind, draft.dispatch_channel_id, dispatchChannel?.channelType]);

  function updateStep(next: FlowStep) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      definition: {
        ...currentDraft.definition,
        steps: currentDraft.definition.steps.map((step) => (step.id === next.id ? next : step)),
      },
    }));
  }

  function addStep(type: FlowStep["type"]) {
    const step = blankStep(type);
    setDraft((currentDraft) => ({
      ...currentDraft,
      definition: {
        entryStepId: currentDraft.definition.entryStepId ?? step.id,
        steps: [...currentDraft.definition.steps, step],
      },
    }));
    setSelected(step.id);
  }

  async function save(takeChannels = false, override?: Partial<FlowCard>) {
    const current = { ...draft, ...override };
    setSaving(true);
    try {
      const res = await fetch("/api/automation-flows", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          id: current.id || undefined,
          name: current.name,
          kind: current.kind,
          status: current.status,
          definition: current.definition,
          channelIds: current.channel_ids,
          dispatchChannelId: current.dispatch_channel_id,
          metaTemplateName: current.meta_template_name,
          metaTemplateLanguage: current.meta_template_language,
          takeChannels,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
      if (res.status === 409) {
        if (window.confirm(body.message ?? "Este número já está em outro fluxo. Mover?")) {
          setSaving(false);
          await save(true);
        }
        return;
      }
      if (!res.ok) {
        toast.error(body.message ?? "Não foi possível salvar o fluxo.");
        return;
      }
      if (body.id) setDraft((currentDraft) => ({ ...currentDraft, ...override, id: body.id! }));
      else if (override) setDraft((currentDraft) => ({ ...currentDraft, ...override }));
      toast.success(phase === "assign" ? "Números atribuídos." : "Fluxo salvo.");
      return true;
    } finally {
      setSaving(false);
    }
    return false;
  }

  async function advance() {
    const saved = await save();
    if (saved) onPhase("assign");
  }

  async function searchContacts() {
    const res = await fetch(`/api/contacts?q=${encodeURIComponent(contactQuery)}`, { credentials: "include" });
    if (!res.ok) return;
    const body = (await res.json()) as { contacts?: { id: string; name?: string; phone?: string }[] };
    setContacts((body.contacts ?? []).map((contact) => ({
      id: contact.id,
      name: contact.name || contact.phone || "Contato",
      phone: contact.phone || "",
    })));
  }

  async function dispatch() {
    const res = await fetch("/api/automation-flows", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dispatch", flowId: draft.id, contactIds: selectedContacts }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; sent?: number };
    if (!res.ok) {
      toast.error(body.message ?? "Não foi possível disparar.");
      return;
    }
    toast.success(`Disparo enviado para ${body.sent ?? 0} contato(s).`);
  }

  const options = steps.map((step) => ({ v: step.id, l: `${STEP_LABEL[step.type]} · ${stepLabel(step)}` }));

  if (phase === "assign") {
    return (
      <AssignPanel
        draft={draft}
        channels={channels}
        templates={templates}
        saving={saving}
        onBack={() => onPhase("draw")}
        onClose={onClose}
        onChange={setDraft}
        onSave={(override) => save(false, override)}
        onMove={(override) => save(true, override)}
      />
    );
  }

  return (
    <div className="min-h-full bg-[radial-gradient(ellipse_at_top_left,_rgba(37,211,102,0.18),_transparent_42%)]">
      <div className="mx-auto grid w-full max-w-6xl gap-5 p-6 lg:grid-cols-[300px_1fr]">
      <aside className="flex flex-col gap-3 rounded-3xl border border-white/60 bg-card/90 p-4 shadow-sm">
        <button className="text-left text-sm text-muted-foreground" onClick={onClose}>
          Voltar para a lista
        </button>
        <div className="flex gap-2 text-[11px] font-semibold">
          <span className="rounded-full bg-whatsapp px-3 py-1 text-whatsapp-foreground">1 · Desenhar</span>
          <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">2 · Atribuir</span>
        </div>
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Nome do fluxo"
          className="rounded-2xl border border-input bg-background px-3 py-2.5 text-sm"
        />
        <select
          value={draft.kind}
          onChange={(event) => setDraft({ ...draft, kind: event.target.value as FlowKind })}
          className="rounded-2xl border border-input bg-background px-3 py-2.5 text-sm"
        >
          <option value="attendance">Atendimento</option>
          <option value="sales">Vendas</option>
        </select>
        <p className="rounded-2xl bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-900">
          Desenhe a conversa agora. O telefone entra no botão Avançar, só com os números ativos desta empresa.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(STEP_LABEL) as FlowStep["type"][]).map((type) => (
            <button key={type} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium hover:bg-whatsapp/15" onClick={() => addStep(type)}>
              + {STEP_LABEL[type]}
            </button>
          ))}
        </div>
        <button disabled={saving} className="rounded-full bg-whatsapp px-3 py-2.5 text-sm font-semibold text-whatsapp-foreground shadow-md shadow-whatsapp/25" onClick={() => void advance()}>
          {saving ? "Salvando…" : "Avançar"}
        </button>
      </aside>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold">{draft.id ? `Editando ${draft.name || "fluxo"}` : "Novo fluxo"}</h2>
          <p className="text-sm text-muted-foreground">
            {steps.length > 0
              ? `${steps.length} etapa(s) salvas. Toque em uma para alterar o texto.`
              : "Este fluxo ainda não tem etapas. Adicione a primeira mensagem ao lado."}
          </p>
        </div>
        <ul className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step.id}>
              <button
                className={`w-full rounded-2xl border px-4 py-3 text-left text-sm shadow-sm ${
                  step.id === selected ? "border-whatsapp bg-whatsapp/10" : "border-border bg-card"
                }`}
                onClick={() => setSelected(step.id)}
              >
                <span className="font-medium">{index + 1}. {STEP_LABEL[step.type]}</span>
                {draft.definition.entryStepId === step.id && <span className="ml-2 text-[10px] text-whatsapp">inicial</span>}
                <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{stepLabel(step) || "Sem texto"}</div>
              </button>
            </li>
          ))}
        </ul>
        {current && (
          <div className="rounded-md border border-border p-3 text-sm">
            <label className="mb-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.definition.entryStepId === current.id}
                onChange={() =>
                  setDraft({ ...draft, definition: { ...draft.definition, entryStepId: current.id } })
                }
              />
              Etapa inicial
            </label>
            {"text" in current && (
              <textarea
                value={current.text}
                onChange={(event) => updateStep({ ...current, text: event.target.value })}
                placeholder="Texto. Use {{nome}}, {{telefone}} ou {{endereco}}."
                className="mb-2 min-h-24 w-full rounded-md border border-input bg-background p-2"
              />
            )}
            {current.type === "condition" && (
              <input
                value={current.match}
                onChange={(event) => updateStep({ ...current, match: event.target.value })}
                placeholder="Palavra, por exemplo sim"
                className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            )}
            {current.type === "ask_text" && (
              <select
                value={current.saveAs}
                onChange={(event) =>
                  updateStep({
                    ...current,
                    saveAs: event.target.value as "" | "endereco" | "dia" | "observacao",
                  })
                }
                className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="">Não guardar</option>
                <option value="endereco">Guardar como endereço</option>
                <option value="dia">Guardar como dia</option>
                <option value="observacao">Guardar como observação</option>
              </select>
            )}
            <StepLinks step={current} options={options} onChange={updateStep} />
            <button
              className="mt-2 text-xs text-destructive"
              onClick={() => {
                setDraft({
                  ...draft,
                  definition: {
                    entryStepId: draft.definition.entryStepId === current.id ? null : draft.definition.entryStepId,
                    steps: steps.filter((step) => step.id !== current.id),
                  },
                });
                setSelected(null);
              }}
            >
              Remover etapa
            </button>
          </div>
        )}
        {draft.kind === "sales" && draft.id && draft.status === "active" && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="font-medium">Disparar agora</div>
            <p className="mb-2 text-xs text-muted-foreground">Até 30 contatos por envio. Busque e marque.</p>
            <div className="mb-2 flex gap-2">
              <input
                value={contactQuery}
                onChange={(event) => setContactQuery(event.target.value)}
                placeholder="Nome ou telefone"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1.5"
              />
              <button className="rounded-md bg-muted px-3" onClick={() => void searchContacts()}>
                Buscar
              </button>
            </div>
            {contacts.map((contact) => (
              <label key={contact.id} className="mb-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedContacts.includes(contact.id)}
                  onChange={(event) =>
                    setSelectedContacts((currentIds) =>
                      event.target.checked ? [...currentIds, contact.id] : currentIds.filter((id) => id !== contact.id),
                    )
                  }
                />
                {contact.name} · {contact.phone}
              </label>
            ))}
            <button className="mt-2 rounded-md bg-whatsapp px-3 py-1.5 text-whatsapp-foreground" onClick={() => void dispatch()}>
              Disparar selecionados
            </button>
          </div>
        )}
      </section>
      </div>
    </div>
  );
}

function AssignPanel({
  draft,
  channels,
  templates,
  saving,
  onBack,
  onClose,
  onChange,
  onSave,
  onMove,
}: {
  draft: FlowCard;
  channels: Channel[];
  templates: Template[];
  saving: boolean;
  onBack: () => void;
  onClose: () => void;
  onChange: (flow: FlowCard) => void;
  onSave: (override?: Partial<FlowCard>) => Promise<boolean>;
  onMove: (override?: Partial<FlowCard>) => Promise<boolean>;
}) {
  const selectedMeta = channels.find((channel) => channel.id === draft.dispatch_channel_id);
  function toggleAttendance(channelId: string) {
    const selected = draft.channel_ids.includes(channelId);
    onChange({
      ...draft,
      channel_ids: selected ? draft.channel_ids.filter((id) => id !== channelId) : [...draft.channel_ids, channelId],
    });
  }
  async function commit(status: FlowStatus, take = false) {
    const override: Partial<FlowCard> = { status };
    const saved = take ? await onMove(override) : await onSave(override);
    if (saved) onClose();
  }
  return (
    <div className="min-h-full bg-[radial-gradient(ellipse_at_top,_rgba(14,165,233,0.16),_transparent_50%)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
        <button className="w-fit text-sm text-muted-foreground" onClick={onBack}>Voltar ao desenho</button>
        <div className="flex gap-2 text-[11px] font-semibold">
          <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">1 · Desenhar</span>
          <span className="rounded-full bg-sky-500 px-3 py-1 text-white">2 · Atribuir</span>
        </div>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{draft.name || "Fluxo"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Só aparecem os números ativos desta empresa. Meta ativo e Evolution conectado.
          </p>
        </div>
        {channels.length === 0 && (
          <div className="rounded-3xl border border-dashed border-sky-400/50 bg-card p-8 text-sm text-muted-foreground">
            Nenhum número ativo nesta empresa. Conecte um canal em Canais WhatsApp e volte aqui.
          </div>
        )}
        {draft.kind === "attendance" ? (
          <div className="grid gap-3">
            {channels.map((channel) => {
              const selected = draft.channel_ids.includes(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => toggleAttendance(channel.id)}
                  className={`rounded-3xl border p-4 text-left shadow-sm transition ${
                    selected ? "border-whatsapp bg-whatsapp/10" : "border-border bg-card"
                  }`}
                >
                  <div className="font-semibold">{channel.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {channel.channelType === "meta" ? "Meta · Ativo" : "Evolution · Conectado"}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            {channels.map((channel) => {
              const selected = draft.dispatch_channel_id === channel.id;
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      dispatch_channel_id: channel.id,
                      meta_template_name: null,
                      meta_template_language: null,
                    })
                  }
                  className={`rounded-3xl border p-4 text-left shadow-sm ${
                    selected ? "border-sky-500 bg-sky-500/10" : "border-border bg-card"
                  }`}
                >
                  <div className="font-semibold">{channel.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {channel.channelType === "meta" ? "Meta · escolha a mensagem aprovada" : "Evolution · usa a primeira etapa do fluxo"}
                  </div>
                </button>
              );
            })}
            {selectedMeta?.channelType === "meta" && (
              <label className="rounded-3xl border border-border bg-card p-4 text-sm">
                Mensagem aprovada pela Meta
                <select
                  value={draft.meta_template_name ? `${draft.meta_template_name}::${draft.meta_template_language}` : ""}
                  onChange={(event) => {
                    const [name, language] = event.target.value.split("::");
                    onChange({ ...draft, meta_template_name: name || null, meta_template_language: language || null });
                  }}
                  className="mt-2 w-full rounded-2xl border border-input bg-background px-3 py-2"
                >
                  <option value="">Selecione</option>
                  {templates.map((template) => (
                    <option key={`${template.name}-${template.language}`} value={`${template.name}::${template.language}`}>
                      {template.name} ({template.language})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            disabled={saving}
            className="rounded-full bg-whatsapp px-5 py-2.5 text-sm font-semibold text-whatsapp-foreground"
            onClick={() => void commit("active")}
          >
            {saving ? "Salvando…" : "Ativar nestes números"}
          </button>
          <button disabled={saving} className="rounded-full bg-muted px-5 py-2.5 text-sm" onClick={() => void commit("draft")}>
            Guardar sem ativar
          </button>
        </div>
      </div>
    </div>
  );
}

function stepLabel(step: FlowStep) {
  if (step.type === "buttons") return step.text || step.buttons.map((button) => button.label).join(" · ");
  if (step.type === "reminder") return step.options.map((option) => option.label).join(" · ");
  if (step.type === "condition") return step.match;
  if ("text" in step) return step.text;
  return "";
}

function StepLinks({
  step,
  options,
  onChange,
}: {
  step: FlowStep;
  options: { v: string; l: string }[];
  onChange: (step: FlowStep) => void;
}) {
  if (step.type === "buttons") {
    return (
      <div className="flex flex-col gap-2">
        {step.buttons.map((button, index) => (
          <div key={button.id} className="grid grid-cols-[1fr_1fr] gap-2">
            <input
              value={button.label}
              maxLength={20}
              onChange={(event) => {
                const buttons = step.buttons.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value } : item,
                );
                onChange({ ...step, buttons });
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5"
            />
            <NextSelect value={button.next} options={options} onChange={(next) => {
              const buttons = step.buttons.map((item, itemIndex) => (itemIndex === index ? { ...item, next } : item));
              onChange({ ...step, buttons });
            }} />
          </div>
        ))}
        {step.buttons.length < 3 && (
          <button
            className="text-xs text-whatsapp"
            onClick={() => onChange({ ...step, buttons: [...step.buttons, { id: newId(), label: "", next: null }] })}
          >
            Adicionar botão
          </button>
        )}
      </div>
    );
  }
  if (step.type === "reminder") {
    return (
      <div className="flex flex-col gap-2">
        {step.options.map((option, index) => (
          <div key={option.id} className="grid grid-cols-[1fr_80px_1fr] gap-2">
            <input
              value={option.label}
              maxLength={20}
              onChange={(event) => {
                const optionsNext = step.options.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value } : item,
                );
                onChange({ ...step, options: optionsNext });
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5"
            />
            <input
              type="number"
              min={1}
              max={365}
              value={option.days}
              onChange={(event) => {
                const optionsNext = step.options.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, days: Number(event.target.value) } : item,
                );
                onChange({ ...step, options: optionsNext });
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5"
            />
            <NextSelect value={option.next} options={options} onChange={(next) => {
              const optionsNext = step.options.map((item, itemIndex) => (itemIndex === index ? { ...item, next } : item));
              onChange({ ...step, options: optionsNext });
            }} />
          </div>
        ))}
        {step.options.length < 3 && (
          <button
            className="text-xs text-whatsapp"
            onClick={() => onChange({ ...step, options: [...step.options, { id: newId(), label: "", days: 30, next: null }] })}
          >
            Adicionar prazo
          </button>
        )}
      </div>
    );
  }
  if (step.type === "ask_text") {
    return <NextSelect value={step.next} options={options} onChange={(next) => onChange({ ...step, next })} />;
  }
  if (step.type === "condition") {
    return (
      <div className="grid gap-2">
        <label className="text-xs">
          Se contiver a palavra
          <NextSelect value={step.yesNext} options={options} onChange={(yesNext) => onChange({ ...step, yesNext })} />
        </label>
        <label className="text-xs">
          Qualquer outra resposta
          <NextSelect value={step.noNext} options={options} onChange={(noNext) => onChange({ ...step, noNext })} />
        </label>
      </div>
    );
  }
  return null;
}

function NextSelect({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: { v: string; l: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      className="w-full rounded-md border border-input bg-background px-2 py-1.5"
    >
      <option value="">Encerra sem outra etapa</option>
      {options.map((option) => (
        <option key={option.v} value={option.v}>
          {option.l}
        </option>
      ))}
    </select>
  );
}
