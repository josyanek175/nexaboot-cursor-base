import {
  matchChoice,
  replyMatches,
  stepById,
  validateDefinition,
  type FlowDefinition,
  type FlowStep,
} from "@/lib/automation-flow";

export const BLOCKS = [
  { type: "message", label: "Mensagem", hint: "Envia um texto e segue" },
  { type: "buttons", label: "Mensagem com botões", hint: "Até 3 opções" },
  { type: "ask_text", label: "Pedir texto", hint: "Espera o que o cliente escrever" },
  { type: "condition", label: "Condição", hint: "Se a resposta contiver..." },
  { type: "reminder", label: "Lembrete", hint: "Prazo para lembrar depois" },
  { type: "transfer", label: "Encaminhar para atendente", hint: "Passa a conversa" },
  { type: "goto", label: "Ir para outra etapa", hint: "Continua em outra etapa" },
  { type: "end", label: "Encerrar", hint: "Termina o fluxo" },
] as const;

export type BlockType = (typeof BLOCKS)[number]["type"];

export function newStepId() {
  return crypto.randomUUID().slice(0, 8);
}

export function typeLabel(type: FlowStep["type"]) {
  return BLOCKS.find((block) => block.type === type)?.label ?? type;
}

export function displayStepName(step: FlowStep, index: number) {
  if (step.name?.trim()) return step.name.trim();
  const n = index + 1;
  if (step.type === "message") return `Mensagem ${n}`;
  if (step.type === "buttons") return `Pergunta ${n}`;
  if (step.type === "ask_text") return `Texto ${n}`;
  if (step.type === "condition") return `Condição ${n}`;
  if (step.type === "reminder") return `Lembrete ${n}`;
  if (step.type === "transfer") return `Atendente ${n}`;
  if (step.type === "goto") return `Atalho ${n}`;
  return `Encerrar ${n}`;
}

export function createStep(type: BlockType): FlowStep {
  const id = newStepId();
  const name =
    type === "message" ? "Nova mensagem" :
    type === "buttons" ? "Nova pergunta" :
    type === "ask_text" ? "Novo texto" :
    type === "condition" ? "Nova condição" :
    type === "reminder" ? "Novo lembrete" :
    type === "transfer" ? "Novo encaminhamento" :
    type === "goto" ? "Novo atalho" :
    "Novo encerramento";
  if (type === "buttons") {
    return { id, name, type, text: "", buttons: [{ id: newStepId(), label: "Opção 1", next: null }] };
  }
  if (type === "ask_text") return { id, name, type, text: "", saveAs: "", next: null };
  if (type === "condition") return { id, name, type, match: "sim", yesNext: null, noNext: null };
  if (type === "reminder") {
    return { id, name, type, text: "", options: [{ id: newStepId(), label: "15 dias", days: 15, next: null }] };
  }
  if (type === "transfer") return { id, name, type, text: "" };
  if (type === "goto") return { id, name, type, next: null };
  if (type === "message") return { id, name, type, text: "", next: null };
  return { id, name, type: "end", text: "" };
}

export function duplicateStep(step: FlowStep): FlowStep {
  const copy = structuredClone(step);
  copy.id = newStepId();
  copy.name = `${step.name?.trim() || typeLabel(step.type)} Cópia`;
  if (copy.type === "buttons") copy.buttons = copy.buttons.map((button) => ({ ...button, id: newStepId() }));
  if (copy.type === "reminder") copy.options = copy.options.map((option) => ({ ...option, id: newStepId() }));
  return copy;
}

export type StepOutput = { key: string; label: string; next: string | null };

export function stepOutputs(step: FlowStep): StepOutput[] {
  if (step.type === "buttons") return step.buttons.map((button) => ({ key: button.id, label: button.label || "Botão", next: button.next }));
  if (step.type === "reminder") return step.options.map((option) => ({ key: option.id, label: option.label || "Prazo", next: option.next }));
  if (step.type === "condition") {
    return [
      { key: "yes", label: `Se contiver “${step.match}”`, next: step.yesNext },
      { key: "no", label: "Qualquer outra resposta", next: step.noNext },
    ];
  }
  if (step.type === "message" || step.type === "ask_text" || step.type === "goto") {
    return [{ key: "next", label: step.type === "goto" ? "Destino" : "Segue para", next: step.next }];
  }
  return [];
}

export function stepSummary(step: FlowStep) {
  if (step.type === "condition") return step.match;
  if (step.type === "goto") return step.next ? "Continua em outra etapa" : "Sem destino";
  if ("text" in step) return step.text || "Sem texto";
  return "";
}

export function referencesTo(definition: FlowDefinition, stepId: string) {
  const hits: string[] = [];
  if (definition.entryStepId === stepId) hits.push("Início");
  for (const step of definition.steps) {
    if (step.id === stepId) continue;
    if (stepOutputs(step).some((output) => output.next === stepId)) hits.push(step.id);
  }
  return hits;
}

export function clearReferences(definition: FlowDefinition, stepId: string): FlowDefinition {
  return {
    entryStepId: definition.entryStepId === stepId ? null : definition.entryStepId,
    steps: definition.steps.map((step) => {
      if (step.type === "buttons") {
        return { ...step, buttons: step.buttons.map((button) => button.next === stepId ? { ...button, next: null } : button) };
      }
      if (step.type === "reminder") {
        return { ...step, options: step.options.map((option) => option.next === stepId ? { ...option, next: null } : option) };
      }
      if (step.type === "condition") {
        return {
          ...step,
          yesNext: step.yesNext === stepId ? null : step.yesNext,
          noNext: step.noNext === stepId ? null : step.noNext,
        };
      }
      if (step.type === "message" || step.type === "ask_text" || step.type === "goto") {
        return { ...step, next: step.next === stepId ? null : step.next };
      }
      return step;
    }),
  };
}

export function publishError(definition: FlowDefinition) {
  const parsed = validateDefinition(definition);
  if (!parsed.ok) return parsed.error;
  if (!parsed.definition.entryStepId) return "Escolha a etapa inicial.";
  if (!stepById(parsed.definition, parsed.definition.entryStepId)) return "A etapa inicial não existe.";
  return null;
}

export function advanceSimulation(step: FlowStep, input: string): { next: string | null; note: string } {
  if (step.type === "buttons" || step.type === "reminder") {
    const choices = step.type === "buttons" ? step.buttons : step.options;
    const hit = matchChoice(input, choices);
    if (!hit) return { next: null, note: "Escolha uma das opções." };
    return { next: hit.next, note: "" };
  }
  if (step.type === "condition") {
    return { next: replyMatches(input, step.match) ? step.yesNext : step.noNext, note: "" };
  }
  if (step.type === "ask_text" || step.type === "message" || step.type === "goto") {
    return { next: step.next, note: "" };
  }
  return { next: null, note: step.type === "transfer" ? "Conversa com o atendente." : "Fluxo encerrado." };
}
