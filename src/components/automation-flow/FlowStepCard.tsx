import { displayStepName, stepOutputs, stepSummary, typeLabel } from "@/components/automation-flow/flow-model";
import type { FlowDefinition, FlowStep } from "@/lib/automation-flow";

export function FlowStepCard({
  step,
  definition,
  active,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  step: FlowStep;
  definition: FlowDefinition;
  active: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const index = definition.steps.findIndex((item) => item.id === step.id);
  const name = displayStepName(step, index);
  return (
    <article className={`min-w-0 w-full rounded-2xl border bg-card p-3 [overflow-wrap:anywhere] xl:w-72 ${active ? "border-whatsapp ring-2 ring-whatsapp/30" : "border-border"}`}>
      <button type="button" className="w-full text-left" onClick={onSelect}>
        <div className="text-[11px] text-muted-foreground">{index + 1}. {typeLabel(step.type)}</div>
        <div className="font-semibold">{name}</div>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{stepSummary(step)}</p>
        <ul className="mt-2 space-y-1 text-[11px]">
          {stepOutputs(step).map((output) => {
            const target = definition.steps.find((item) => item.id === output.next);
            const targetName = target ? displayStepName(target, definition.steps.indexOf(target)) : "—";
            return (
              <li key={output.key} className="rounded-lg bg-muted px-2 py-1">
                {output.label} → {targetName}
              </li>
            );
          })}
        </ul>
      </button>
      <div className="mt-2 flex flex-wrap gap-3 text-xs [&>button]:min-h-11 xl:[&>button]:min-h-0">
        <button className="text-whatsapp" onClick={onSelect}>Editar</button>
        <button onClick={onDuplicate}>Duplicar</button>
        <button className="text-destructive" onClick={onDelete}>Excluir</button>
      </div>
    </article>
  );
}
