import { useState } from "react";
import { advanceSimulation, displayStepName, stepSummary } from "@/components/automation-flow/flow-model";
import { promptForStep, stepById, type FlowDefinition } from "@/lib/automation-flow";

export function FlowSimulator({
  definition,
  onClose,
  onActive,
}: {
  definition: FlowDefinition;
  onClose: () => void;
  onActive: (id: string | null) => void;
}) {
  const [currentId, setCurrentId] = useState(definition.entryStepId);
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const step = stepById(definition, currentId);

  function go(next: string | null, line: string) {
    setLog((items) => [...items, line]);
    setText("");
    setNote("");
    setCurrentId(next);
    onActive(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex h-[640px] w-[360px] flex-col overflow-hidden rounded-3xl bg-[#ece5dd] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between bg-[#075e54] px-4 py-3 text-white">
          <span className="text-sm font-semibold">Testar fluxo</span>
          <button onClick={onClose}>Fechar</button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {log.map((line, index) => (
            <div key={index} className="ml-auto max-w-[80%] rounded-lg bg-[#dcf8c6] px-3 py-2 text-sm">{line}</div>
          ))}
          {step ? (
            <div className="max-w-[85%] rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
              <div className="mb-1 text-[10px] font-semibold text-[#075e54]">{displayStepName(step, definition.steps.indexOf(step))}</div>
              <div className="whitespace-pre-wrap">{stepSummary(step) || promptForStep(step, {})}</div>
            </div>
          ) : (
            <p className="text-center text-xs text-neutral-500">Escolha a etapa inicial para testar.</p>
          )}
          {note && <p className="text-center text-xs text-amber-700">{note}</p>}
        </div>
        {step && (step.type === "buttons" || step.type === "reminder") && (
          <div className="flex flex-col gap-1 bg-white p-2">
            {(step.type === "buttons" ? step.buttons : step.options).map((choice) => (
              <button key={choice.id} className="rounded-full border border-[#075e54] px-3 py-1.5 text-sm text-[#075e54]" onClick={() => {
                const result = advanceSimulation(step, choice.label);
                if (result.note) setNote(result.note);
                else go(result.next, choice.label);
              }}>
                {choice.label}
              </button>
            ))}
          </div>
        )}
        {step && (step.type === "ask_text" || step.type === "condition" || step.type === "message") && (
          <form
            className="flex gap-2 bg-white p-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = step.type === "message" ? "Continuar" : text;
              const result = advanceSimulation(step, value);
              if (result.note) setNote(result.note);
              else go(result.next, value);
            }}
          >
            {step.type !== "message" && (
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Escreva como o cliente" className="flex-1 rounded-full border px-3 py-2 text-sm" />
            )}
            <button className="rounded-full bg-[#075e54] px-3 text-sm text-white">{step.type === "message" ? "Continuar" : "Enviar"}</button>
          </form>
        )}
        {step?.type === "goto" && (
          <button className="m-2 rounded-full bg-[#075e54] py-2 text-sm text-white" onClick={() => go(step.next, "Seguir")}>Seguir</button>
        )}
      </div>
    </div>
  );
}
