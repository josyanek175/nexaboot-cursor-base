/** Modelo do fluxo de atendimento. Sem banco e sem envio. */

export type FlowKind = "attendance" | "sales";
export type FlowStatus = "draft" | "active" | "paused";
export type SaveAs = "endereco" | "dia" | "observacao" | "";

export type FlowButton = { id: string; label: string; next: string | null };
export type ReminderOption = { id: string; label: string; days: number; next: string | null };

export type FlowStep =
  | { id: string; name?: string; type: "message"; text: string; next: string | null }
  | { id: string; name?: string; type: "buttons"; text: string; buttons: FlowButton[] }
  | { id: string; name?: string; type: "ask_text"; text: string; saveAs: SaveAs; next: string | null }
  | { id: string; name?: string; type: "condition"; match: string; yesNext: string | null; noNext: string | null }
  | { id: string; name?: string; type: "reminder"; text: string; options: ReminderOption[] }
  | { id: string; name?: string; type: "transfer"; text: string }
  | { id: string; name?: string; type: "goto"; next: string | null }
  | { id: string; name?: string; type: "end"; text: string };

export type FlowDefinition = { entryStepId: string | null; steps: FlowStep[] };

export type FlowVars = {
  nome?: string;
  telefone?: string;
  endereco?: string;
  prazo?: string;
  dia?: string;
};

const STEP_TYPES = new Set(["message", "buttons", "ask_text", "condition", "reminder", "transfer", "goto", "end"]);

export function emptyDefinition(): FlowDefinition {
  return { entryStepId: null, steps: [] };
}

export function renderFlowText(text: string, vars: FlowVars): string {
  return text
    .replaceAll("{{nome}}", vars.nome ?? "")
    .replaceAll("{{telefone}}", vars.telefone ?? "")
    .replaceAll("{{endereco}}", vars.endereco ?? "")
    .replaceAll("{{prazo}}", vars.prazo ?? "")
    .replaceAll("{{dia}}", vars.dia ?? "");
}

export function promptForStep(step: FlowStep, vars: FlowVars): string {
  const body = "text" in step ? renderFlowText(step.text, vars).trim() : "";
  if (step.type === "buttons") {
    const lines = step.buttons.map((button, index) => `${index + 1}. ${button.label}`);
    return [body, ...lines].filter(Boolean).join("\n");
  }
  if (step.type === "reminder") {
    const lines = step.options.map((option, index) => `${index + 1}. ${option.label}`);
    return [body, ...lines].filter(Boolean).join("\n");
  }
  return body;
}

function normalizeReply(text: string): string {
  return text.trim().toLowerCase();
}

export function matchChoice<T extends { label: string }>(text: string, choices: T[]): T | null {
  const normalized = normalizeReply(text);
  if (!normalized) return null;
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
    return choices[asNumber - 1] ?? null;
  }
  return choices.find((choice) => normalizeReply(choice.label) === normalized) ?? null;
}

export function replyMatches(text: string, match: string): boolean {
  const needle = normalizeReply(match);
  if (!needle) return false;
  return normalizeReply(text).includes(needle);
}

export function validateDefinition(raw: unknown): { ok: true; definition: FlowDefinition } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Definição inválida." };
  const record = raw as { entryStepId?: unknown; steps?: unknown };
  if (!Array.isArray(record.steps)) return { ok: false, error: "O fluxo precisa de uma lista de etapas." };
  if (record.steps.length > 40) return { ok: false, error: "O fluxo pode ter no máximo 40 etapas." };

  const steps: FlowStep[] = [];
  for (const item of record.steps) {
    const parsed = parseStep(item);
    if (!parsed.ok) return parsed;
    steps.push(parsed.step);
  }
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return { ok: false, error: "Há etapas com o mesmo identificador." };

  const entry = typeof record.entryStepId === "string" ? record.entryStepId : null;
  if (entry && !ids.has(entry)) return { ok: false, error: "A etapa inicial não existe." };
  if (steps.length > 0 && !entry) return { ok: false, error: "Escolha a etapa inicial." };

  for (const step of steps) {
    const missing = referencedIds(step).filter((id) => id && !ids.has(id));
    if (missing.length > 0) return { ok: false, error: "Uma etapa aponta para um caminho que não existe." };
  }
  return { ok: true, definition: { entryStepId: entry, steps } };
}

function referencedIds(step: FlowStep): string[] {
  if (step.type === "buttons") return step.buttons.map((button) => button.next).filter((id): id is string => !!id);
  if (step.type === "message" || step.type === "ask_text" || step.type === "goto") return step.next ? [step.next] : [];
  if (step.type === "condition") return [step.yesNext, step.noNext].filter((id): id is string => !!id);
  if (step.type === "reminder") return step.options.map((option) => option.next).filter((id): id is string => !!id);
  return [];
}

function parseStep(raw: unknown): { ok: true; step: FlowStep } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Etapa inválida." };
  const row = raw as Record<string, unknown>;
  const id = cleanId(row.id);
  const type = String(row.type ?? "");
  if (!id) return { ok: false, error: "Etapa sem identificador." };
  if (!STEP_TYPES.has(type)) return { ok: false, error: "Tipo de etapa desconhecido." };
  const text = cleanText(row.text);

  if (type === "buttons" || type === "reminder") {
    const source = Array.isArray(row.buttons) ? row.buttons : Array.isArray(row.options) ? row.options : null;
    if (!source || source.length < 1 || source.length > 3) {
      return { ok: false, error: "Cada etapa com opções precisa ter de 1 a 3 botões." };
    }
    const choices = source.map(parseChoice);
    if (choices.some((choice) => !choice)) return { ok: false, error: "Botão sem texto." };
    if (type === "reminder") {
      const options = choices.map((choice, index) => {
        const daysRaw = Number((source[index] as { days?: unknown }).days);
        const days = Number.isFinite(daysRaw) ? Math.floor(daysRaw) : 0;
        return { id: choice!.id, label: choice!.label, days, next: choice!.next };
      });
      if (options.some((option) => option.days < 1 || option.days > 365)) {
        return { ok: false, error: "O prazo do lembrete fica entre 1 e 365 dias." };
      }
      return { ok: true, step: withName({ id, type: "reminder", text, options }, row) };
    }
    return { ok: true, step: withName({ id, type: "buttons", text, buttons: choices as FlowButton[] }, row) };
  }

  if (type === "message") {
    return { ok: true, step: withName({ id, type: "message", text, next: cleanRef(row.next) }, row) };
  }
  if (type === "ask_text") {
    const saveAs = row.saveAs === "endereco" || row.saveAs === "dia" || row.saveAs === "observacao" ? row.saveAs : "";
    return { ok: true, step: withName({ id, type: "ask_text", text, saveAs, next: cleanRef(row.next) }, row) };
  }
  if (type === "condition") {
    const match = cleanText(row.match).slice(0, 40);
    if (!match) return { ok: false, error: "A condição precisa da palavra que o cliente deve escrever." };
    return { ok: true, step: withName({ id, type: "condition", match, yesNext: cleanRef(row.yesNext), noNext: cleanRef(row.noNext) }, row) };
  }
  if (type === "goto") {
    return { ok: true, step: withName({ id, type: "goto", next: cleanRef(row.next) }, row) };
  }
  if (type === "transfer") return { ok: true, step: withName({ id, type: "transfer", text }, row) };
  return { ok: true, step: withName({ id, type: "end", text }, row) };
}

function withName<T extends FlowStep>(step: T, row: Record<string, unknown>): T {
  const name = cleanText(row.name).slice(0, 80);
  return name ? { ...step, name } : step;
}

function parseChoice(raw: unknown): FlowButton | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const label = cleanText(row.label).slice(0, 20);
  if (!label) return null;
  return { id: cleanId(row.id) || label, label, next: cleanRef(row.next) };
}

function cleanId(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim().slice(0, 2000);
}

function cleanRef(value: unknown): string | null {
  const id = cleanId(value);
  return id || null;
}

export function stepById(definition: FlowDefinition, id: string | null): FlowStep | null {
  if (!id) return null;
  return definition.steps.find((step) => step.id === id) ?? null;
}
