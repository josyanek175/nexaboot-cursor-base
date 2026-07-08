// Roteamento de envio outbound por provider (Meta ou Evolution) com logs de diagnóstico.

import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { sendMetaManualText } from "@/lib/meta-send-message.server";
import {
  getProviderByKind,
  normalizeProviderKind,
} from "@/lib/whatsapp/whatsapp-provider-router.server";

export type SendConversationTextResult =
  | { ok: true; provider: "meta" | "evolution"; message: Record<string, unknown> }
  | { ok: false; status: number; error: string; message?: string; provider?: string };

export async function sendConversationText(params: {
  companyId: string;
  conversationId: string;
  text: string;
  sentByUserId?: string | null;
  sentByName?: string | null;
}): Promise<SendConversationTextResult> {
  const { companyId, conversationId, text, sentByUserId, sentByName } = params;

  console.log("[SEND_MESSAGE_REQUEST_RECEIVED]", { conversationId, companyId });

  await ensureCrmSchema();
  const s = sql();

  const rows = await s<{
    id: string;
    company_id: string;
    whatsapp_channel_id: string;
    channel_type: string;
    channel_name: string | null;
    evolution_instance_name: string | null;
    phone: string | null;
    external_jid: string | null;
  }[]>`
    SELECT c.id, c.company_id, c.whatsapp_channel_id,
           ch.channel_type, ch.name AS channel_name, ch.evolution_instance_name,
           ct.phone, ct.external_jid
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.id = ${conversationId}::uuid
      AND c.company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const conv = rows[0];
  if (!conv) {
    return { ok: false, status: 404, error: "conversation_not_found" };
  }

  const providerKind = normalizeProviderKind(conv.channel_type) ?? "evolution";

  console.log("[SEND_MESSAGE_SELECTED_CHANNEL]", {
    channelId: conv.whatsapp_channel_id,
    channelType: conv.channel_type,
    channelName: conv.channel_name,
  });
  console.log("[SEND_MESSAGE_PROVIDER]", { provider: providerKind });
  console.log("[SEND_MESSAGE_CHANNEL_ID]", { channelId: conv.whatsapp_channel_id });
  console.log("[SEND_MESSAGE_COMPANY_ID]", { companyId });

  getProviderByKind(providerKind);

  if (providerKind === "meta") {
    const result = await sendMetaManualText({
      companyId,
      conversationId,
      text,
      sentByUserId,
      sentByName,
    });
    if (!result.ok) {
      return { ...result, provider: "meta" };
    }
    return { ok: true, provider: "meta", message: result.message };
  }

  const apiUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = conv.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME;
  if (!apiUrl || !apiKey || !instance) {
    return { ok: false, status: 500, error: "missing_evolution_config", provider: "evolution" };
  }
  const number = String(conv.phone || conv.external_jid || "").replace(/\D/g, "");
  if (!number) {
    return { ok: false, status: 400, error: "missing_number", provider: "evolution" };
  }

  console.log("[EVOLUTION_SEND]", { conversationId, instance, number });

  let providerId: string | null = null;
  try {
    const res = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number, text }),
      },
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      console.error("[EVOLUTION_ERROR]", { status: res.status, body: body.slice(0, 500) });
      const code =
        res.status === 401 || res.status === 403
          ? "unauthorized_check_api_key"
          : "evolution_http_error";
      return {
        ok: false,
        status: 502,
        error: code,
        message: body.slice(0, 500) || undefined,
        provider: "evolution",
      };
    }
    try {
      providerId = JSON.parse(body)?.key?.id ?? null;
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.error("[EVOLUTION_ERROR]", e);
    return {
      ok: false,
      status: 502,
      error: "evolution_unreachable",
      message: e instanceof Error ? e.message : String(e),
      provider: "evolution",
    };
  }

  const inserted = await s`
    INSERT INTO public.messages
      (conversation_id, external_id, external_message_id, direction,
       message_type, message_text, from_me, status,
       sent_by_user_id, sent_by_name)
    VALUES
      (${conversationId}::uuid, ${providerId}, ${providerId}, 'out',
       'text', ${text}, true, 'sent',
       ${sentByUserId ?? null}, ${sentByName ?? null})
    RETURNING id, conversation_id, direction, message_type,
              message_text AS body, from_me, status, created_at,
              sent_by_user_id, sent_by_name
  `;
  await s`
    UPDATE public.conversations
    SET last_message = ${text}, last_message_at = now(), updated_at = now()
    WHERE id = ${conversationId}::uuid
  `;
  console.log("[EVOLUTION_MESSAGE_SAVED]", {
    conversationId,
    out: true,
    messageId: inserted[0]?.id,
  });

  const row = inserted[0];
  if (!row) {
    return { ok: false, status: 500, error: "message_save_failed", provider: "evolution" };
  }

  return {
    ok: true,
    provider: "evolution",
    message: {
      id: row.id,
      conversation_id: row.conversation_id,
      direction: row.direction,
      message_type: row.message_type,
      body: row.body,
      from_me: row.from_me,
      status: row.status,
      created_at: row.created_at,
      sent_by_user_id: row.sent_by_user_id,
      sent_by_name: row.sent_by_name,
    },
  };
}
