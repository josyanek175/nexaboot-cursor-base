/** Renderização pura de templates Meta para exibição no atendimento (sem I/O). */

export function extractBodyText(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    if (String(row.type ?? "").toUpperCase() !== "BODY") continue;
    const text = row.text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

export function extractButtons(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const out: string[] = [];
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    if (String(row.type ?? "").toUpperCase() !== "BUTTONS") continue;
    const buttons = row.buttons;
    if (!Array.isArray(buttons)) continue;
    for (const b of buttons) {
      if (!b || typeof b !== "object") continue;
      const btn = b as Record<string, unknown>;
      const text = typeof btn.text === "string" ? btn.text : null;
      if (text) out.push(text);
    }
  }
  return out;
}

export function extractTemplateVariables(components: unknown): string[] {
  const body = extractBodyText(components) ?? "";
  const found = new Set<string>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) {
    found.add(m[1]);
  }
  return [...found].sort((a, b) => Number(a) - Number(b));
}

export function renderMetaTemplateMessage(opts: {
  body: string;
  parameters: string[];
  buttons?: string[];
}): { body: string; buttons: string[] } {
  const renderedBody = opts.body.replace(/\{\{(\d+)\}\}/g, (_match, idx: string) => {
    const i = Number(idx) - 1;
    if (Number.isFinite(i) && i >= 0 && i < opts.parameters.length) {
      return opts.parameters[i] ?? "";
    }
    return "";
  });

  return {
    body: renderedBody,
    buttons: [...(opts.buttons ?? [])],
  };
}

export function renderMetaTemplateFromComponents(opts: {
  components: unknown;
  parameters: string[];
}): { body: string; buttons: string[] } {
  return renderMetaTemplateMessage({
    body: extractBodyText(opts.components) ?? "",
    parameters: opts.parameters,
    buttons: extractButtons(opts.components),
  });
}

/** Placeholder legado usado antes da renderização — útil para fallback em mensagens antigas. */
export const LEGACY_META_TEMPLATE_PREFIX = "[Template Meta:";

export function isLegacyMetaTemplatePlaceholder(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith(LEGACY_META_TEMPLATE_PREFIX);
}
