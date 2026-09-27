import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { emptyDefinition, type FlowDefinition, type FlowKind, type FlowStatus, type FlowStep } from "@/lib/automation-flow";

export const Route = createFileRoute("/_app/fluxos")({
  component: FluxosPage,
  head: () => ({ meta: [{ title: "Fluxos — NexaBoot" }] }),
});

type Channel = { id: string; name: string; channelType: string };
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
        flow={editing}
        channels={channels}
        onClose={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Fluxos</h1>
          <p className="text-sm text-muted-foreground">
            Atendimento responde quem chama o número. Vendas dispara a mensagem, e na Meta usa uma campanha aprovada.
          </p>
        </div>
        <button
          className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground"
          onClick={() =>
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
            })
          }
        >
          Novo fluxo
        </button>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!loading && flows.length === 0 && (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">Nenhum fluxo ainda.</p>
      )}
      <ul className="flex flex-col gap-2">
        {flows.map((flow) => (
          <li key={flow.id} className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3">
            <div>
              <div className="font-medium">{flow.name}</div>
              <div className="text-xs text-muted-foreground">
                {flow.kind === "attendance" ? "Atendimento" : "Vendas"} · {statusLabel(flow.status)} ·{" "}
                {flow.kind === "attendance" ? `${flow.channel_ids.length} número(s)` : "disparo"}
              </div>
            </div>
            <button className="text-sm text-whatsapp" onClick={() => setEditing(flow)}>
              Editar
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(status: FlowStatus) {
  if (status === "active") return "Ativo";
  if (status === "paused") return "Pausado";
  return "Rascunho";
}

function FlowEditor({ flow, channels, onClose }: { flow: FlowCard; channels: Channel[]; onClose: () => void }) {
  const [draft, setDraft] = useState(flow);
  const [selected, setSelected] = useState<string | null>(flow.definition.entryStepId);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [saving, setSaving] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);

  const steps = draft.definition.steps;
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

  async function save(takeChannels = false) {
    setSaving(true);
    try {
      const res = await fetch("/api/automation-flows", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          id: draft.id || undefined,
          name: draft.name,
          kind: draft.kind,
          status: draft.status,
          definition: draft.definition,
          channelIds: draft.channel_ids,
          dispatchChannelId: draft.dispatch_channel_id,
          metaTemplateName: draft.meta_template_name,
          metaTemplateLanguage: draft.meta_template_language,
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
      if (body.id) setDraft((currentDraft) => ({ ...currentDraft, id: body.id! }));
      toast.success("Fluxo salvo.");
    } finally {
      setSaving(false);
    }
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

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-6 lg:grid-cols-[280px_1fr]">
      <aside className="flex flex-col gap-3">
        <button className="text-left text-sm text-muted-foreground" onClick={onClose}>
          Voltar
        </button>
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Nome do fluxo"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <select
          value={draft.kind}
          onChange={(event) => setDraft({ ...draft, kind: event.target.value as FlowKind })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="attendance">Atendimento</option>
          <option value="sales">Vendas</option>
        </select>
        <select
          value={draft.status}
          onChange={(event) => setDraft({ ...draft, status: event.target.value as FlowStatus })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="draft">Rascunho</option>
          <option value="active">Ativo</option>
          <option value="paused">Pausado</option>
        </select>
        {draft.kind === "attendance" ? (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 font-medium">Números deste atendimento</div>
            {channels.map((channel) => (
              <label key={channel.id} className="mb-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.channel_ids.includes(channel.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      channel_ids: event.target.checked
                        ? [...draft.channel_ids, channel.id]
                        : draft.channel_ids.filter((id) => id !== channel.id),
                    })
                  }
                />
                <span>{channel.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 font-medium">Número do disparo</div>
            <select
              value={draft.dispatch_channel_id ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, dispatch_channel_id: event.target.value || null, meta_template_name: null, meta_template_language: null })
              }
              className="w-full rounded-md border border-input bg-background px-2 py-1.5"
            >
              <option value="">Selecione</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
            {dispatchChannel?.channelType === "meta" && (
              <label className="mt-2 block">
                Mensagem aprovada pela Meta
                <select
                  value={draft.meta_template_name ? `${draft.meta_template_name}::${draft.meta_template_language}` : ""}
                  onChange={(event) => {
                    const [name, language] = event.target.value.split("::");
                    setDraft({ ...draft, meta_template_name: name || null, meta_template_language: language || null });
                  }}
                  className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
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
            <p className="mt-2 text-xs text-muted-foreground">
              Na Meta, a primeira mensagem é a campanha aprovada. Os botões da etapa inicial precisam ter o mesmo texto dos botões dessa mensagem.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {(Object.keys(STEP_LABEL) as FlowStep["type"][]).map((type) => (
            <button key={type} className="rounded bg-muted px-2 py-1 text-[11px]" onClick={() => addStep(type)}>
              + {STEP_LABEL[type]}
            </button>
          ))}
        </div>
        <button disabled={saving} className="rounded-md bg-whatsapp px-3 py-2 text-sm text-whatsapp-foreground" onClick={() => void save()}>
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </aside>
      <section className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.id}>
              <button
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  step.id === selected ? "border-whatsapp bg-whatsapp/10" : "border-border"
                }`}
                onClick={() => setSelected(step.id)}
              >
                <span className="font-medium">{STEP_LABEL[step.type]}</span>
                {draft.definition.entryStepId === step.id && <span className="ml-2 text-[10px] text-whatsapp">inicial</span>}
                <div className="truncate text-xs text-muted-foreground">{stepLabel(step)}</div>
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
