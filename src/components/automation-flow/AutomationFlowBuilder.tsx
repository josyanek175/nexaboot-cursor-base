import { useState } from "react";
import { toast } from "sonner";
import { FlowBlockLibrary } from "@/components/automation-flow/FlowBlockLibrary";
import { FlowCanvas } from "@/components/automation-flow/FlowCanvas";
import { FlowSettings, type FlowChannel } from "@/components/automation-flow/FlowSettings";
import { FlowSimulator } from "@/components/automation-flow/FlowSimulator";
import { FlowStepEditor } from "@/components/automation-flow/FlowStepEditor";
import { FlowToolbar } from "@/components/automation-flow/FlowToolbar";
import {
  clearReferences,
  createStep,
  displayStepName,
  duplicateStep,
  publishError,
  referencesTo,
  type BlockType,
} from "@/components/automation-flow/flow-model";
import { stepById, type FlowDefinition, type FlowKind, type FlowStatus, type FlowStep } from "@/lib/automation-flow";

export type BuilderFlow = {
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

export function AutomationFlowBuilder({
  flow,
  channels,
  onClose,
}: {
  flow: BuilderFlow;
  channels: FlowChannel[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(flow);
  const [selectedId, setSelectedId] = useState<string | null>(flow.definition.entryStepId);
  const [panel, setPanel] = useState<"step" | "settings" | null>(flow.definition.steps[0] ? "step" : null);
  const [testing, setTesting] = useState(false);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = stepById(draft.definition, selectedId);

  function add(type: BlockType) {
    const step = createStep(type);
    setDraft((current) => ({
      ...current,
      definition: {
        entryStepId: current.definition.entryStepId ?? step.id,
        steps: [...current.definition.steps, step],
      },
    }));
    setSelectedId(step.id);
    setPanel("step");
  }

  function replaceStep(step: FlowStep) {
    setDraft((current) => ({
      ...current,
      definition: { ...current.definition, steps: current.definition.steps.map((item) => item.id === step.id ? step : item) },
    }));
  }

  function duplicate(id: string) {
    const step = stepById(draft.definition, id);
    if (!step) return;
    const copy = duplicateStep(step);
    setDraft((current) => ({ ...current, definition: { ...current.definition, steps: [...current.definition.steps, copy] } }));
    setSelectedId(copy.id);
    setPanel("step");
  }

  function remove(id: string) {
    const used = referencesTo(draft.definition, id).map((ref) => {
      if (ref === "Início") return "Início";
      const step = stepById(draft.definition, ref);
      return step ? displayStepName(step, draft.definition.steps.indexOf(step)) : ref;
    });
    if (used.length > 0) {
      const ok = window.confirm(`Esta etapa é usada em: ${used.join(", ")}. Se excluir, esses destinos ficam vazios. Continuar?`);
      if (!ok) return;
    }
    const cleared = clearReferences(draft.definition, id);
    setDraft((current) => ({
      ...current,
      definition: { ...cleared, steps: cleared.steps.filter((step) => step.id !== id) },
    }));
    if (selectedId === id) {
      setSelectedId(null);
      setPanel(null);
    }
  }

  async function save(status: FlowStatus, takeChannels = false) {
    if (status === "active") {
      const error = publishError({ ...draft.definition, entryStepId: draft.definition.entryStepId });
      if (error) {
        toast.error(error);
        return false;
      }
    }
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
          status,
          definition: draft.definition,
          channelIds: draft.channel_ids,
          dispatchChannelId: draft.dispatch_channel_id,
          metaTemplateName: draft.meta_template_name,
          metaTemplateLanguage: draft.meta_template_language,
          takeChannels,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        id?: string;
        definition?: FlowDefinition;
        name?: string;
        kind?: FlowKind;
        status?: FlowStatus;
      };
      if (res.status === 409) {
        if (window.confirm(body.message ?? "Este ramal já está em outro fluxo. Mover?")) {
          setSaving(false);
          return save(status, true);
        }
        return false;
      }
      if (!res.ok) {
        toast.error(body.message ?? "Não foi possível salvar.");
        return false;
      }
      setDraft((current) => ({
        ...current,
        id: body.id ?? current.id,
        name: body.name ?? current.name,
        kind: body.kind ?? current.kind,
        status: body.status ?? status,
        definition: body.definition ?? current.definition,
      }));
      toast.success(status === "active" ? "Fluxo publicado." : "Fluxo salvo.");
      return true;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <FlowToolbar
        name={draft.name}
        status={draft.status}
        saving={saving}
        onBack={onClose}
        onName={(name) => setDraft({ ...draft, name })}
        onStatus={(status) => setDraft({ ...draft, status })}
        onSave={() => void save(draft.status)}
        onPublish={() => void save("active")}
        onTest={() => {
          setSimulatingId(draft.definition.entryStepId);
          setTesting(true);
        }}
        onSettings={() => setPanel("settings")}
      />
      <div className="flex min-h-0 flex-1">
        <FlowBlockLibrary onAdd={add} />
        <FlowCanvas
          definition={draft.definition}
          selectedId={selectedId}
          simulatingId={testing ? simulatingId : null}
          onSelect={(id) => { setSelectedId(id); setPanel("step"); }}
          onAdd={add}
          onDuplicate={duplicate}
          onDelete={remove}
          onEntry={(id) => setDraft({ ...draft, definition: { ...draft.definition, entryStepId: id || null } })}
        />
        {panel === "step" && selected && (
          <FlowStepEditor
            step={selected}
            definition={draft.definition}
            onChange={replaceStep}
            onClose={() => setPanel(null)}
            onDuplicate={() => duplicate(selected.id)}
            onDelete={() => remove(selected.id)}
          />
        )}
        {panel === "settings" && (
          <FlowSettings
            kind={draft.kind}
            channelIds={draft.channel_ids}
            dispatchChannelId={draft.dispatch_channel_id}
            templateName={draft.meta_template_name}
            templateLanguage={draft.meta_template_language}
            channels={channels}
            onKind={(kind) => setDraft({ ...draft, kind })}
            onChannels={(channel_ids) => setDraft({ ...draft, channel_ids })}
            onDispatch={(dispatch_channel_id) => setDraft({ ...draft, dispatch_channel_id, meta_template_name: null, meta_template_language: null })}
            onTemplate={(meta_template_name, meta_template_language) => setDraft({ ...draft, meta_template_name, meta_template_language })}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
      {testing && (
        <FlowSimulator
          definition={draft.definition}
          onClose={() => { setTesting(false); setSimulatingId(null); }}
          onActive={setSimulatingId}
        />
      )}
    </div>
  );
}
