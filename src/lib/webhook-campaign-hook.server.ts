/**
 * Ponte entre o processamento de webhooks e a área de campanhas.
 *
 * Fica separada de propósito. `handleCampaignInboundReply` percorre uma árvore
 * grande (campaign_contacts, campaign_events, opt-out, status de serviço) que
 * ainda usa o pool global, então ela NÃO entra na transação curta do
 * message-worker. Roda depois do COMMIT, exatamente como a rota legada já faz
 * hoje: uma falha aqui é registrada e não derruba a mensagem, que já está
 * gravada e visível para o atendente.
 *
 * A proteção contra resposta duplicada é a montante: só mensagens realmente
 * novas viram candidatas (veja `messageCreated`), então reprocessar um evento
 * já gravado não dispara a campanha de novo.
 */

import { handleCampaignInboundReply } from "@/lib/campaign-response.server";

export type CampaignCandidate = {
  companyId: string;
  channelId: string;
  conversationId: string;
  phone: string;
  responseText: string | null;
  allowEmptyText: boolean;
  inboundMessageId: string;
};

type LogFn = (event: string, data?: Record<string, unknown>) => void;

export async function runCampaignCandidates(
  candidates: CampaignCandidate[],
  logError: LogFn = (event, data) => console.error(`[${event}]`, data ?? {}),
): Promise<void> {
  for (const candidate of candidates) {
    try {
      await handleCampaignInboundReply({
        companyId: candidate.companyId,
        channelId: candidate.channelId,
        conversationId: candidate.conversationId,
        phone: candidate.phone,
        responseText: candidate.responseText,
        allowEmptyText: candidate.allowEmptyText,
        inboundMessageId: candidate.inboundMessageId,
      });
    } catch (e) {
      logError("CAMPAIGN_RESPONSE_HOOK_FAIL", {
        conversationId: candidate.conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/** Junta os candidatos de um evento inteiro, na ordem em que apareceram. */
export function collectCampaignCandidates(
  results: Array<{ campaignCandidate: CampaignCandidate | null }>,
): CampaignCandidate[] {
  return results
    .map((r) => r.campaignCandidate)
    .filter((c): c is CampaignCandidate => c != null);
}
