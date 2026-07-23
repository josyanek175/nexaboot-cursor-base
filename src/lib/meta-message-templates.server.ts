// Sincronização e listagem de templates Meta (HSM) por canal.
// Token via loadMetaAccessToken — nunca logar/expor access token.

import { sql, ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { loadMetaAccessToken } from "@/lib/meta-access-token.server";
import {
  extractBodyText,
  extractButtons,
  extractTemplateVariables,
  renderMetaTemplateFromComponents,
  renderMetaTemplateMessage,
} from "@/lib/meta-template-render";

export {
  extractTemplateVariables,
  renderMetaTemplateFromComponents,
  renderMetaTemplateMessage,
} from "@/lib/meta-template-render";

export type MetaMessageTemplateRow = {
  id: string;
  company_id: string;
  channel_id: string;
  meta_template_id: string | null;
  template_name: string;
  language_code: string;
  category: string | null;
  status: string;
  components: unknown;
  active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MetaTemplatePublic = {
  id: string;
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  active: boolean;
  bodyText: string | null;
  buttons: string[];
  variables: string[];
  components: unknown;
  lastSyncedAt: string | null;
};

type GraphTemplate = {
  id?: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  components?: unknown[];
};

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
}

export function toMetaTemplatePublic(row: MetaMessageTemplateRow): MetaTemplatePublic {
  return {
    id: row.id,
    metaTemplateId: row.meta_template_id,
    name: row.template_name,
    language: row.language_code,
    category: row.category,
    status: row.status,
    active: row.active,
    bodyText: extractBodyText(row.components),
    buttons: extractButtons(row.components),
    variables: extractTemplateVariables(row.components),
    components: row.components,
    lastSyncedAt: row.last_synced_at,
  };
}

async function loadMetaChannelForCompany(
  channelId: string,
  companyId: string,
): Promise<{
  id: string;
  waba_id: string | null;
  phone_number_id: string | null;
  status: string;
  active: boolean;
} | null> {
  const rows = await sql<
    {
      id: string;
      waba_id: string | null;
      phone_number_id: string | null;
      status: string;
      active: boolean;
    }[]
  >`
    SELECT id, waba_id, phone_number_id, status, active
    FROM public.whatsapp_channels
    WHERE id = ${channelId}::uuid
      AND company_id = ${companyId}::uuid
      AND lower(channel_type) = 'meta'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function fetchAllGraphTemplates(
  wabaId: string,
  token: string,
): Promise<GraphTemplate[]> {
  const version = graphVersion();
  const fields = "id,name,status,category,language,components";
  let url: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates` +
    `?fields=${encodeURIComponent(fields)}&limit=100`;

  const all: GraphTemplate[] = [];
  while (url) {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = await res.text().catch(() => "");
    let json: { data?: GraphTemplate[]; paging?: { next?: string }; error?: { message?: string } };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new Error(`graph_invalid_json:${res.status}`);
    }
    if (!res.ok) {
      throw new Error(json.error?.message || `graph_http_${res.status}`);
    }
    if (Array.isArray(json.data)) all.push(...json.data);
    url = json.paging?.next?.trim() || null;
  }
  return all;
}

export async function listMetaTemplatesForChannel(
  companyId: string,
  channelId: string,
  opts: { approvedOnly?: boolean } = {},
): Promise<MetaTemplatePublic[]> {
  await ensureCrmSchema();
  await ensureCampaignsSchema();

  const channel = await loadMetaChannelForCompany(channelId, companyId);
  if (!channel) return [];

  const rows = opts.approvedOnly
    ? await sql<MetaMessageTemplateRow[]>`
        SELECT id, company_id, channel_id, meta_template_id, template_name, language_code,
               category, status, components, active, last_synced_at, created_at, updated_at
        FROM public.meta_message_templates
        WHERE company_id = ${companyId}::uuid
          AND channel_id = ${channelId}::uuid
          AND active = true
          AND upper(status) = 'APPROVED'
        ORDER BY template_name ASC, language_code ASC
      `
    : await sql<MetaMessageTemplateRow[]>`
        SELECT id, company_id, channel_id, meta_template_id, template_name, language_code,
               category, status, components, active, last_synced_at, created_at, updated_at
        FROM public.meta_message_templates
        WHERE company_id = ${companyId}::uuid
          AND channel_id = ${channelId}::uuid
        ORDER BY template_name ASC, language_code ASC
      `;

  return rows.map(toMetaTemplatePublic);
}

export async function getMetaTemplateById(
  companyId: string,
  channelId: string,
  templateRowId: string,
): Promise<MetaMessageTemplateRow | null> {
  await ensureCampaignsSchema();
  const rows = await sql<MetaMessageTemplateRow[]>`
    SELECT id, company_id, channel_id, meta_template_id, template_name, language_code,
           category, status, components, active, last_synced_at, created_at, updated_at
    FROM public.meta_message_templates
    WHERE id = ${templateRowId}::uuid
      AND company_id = ${companyId}::uuid
      AND channel_id = ${channelId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export type MetaTemplateSyncResult =
  | { ok: true; synced: number; approved: number; deactivated: number }
  | { ok: false; error: string; status?: number };

export async function syncMetaTemplatesForChannel(
  companyId: string,
  channelId: string,
): Promise<MetaTemplateSyncResult> {
  await ensureCrmSchema();
  await ensureCampaignsSchema();

  console.log("[META_TEMPLATE_SYNC_START]", { companyId, channelId });

  try {
    const channel = await loadMetaChannelForCompany(channelId, companyId);
    if (!channel) {
      console.error("[META_TEMPLATE_SYNC_ERROR]", { channelId, error: "channel_not_found" });
      return { ok: false, error: "channel_not_found", status: 404 };
    }
    if (!channel.active) {
      return { ok: false, error: "channel_inactive", status: 400 };
    }
    const wabaId = channel.waba_id?.trim();
    if (!wabaId) {
      return { ok: false, error: "missing_waba_id", status: 400 };
    }

    const token = await loadMetaAccessToken(channelId, companyId, {
      phoneNumberId: channel.phone_number_id,
      source: "template_sync",
    });
    if (!token) {
      return { ok: false, error: "missing_token", status: 400 };
    }

    const remote = await fetchAllGraphTemplates(wabaId, token);
    const s = sql();
    const seenKeys = new Set<string>();
    let synced = 0;
    let approved = 0;

    for (const t of remote) {
      const name = String(t.name ?? "").trim();
      const language = String(t.language ?? "").trim();
      if (!name || !language) continue;

      const status = String(t.status ?? "PENDING").toUpperCase();
      const active = status === "APPROVED";
      if (active) approved += 1;

      const metaId = t.id ? String(t.id) : null;
      const category = t.category ? String(t.category) : null;
      const components = Array.isArray(t.components) ? t.components : [];
      const key = `${name}::${language}`;
      seenKeys.add(key);

      await s`
        INSERT INTO public.meta_message_templates (
          company_id, channel_id, meta_template_id, template_name, language_code,
          category, status, components, active, last_synced_at, updated_at
        ) VALUES (
          ${companyId}::uuid,
          ${channelId}::uuid,
          ${metaId},
          ${name},
          ${language},
          ${category},
          ${status},
          ${JSON.stringify(components)}::jsonb,
          ${active},
          now(),
          now()
        )
        ON CONFLICT (channel_id, template_name, language_code)
        DO UPDATE SET
          meta_template_id = EXCLUDED.meta_template_id,
          category = EXCLUDED.category,
          status = EXCLUDED.status,
          components = EXCLUDED.components,
          active = EXCLUDED.active,
          last_synced_at = now(),
          updated_at = now()
      `;
      synced += 1;
    }

    // Marca como inativo o que não voltou nesta sync (seguro: só deste canal).
    const existing = await s<{ id: string; template_name: string; language_code: string }[]>`
      SELECT id, template_name, language_code
      FROM public.meta_message_templates
      WHERE company_id = ${companyId}::uuid
        AND channel_id = ${channelId}::uuid
        AND active = true
    `;
    let deactivated = 0;
    for (const row of existing) {
      const key = `${row.template_name}::${row.language_code}`;
      if (seenKeys.has(key)) continue;
      await s`
        UPDATE public.meta_message_templates
        SET active = false, updated_at = now(), last_synced_at = now()
        WHERE id = ${row.id}::uuid
      `;
      deactivated += 1;
    }

    console.log("[META_TEMPLATE_SYNC_SUCCESS]", {
      companyId,
      channelId,
      synced,
      approved,
      deactivated,
    });

    return { ok: true, synced, approved, deactivated };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[META_TEMPLATE_SYNC_ERROR]", { companyId, channelId, error: message });
    return { ok: false, error: message, status: 502 };
  }
}

/** Mapeamento padrão {{n}} → campo do contato. */
export function defaultMetaVariableMappings(
  templateName: string,
  variables: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of variables) {
    map[v] = "name";
  }
  if (
    templateName === "abordagem_inicial_troca_refil" &&
    (variables.includes("1") || variables.length === 0)
  ) {
    map["1"] = "name";
  }
  return map;
}

export function resolveMetaTemplateParam(
  fieldKey: string,
  contact: { name?: string | null; phone?: string | null; variables?: Record<string, unknown> },
): string {
  const key = fieldKey.trim().toLowerCase();
  const vars = contact.variables ?? {};
  if (key === "name" || key === "nome") {
    return String(contact.name ?? vars.nome ?? vars.name ?? "").trim();
  }
  if (key === "phone" || key === "telefone") {
    return String(contact.phone ?? vars.telefone ?? vars.phone ?? "").replace(/\D+/g, "");
  }
  const fromVars = vars[fieldKey] ?? vars[key];
  if (fromVars != null && String(fromVars).trim()) return String(fromVars).trim();
  return "";
}

export type BuildMetaBodyParamsResult =
  | { ok: true; parameters: string[]; orderedKeys: string[] }
  | { ok: false; error: string; emptyKey?: string };

/**
 * Monta parâmetros BODY na ordem {{1}}, {{2}}, {{3}}…
 * Nunca retorna text vazio/null — falha com erro claro.
 */
export function buildMetaTemplateBodyParameters(opts: {
  templateName: string;
  components: unknown;
  mappings: Record<string, string>;
  contact: { name?: string | null; phone?: string | null; variables?: Record<string, unknown> };
}): BuildMetaBodyParamsResult {
  const extracted = extractTemplateVariables(opts.components);
  let orderedKeys = extracted;
  if (orderedKeys.length === 0 && opts.templateName === "abordagem_inicial_troca_refil") {
    orderedKeys = ["1"];
  }

  const parameters: string[] = [];
  for (const key of orderedKeys) {
    let field = opts.mappings[key]?.trim() || "";
    if (!field && opts.templateName === "abordagem_inicial_troca_refil" && key === "1") {
      field = "name";
    }
    if (!field) field = "name";

    let value = resolveMetaTemplateParam(field, opts.contact);
    if (!value && (field === "name" || field === "nome") && key === "1") {
      // Fallback seguro apenas para {{1}}/nome quando o template inicial exige.
      value = "Cliente";
    }
    if (!value) {
      return {
        ok: false,
        error: `empty_template_param_{{${key}}}`,
        emptyKey: key,
      };
    }
    parameters.push(value);
  }

  return { ok: true, parameters, orderedKeys };
}

/** Valida template APPROVED+active do canal/empresa — não confiar no frontend. */
export async function assertApprovedMetaTemplate(opts: {
  companyId: string;
  channelId: string;
  templateName: string;
  languageCode: string;
}): Promise<
  | { ok: true; row: MetaMessageTemplateRow }
  | { ok: false; error: "invalid_meta_template" | "meta_template_not_approved" }
> {
  await ensureCampaignsSchema();
  const name = opts.templateName.trim();
  const language = opts.languageCode.trim();
  if (!name || !language) return { ok: false, error: "invalid_meta_template" };

  const rows = await sql<MetaMessageTemplateRow[]>`
    SELECT id, company_id, channel_id, meta_template_id, template_name, language_code,
           category, status, components, active, last_synced_at, created_at, updated_at
    FROM public.meta_message_templates
    WHERE company_id = ${opts.companyId}::uuid
      AND channel_id = ${opts.channelId}::uuid
      AND template_name = ${name}
      AND language_code = ${language}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, error: "invalid_meta_template" };
  if (!row.active || String(row.status).toUpperCase() !== "APPROVED") {
    return { ok: false, error: "meta_template_not_approved" };
  }
  return { ok: true, row };
}
