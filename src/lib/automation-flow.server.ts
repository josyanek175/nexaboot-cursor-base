import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { sendConversationText } from "@/lib/message-send-router.server";
import { sendMetaTemplateMessage } from "@/lib/meta-send-message.server";
import { toMetaTemplatePublic } from "@/lib/meta-message-templates.server";
import { upsertInboundConversation } from "@/lib/crm-inbound.server";
import {
  emptyDefinition,
  matchChoice,
  promptForStep,
  replyMatches,
  stepById,
  validateDefinition,
  type FlowDefinition,
  type FlowKind,
  type FlowStatus,
  type FlowVars,
} from "@/lib/automation-flow";

function db() {
  return sql() as {
    <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  };
}

const ADMIN_ROLES = new Set(["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"]);
const REMINDER_ROLES = new Set([
  ...ADMIN_ROLES,
  "GERENTE",
  "SUPERVISOR",
  "ATENDENTE",
  "ATENDENTE_GERAL",
]);

type Actor = { companyId: string; userId: string; role: string };

let schemaReady: Promise<void> | null = null;

export function ensureAutomationSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db()`
        CREATE TABLE IF NOT EXISTS public.automation_flows (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id uuid NOT NULL,
          name text NOT NULL,
          kind text NOT NULL CHECK (kind IN ('attendance', 'sales')),
          status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
          definition jsonb NOT NULL DEFAULT '{"entryStepId":null,"steps":[]}'::jsonb,
          dispatch_channel_id uuid,
          meta_template_name text,
          meta_template_language text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await db()`
        CREATE TABLE IF NOT EXISTS public.automation_flow_channels (
          flow_id uuid NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
          channel_id uuid NOT NULL,
          company_id uuid NOT NULL,
          PRIMARY KEY (flow_id, channel_id)
        )
      `;
      await db()`
        CREATE UNIQUE INDEX IF NOT EXISTS automation_flow_channels_one_per_number
          ON public.automation_flow_channels (channel_id)
      `;
      await db()`
        CREATE TABLE IF NOT EXISTS public.automation_sessions (
          conversation_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          flow_id uuid NOT NULL,
          contact_id uuid NOT NULL,
          channel_id uuid NOT NULL,
          step_id text,
          status text NOT NULL DEFAULT 'waiting',
          collected jsonb NOT NULL DEFAULT '{}'::jsonb,
          source text NOT NULL DEFAULT 'inbound',
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await db()`
        CREATE TABLE IF NOT EXISTS public.automation_reminders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id uuid NOT NULL,
          flow_id uuid NOT NULL,
          contact_id uuid NOT NULL,
          channel_id uuid NOT NULL,
          conversation_id uuid,
          label text NOT NULL,
          days integer NOT NULL,
          due_at timestamptz NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
    })().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function requireAutomationActor(mode: "manage" | "reminders"): Promise<Actor | Response> {
  const userId = getSessionUserId();
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const company = await requireCompanyId(userId);
  if (company instanceof Response) return company;
  const users = await db()<{ role: string }[]>`
    SELECT role FROM public.users WHERE id = ${userId}::uuid LIMIT 1
  `;
  const role = String(users[0]?.role ?? "");
  const allowed = mode === "manage" ? ADMIN_ROLES : REMINDER_ROLES;
  if (!allowed.has(role)) return Response.json({ error: "forbidden" }, { status: 403 });
  return { companyId: company, userId, role };
}

type FlowRow = {
  id: string;
  name: string;
  kind: FlowKind;
  status: FlowStatus;
  definition: FlowDefinition;
  dispatch_channel_id: string | null;
  meta_template_name: string | null;
  meta_template_language: string | null;
  channel_ids: string[];
};

function asDefinition(value: unknown): FlowDefinition {
  const parsed = validateDefinition(value);
  return parsed.ok ? parsed.definition : emptyDefinition();
}

export async function listAutomationFlows(companyId: string): Promise<FlowRow[]> {
  await ensureAutomationSchema();
  const rows = await db()<{
    id: string;
    name: string;
    kind: FlowKind;
    status: FlowStatus;
    definition: unknown;
    dispatch_channel_id: string | null;
    meta_template_name: string | null;
    meta_template_language: string | null;
    channel_ids: string[] | null;
  }[]>`
    SELECT f.id, f.name, f.kind, f.status, f.definition, f.dispatch_channel_id,
           f.meta_template_name, f.meta_template_language,
           COALESCE(array_agg(c.channel_id) FILTER (WHERE c.channel_id IS NOT NULL), '{}') AS channel_ids
    FROM public.automation_flows f
    LEFT JOIN public.automation_flow_channels c ON c.flow_id = f.id
    WHERE f.company_id = ${companyId}::uuid
    GROUP BY f.id
    ORDER BY f.updated_at DESC
  `;
  return rows.map((row) => ({ ...row, definition: asDefinition(row.definition), channel_ids: row.channel_ids ?? [] }));
}

export async function listCompanyChannels(companyId: string) {
  const rows = await db()<{ id: string; name: string | null; channel_type: string | null; status: string | null }[]>`
    SELECT id, name, channel_type, status
    FROM public.whatsapp_channels
    WHERE company_id = ${companyId}::uuid
      AND deleted_at IS NULL
      AND COALESCE(active, true) = true
      AND (
        (lower(COALESCE(channel_type, '')) = 'meta' AND upper(COALESCE(status, '')) = 'ACTIVE')
        OR (lower(COALESCE(channel_type, '')) <> 'meta' AND lower(COALESCE(status, '')) = 'connected')
      )
    ORDER BY name NULLS LAST
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name || "Canal",
    channelType: String(row.channel_type ?? "").toLowerCase(),
    status: String(row.status ?? ""),
  }));
}

export async function saveAutomationFlow(actor: Actor, body: unknown): Promise<Response> {
  await ensureAutomationSchema();
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = typeof record.id === "string" && record.id ? record.id : null;
  const name = String(record.name ?? "").trim().slice(0, 120);
  const kind: FlowKind = record.kind === "sales" ? "sales" : "attendance";
  const status: FlowStatus = record.status === "active" || record.status === "paused" ? record.status : "draft";
  const parsed = validateDefinition(record.definition);
  if (!name) return Response.json({ error: "invalid_input", message: "Dê um nome ao fluxo." }, { status: 400 });
  if (!parsed.ok) return Response.json({ error: "invalid_input", message: parsed.error }, { status: 400 });
  const channelIds = Array.isArray(record.channelIds) ? record.channelIds.map(String).filter(Boolean) : [];
  const dispatchChannelId = typeof record.dispatchChannelId === "string" ? record.dispatchChannelId : null;
  const templateName = typeof record.metaTemplateName === "string" ? record.metaTemplateName.trim() : "";
  const templateLanguage = typeof record.metaTemplateLanguage === "string" ? record.metaTemplateLanguage.trim() : "";
  const takeChannels = record.takeChannels === true;

  if (status === "active" && kind === "attendance" && channelIds.length === 0) {
    return Response.json({ error: "invalid_input", message: "Marque pelo menos um número para ativar o atendimento." }, { status: 400 });
  }
  if (status === "active" && kind === "sales") {
    if (!dispatchChannelId) {
      return Response.json({ error: "invalid_input", message: "Escolha o número do disparo." }, { status: 400 });
    }
    const channels = await listCompanyChannels(actor.companyId);
    const channel = channels.find((item) => item.id === dispatchChannelId);
    if (!channel) return Response.json({ error: "invalid_input", message: "Número do disparo não encontrado." }, { status: 400 });
    if (channel.channelType === "meta" && (!templateName || !templateLanguage)) {
      return Response.json(
        { error: "invalid_input", message: "No número Meta, escolha uma mensagem de campanha já aprovada." },
        { status: 400 },
      );
    }
    if (channel.channelType === "meta") {
      const approved = await db()<{ id: string }[]>`
        SELECT id FROM public.meta_message_templates
        WHERE company_id = ${actor.companyId}::uuid
          AND channel_id = ${dispatchChannelId}::uuid
          AND template_name = ${templateName}
          AND language_code = ${templateLanguage}
          AND active = true
          AND upper(status) = 'APPROVED'
        LIMIT 1
      `;
      if (!approved[0]) {
        return Response.json(
          { error: "invalid_input", message: "Essa mensagem ainda não está aprovada pela Meta." },
          { status: 400 },
        );
      }
    }
  }

  const s = db();
  const flowId = id ?? (await s<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0].id;
  if (id) {
    const owns = await s<{ id: string }[]>`
      SELECT id FROM public.automation_flows
      WHERE id = ${flowId}::uuid AND company_id = ${actor.companyId}::uuid
      LIMIT 1
    `;
    if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (kind === "attendance" && channelIds.length > 0) {
    const taken = await s<{ channel_id: string; name: string }[]>`
      SELECT c.channel_id, f.name
      FROM public.automation_flow_channels c
      JOIN public.automation_flows f ON f.id = c.flow_id
      WHERE c.company_id = ${actor.companyId}::uuid
        AND c.channel_id = ANY(${channelIds}::uuid[])
        AND c.flow_id <> ${flowId}::uuid
    `;
    if (taken.length > 0 && !takeChannels) {
      return Response.json(
        {
          error: "channel_taken",
          message: `O número já está no fluxo "${taken[0].name}". Confirme para movê-lo.`,
          flowName: taken[0].name,
        },
        { status: 409 },
      );
    }
    if (taken.length > 0) {
      await s`
        DELETE FROM public.automation_flow_channels
        WHERE company_id = ${actor.companyId}::uuid
          AND channel_id = ANY(${channelIds}::uuid[])
          AND flow_id <> ${flowId}::uuid
      `;
    }
  }

  await s`
    INSERT INTO public.automation_flows (
      id, company_id, name, kind, status, definition, dispatch_channel_id,
      meta_template_name, meta_template_language
    ) VALUES (
      ${flowId}::uuid, ${actor.companyId}::uuid, ${name}, ${kind}, ${status},
      ${JSON.stringify(parsed.definition)}::jsonb,
      ${kind === "sales" ? dispatchChannelId : null}::uuid,
      ${kind === "sales" ? templateName || null : null},
      ${kind === "sales" ? templateLanguage || null : null}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      status = EXCLUDED.status,
      definition = EXCLUDED.definition,
      dispatch_channel_id = EXCLUDED.dispatch_channel_id,
      meta_template_name = EXCLUDED.meta_template_name,
      meta_template_language = EXCLUDED.meta_template_language,
      updated_at = now()
    WHERE public.automation_flows.company_id = ${actor.companyId}::uuid
  `;

  await s`DELETE FROM public.automation_flow_channels WHERE flow_id = ${flowId}::uuid`;
  if (kind === "attendance") {
    for (const channelId of channelIds) {
      await s`
        INSERT INTO public.automation_flow_channels (flow_id, channel_id, company_id)
        VALUES (${flowId}::uuid, ${channelId}::uuid, ${actor.companyId}::uuid)
        ON CONFLICT (channel_id) DO UPDATE SET flow_id = EXCLUDED.flow_id, company_id = EXCLUDED.company_id
      `;
    }
  }
  return Response.json({ id: flowId });
}

export async function deleteAutomationFlow(actor: Actor, id: string): Promise<Response> {
  await ensureAutomationSchema();
  await db()`
    DELETE FROM public.automation_flows
    WHERE id = ${id}::uuid AND company_id = ${actor.companyId}::uuid
  `;
  return Response.json({ ok: true });
}

type Collected = FlowVars & { lastText?: string; observacao?: string };

type SessionRow = {
  conversation_id: string;
  company_id: string;
  flow_id: string;
  contact_id: string;
  channel_id: string;
  step_id: string | null;
  status: string;
  collected: Collected;
  source: string;
};

async function loadContactVars(contactId: string, collected: Collected): Promise<FlowVars> {
  const rows = await db()<{ name: string | null; phone: string | null; reference: string | null }[]>`
    SELECT name, phone, reference FROM public.contacts WHERE id = ${contactId}::uuid LIMIT 1
  `;
  const contact = rows[0];
  return {
    nome: contact?.name ?? "",
    telefone: contact?.phone ?? "",
    endereco: collected.endereco || contact?.reference || "",
    prazo: collected.prazo ?? "",
    dia: collected.dia ?? "",
  };
}

async function sendText(companyId: string, conversationId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await sendConversationText({ companyId, conversationId, text: trimmed, sentByName: "Fluxo" });
}

async function presentStep(params: {
  companyId: string;
  conversationId: string;
  contactId: string;
  definition: FlowDefinition;
  stepId: string | null;
  collected: Collected;
}): Promise<{ stepId: string | null; status: "waiting" | "transferred" | "ended"; collected: Collected }> {
  let current = stepById(params.definition, params.stepId);
  let hops = 0;
  let collected = { ...params.collected };
  while (current && hops < 8) {
    hops += 1;
    if (current.type === "condition") {
      const yes = replyMatches(collected.lastText ?? "", current.match);
      current = stepById(params.definition, yes ? current.yesNext : current.noNext);
      continue;
    }
    const vars = await loadContactVars(params.contactId, collected);
    const text = promptForStep(current, vars);
    if (current.type === "transfer") {
      await sendText(params.companyId, params.conversationId, text);
      return { stepId: current.id, status: "transferred", collected };
    }
    if (current.type === "end") {
      await sendText(params.companyId, params.conversationId, text);
      return { stepId: current.id, status: "ended", collected };
    }
    await sendText(params.companyId, params.conversationId, text);
    return { stepId: current.id, status: "waiting", collected };
  }
  return { stepId: null, status: "ended", collected };
}

async function saveSession(session: SessionRow, patch: Partial<SessionRow>) {
  const next = { ...session, ...patch };
  await db()`
    INSERT INTO public.automation_sessions (
      conversation_id, company_id, flow_id, contact_id, channel_id, step_id, status, collected, source
    ) VALUES (
      ${next.conversation_id}::uuid, ${next.company_id}::uuid, ${next.flow_id}::uuid,
      ${next.contact_id}::uuid, ${next.channel_id}::uuid, ${next.step_id},
      ${next.status}, ${JSON.stringify(next.collected)}::jsonb, ${next.source}
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      flow_id = EXCLUDED.flow_id,
      step_id = EXCLUDED.step_id,
      status = EXCLUDED.status,
      collected = EXCLUDED.collected,
      source = EXCLUDED.source,
      updated_at = now()
  `;
}

export async function onAutomationInbound(params: {
  companyId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  text: string;
}): Promise<void> {
  try {
    await ensureAutomationSchema();
  } catch (error) {
    console.error("[AUTOMATION_SCHEMA]", error instanceof Error ? error.message : error);
    return;
  }
  try {
    const text = params.text.trim();
    if (!text) return;
    const sessions = await db()<SessionRow[]>`
      SELECT conversation_id, company_id, flow_id, contact_id, channel_id, step_id, status, collected, source
      FROM public.automation_sessions
      WHERE conversation_id = ${params.conversationId}::uuid
        AND company_id = ${params.companyId}::uuid
      LIMIT 1
    `;
    const session = sessions[0];
    if (session?.status === "transferred") return;
    if (session?.status === "waiting") {
      await answerWaitingSession(session, text);
      return;
    }
    const flows = await db()<{ id: string; definition: unknown }[]>`
      SELECT f.id, f.definition
      FROM public.automation_flows f
      JOIN public.automation_flow_channels c ON c.flow_id = f.id
      WHERE f.company_id = ${params.companyId}::uuid
        AND f.kind = 'attendance'
        AND f.status = 'active'
        AND c.channel_id = ${params.channelId}::uuid
      LIMIT 1
    `;
    const flow = flows[0];
    if (!flow) return;
    const definition = asDefinition(flow.definition);
    const created: SessionRow = {
      conversation_id: params.conversationId,
      company_id: params.companyId,
      flow_id: flow.id,
      contact_id: params.contactId,
      channel_id: params.channelId,
      step_id: definition.entryStepId,
      status: "waiting",
      collected: {},
      source: "inbound",
    };
    const presented = await presentStep({
      companyId: params.companyId,
      conversationId: params.conversationId,
      contactId: params.contactId,
      definition,
      stepId: definition.entryStepId,
      collected: {},
    });
    await saveSession(created, presented);
  } catch (error) {
    console.error("[AUTOMATION_INBOUND]", error instanceof Error ? error.message : error);
  }
}

async function answerWaitingSession(session: SessionRow, text: string) {
  const flows = await db()<{ definition: unknown; status: string }[]>`
    SELECT definition, status FROM public.automation_flows
    WHERE id = ${session.flow_id}::uuid AND company_id = ${session.company_id}::uuid
    LIMIT 1
  `;
  const flow = flows[0];
  if (!flow || flow.status !== "active") return;
  const definition = asDefinition(flow.definition);
  const step = stepById(definition, session.step_id);
  const collected: Collected = {
    ...(session.collected ?? {}),
    lastText: text,
  };
  if (!step) {
    await saveSession(session, { status: "ended", collected });
    return;
  }
  if (step.type === "buttons" || step.type === "reminder") {
    const choices = step.type === "buttons" ? step.buttons : step.options;
    const hit = matchChoice(text, choices);
    if (!hit) {
      const vars = await loadContactVars(session.contact_id, collected);
      await sendText(
        session.company_id,
        session.conversation_id,
        `Toque em uma das opções.\n${promptForStep(step, vars)}`,
      );
      return;
    }
    if (step.type === "reminder") {
      collected.prazo = hit.label;
      const option = step.options.find((item) => item.id === hit.id);
      const dueAt = new Date(Date.now() + (option?.days ?? 1) * 24 * 60 * 60 * 1000).toISOString();
      await db()`
        INSERT INTO public.automation_reminders (
          company_id, flow_id, contact_id, channel_id, conversation_id, label, days, due_at
        ) VALUES (
          ${session.company_id}::uuid, ${session.flow_id}::uuid, ${session.contact_id}::uuid,
          ${session.channel_id}::uuid, ${session.conversation_id}::uuid, ${hit.label},
          ${option?.days ?? 1}, ${dueAt}::timestamptz
        )
      `;
    }
    const presented = await presentStep({
      companyId: session.company_id,
      conversationId: session.conversation_id,
      contactId: session.contact_id,
      definition,
      stepId: hit.next,
      collected,
    });
    await saveSession(session, presented);
    return;
  }
  if (step.type === "ask_text") {
    if (step.saveAs === "endereco") {
      collected.endereco = text;
      await db()`UPDATE public.contacts SET reference = ${text} WHERE id = ${session.contact_id}::uuid`;
    } else if (step.saveAs === "dia") collected.dia = text;
    else if (step.saveAs === "observacao") collected.observacao = text;
    const presented = await presentStep({
      companyId: session.company_id,
      conversationId: session.conversation_id,
      contactId: session.contact_id,
      definition,
      stepId: step.next,
      collected,
    });
    await saveSession(session, presented);
  }
}

export async function stopAutomationForConversation(conversationId: string, companyId: string): Promise<void> {
  try {
    await ensureAutomationSchema();
    await db()`
      UPDATE public.automation_sessions
      SET status = 'transferred', updated_at = now()
      WHERE conversation_id = ${conversationId}::uuid
        AND company_id = ${companyId}::uuid
        AND status = 'waiting'
    `;
  } catch (error) {
    console.error("[AUTOMATION_STOP]", error instanceof Error ? error.message : error);
  }
}

export async function dispatchAutomationFlow(actor: Actor, flowId: string, contactIds: string[]): Promise<Response> {
  await ensureAutomationSchema();
  const unique = [...new Set(contactIds)].slice(0, 30);
  if (unique.length === 0) {
    return Response.json({ error: "invalid_input", message: "Escolha pelo menos um contato." }, { status: 400 });
  }
  const flows = await db()<FlowRow[]>`
    SELECT id, name, kind, status, definition, dispatch_channel_id, meta_template_name, meta_template_language,
           '{}'::uuid[] AS channel_ids
    FROM public.automation_flows
    WHERE id = ${flowId}::uuid AND company_id = ${actor.companyId}::uuid AND kind = 'sales'
    LIMIT 1
  `;
  const flow = flows[0];
  if (!flow || flow.status !== "active" || !flow.dispatch_channel_id) {
    return Response.json({ error: "invalid_input", message: "Ative o fluxo de vendas e escolha o número." }, { status: 400 });
  }
  const definition = asDefinition(flow.definition);
  const channels = await listCompanyChannels(actor.companyId);
  const channel = channels.find((item) => item.id === flow.dispatch_channel_id);
  if (!channel) return Response.json({ error: "invalid_input", message: "Número do disparo não encontrado." }, { status: 400 });

  let sent = 0;
  const errors: string[] = [];
  for (const contactId of unique) {
    const contacts = await db()<{ name: string | null; phone: string | null }[]>`
      SELECT name, phone FROM public.contacts
      WHERE id = ${contactId}::uuid AND company_id = ${actor.companyId}::uuid
      LIMIT 1
    `;
    const contact = contacts[0];
    if (!contact?.phone) {
      errors.push(contactId);
      continue;
    }
    const conversationId = await upsertInboundConversation({
      companyId: actor.companyId,
      channelId: flow.dispatch_channel_id,
      contactId,
      initialUnread: 0,
    });
    if (channel.channelType === "meta") {
      const approved = await db()<{ components: unknown }[]>`
        SELECT components FROM public.meta_message_templates
        WHERE company_id = ${actor.companyId}::uuid
          AND channel_id = ${flow.dispatch_channel_id}::uuid
          AND template_name = ${flow.meta_template_name ?? ""}
          AND language_code = ${flow.meta_template_language ?? ""}
        LIMIT 1
      `;
      const variableCount = toMetaTemplatePublic({
        id: "",
        company_id: actor.companyId,
        channel_id: flow.dispatch_channel_id,
        meta_template_id: null,
        template_name: flow.meta_template_name ?? "",
        language_code: flow.meta_template_language ?? "",
        category: null,
        status: "APPROVED",
        components: approved[0]?.components ?? [],
        active: true,
        last_synced_at: null,
        created_at: "",
        updated_at: "",
      }).variables.length;
      const bodyParameters = [contact.name || "cliente", contact.phone].slice(0, variableCount);
      const send = await sendMetaTemplateMessage({
        companyId: actor.companyId,
        channelId: flow.dispatch_channel_id,
        toPhone: contact.phone,
        templateName: flow.meta_template_name ?? "",
        languageCode: flow.meta_template_language ?? "",
        bodyParameters,
      });
      if (!send.ok) {
        errors.push(contact.phone);
        continue;
      }
      await db()`
        INSERT INTO public.messages (
          conversation_id, direction, message_type, message_text, from_me, status
        ) VALUES (
          ${conversationId}::uuid, 'out', 'text',
          ${`Campanha: ${flow.meta_template_name}`}, true, 'sent'
        )
      `;
      await saveSession(
        {
          conversation_id: conversationId,
          company_id: actor.companyId,
          flow_id: flow.id,
          contact_id: contactId,
          channel_id: flow.dispatch_channel_id,
          step_id: definition.entryStepId,
          status: "waiting",
          collected: {},
          source: "campaign",
        },
        { source: "campaign" },
      );
      sent += 1;
      continue;
    }
    const presented = await presentStep({
      companyId: actor.companyId,
      conversationId,
      contactId,
      definition,
      stepId: definition.entryStepId,
      collected: {},
    });
    await saveSession(
      {
        conversation_id: conversationId,
        company_id: actor.companyId,
        flow_id: flow.id,
        contact_id: contactId,
        channel_id: flow.dispatch_channel_id,
        step_id: definition.entryStepId,
        status: "waiting",
        collected: {},
        source: "campaign",
      },
      { ...presented, source: "campaign" },
    );
    sent += 1;
  }
  return Response.json({ sent, failed: errors.length });
}

export async function listAutomationReminders(companyId: string) {
  await ensureAutomationSchema();
  return db()`
    SELECT r.id, r.label, r.days, r.due_at, r.status, r.created_at,
           f.name AS flow_name, ct.name AS contact_name, ct.phone, ch.name AS channel_name
    FROM public.automation_reminders r
    JOIN public.automation_flows f ON f.id = r.flow_id
    JOIN public.contacts ct ON ct.id = r.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = r.channel_id
    WHERE r.company_id = ${companyId}::uuid
      AND r.status = 'pending'
    ORDER BY r.due_at ASC
  `;
}

export async function dismissAutomationReminder(actor: Actor, id: string) {
  await ensureAutomationSchema();
  await db()`
    UPDATE public.automation_reminders
    SET status = 'dismissed'
    WHERE id = ${id}::uuid AND company_id = ${actor.companyId}::uuid AND status = 'pending'
  `;
  return Response.json({ ok: true });
}

export async function resendAutomationReminder(actor: Actor, id: string) {
  await ensureAutomationSchema();
  const rows = await db()<{
    id: string;
    flow_id: string;
    contact_id: string;
    channel_id: string;
    conversation_id: string | null;
    kind: FlowKind;
    definition: unknown;
    dispatch_channel_id: string | null;
    meta_template_name: string | null;
    meta_template_language: string | null;
    phone: string | null;
    name: string | null;
    channel_type: string | null;
  }[]>`
    SELECT r.id, r.flow_id, r.contact_id, r.channel_id, r.conversation_id,
           f.kind, f.definition, f.dispatch_channel_id, f.meta_template_name, f.meta_template_language,
           ct.phone, ct.name, ch.channel_type
    FROM public.automation_reminders r
    JOIN public.automation_flows f ON f.id = r.flow_id
    JOIN public.contacts ct ON ct.id = r.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = r.channel_id
    WHERE r.id = ${id}::uuid AND r.company_id = ${actor.companyId}::uuid AND r.status = 'pending'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.phone) return Response.json({ error: "not_found" }, { status: 404 });
  const channelId = row.kind === "sales" ? row.dispatch_channel_id ?? row.channel_id : row.channel_id;
  const conversationId = row.conversation_id ?? await upsertInboundConversation({
    companyId: actor.companyId,
    channelId,
    contactId: row.contact_id,
    initialUnread: 0,
  });
  const definition = asDefinition(row.definition);
  const isMeta = String(row.channel_type ?? "").toLowerCase() === "meta" && row.kind === "sales" && row.meta_template_name;
  if (isMeta) {
    const sent = await sendMetaTemplateMessage({
      companyId: actor.companyId,
      channelId,
      toPhone: row.phone,
      templateName: row.meta_template_name ?? "",
      languageCode: row.meta_template_language ?? "",
      bodyParameters: [],
    });
    if (!sent.ok) {
      return Response.json({ error: "send_failed", message: "Não foi possível reenviar a mensagem aprovada." }, { status: 502 });
    }
  } else {
    const vars = await loadContactVars(row.contact_id, {});
    const step = stepById(definition, definition.entryStepId);
    if (step) await sendText(actor.companyId, conversationId, promptForStep(step, vars));
  }
  await saveSession(
    {
      conversation_id: conversationId,
      company_id: actor.companyId,
      flow_id: row.flow_id,
      contact_id: row.contact_id,
      channel_id: channelId,
      step_id: definition.entryStepId,
      status: "waiting",
      collected: {},
      source: "campaign",
    },
    {},
  );
  await db()`UPDATE public.automation_reminders SET status = 'resent' WHERE id = ${row.id}::uuid`;
  return Response.json({ ok: true });
}

export async function listApprovedTemplates(companyId: string, channelId: string) {
  const rows = await db()<{
    template_name: string;
    language_code: string;
    components: unknown;
  }[]>`
    SELECT template_name, language_code, components
    FROM public.meta_message_templates
    WHERE company_id = ${companyId}::uuid
      AND channel_id = ${channelId}::uuid
      AND active = true
      AND upper(status) = 'APPROVED'
    ORDER BY template_name
  `;
  return rows.map((row) => {
    const view = toMetaTemplatePublic({
      id: "",
      company_id: companyId,
      channel_id: channelId,
      meta_template_id: null,
      template_name: row.template_name,
      language_code: row.language_code,
      category: null,
      status: "APPROVED",
      components: row.components,
      active: true,
      last_synced_at: null,
      created_at: "",
      updated_at: "",
    });
    return { name: row.template_name, language: row.language_code, bodyText: view.bodyText, buttons: view.buttons };
  });
}
