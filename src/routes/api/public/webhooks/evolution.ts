/**
 * Webhook público da Evolution.
 *
 * Duas rotas de execução, escolhidas por WEBHOOK_DURABLE_INBOX_ENABLED:
 *   - ingestão durável: persiste o payload e responde 200 depois do COMMIT;
 *   - legado: processa tudo dentro da requisição.
 *
 * A lógica de domínio do caminho legado vive em
 * `@/lib/webhook-evolution-processing.server` — as mesmas funções que o
 * message-worker chama. Aqui ficou só o que é HTTP: token, corpo e status.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getSql } from "@/lib/pg.server";
import { getWebhookInboxSql } from "@/lib/pg-webhook-inbox.server";
import { isDurableWebhookInboxEnabled } from "@/lib/webhook-inbox-core";
import { isWebhookLegacyProcessingEnabled } from "@/lib/webhook-message-core";
import { ingestWebhookRequestToInbox } from "@/lib/webhook-inbox.server";
import { runWebhookIngress } from "@/lib/webhook-ingress.server";
import {
  collectCampaignCandidates,
  runCampaignCandidates,
} from "@/lib/webhook-campaign-hook.server";
import {
  processEvolutionInboxEvent,
  type Json,
} from "@/lib/webhook-evolution-processing.server";

const PayloadSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

/**
 * Lê o segredo do webhook em qualquer um dos formatos aceitos:
 * query ?token=, header x-webhook-secret ou header apikey.
 */
function readWebhookToken(request: Request): string {
  const url = new URL(request.url);
  return (
    url.searchParams.get("token") ||
    request.headers.get("x-webhook-secret") ||
    request.headers.get("apikey") ||
    ""
  );
}

/**
 * Validação central e obrigatória do EVOLUTION_WEBHOOK_SECRET.
 * Garante que NENHUM caminho chame a ingestão sem token válido.
 * Retorna null quando autorizado; uma Response de erro quando bloqueado.
 */
function checkWebhookAuth(request: Request): Response | null {
  console.log("[EVOLUTION_WEBHOOK_RECEIVED]");
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[EVOLUTION_WEBHOOK_AUTH_FAIL]", { reason: "secret_not_configured" });
    return Response.json({ error: "webhook_secret_not_configured" }, { status: 503 });
  }
  if (readWebhookToken(request) !== expected) {
    console.warn("[EVOLUTION_WEBHOOK_AUTH_FAIL]", { reason: "invalid_token" });
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  console.log("[EVOLUTION_WEBHOOK_AUTH_OK]");
  return null;
}

export async function handleEvolutionWebhookPOST(request: Request): Promise<Response> {
  // Segurança: validação obrigatória antes de qualquer leitura do corpo.
  const authError = checkWebhookAuth(request);
  if (authError) return authError;

  let body: z.infer<typeof PayloadSchema>;
  try {
    body = PayloadSchema.parse(await request.json());
  } catch (e) {
    console.log("[WEBHOOK_INVALID_PAYLOAD]", String(e));
    return new Response("Invalid payload", { status: 400 });
  }

  try {
    // Modo inline: o anexo é baixado dentro da requisição, como sempre foi.
    const result = await processEvolutionInboxEvent({
      sql: getSql(),
      payload: body as Json,
      media: { mode: "inline" },
    });

    if (result.status === "missing_instance") {
      return new Response("Missing instance", { status: 400 });
    }
    if (result.status === "channel_not_found") {
      return new Response("Channel not found", { status: 404 });
    }
    if (result.status === "channel_without_company") {
      // 200 para a Evolution não reenviar em loop um evento que nunca será
      // processável.
      return Response.json({ ok: true, ignored: "channel_without_company" });
    }

    await runCampaignCandidates(collectCampaignCandidates(result.messages));

    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[WEBHOOK_ERROR]", {
      event: body.event ?? "unknown",
      instance: body.instance ?? null,
      error: msg,
    });
    return new Response("Server error", { status: 500 });
  }
}

/**
 * Ingestão durável: valida o token, lê o corpo com teto e prazo, persiste o
 * payload integral na inbox e só então responde 200.
 *
 * Nenhuma etapa pesada roda aqui — sem upsertContact, upsertConversation,
 * download de mídia, INSERT em messages, atualização de conversa ou campanha.
 */
export async function ingestEvolutionWebhookDurable(request: Request): Promise<Response> {
  const authError = checkWebhookAuth(request);
  if (authError) return authError;

  return ingestWebhookRequestToInbox({
    sql: getWebhookInboxSql(),
    provider: "evolution",
    request,
  });
}

/** Roteia entre ingestão durável, legado e kill-switch. */
export async function handleEvolutionWebhookRequest(request: Request): Promise<Response> {
  if (isDurableWebhookInboxEnabled()) return ingestEvolutionWebhookDurable(request);
  if (!isWebhookLegacyProcessingEnabled()) {
    console.warn("[WEBHOOK_MESSAGE_CONFIG_CONFLICT]", {
      code: "legacy_disabled",
      severity: "warning",
      message:
        "WEBHOOK_LEGACY_PROCESSING_ENABLED=false e WEBHOOK_DURABLE_INBOX_ENABLED=false: nenhum processamento ativo.",
    });
    return Response.json(
      { ok: false, code: "legacy_processing_disabled" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  return handleEvolutionWebhookPOST(request);
}

export const Route = createFileRoute("/api/public/webhooks/evolution")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ ok: true, service: "evolution-webhook" }), {
          headers: { "Content-Type": "application/json" },
        }),
      POST: async ({ request }) =>
        runWebhookIngress("evolution_public", () => handleEvolutionWebhookRequest(request)),
    },
  },
});
