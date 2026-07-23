// Parsing compartilhado de planilha/lista para campanhas (client + server).
import { buildVariedMessage } from "@/lib/campaign-send-policy";

export const CAMPAIGN_NAME_KEYS = ["nome", "name", "cliente", "contato"];
export const CAMPAIGN_PHONE_KEYS = ["telefone", "celular", "whatsapp", "phone", "fone", "tel"];

export type ParsedSpreadsheetRow = {
  /** Índice original (0-based) na lista enviada. */
  index: number;
  name: string;
  phone: string;
  /** Colunas extras → tags {chave: valor}. */
  variables: Record<string, string>;
  /** Tags disponíveis nesta linha (chaves normalizadas). */
  tagKeys: string[];
};

export type NormalizedImportRow = ParsedSpreadsheetRow & {
  phoneDigits: string;
  status: "valid" | "invalid" | "duplicate" | "opt_out";
  reason?: string;
};

export function normalizeTagKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pickField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of Object.keys(row)) {
    const norm = normalizeTagKey(k);
    if (keys.includes(norm)) {
      const v = row[k];
      if (v === undefined || v === null) return undefined;
      const s = String(v).trim();
      return s.length ? s : undefined;
    }
  }
  return undefined;
}

/** Converte linha bruta da planilha em nome, telefone e variables. */
export function parseSpreadsheetRow(
  row: Record<string, unknown>,
  index: number,
): ParsedSpreadsheetRow | null {
  const name = pickField(row, CAMPAIGN_NAME_KEYS) ?? "";
  const phoneRaw = pickField(row, CAMPAIGN_PHONE_KEYS) ?? "";
  const variables: Record<string, string> = {};
  const reserved = new Set([...CAMPAIGN_NAME_KEYS, ...CAMPAIGN_PHONE_KEYS]);

  for (const k of Object.keys(row)) {
    const tag = normalizeTagKey(k);
    if (!tag || reserved.has(tag)) continue;
    const v = row[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    variables[tag] = s;
  }

  if (name) variables.nome = name;
  if (phoneRaw) variables.telefone = phoneRaw;

  const tagKeys = Object.keys(variables).sort();

  if (!name && !phoneRaw && tagKeys.length === 0) return null;

  return { index, name, phone: phoneRaw, variables, tagKeys };
}

/** Copia campos do CRM para campaign_contacts.variables (isolado por importação). */
export function buildCrmContactVariables(contact: {
  email?: string | null;
  reference?: string | null;
  tags?: string[] | null;
}): Record<string, string> {
  const variables: Record<string, string> = {};
  const email = contact.email?.trim();
  if (email) variables.email = email;

  const reference = contact.reference?.trim();
  if (reference) {
    variables.reference = reference;
    variables.referencia = reference;
  }

  for (const tag of contact.tags ?? []) {
    const label = String(tag).trim();
    if (!label) continue;
    const key = normalizeTagKey(label);
    if (key) variables[key] = label;
  }

  return variables;
}

/** Parse texto colado (CSV ou TSV). */
export function parsePastedText(text: string): Record<string, unknown>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const semis = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  const tabs = (headerLine.match(/\t/g) ?? []).length;
  const sep = tabs >= semis && tabs >= commas ? "\t" : semis >= commas ? ";" : ",";

  const headers = headerLine.split(sep).map((h) => h.trim());
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    const row: Record<string, unknown> = {};
    headers.forEach((h, j) => {
      row[h] = cols[j]?.trim() ?? "";
    });
    rows.push(row);
  }
  return rows;
}

export function collectAvailableTags(rows: ParsedSpreadsheetRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    for (const k of r.tagKeys) set.add(k);
  }
  return [...set].sort();
}

export function previewMessage(
  messageTemplate: string,
  sample: ParsedSpreadsheetRow | null,
): string {
  if (!messageTemplate.trim() || !sample) return "";
  const vars: Record<string, unknown> = {
    ...sample.variables,
    nome: sample.name || sample.variables.nome || "",
    telefone: sample.phone || sample.variables.telefone || "",
    phone: sample.phone || sample.variables.telefone || "",
  };
  return buildVariedMessage(messageTemplate, vars).rendered_message;
}

export function normalizePhoneDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}
