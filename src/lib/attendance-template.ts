/**
 * Overlay de templates WhatsApp para atendimento (UX).
 * Fonte Meta oficial: meta_message_templates (via FK).
 */

export type AttendanceTemplateVarType = "text" | "textarea";

export type AttendanceTemplateVarSource =
  | "manual"
  | "customer_name"
  | "customer_phone"
  | "company_name"
  | "attendant_name";

export type AttendanceTemplateVariable = {
  position: number;
  label: string;
  type: AttendanceTemplateVarType;
  source: AttendanceTemplateVarSource;
  required: boolean;
};

export function normalizeAttendanceVariables(raw: unknown): AttendanceTemplateVariable[] {
  if (!Array.isArray(raw)) return [];
  const out: AttendanceTemplateVariable[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const position = Math.floor(Number(o.position));
    if (!Number.isFinite(position) || position < 1) continue;
    const label = String(o.label ?? "").trim() || `Variável ${position}`;
    const typeRaw = String(o.type ?? "text").toLowerCase();
    const type: AttendanceTemplateVarType = typeRaw === "textarea" ? "textarea" : "text";
    const sourceRaw = String(o.source ?? "manual").toLowerCase();
    const allowed: AttendanceTemplateVarSource[] = [
      "manual",
      "customer_name",
      "customer_phone",
      "company_name",
      "attendant_name",
    ];
    const source = (allowed.includes(sourceRaw as AttendanceTemplateVarSource)
      ? sourceRaw
      : "manual") as AttendanceTemplateVarSource;
    const required = o.required !== false && o.required !== "false";
    out.push({ position, label, type, source, required });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

/** Prévia independente — não altera o template original. */
export function previewAttendanceTemplateBody(
  bodyTemplate: string,
  valuesByPosition: Record<number, string> | string[],
): string {
  const body = String(bodyTemplate ?? "");
  return body.replace(/\{\{(\d+)\}\}/g, (_m, idx: string) => {
    const pos = Number(idx);
    if (!Number.isFinite(pos)) return "";
    if (Array.isArray(valuesByPosition)) {
      return String(valuesByPosition[pos - 1] ?? "");
    }
    return String(valuesByPosition[pos] ?? "");
  });
}

export function buildOrderedTemplateParameters(
  variables: AttendanceTemplateVariable[],
  valuesByPosition: Record<number, string>,
): { ok: true; parameters: string[] } | { ok: false; error: string; missingPosition?: number } {
  const sorted = [...variables].sort((a, b) => a.position - b.position);
  const parameters: string[] = [];
  for (const v of sorted) {
    const raw = valuesByPosition[v.position];
    const value = String(raw ?? "").trim();
    if (v.required && !value) {
      return {
        ok: false,
        error: "required_variable_empty",
        missingPosition: v.position,
      };
    }
    parameters.push(value);
  }
  return { ok: true, parameters };
}

export function resolveAttendanceVariableDefaults(opts: {
  variables: AttendanceTemplateVariable[];
  contactName?: string | null;
  contactPhone?: string | null;
  companyName?: string | null;
  attendantName?: string | null;
}): Record<number, string> {
  const out: Record<number, string> = {};
  for (const v of opts.variables) {
    if (v.source === "customer_name") {
      out[v.position] = String(opts.contactName ?? "").trim();
    } else if (v.source === "customer_phone") {
      out[v.position] = String(opts.contactPhone ?? "").trim();
    } else if (v.source === "company_name") {
      out[v.position] = String(opts.companyName ?? "").trim();
    } else if (v.source === "attendant_name") {
      out[v.position] = String(opts.attendantName ?? "").trim();
    } else {
      out[v.position] = "";
    }
  }
  return out;
}

/** Regras de segurança/isolamento — testáveis sem DB. */
export function evaluateAttendanceTemplateSendGuards(opts: {
  authCompanyId: string;
  conversationCompanyId: string;
  presetCompanyId: string;
  metaCompanyId: string;
  channelType: string | null | undefined;
  conversationChannelId: string | null | undefined;
  metaChannelId: string | null | undefined;
  presetActive: boolean;
  metaActive: boolean;
  metaStatus: string | null | undefined;
}): { ok: true } | { ok: false; error: string } {
  if (opts.conversationCompanyId !== opts.authCompanyId) {
    return { ok: false, error: "conversation_wrong_company" };
  }
  if (opts.presetCompanyId !== opts.authCompanyId || opts.metaCompanyId !== opts.authCompanyId) {
    return { ok: false, error: "forbidden_company" };
  }
  if (String(opts.channelType ?? "").toLowerCase() !== "meta") {
    return { ok: false, error: "channel_not_meta" };
  }
  if (!opts.presetActive) return { ok: false, error: "template_inactive" };
  if (!opts.metaActive || String(opts.metaStatus ?? "").toUpperCase() !== "APPROVED") {
    return { ok: false, error: "meta_template_not_approved" };
  }
  if (
    !opts.conversationChannelId ||
    !opts.metaChannelId ||
    opts.conversationChannelId !== opts.metaChannelId
  ) {
    return { ok: false, error: "template_channel_mismatch" };
  }
  return { ok: true };
}

/** Simula merge de payload no UPSERT (dedupe echo vs CRM). */
export function mergeAttendanceTemplateRawPayload(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return { ...incoming };
  if (existing.origin === "attendance_template") return { ...existing };
  if (incoming.origin === "attendance_template") {
    return { ...existing, ...incoming };
  }
  return { ...existing, ...incoming };
}
