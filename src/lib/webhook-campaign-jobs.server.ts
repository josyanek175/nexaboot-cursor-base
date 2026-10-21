/**
 * Tarefas duráveis de resposta de campanha.
 *
 * Criadas DENTRO da transação principal do message-worker. O processamento
 * imediato após o COMMIT é otimização: se falhar, a tarefa permanece pending
 * e pode ser reprocessada. A inbox já estar `processed` não apaga o efeito.
 */

import type { InboxTx } from "@/lib/webhook-inbox-claim.server";
import type { CampaignCandidate } from "@/lib/webhook-campaign-hook.server";
import { handleCampaignInboundReply } from "@/lib/campaign-response.server";

export type EnsureCampaignJobInput = {
  inboxId: string;
  messageId: string;
  companyId: string;
  channelId: string;
  conversationId: string;
  externalMessageId: string | null;
  phone: string;
  responseText: string | null;
  allowEmptyText: boolean;
  campaignId?: string | null;
};

export type EnsureCampaignJobResult = {
  campaignJobId: string | null;
  created: boolean;
};

export async function ensureCampaignJob(
  tx: InboxTx,
  params: EnsureCampaignJobInput,
): Promise<EnsureCampaignJobResult> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO public.webhook_campaign_jobs (
      inbox_id, message_id, campaign_id, company_id, channel_id,
      conversation_id, external_message_id, phone, response_text,
      allow_empty_text, job_payload, status
    ) VALUES (
      ${params.inboxId}::uuid,
      ${params.messageId}::uuid,
      ${params.campaignId ?? null}::uuid,
      ${params.companyId}::uuid,
      ${params.channelId}::uuid,
      ${params.conversationId}::uuid,
      ${params.externalMessageId},
      ${params.phone},
      ${params.responseText},
      ${params.allowEmptyText},
      ${{}}::jsonb,
      'pending'
    )
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
  `;

  if (inserted[0]) return { campaignJobId: inserted[0].id, created: true };

  const existing = await tx<{ id: string }[]>`
    SELECT id FROM public.webhook_campaign_jobs
    WHERE message_id = ${params.messageId}::uuid
    LIMIT 1
  `;
  return { campaignJobId: existing[0]?.id ?? null, created: false };
}

export async function markCampaignJobProcessed(
  sql: InboxTx,
  params: { campaignJobId: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE public.webhook_campaign_jobs
    SET status = 'processed',
        processed_at = now(),
        last_error = NULL,
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = ${params.campaignJobId}::uuid
      AND status IN ('pending', 'processing', 'retry')
    RETURNING id
  `;
  return rows.length > 0;
}

export async function markCampaignJobRetry(
  sql: InboxTx,
  params: { campaignJobId: string; error: string; delayMs: number },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE public.webhook_campaign_jobs
    SET status = 'retry',
        attempts = attempts + 1,
        available_at = now() + make_interval(secs => ${params.delayMs} / 1000.0),
        last_error = ${params.error},
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = ${params.campaignJobId}::uuid
      AND status IN ('pending', 'processing', 'retry')
    RETURNING id
  `;
  return rows.length > 0;
}

type LogFn = (event: string, data?: Record<string, unknown>) => void;

/**
 * Otimização pós-COMMIT: tenta processar na hora.
 * Falha NÃO perde trabalho — a tarefa continua pending/retry.
 */
export async function tryProcessCampaignJobImmediately(params: {
  sql: InboxTx;
  campaignJobId: string;
  candidate: CampaignCandidate;
  log?: LogFn;
  logError?: LogFn;
}): Promise<"processed" | "failed"> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const logError = params.logError ?? ((e, d) => console.error(`[${e}]`, d ?? {}));

  try {
    await handleCampaignInboundReply({
      companyId: params.candidate.companyId,
      channelId: params.candidate.channelId,
      conversationId: params.candidate.conversationId,
      phone: params.candidate.phone,
      responseText: params.candidate.responseText,
      allowEmptyText: params.candidate.allowEmptyText,
      inboundMessageId: params.candidate.inboundMessageId,
    });
    await markCampaignJobProcessed(params.sql, { campaignJobId: params.campaignJobId });
    log("WEBHOOK_CAMPAIGN_JOB_PROCESSED", {
      campaignJobId: params.campaignJobId,
      conversationId: params.candidate.conversationId,
    });
    return "processed";
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await markCampaignJobRetry(params.sql, {
      campaignJobId: params.campaignJobId,
      error: error.slice(0, 500),
      delayMs: 5_000,
    }).catch(() => undefined);
    logError("WEBHOOK_CAMPAIGN_JOB_RETRY", {
      campaignJobId: params.campaignJobId,
      conversationId: params.candidate.conversationId,
      error: error.slice(0, 300),
    });
    return "failed";
  }
}
