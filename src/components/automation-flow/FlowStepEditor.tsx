import { displayStepName, typeLabel } from "@/components/automation-flow/flow-model";
import type { FlowDefinition, FlowStep, SaveAs } from "@/lib/automation-flow";

export function FlowStepEditor({
  step,
  definition,
  onChange,
  onClose,
  onDuplicate,
  onDelete,
}: {
  step: FlowStep;
  definition: FlowDefinition;
  onChange: (step: FlowStep) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const index = definition.steps.findIndex((item) => item.id === step.id);
  const targets = definition.steps.filter((item) => item.id !== step.id);
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{displayStepName(step, index)}</h2>
        <button className="text-xs text-muted-foreground" onClick={onClose}>Fechar</button>
      </div>
      <label className="mb-2 block text-xs">
        Nome da etapa
        <input
          value={step.name ?? ""}
          placeholder={displayStepName({ ...step, name: undefined }, index)}
          onChange={(event) => onChange({ ...step, name: event.target.value })}
          className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
        />
      </label>
      <p className="mb-3 text-[11px] text-muted-foreground">Tipo: {typeLabel(step.type)}</p>
      {"text" in step && (
        <label className="mb-3 block text-xs">
          {step.type === "end" ? "Mensagem final" : "Mensagem"}
          <textarea
            value={step.text}
            onChange={(event) => onChange({ ...step, text: event.target.value })}
            className="mt-1 min-h-24 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
      )}
      {step.type === "buttons" && (
        <Choices
          items={step.buttons.map((button) => ({ id: button.id, label: button.label, next: button.next }))}
          targets={targets}
          definition={definition}
          onChange={(buttons) => onChange({ ...step, buttons })}
          canAdd={step.buttons.length < 3}
        />
      )}
      {step.type === "ask_text" && (
        <>
          <label className="mb-3 block text-xs">
            Guardar resposta como
            <select
              value={step.saveAs}
              onChange={(event) => onChange({ ...step, saveAs: event.target.value as SaveAs })}
              className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Não guardar</option>
              <option value="endereco">Endereço</option>
              <option value="dia">Dia</option>
              <option value="observacao">Observação</option>
            </select>
          </label>
          <NextField label="Próxima etapa" value={step.next} targets={targets} definition={definition} onChange={(next) => onChange({ ...step, next })} />
        </>
      )}
      {step.type === "condition" && (
        <>
          <label className="mb-3 block text-xs">
            Se a resposta contiver
            <input value={step.match} onChange={(event) => onChange({ ...step, match: event.target.value })} className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm" />
          </label>
          <NextField label="Caminho sim" value={step.yesNext} targets={targets} definition={definition} onChange={(yesNext) => onChange({ ...step, yesNext })} />
          <NextField label="Caminho não" value={step.noNext} targets={targets} definition={definition} onChange={(noNext) => onChange({ ...step, noNext })} />
        </>
      )}
      {step.type === "reminder" && (
        <div className="flex flex-col gap-2">
          {step.options.map((option, optionIndex) => (
            <div key={option.id} className="rounded-xl border border-border p-2">
              <input
                value={option.label}
                maxLength={20}
                onChange={(event) => {
                  const options = step.options.map((item, index) => index === optionIndex ? { ...item, label: event.target.value } : item);
                  onChange({ ...step, options });
                }}
                className="mb-1 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm"
              />
              <input
                type="number"
                min={1}
                max={365}
                value={option.days}
                onChange={(event) => {
                  const options = step.options.map((item, index) => index === optionIndex ? { ...item, days: Number(event.target.value) } : item);
                  onChange({ ...step, options });
                }}
                className="mb-1 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm"
              />
              <NextField
                label="Próxima etapa"
                value={option.next}
                targets={targets}
                definition={definition}
                onChange={(next) => {
                  const options = step.options.map((item, index) => index === optionIndex ? { ...item, next } : item);
                  onChange({ ...step, options });
                }}
              />
            </div>
          ))}
          {step.options.length < 3 && (
            <button className="text-xs text-whatsapp" onClick={() => onChange({ ...step, options: [...step.options, { id: crypto.randomUUID().slice(0, 8), label: "", days: 30, next: null }] })}>
              Adicionar prazo
            </button>
          )}
        </div>
      )}
      {(step.type === "message" || step.type === "goto") && (
        <NextField label={step.type === "goto" ? "Etapa destino" : "Próxima etapa"} value={step.next} targets={targets} definition={definition} onChange={(next) => onChange({ ...step, next })} />
      )}
      <div className="mt-4 flex gap-3 text-xs">
        <button onClick={onDuplicate}>Duplicar</button>
        <button className="text-destructive" onClick={onDelete}>Excluir</button>
      </div>
    </aside>
  );
}

function Choices({
  items,
  targets,
  definition,
  onChange,
  canAdd,
}: {
  items: { id: string; label: string; next: string | null }[];
  targets: FlowStep[];
  definition: FlowDefinition;
  onChange: (items: { id: string; label: string; next: string | null }[]) => void;
  canAdd: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={item.id} className="rounded-xl border border-border p-2">
          <input
            value={item.label}
            maxLength={20}
            placeholder="Texto do botão"
            onChange={(event) => onChange(items.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row))}
            className="mb-1 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm"
          />
          <NextField
            label="Próxima etapa"
            value={item.next}
            targets={targets}
            definition={definition}
            onChange={(next) => onChange(items.map((row, rowIndex) => rowIndex === index ? { ...row, next } : row))}
          />
        </div>
      ))}
      {canAdd && (
        <button className="text-xs text-whatsapp" onClick={() => onChange([...items, { id: crypto.randomUUID().slice(0, 8), label: "", next: null }])}>
          Adicionar botão
        </button>
      )}
    </div>
  );
}

function NextField({
  label,
  value,
  targets,
  definition,
  onChange,
}: {
  label: string;
  value: string | null;
  targets: FlowStep[];
  definition: FlowDefinition;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="block text-xs">
      {label}
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} className="mt-1 w-full rounded-xl border border-input bg-background px-2 py-1.5 text-sm">
        <option value="">Sem destino</option>
        {targets.map((target) => (
          <option key={target.id} value={target.id}>{displayStepName(target, definition.steps.indexOf(target))}</option>
        ))}
      </select>
    </label>
  );
}
