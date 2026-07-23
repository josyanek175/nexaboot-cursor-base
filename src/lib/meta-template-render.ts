/** Renderização pura de templates Meta para exibição no atendimento (sem I/O). */

export const LEGACY_META_TEMPLATE_PREFIX = "[Template Meta:";

export type TemplateComponentsDiagnostics = {
  componentsType: string;
  componentsCount: number;
  hasBodyComponent: boolean;
};

/** Normaliza components: array, string JSON, wrapper { components: [...] }. */
export function normalizeTemplateComponents(components: unknown): unknown[] | null {
  let value: unknown = components;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value : null;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.components)) {
      return obj.components.length > 0 ? obj.components : null;
    }
    const type = String(obj.type ?? "").toUpperCase();
    if (type === "BODY" || type === "BUTTONS" || type === "HEADER" || type === "FOOTER") {
      return [obj];
    }
  }

  return null;
}

export function describeTemplateComponents(components: unknown): TemplateComponentsDiagnostics {
  const normalized = normalizeTemplateComponents(components);
  if (!normalized) {
    return {
      componentsType: components == null ? "null" : typeof components,
      componentsCount: 0,
      hasBodyComponent: false,
    };
  }
  let hasBody = false;
  for (const c of normalized) {
    if (!c || typeof c !== "object") continue;
    if (String((c as Record<string, unknown>).type ?? "").toUpperCase() === "BODY") {
      hasBody = true;
      break;
    }
  }
  return {
    componentsType: "array",
    componentsCount: normalized.length,
    hasBodyComponent: hasBody,
  };
}

export function extractBodyText(components: unknown): string | null {
  const list = normalizeTemplateComponents(components);
  if (!list) return null;

  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    if (String(row.type ?? "").toUpperCase() !== "BODY") continue;
    if (typeof row.text === "string" && row.text.trim()) return row.text;
    if (typeof row.body === "string" && row.body.trim()) return row.body;
  }
  return null;
}

export function extractButtons(components: unknown): string[] {
  const list = normalizeTemplateComponents(components);
  if (!list) return [];

  const out: string[] = [];
  for (const c of list) {
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
}): { body: string; buttons: string[]; rendered: boolean; reason?: string } {
  const bodyTemplate = extractBodyText(opts.components);
  if (!bodyTemplate?.trim()) {
    return {
      body: "",
      buttons: extractButtons(opts.components),
      rendered: false,
      reason: "missing_body_component",
    };
  }
  const rendered = renderMetaTemplateMessage({
    body: bodyTemplate,
    parameters: opts.parameters,
    buttons: extractButtons(opts.components),
  });
  return { ...rendered, rendered: !!rendered.body.trim(), reason: undefined };
}

export function buildMetaTemplateOutboundFallback(templateName: string): string {
  const name = templateName.trim() || "template";
  return `Template Meta enviado: ${name}`;
}

/** Garante texto outbound não vazio para persistência. */
export function ensureMetaTemplateOutboundBody(opts: {
  renderedBody: string;
  templateName: string;
}): { body: string; usedFallback: boolean; reason?: string } {
  const trimmed = opts.renderedBody.trim();
  if (trimmed) {
    return { body: opts.renderedBody, usedFallback: false };
  }
  return {
    body: buildMetaTemplateOutboundFallback(opts.templateName),
    usedFallback: true,
    reason: "empty_rendered_body",
  };
}

export function isLegacyMetaTemplatePlaceholder(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith(LEGACY_META_TEMPLATE_PREFIX);
}

export type MetaTemplatePayload = {
  template_name?: string;
  template_language?: string;
  template_components?: unknown;
  body_parameters?: unknown;
  template_buttons?: unknown;
};

/** Parse raw_payload quando vier como string JSON da API. */
export function parseMessageRawPayload(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function normalizeBodyParameters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => String(p ?? ""));
}

/** Resolve texto/botões para exibição no atendimento (mensagens novas e legadas). */
export function resolveMetaTemplateDisplayForMessage(opts: {
  messageText?: string | null;
  metaTemplate?: MetaTemplatePayload | null;
}): { body: string; buttons: string[]; source: "message_text" | "meta_template" | "legacy_placeholder" | "fallback" | "empty" } {
  const messageText = opts.messageText != null ? String(opts.messageText) : "";
  const meta = opts.metaTemplate;
  const params = normalizeBodyParameters(meta?.body_parameters);
  const components = meta?.template_components;
  const templateName = typeof meta?.template_name === "string" ? meta.template_name : "";

  const presetButtons = Array.isArray(meta?.template_buttons)
    ? meta.template_buttons.map((b) => String(b))
    : [];

  const shouldTryRender =
    !!components &&
    (isLegacyMetaTemplatePlaceholder(messageText) || !messageText.trim());

  if (shouldTryRender) {
    const rendered = renderMetaTemplateFromComponents({ components, parameters: params });
    if (rendered.body.trim()) {
      return {
        body: rendered.body,
        buttons: presetButtons.length > 0 ? presetButtons : rendered.buttons,
        source: "meta_template",
      };
    }
  }

  if (messageText.trim() && !isLegacyMetaTemplatePlaceholder(messageText)) {
    return {
      body: messageText,
      buttons: presetButtons,
      source: "message_text",
    };
  }

  if (isLegacyMetaTemplatePlaceholder(messageText)) {
    return {
      body: messageText,
      buttons: presetButtons,
      source: "legacy_placeholder",
    };
  }

  if (templateName) {
    return {
      body: buildMetaTemplateOutboundFallback(templateName),
      buttons: presetButtons,
      source: "fallback",
    };
  }

  return { body: "", buttons: presetButtons, source: "empty" };
}

export function previewText(text: string, maxLen = 100): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}…`;
}
