/** Variáveis disponíveis em modelos Evolution. */

export const EVOLUTION_TEMPLATE_VARIABLES = [
  { key: "nome", label: "Nome do contato", sample: "Maria Silva" },
  { key: "telefone", label: "Telefone", sample: "5534999999999" },
  { key: "endereco", label: "Endereço", sample: "Rua das Flores, 123" },
  { key: "produto", label: "Produto", sample: "Refil Premium" },
  { key: "data_ultima_troca", label: "Data última troca", sample: "15/06/2026" },
  { key: "nome_atendente", label: "Nome do atendente", sample: "Josyane" },
] as const;

export type EvolutionVariableKey = (typeof EVOLUTION_TEMPLATE_VARIABLES)[number]["key"];

const SAMPLE_VALUES: Record<string, string> = Object.fromEntries(
  EVOLUTION_TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]),
);

/** Aceita {nome} ou { name } (alias). */
export function renderEvolutionTemplateBody(
  template: string,
  vars: Record<string, unknown>,
): string {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v != null) normalized[k.toLowerCase()] = String(v).trim();
  }
  if (normalized.name && !normalized.nome) normalized.nome = normalized.name;
  if (normalized.nome && !normalized.name) normalized.name = normalized.nome;
  if (normalized.telefone && !normalized.phone) normalized.phone = normalized.telefone;
  if (normalized.phone && !normalized.telefone) normalized.telefone = normalized.phone;

  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key: string) => {
    const k = key.toLowerCase();
    const raw =
      normalized[k] ??
      normalized[key] ??
      (k === "nome" ? normalized.name : undefined) ??
      (k === "name" ? normalized.nome : undefined) ??
      (k === "telefone" ? normalized.phone : undefined) ??
      (k === "phone" ? normalized.telefone : undefined);
    return raw ?? "";
  });
}

export function previewEvolutionTemplate(template: string): string {
  return renderEvolutionTemplateBody(template, SAMPLE_VALUES);
}

export function listVariablesInTemplate(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}
