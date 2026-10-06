/**
 * Presets de template WhatsApp no atendimento + envio Meta com UPSERT.
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import { sendMetaTemplateMessage } from "@/lib/meta-send-message.server";
import { extractBodyText, renderMetaTemplateFromComponents } from "@/lib/meta-template-render";
import { syncMetaTemplatesForChannel } from "@/lib/meta-message-templates.server";
import { bumpConversationAfterOutboundMessage } from "@/lib/crm-outbound.server";
import { tryApplyHumanReplyFromMessage } from "@/lib/campaign-service-status.server";
import { normalizePhoneE164, isValidE164Digits } from "@/lib/phone";
import {
  buildOrderedTemplateParameters,
  evaluateAttendanceTemplateSendGuards,
  inferVariablesFromBodyTemplate,
  normalizeAttendanceVariables,
  previewAttendanceTemplateBody,
  resolveAttendanceVariableDefaults,
  shouldRefreshMetaTemplates,
  type AttendanceTemplateVariable,
} from "@/lib/attendance-template";

export type AttendanceWhatsappTemplateRow = {
  id: string;
  company_id: string;
  meta_template_id: string;
  name: string;
  description: string | null;
  variables: AttendanceTemplateVariable[];
  active: boolean;
  created_at: string;
  updated_at: string;
  // joined from meta
  meta_template_name?: string;
  language_code?: string;
  category?: string | null;
  status?: string;
  body_text?: string | null;
  channel_id?: string;
};

/** Item do modal: Meta APPROVED + overlay opcional. */
export type AttendanceChatTemplateOption = {
  /** Sempre o id de meta_message_templates (chave de envio). */
  id: string;
  metaTemplateId: string;
  attendanceTemplateId: string | null;
  hasOverlay: boolean;
  name: string;
  description: string | null;
  variables: AttendanceTemplateVariable[];
  body_text: string | null;
  meta_template_name: string;
  language_code: string;
  category: string | null;
};

let _schemaReady: Promise<void> | null = null;

export async function ensureAttendanceWhatsappTemplatesSchema(
  db?: PgSql,
): Promise<void> {
  if (_schemaReady) return _schemaReady;
  const s = db ?? sql();
  _schemaReady = (async () => {
    try {
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS public.attendance_whatsapp_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
          meta_template_id UUID NOT NULL REFERENCES public.meta_message_templates(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          variables JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS attendance_whatsapp_templates_company_meta_uniq
          ON public.attendance_whatsapp_templates (company_id, meta_template_id);

        CREATE INDEX IF NOT EXISTS idx_attendance_whatsapp_templates_company_active
          ON public.attendance_whatsapp_templates (company_id, active, updated_at DESC);
      `);
    } catch (e) {
      _schemaReady = null;
      const msg = String((e as Error)?.message ?? e);
      if (/already exists/i.test(msg) || /duplicate key/i.test(msg)) return;
      throw e;
    }
  })();
  return _schemaReady;
}

function mapRow(r: Record<string, unknown>): AttendanceWhatsappTemplateRow {
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    meta_template_id: String(r.meta_template_id),
    name: String(r.name),
    description: r.description != null ? String(r.description) : null,
    variables: normalizeAttendanceVariables(r.variables),
    active: !!r.active,
    created_at: new Date(r.created_at as string | Date).toISOString(),
    updated_at: new Date(r.updated_at as string | Date).toISOString(),
    meta_template_name: r.meta_template_name != null ? String(r.meta_template_name) : undefined,
    language_code: r.language_code != null ? String(r.language_code) : undefined,
    category: r.category != null ? String(r.category) : null,
    status: r.status != null ? String(r.status) : undefined,
    body_text: r.body_text != null ? String(r.body_text) : r.body_text === null ? null : undefined,
    channel_id: r.channel_id != null ? String(r.channel_id) : undefined,
  };
}

async function loadChannelTemplateSyncState(
  companyId: string,
  channelId: string,
): Promise<{ localCount: number; lastSyncedAt: Date | null }> {
  const s = sql();
  const rows = await s<{ cnt: number; last_synced: Date | string | null }[]>`
    SELECT
      COUNT(*)::int AS cnt,
      MAX(last_synced_at) AS last_synced
    FROM public.meta_message_templates
    WHERE company_id = ${companyId}::uuid
      AND channel_id = ${channelId}::uuid
  `;
  const last = rows[0]?.last_synced;
  return {
    localCount: Number(rows[0]?.cnt ?? 0) || 0,
    lastSyncedAt: last ? new Date(last) : null,
  };
}

async function loadApprovedChatTemplatesForChannel(opts: {
  companyId: string;
  channelId: string;
}): Promise<AttendanceChatTemplateOption[]> {
  await ensureAttendanceWhatsappTemplatesSchema();
  const s = sql();
  const rows = await s<
    {
      meta_id: string;
      template_name: string;
      language_code: string;
      category: string | null;
      components: unknown;
      overlay_id: string | null;
      overlay_name: string | null;
      overlay_description: string | null;
      overlay_variables: unknown;
      overlay_active: boolean | null;
    }[]
  >`
    SELECT
      m.id AS meta_id,
      m.template_name,
      m.language_code,
      m.category,
      m.components,
      a.id AS overlay_id,
      a.name AS overlay_name,
      a.description AS overlay_description,
      a.variables AS overlay_variables,
      a.active AS overlay_active
    FROM public.meta_message_templates m
    LEFT JOIN public.attendance_whatsapp_templates a
      ON a.meta_template_id = m.id
     AND a.company_id = m.company_id
     AND a.active = true
    WHERE m.company_id = ${opts.companyId}::uuid
      AND m.channel_id = ${opts.channelId}::uuid
      AND m.active = true
      AND upper(m.status) = 'APPROVED'
    ORDER BY COALESCE(a.name, m.template_name) ASC
  `;

  return rows.map((r) => {
    const body = extractBodyText(r.components);
    const hasOverlay = !!r.overlay_id && r.overlay_active !== false;
    const variables = hasOverlay
      ? normalizeAttendanceVariables(r.overlay_variables)
      : inferVariablesFromBodyTemplate(body);
    return {
      id: r.meta_id,
      metaTemplateId: r.meta_id,
      attendanceTemplateId: hasOverlay ? String(r.overlay_id) : null,
      hasOverlay,
      name: hasOverlay
        ? String(r.overlay_name ?? r.template_name)
        : String(r.template_name),
      description: hasOverlay
        ? r.overlay_description != null
          ? String(r.overlay_description)
          : null
        : null,
      variables,
      body_text: body,
      meta_template_name: r.template_name,
      language_code: r.language_code,
      category: r.category,
    };
  });
}

/**
 * Lista templates APPROVED do canal (overlay opcional) + auto-sync Meta com freshness.
 */
export async function listAttendanceTemplatesForConversation(opts: {
  companyId: string;
  conversationId: string;
  forceSync?: boolean;
}): Promise<
  | {
      ok: true;
      channelType: string;
      channelId: string;
      templates: AttendanceChatTemplateOption[];
      contactName: string | null;
      synced: boolean;
      syncError: string | null;
    }
  | { ok: false; error: string; status: number; message?: string }
> {
  await ensureAttendanceWhatsappTemplatesSchema();
  const s = sql();

  const conv = await s<
    {
      id: string;
      company_id: string;
      channel_id: string | null;
      channel_type: string | null;
      contact_name: string | null;
    }[]
  >`
    SELECT
      c.id,
      c.company_id,
      c.whatsapp_channel_id AS channel_id,
      lower(ch.channel_type) AS channel_type,
      ct.name AS contact_name
    FROM public.conversations c
    LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    LEFT JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = ${opts.conversationId}::uuid
      AND c.company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  const row = conv[0];
  if (!row) return { ok: false, error: "conversation_not_found", status: 404 };
  if (!row.channel_id || row.channel_type !== "meta") {
    return {
      ok: false,
      error: "channel_not_meta",
      status: 400,
      message: "Envio de template disponível apenas em conversas Meta.",
    };
  }

  const state = await loadChannelTemplateSyncState(opts.companyId, row.channel_id);
  let synced = false;
  let syncError: string | null = null;

  if (
    shouldRefreshMetaTemplates({
      force: opts.forceSync,
      localCount: state.localCount,
      lastSyncedAt: state.lastSyncedAt,
    })
  ) {
    const sync = await syncMetaTemplatesForChannel(opts.companyId, row.channel_id);
    if (sync.ok) {
      synced = true;
    } else {
      syncError = sync.error;
    }
  }

  const templates = await loadApprovedChatTemplatesForChannel({
    companyId: opts.companyId,
    channelId: row.channel_id,
  });

  if (templates.length === 0 && syncError) {
    return {
      ok: false,
      error: "sync_failed",
      status: 502,
      message: "Não foi possível atualizar os templates da Meta.",
    };
  }

  return {
    ok: true,
    channelType: "meta",
    channelId: row.channel_id,
    templates,
    contactName: row.contact_name,
    synced,
    syncError,
  };
}

export async function listAttendanceTemplatesAdmin(
  companyId: string,
): Promise<AttendanceWhatsappTemplateRow[]> {
  await ensureAttendanceWhatsappTemplatesSchema();
  const s = sql();
  const rows = await s<Record<string, unknown>[]>`
    SELECT
      a.id, a.company_id, a.meta_template_id, a.name, a.description,
      a.variables, a.active, a.created_at, a.updated_at,
      m.template_name AS meta_template_name,
      m.language_code,
      m.category,
      m.status,
      m.channel_id,
      m.components
    FROM public.attendance_whatsapp_templates a
    INNER JOIN public.meta_message_templates m
      ON m.id = a.meta_template_id
     AND m.company_id = a.company_id
    WHERE a.company_id = ${companyId}::uuid
    ORDER BY a.updated_at DESC
  `;
  return rows.map((t) => {
    const base = mapRow(t);
    base.body_text = extractBodyText(t.components);
    return base;
  });
}

/** Templates Meta APPROVED da empresa (para vincular preset). */
export async function listApprovedMetaTemplatesForCompany(
  companyId: string,
): Promise<
  {
    id: string;
    template_name: string;
    language_code: string;
    category: string | null;
    channel_id: string;
    channel_name: string | null;
    body_text: string | null;
  }[]
> {
  const s = sql();
  const rows = await s<
    {
      id: string;
      template_name: string;
      language_code: string;
      category: string | null;
      channel_id: string;
      channel_name: string | null;
      components: unknown;
    }[]
  >`
    SELECT
      m.id, m.template_name, m.language_code, m.category, m.channel_id,
      ch.name AS channel_name, m.components
    FROM public.meta_message_templates m
    LEFT JOIN public.whatsapp_channels ch ON ch.id = m.channel_id
    WHERE m.company_id = ${companyId}::uuid
      AND m.active = true
      AND upper(m.status) = 'APPROVED'
    ORDER BY m.template_name ASC, m.language_code ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    template_name: r.template_name,
    language_code: r.language_code,
    category: r.category,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    body_text: extractBodyText(r.components),
  }));
}

export async function upsertAttendanceTemplate(opts: {
  companyId: string;
  metaTemplateId: string;
  name: string;
  description?: string | null;
  variables?: unknown;
  active?: boolean;
  id?: string | null;
}): Promise<
  | { ok: true; template: AttendanceWhatsappTemplateRow }
  | { ok: false; error: string; status: number }
> {
  await ensureAttendanceWhatsappTemplatesSchema();
  const s = sql();
  const name = opts.name.trim();
  if (!name) return { ok: false, error: "invalid_name", status: 400 };
  const variables = normalizeAttendanceVariables(opts.variables ?? []);

  const meta = await s<
    { id: string; company_id: string; template_name: string; language_code: string; components: unknown }[]
  >`
    SELECT id, company_id, template_name, language_code, components
    FROM public.meta_message_templates
    WHERE id = ${opts.metaTemplateId}::uuid
      AND company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  if (!meta[0]) return { ok: false, error: "meta_template_not_found", status: 404 };

  // Se variables vazio, gerar placeholders a partir do body Meta.
  let vars = variables;
  if (vars.length === 0) {
    const body = extractBodyText(meta[0].components) ?? "";
    const positions = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(positions)].sort((a, b) => a - b);
    vars = uniq.map((position) => ({
      position,
      label: position === 1 ? "Nome do cliente" : `Variável ${position}`,
      type: "text" as const,
      source: position === 1 ? ("customer_name" as const) : ("manual" as const),
      required: true,
    }));
  }

  if (opts.id) {
    const updated = await s<Record<string, unknown>[]>`
      UPDATE public.attendance_whatsapp_templates
      SET name = ${name},
          description = ${opts.description?.trim() || null},
          variables = ${JSON.stringify(vars)}::jsonb,
          active = ${opts.active !== false},
          meta_template_id = ${opts.metaTemplateId}::uuid,
          updated_at = now()
      WHERE id = ${opts.id}::uuid
        AND company_id = ${opts.companyId}::uuid
      RETURNING id, company_id, meta_template_id, name, description, variables, active, created_at, updated_at
    `;
    if (!updated[0]) return { ok: false, error: "not_found", status: 404 };
    const row = mapRow(updated[0]);
    row.meta_template_name = meta[0].template_name;
    row.language_code = meta[0].language_code;
    row.body_text = extractBodyText(meta[0].components);
    return { ok: true, template: row };
  }

  try {
    const inserted = await s<Record<string, unknown>[]>`
      INSERT INTO public.attendance_whatsapp_templates
        (company_id, meta_template_id, name, description, variables, active)
      VALUES (
        ${opts.companyId}::uuid,
        ${opts.metaTemplateId}::uuid,
        ${name},
        ${opts.description?.trim() || null},
        ${JSON.stringify(vars)}::jsonb,
        ${opts.active !== false}
      )
      ON CONFLICT (company_id, meta_template_id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        variables = EXCLUDED.variables,
        active = EXCLUDED.active,
        updated_at = now()
      RETURNING id, company_id, meta_template_id, name, description, variables, active, created_at, updated_at
    `;
    const row = mapRow(inserted[0]);
    row.meta_template_name = meta[0].template_name;
    row.language_code = meta[0].language_code;
    row.body_text = extractBodyText(meta[0].components);
    return { ok: true, template: row };
  } catch (e) {
    console.error("[ATTENDANCE_TEMPLATE_UPSERT_FAIL]", e);
    return { ok: false, error: "save_failed", status: 500 };
  }
}

/**
 * UPSERT outbound com dedupe por wamid.
 * Complementa sent_by / raw_payload do template sem apagar dados melhores.
 */
export async function upsertAttendanceTemplateOutboundMessage(opts: {
  conversationId: string;
  wamid: string;
  messageText: string;
  rawPayload: Record<string, unknown>;
  sentByUserId: string | null;
  sentByName: string | null;
  messageSource?: string | null;
}): Promise<Record<string, unknown> | null> {
  const s = sql();
  const wamid = opts.wamid.trim();
  if (!wamid) return null;

  const rows = await s<Record<string, unknown>[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status,
      sent_by_user_id, sent_by_name, message_source
    ) VALUES (
      ${opts.conversationId}::uuid,
      ${wamid},
      ${wamid},
      'out',
      'text',
      ${opts.messageText},
      true,
      ${JSON.stringify(opts.rawPayload)}::jsonb,
      'sent',
      ${opts.sentByUserId}::uuid,
      ${opts.sentByName},
      ${opts.messageSource ?? null}
    )
    ON CONFLICT (conversation_id, external_message_id)
      WHERE external_message_id IS NOT NULL
    DO UPDATE SET
      sent_by_user_id = COALESCE(public.messages.sent_by_user_id, EXCLUDED.sent_by_user_id),
      sent_by_name = COALESCE(public.messages.sent_by_name, EXCLUDED.sent_by_name),
      message_source = COALESCE(NULLIF(public.messages.message_source, ''), EXCLUDED.message_source),
      message_text = CASE
        WHEN EXCLUDED.message_text IS NOT NULL AND btrim(EXCLUDED.message_text) <> ''
          AND (
            public.messages.message_text IS NULL
            OR btrim(public.messages.message_text) = ''
            OR (EXCLUDED.raw_payload->>'origin') = 'attendance_template'
          )
        THEN EXCLUDED.message_text
        ELSE public.messages.message_text
      END,
      raw_payload = CASE
        WHEN public.messages.raw_payload IS NULL THEN EXCLUDED.raw_payload
        WHEN EXCLUDED.raw_payload IS NULL THEN public.messages.raw_payload
        WHEN (public.messages.raw_payload->>'origin') = 'attendance_template'
          THEN public.messages.raw_payload
        WHEN (EXCLUDED.raw_payload->>'origin') = 'attendance_template'
          THEN COALESCE(public.messages.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload
        ELSE COALESCE(public.messages.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload
      END,
      from_me = true,
      direction = 'out',
      status = CASE
        WHEN public.messages.status IN ('sent', 'delivered', 'read') THEN public.messages.status
        ELSE COALESCE(EXCLUDED.status, public.messages.status)
      END
    RETURNING id, conversation_id, direction, message_type, message_text, from_me,
              status, created_at, sent_by_user_id, sent_by_name, external_message_id,
              message_source, raw_payload
  `;

  return rows[0] ?? null;
}

export async function sendAttendanceWhatsappTemplate(opts: {
  companyId: string;
  conversationId: string;
  /** Id em meta_message_templates (obrigatório). */
  metaTemplateId: string;
  /** Overlay opcional — se informado, deve apontar para o mesmo metaTemplateId. */
  attendanceTemplateId?: string | null;
  /** Valores por posição: { "1": "Maria", "2": "..." } */
  variableValues: Record<string, string>;
  sentByUserId: string | null;
  sentByName: string | null;
}): Promise<
  | { ok: true; message: Record<string, unknown>; wamid: string | null }
  | { ok: false; error: string; status: number; message?: string }
> {
  await ensureAttendanceWhatsappTemplatesSchema();
  const s = sql();

  const conv = await s<
    {
      id: string;
      company_id: string;
      channel_id: string | null;
      channel_type: string | null;
      contact_phone: string | null;
      contact_name: string | null;
    }[]
  >`
    SELECT
      c.id,
      c.company_id,
      c.whatsapp_channel_id AS channel_id,
      lower(ch.channel_type) AS channel_type,
      ct.phone AS contact_phone,
      ct.name AS contact_name
    FROM public.conversations c
    LEFT JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    LEFT JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = ${opts.conversationId}::uuid
      AND c.company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  const conversation = conv[0];
  if (!conversation) {
    return { ok: false, error: "conversation_not_found", status: 404, message: "Conversa não encontrada." };
  }
  if (!conversation.channel_id || conversation.channel_type !== "meta") {
    return {
      ok: false,
      error: "channel_not_meta",
      status: 400,
      message: "Envio de template disponível apenas em conversas Meta.",
    };
  }

  const metaRows = await s<
    {
      id: string;
      company_id: string;
      channel_id: string;
      template_name: string;
      language_code: string;
      status: string;
      active: boolean;
      components: unknown;
    }[]
  >`
    SELECT id, company_id, channel_id, template_name, language_code, status, active, components
    FROM public.meta_message_templates
    WHERE id = ${opts.metaTemplateId}::uuid
      AND company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  const meta = metaRows[0];
  if (!meta) {
    return { ok: false, error: "template_not_found", status: 404, message: "Template não encontrado." };
  }

  let overlay: {
    id: string;
    name: string;
    variables: unknown;
    active: boolean;
    meta_template_id: string;
  } | null = null;

  if (opts.attendanceTemplateId) {
    const overlayRows = await s<
      {
        id: string;
        name: string;
        variables: unknown;
        active: boolean;
        meta_template_id: string;
        company_id: string;
      }[]
    >`
      SELECT id, name, variables, active, meta_template_id, company_id
      FROM public.attendance_whatsapp_templates
      WHERE id = ${opts.attendanceTemplateId}::uuid
        AND company_id = ${opts.companyId}::uuid
      LIMIT 1
    `;
    overlay = overlayRows[0] ?? null;
    if (!overlay || overlay.meta_template_id !== meta.id) {
      return {
        ok: false,
        error: "overlay_mismatch",
        status: 400,
        message: "Preset de atendimento não corresponde ao template Meta.",
      };
    }
  } else {
    const overlayRows = await s<
      {
        id: string;
        name: string;
        variables: unknown;
        active: boolean;
        meta_template_id: string;
      }[]
    >`
      SELECT id, name, variables, active, meta_template_id
      FROM public.attendance_whatsapp_templates
      WHERE company_id = ${opts.companyId}::uuid
        AND meta_template_id = ${meta.id}::uuid
        AND active = true
      LIMIT 1
    `;
    overlay = overlayRows[0] ?? null;
  }

  const guard = evaluateAttendanceTemplateSendGuards({
    authCompanyId: opts.companyId,
    conversationCompanyId: conversation.company_id,
    presetCompanyId: opts.companyId,
    metaCompanyId: meta.company_id,
    channelType: conversation.channel_type,
    conversationChannelId: conversation.channel_id,
    metaChannelId: meta.channel_id,
    presetActive: overlay ? overlay.active : true,
    metaActive: meta.active,
    metaStatus: meta.status,
  });
  if (!guard.ok) {
    const messages: Record<string, string> = {
      conversation_wrong_company: "Conversa de outra empresa.",
      forbidden_company: "Template de outra empresa.",
      channel_not_meta: "Envio de template disponível apenas em conversas Meta.",
      template_inactive: "Template inativo.",
      meta_template_not_approved: "Template Meta não está aprovado.",
      template_channel_mismatch:
        "Este template não pertence ao canal WhatsApp desta conversa.",
    };
    const status =
      guard.error === "forbidden_company" || guard.error === "conversation_wrong_company"
        ? 403
        : 400;
    return {
      ok: false,
      error: guard.error,
      status,
      message: messages[guard.error] ?? guard.error,
    };
  }

  const bodyTemplate = extractBodyText(meta.components) ?? "";
  const variables = overlay
    ? normalizeAttendanceVariables(overlay.variables)
    : inferVariablesFromBodyTemplate(bodyTemplate);

  const valuesByPosition: Record<number, string> = {};
  for (const [k, v] of Object.entries(opts.variableValues ?? {})) {
    const pos = Number(k);
    if (Number.isFinite(pos)) valuesByPosition[pos] = String(v ?? "");
  }

  const built = buildOrderedTemplateParameters(variables, valuesByPosition);
  if (!built.ok) {
    return {
      ok: false,
      error: built.error,
      status: 400,
      message:
        built.missingPosition != null
          ? `Preencha o campo obrigatório (variável ${built.missingPosition}).`
          : "Parâmetros inválidos.",
    };
  }

  const phone = normalizePhoneE164(conversation.contact_phone, { defaultCountry: "BR" });
  if (!phone || !isValidE164Digits(phone)) {
    return {
      ok: false,
      error: "invalid_recipient_phone",
      status: 400,
      message: "Telefone do contato inválido.",
    };
  }

  const send = await sendMetaTemplateMessage({
    companyId: opts.companyId,
    channelId: conversation.channel_id,
    toPhone: phone,
    templateName: meta.template_name,
    languageCode: meta.language_code,
    bodyParameters: built.parameters,
  });

  if (!send.ok) {
    return {
      ok: false,
      error: send.error,
      status: 502,
      message: send.errorMessage || "Falha ao enviar template pela Meta.",
    };
  }

  const rendered = renderMetaTemplateFromComponents({
    components: meta.components,
    parameters: built.parameters,
  });
  const friendlyName = overlay?.name ?? meta.template_name;
  const messageText =
    rendered.body?.trim() ||
    previewAttendanceTemplateBody(bodyTemplate, built.parameters) ||
    `[Template] ${friendlyName}`;

  const wamid = send.wamid?.trim() || null;
  const rawPayload = {
    origin: "attendance_template",
    attendance_template_id: overlay?.id ?? null,
    meta_template_row_id: meta.id,
    meta_template_name: meta.template_name,
    meta_language_code: meta.language_code,
    template_parameters: built.parameters,
    sent_by_user_id: opts.sentByUserId,
    friendly_name: friendlyName,
  };

  let message: Record<string, unknown> | null = null;
  if (wamid) {
    message = await upsertAttendanceTemplateOutboundMessage({
      conversationId: opts.conversationId,
      wamid,
      messageText,
      rawPayload,
      sentByUserId: opts.sentByUserId,
      sentByName: opts.sentByName,
      messageSource: "crm_template",
    });
  } else {
    // Sem wamid: inserir sem external id (raro).
    const inserted = await s<Record<string, unknown>[]>`
      INSERT INTO public.messages (
        conversation_id, direction, message_type, message_text, from_me,
        raw_payload, status, sent_by_user_id, sent_by_name, message_source
      ) VALUES (
        ${opts.conversationId}::uuid, 'out', 'text', ${messageText}, true,
        ${JSON.stringify(rawPayload)}::jsonb, 'sent',
        ${opts.sentByUserId}::uuid, ${opts.sentByName}, 'crm_template'
      )
      RETURNING id, conversation_id, direction, message_type, message_text, from_me,
                status, created_at, sent_by_user_id, sent_by_name, external_message_id
    `;
    message = inserted[0] ?? null;
  }

  if (!message) {
    return {
      ok: false,
      error: "persist_failed",
      status: 500,
      message: "Template enviado, mas falhou ao gravar no histórico.",
    };
  }

  await bumpConversationAfterOutboundMessage({
    conversationId: opts.conversationId,
    lastMessageText: messageText,
  });

  try {
    await tryApplyHumanReplyFromMessage({
      companyId: opts.companyId,
      conversationId: opts.conversationId,
      messageId: String(message.id),
    });
  } catch (e) {
    console.error("[ATTENDANCE_TEMPLATE_CAMPAIGN_HOOK_FAIL]", e);
  }

  return {
    ok: true,
    wamid,
    message: {
      id: message.id,
      conversation_id: message.conversation_id,
      direction: message.direction,
      message_type: message.message_type,
      body: message.message_text,
      message_text: message.message_text,
      from_me: message.from_me,
      status: message.status,
      created_at: message.created_at,
      sent_by_user_id: message.sent_by_user_id,
      sent_by_name: message.sent_by_name,
      external_message_id: message.external_message_id ?? wamid,
    },
  };
}

export { resolveAttendanceVariableDefaults, previewAttendanceTemplateBody };
