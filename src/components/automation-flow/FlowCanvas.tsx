import { useState } from "react";
import { BLOCKS, type BlockType } from "@/components/automation-flow/flow-model";
import { FlowStepCard } from "@/components/automation-flow/FlowStepCard";
import { stepById, type FlowDefinition, type FlowStep } from "@/lib/automation-flow";
import { stepOutputs } from "@/components/automation-flow/flow-model";

export function FlowCanvas({
  definition,
  selectedId,
  simulatingId,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onEntry,
}: {
  definition: FlowDefinition;
  selectedId: string | null;
  simulatingId: string | null;
  onSelect: (id: string) => void;
  onAdd: (type: BlockType) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onEntry: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const entry = stepById(definition, definition.entryStepId);
  const placed = new Set<string>();

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/20 p-3 xl:p-6">
      <div className="mx-auto flex w-full flex-col items-center gap-2 xl:w-fit">
        <div className="rounded-full bg-whatsapp px-4 py-1 text-xs font-semibold text-whatsapp-foreground">INÍCIO</div>
        <select
          aria-label="Primeira etapa"
          value={definition.entryStepId ?? ""}
          onChange={(event) => onEntry(event.target.value)}
          className="min-h-11 w-full max-w-full rounded-xl border border-input bg-card px-3 py-1.5 text-xs xl:w-auto"
        >
          <option value="">Escolha a primeira etapa</option>
          {definition.steps.map((step, index) => (
            <option key={step.id} value={step.id}>{index + 1}. {step.name || step.type}</option>
          ))}
        </select>
        <div className="w-full space-y-3 xl:hidden">
          <p className="py-2 text-xs text-muted-foreground">Toque em uma etapa para editar. Os destinos de cada opção aparecem no cartão.</p>
          {definition.steps.map(step => <FlowStepCard key={step.id} step={step} definition={definition}
            active={step.id === selectedId || step.id === simulatingId} onSelect={() => onSelect(step.id)}
            onDuplicate={() => onDuplicate(step.id)} onDelete={() => onDelete(step.id)} />)}
          {definition.steps.length === 0 && <p className="text-sm text-muted-foreground">Adicione a primeira etapa para começar.</p>}
        </div>
        <div className="hidden flex-col items-center gap-2 xl:flex">
        <div className="h-6 w-px bg-whatsapp/60" />
        {entry ? (
          <Branch step={entry} definition={definition} seen={placed} selectedId={selectedId} simulatingId={simulatingId} onSelect={onSelect} onDuplicate={onDuplicate} onDelete={onDelete} />
        ) : (
          <p className="text-sm text-muted-foreground">Adicione uma etapa e marque como início.</p>
        )}
        <button className="mt-4 rounded-full border border-dashed border-whatsapp px-4 py-2 text-sm text-whatsapp" onClick={() => setMenuOpen((open) => !open)}>
          + Adicionar etapa
        </button>
        {menuOpen && (
          <div className="grid gap-1 rounded-2xl border border-border bg-card p-2 shadow-lg">
            {BLOCKS.map((block) => (
              <button key={block.type} className="rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { onAdd(block.type); setMenuOpen(false); }}>
                {block.label}
              </button>
            ))}
          </div>
        )}
        <LooseSteps definition={definition} placed={placed} selectedId={selectedId} simulatingId={simulatingId} onSelect={onSelect} onDuplicate={onDuplicate} onDelete={onDelete} />
        </div>
      </div>
    </div>
  );
}

function Branch({
  step,
  definition,
  seen,
  selectedId,
  simulatingId,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  step: FlowStep;
  definition: FlowDefinition;
  seen: Set<string>;
  selectedId: string | null;
  simulatingId: string | null;
  onSelect: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (seen.has(step.id)) {
    return <div className="rounded-full bg-muted px-3 py-1 text-[11px]">Volta para {step.name || step.type}</div>;
  }
  seen.add(step.id);
  const outputs = stepOutputs(step).filter((output) => output.next);
  return (
    <div className="flex flex-col items-center gap-2">
      <FlowStepCard
        step={step}
        definition={definition}
        active={step.id === selectedId || step.id === simulatingId}
        onSelect={() => onSelect(step.id)}
        onDuplicate={() => onDuplicate(step.id)}
        onDelete={() => onDelete(step.id)}
      />
      {outputs.length === 1 && outputs[0].next && stepById(definition, outputs[0].next) && (
        <>
          <div className="h-6 w-px bg-border" />
          <Branch step={stepById(definition, outputs[0].next)!} definition={definition} seen={seen} selectedId={selectedId} simulatingId={simulatingId} onSelect={onSelect} onDuplicate={onDuplicate} onDelete={onDelete} />
        </>
      )}
      {outputs.length > 1 && (
        <div className="mt-2 flex items-start gap-4 border-t border-border pt-3">
          {outputs.map((output) => {
            const next = stepById(definition, output.next);
            return (
              <div key={output.key} className="flex flex-col items-center gap-2">
                <span className="max-w-40 text-center text-[10px] text-muted-foreground">{output.label}</span>
                <div className="h-4 w-px bg-border" />
                {next ? (
                  <Branch step={next} definition={definition} seen={seen} selectedId={selectedId} simulatingId={simulatingId} onSelect={onSelect} onDuplicate={onDuplicate} onDelete={onDelete} />
                ) : (
                  <span className="text-[11px] text-muted-foreground">Sem destino</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LooseSteps(props: {
  definition: FlowDefinition;
  placed: Set<string>;
  selectedId: string | null;
  simulatingId: string | null;
  onSelect: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const loose = props.definition.steps.filter((step) => !props.placed.has(step.id));
  if (loose.length === 0) return null;
  return (
    <div className="mt-8 w-full max-w-3xl">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">Etapas ainda sem caminho a partir do início</p>
      <div className="flex flex-wrap gap-3">
        {loose.map((step) => (
          <FlowStepCard
            key={step.id}
            step={step}
            definition={props.definition}
            active={step.id === props.selectedId || step.id === props.simulatingId}
            onSelect={() => props.onSelect(step.id)}
            onDuplicate={() => props.onDuplicate(step.id)}
            onDelete={() => props.onDelete(step.id)}
          />
        ))}
      </div>
    </div>
  );
}
