/**
 * Variáveis dinâmicas Evolution — extração, mapeamento, resolução e validação.
 * Persistência em campaigns.meta_variable_mappings["__evolution_v2"] (sem migration dedicada).
 */
import { normalizeTagKey } from "@/lib/campaign-spreadsheet";
import { stripTemplateMetadata } from "@/lib/campaign-template-metadata";

export const EVOLUTION_MAPPINGS_JSON_KEY = "__evolution_v2";

/** Sugestões iniciais — não limitam variáveis permitidas. */
export const EVOLUTION_VARIABLE_SUGGESTIONS = [
  { key: "nome", label: "Nome do contato", sample: "Maria Silva" },
  { key: "telefone", label: "Telefone", sample: "5534999999999" },
  { key: "endereco", label: "Endereço", sample: "Rua das Flores, 123" },
  { key: "produto", label: "Produto", sample: "Refil Premium" },
  { key: "data_ultima_troca", label: "Data última troca", sample: "15/06/2026" },
  { key: "nome_atendente", label: "Nome do atendente", sample: "Josyane" },
] as const;

const SAMPLE_BY_KEY: Record<string, string> = Object.fromEntries(
  EVOLUTION_VARIABLE_SUGGESTIONS.map((v) => [v.key, v.sample]),
);

export type EvolutionVariableSourceType =
  | "contact_field"
  | "contact_variable"
  | "spreadsheet_column"
  | "campaign_fixed"
  | "attendant"
  | "company";

export type EvolutionVariableSource =
  | { source: "contact_field"; field: "name" | "phone" }
  | { source: "contact_variable"; key: string }
  | { source: "spreadsheet_column"; column: string }
  | { source: "campaign_fixed"; value: string }
  | { source: "attendant"; field: "name" }
  | { source: "company"; field: "name" | "trade_name" | "phone" };

export type EvolutionVariableMappings = Record<string, EvolutionVariableSource>;

export type EvolutionResolveContext = {
  contact: {
    name: string | null;
    phone: string;
    variables: Record<string, unknown>;
  };
  attendant?: { name?: string | null };
  company?: { name?: string | null; trade_name?: string | null; phone?: string | null };
};

const VAR_NAME_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Extrai variáveis únicas preservando ordem de aparição. */
export function extractEvolutionTemplateVariables(template: string): string[] {
  const visible = stripTemplateMetadata(template);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of visible.matchAll(VAR_NAME_RE)) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function suggestEvolutionMapping(varName: string): EvolutionVariableSource {
  const v = varName.toLowerCase();
  if (v === "nome" || v === "name") return { source: "contact_field", field: "name" };
  if (v === "telefone" || v === "phone") return { source: "contact_field", field: "phone" };
  if (v === "nome_atendente") return { source: "attendant", field: "name" };
  if (v === "empresa" || v === "nome_empresa") return { source: "company", field: "name" };
  return { source: "spreadsheet_column", column: v };
}

export function buildDefaultEvolutionMappings(template: string): EvolutionVariableMappings {
  const vars = extractEvolutionTemplateVariables(template);
  const out: EvolutionVariableMappings = {};
  for (const v of vars) out[v] = suggestEvolutionMapping(v);
  return out;
}

function parseEvolutionSource(raw: unknown): EvolutionVariableSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const source = String(o.source ?? "") as EvolutionVariableSourceType;
  switch (source) {
    case "contact_field":
      if (o.field === "name" || o.field === "phone") return { source, field: o.field };
      return null;
    case "contact_variable":
      if (typeof o.key === "string" && o.key.trim()) {
        return { source, key: normalizeTagKey(o.key) || o.key.trim().toLowerCase() };
      }
      return null;
    case "spreadsheet_column":
      if (typeof o.column === "string" && o.column.trim()) {
        return { source, column: normalizeTagKey(o.column) || o.column.trim().toLowerCase() };
      }
      return null;
    case "campaign_fixed":
      if (typeof o.value === "string") return { source, value: o.value };
      return null;
    case "attendant":
      if (o.field === "name") return { source, field: "name" };
      return null;
    case "company":
      if (o.field === "name" || o.field === "trade_name" || o.field === "phone") {
        return { source, field: o.field };
      }
      return null;
    default:
      return null;
  }
}

export function unpackEvolutionMappings(raw: unknown): EvolutionVariableMappings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const block = root[EVOLUTION_MAPPINGS_JSON_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: EvolutionVariableMappings = {};
  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    const parsed = parseEvolutionSource(v);
    if (parsed) out[k.toLowerCase()] = parsed;
  }
  return out;
}

export function packEvolutionMappings(
  metaMappings: Record<string, unknown> | null | undefined,
  evolutionMappings: EvolutionVariableMappings,
): Record<string, unknown> {
  const base =
    metaMappings && typeof metaMappings === "object" && !Array.isArray(metaMappings)
      ? { ...(metaMappings as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== "string") delete base[k];
  }
  base[EVOLUTION_MAPPINGS_JSON_KEY] = evolutionMappings;
  return base;
}

export function mergeEvolutionMappings(
  template: string,
  stored: EvolutionVariableMappings,
): EvolutionVariableMappings {
  const vars = extractEvolutionTemplateVariables(template);
  const out: EvolutionVariableMappings = {};
  for (const v of vars) {
    out[v] = stored[v] ?? suggestEvolutionMapping(v);
  }
  return out;
}

export function listUnconfiguredEvolutionVariables(
  template: string,
  mappings: EvolutionVariableMappings,
): string[] {
  const vars = extractEvolutionTemplateVariables(template);
  return vars.filter((v) => !mappings[v]);
}

export function resolveEvolutionVariableValue(
  varName: string,
  mapping: EvolutionVariableSource,
  ctx: EvolutionResolveContext,
): string | null {
  switch (mapping.source) {
    case "contact_field":
      if (mapping.field === "name") return ctx.contact.name?.trim() || null;
      if (mapping.field === "phone") return ctx.contact.phone?.trim() || null;
      return null;
    case "contact_variable": {
      const key = normalizeTagKey(mapping.key) || mapping.key.toLowerCase();
      const raw = ctx.contact.variables[key] ?? ctx.contact.variables[mapping.key];
      if (raw == null) return null;
      const s = String(raw).trim();
      return s || null;
    }
    case "spreadsheet_column": {
      const col = normalizeTagKey(mapping.column) || mapping.column.toLowerCase();
      const raw = ctx.contact.variables[col] ?? ctx.contact.variables[mapping.column];
      if (raw == null) return null;
      const s = String(raw).trim();
      return s || null;
    }
    case "campaign_fixed":
      return mapping.value.trim() || null;
    case "attendant":
      return ctx.attendant?.name?.trim() || null;
    case "company": {
      if (mapping.field === "trade_name") {
        return ctx.company?.trade_name?.trim() || ctx.company?.name?.trim() || null;
      }
      if (mapping.field === "phone") return ctx.company?.phone?.trim() || null;
      return ctx.company?.name?.trim() || null;
    }
    default:
      return null;
  }
}

export type EvolutionResolveResult =
  | { ok: true; values: Record<string, string>; rendered: string }
  | { ok: false; missing: string[]; rendered?: string };

export function resolveAndRenderEvolutionTemplate(
  template: string,
  mappings: EvolutionVariableMappings,
  ctx: EvolutionResolveContext,
): EvolutionResolveResult {
  const visible = stripTemplateMetadata(template);
  const vars = extractEvolutionTemplateVariables(visible);
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const v of vars) {
    const mapping = mappings[v] ?? suggestEvolutionMapping(v);
    const val = resolveEvolutionVariableValue(v, mapping, ctx);
    if (val == null || val === "") {
      missing.push(v);
    } else {
      values[v] = val;
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const rendered = visible.replace(VAR_NAME_RE, (_full, key: string) => {
    const k = key.toLowerCase();
    return values[k] ?? "";
  });

  if (/\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(rendered)) {
    const stillMissing = extractEvolutionTemplateVariables(rendered);
    return { ok: false, missing: stillMissing.length ? stillMissing : missing, rendered };
  }

  return { ok: true, values, rendered };
}

export function previewEvolutionTemplateWithMappings(
  template: string,
  mappings: EvolutionVariableMappings,
): string {
  const visible = stripTemplateMetadata(template);
  const sampleCtx: EvolutionResolveContext = {
    contact: {
      name: SAMPLE_BY_KEY.nome ?? "Maria Silva",
      phone: SAMPLE_BY_KEY.telefone ?? "5534999999999",
      variables: { ...SAMPLE_BY_KEY },
    },
    attendant: { name: SAMPLE_BY_KEY.nome_atendente ?? "Josyane" },
    company: { name: "Empresa Exemplo Ltda", trade_name: "Empresa Exemplo" },
  };
  const result = resolveAndRenderEvolutionTemplate(visible, mappings, sampleCtx);
  if (result.ok) return result.rendered;
  let preview = visible;
  for (const v of extractEvolutionTemplateVariables(visible)) {
    const mapping = mappings[v] ?? suggestEvolutionMapping(v);
    const val = resolveEvolutionVariableValue(v, mapping, sampleCtx);
    preview = preview.replace(new RegExp(`\\{${v}\\}`, "gi"), val ?? `{${v}}`);
  }
  return preview;
}

export function buildSamplePreviewContext(
  overrides?: Partial<EvolutionResolveContext>,
): EvolutionResolveContext {
  return {
    contact: {
      name: "Maria Silva",
      phone: "5534999999999",
      variables: { ...SAMPLE_BY_KEY, produto: "Refil Premium", valor_servico: "R$ 89,90" },
      ...overrides?.contact,
    },
    attendant: { name: "Josyane", ...overrides?.attendant },
    company: {
      name: "Empresa Exemplo Ltda",
      trade_name: "Empresa Exemplo",
      phone: "5534000000000",
      ...overrides?.company,
    },
  };
}

export const EVOLUTION_SOURCE_LABELS: Record<EvolutionVariableSourceType, string> = {
  contact_field: "Campo do contato",
  contact_variable: "Campo personalizado do contato",
  spreadsheet_column: "Coluna da planilha importada",
  campaign_fixed: "Valor fixo da campanha",
  attendant: "Dados do atendente",
  company: "Dados da empresa",
};

/** Compatibilidade: substituição simples a partir de dict plano (legado). */
export function renderEvolutionTemplateBody(
  template: string,
  contactVars: Record<string, unknown>,
): string {
  const visible = stripTemplateMetadata(template);
  return visible.replace(VAR_NAME_RE, (_full, key: string) => {
    const k = key.toLowerCase();
    const raw = contactVars[k] ?? contactVars[key];
    if (raw == null) return `{${key}}`;
    const s = String(raw).trim();
    return s || `{${key}}`;
  });
}

/** Compatibilidade: prévia com mapeamentos sugeridos e dados fictícios. */
export function previewEvolutionTemplate(template: string): string {
  const mappings = buildDefaultEvolutionMappings(template);
  return previewEvolutionTemplateWithMappings(template, mappings);
}
